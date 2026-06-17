/**
 * `SessionStart` hook runner — composes the additionalContext payload
 * Claude Code injects on session open and seeds the per-session state
 * partition (status.json, events marker), then GCs stale sessions +
 * events.
 *
 * This is the ONLY project-aware hook that runs on UNADOPTED repos (to
 * show the adoption banner).
 *
 * Spec: docs/CONTEXT_CONTINUITY_SPEC.md §3.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import {
  resolveRepoRoot,
  buildSessionStartContext,
} from "../../session-start/index.js";
import { rebuildDerived } from "../../state/rebuild-derived.js";
import { inspectJoinState, runJoin, writeCliPathFile } from "../../join/index.js";
import { MIGRATIONS, runMigrations, type RunMigrationsResult } from "../../migrate/index.js";
import { runUpdateCheck } from "../../update-check.js";
import { VERSION } from "../../index.js";
import { findCurrentActiveTask, readTaskJournal } from "../../tasks/index.js";
import {
  resolveSessionId,
  ensureSessionDir,
  seedEventsMarker,
  gcStaleSessions,
} from "../../session/index.js";
import {
  writeStatusJson,
  defaultStatusJson,
  readAdoptionState,
} from "../../status-line/index.js";
import { gcStaleEvents } from "../../events/reader.js";
import { runRuntimePrune } from "../../gc/runtime-prune.js";
import { readActiveTaskSummary } from "../../context/task-summary.js";

import { readDeferState } from "../defer.js";
import {
  readHookStdin,
  parseHookPayload,
  emitShapeB,
  appendTelemetry,
} from "./payload.js";
import { spawn } from "node:child_process";
import { cairnDir } from "@isaacriehm/cairn-state";

/**
 * Sync the bundle entry point into the homedir shim so `cairn-lens`
 * (and any other external TUI tools) can find the CLI executable
 * regardless of where the plugin bundle is currently installed.
 *
 * Writes the shim under the marketplace slug derived from
 * `CLAUDE_PLUGIN_ROOT` — `~/.claude/plugins/cache/<slug>/.active-version-path`.
 * The statusline command uses a runtime glob to locate it, so plugin
 * slug renames (forks, local-dev installs, alt marketplaces) work
 * automatically with no hardcoded slug.
 *
 * `CLAUDE_PLUGIN_ROOT` not set → silent skip with explicit warning so
 * the operator can diagnose via the SessionStart banner.
 */
function syncActiveVersionShim(warnings: string[]): void {
  const pluginRoot = process.env["CLAUDE_PLUGIN_ROOT"];
  if (typeof pluginRoot !== "string" || pluginRoot.length === 0) {
    warnings.push(
      "statusline_shim_skipped: CLAUDE_PLUGIN_ROOT not set (Claude Code did not inject env)",
    );
    return;
  }
  const bundlePath = join(pluginRoot, "dist", "cli.mjs");
  if (!existsSync(bundlePath)) {
    warnings.push(`statusline_shim_skipped: bundle missing at ${bundlePath}`);
    return;
  }

  const slug = pluginCacheSlug(pluginRoot) ?? localDevSlug(pluginRoot);
  if (slug === null) {
    warnings.push(
      `statusline_shim_skipped: cannot derive slug from CLAUDE_PLUGIN_ROOT (${pluginRoot})`,
    );
    return;
  }

  const shimDir = join(homedir(), ".claude", "plugins", "cache", slug);
  const shimPath = join(shimDir, ".active-version-path");
  try {
    mkdirSync(shimDir, { recursive: true });
    writeFileSync(shimPath, `${bundlePath}\n`, "utf8");
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    warnings.push(`statusline_shim_failed: ${message}`);
  }
}

/**
 * Extract the marketplace slug from a plugin-root path. The cache
 * layout is `<cacheRoot>/<slug>/<plugin-name>/<version>/`. Returns
 * the segment immediately under `cache/` or null if the path doesn't
 * look like a plugin cache.
 */
function pluginCacheSlug(pluginRoot: string): string | null {
  // Normalize separators before comparing. Claude Code injects
  // `CLAUDE_PLUGIN_ROOT` forward-slashed even on Windows, but `join` yields
  // OS-native backslashes there — so a raw `startsWith` against the joined
  // cache root mismatches on `/` vs `\` and the slug never derives (the
  // statusline shim is then silently skipped). Compare in POSIX form.
  const toPosix = (p: string): string => p.replace(/\\/g, "/");
  const root = toPosix(pluginRoot);
  const cacheRoot = toPosix(join(homedir(), ".claude", "plugins", "cache"));
  if (!root.startsWith(cacheRoot)) return null;
  const rest = root.slice(cacheRoot.length).replace(/^\/+/, "");
  if (rest.length === 0) return null;
  const parts = rest.split("/").filter((p) => p.length > 0);
  return parts.length > 0 ? (parts[0] ?? null) : null;
}

/**
 * Derive a cache slug for plugins loaded from a local-dev marketplace
 * (`source: directory`). Walks up `pluginRoot` looking for a sibling
 * `.claude-plugin/marketplace.json` and reads its `name` — this is the
 * same slug Claude Code uses when the marketplace is installed
 * normally, so the local-dev shim overwrites the cached-install shim
 * (and vice-versa) on whichever ran most recently. The bash one-liner
 * picks newest by mtime, so transitions stay consistent.
 *
 * Returns null when no marketplace manifest is found (caller emits
 * skip warning).
 */
function localDevSlug(pluginRoot: string): string | null {
  let dir = pluginRoot;
  for (let i = 0; i < 8; i++) {
    const manifest = join(dir, ".claude-plugin", "marketplace.json");
    if (existsSync(manifest)) {
      try {
        const parsed = JSON.parse(readFileSync(manifest, "utf8")) as {
          name?: unknown;
        };
        if (typeof parsed.name === "string" && parsed.name.length > 0) {
          return parsed.name;
        }
      } catch {
        return null;
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

interface SessionStartShapeBOutput {
  continue: true;
  hookSpecificOutput: {
    hookEventName: "SessionStart";
    additionalContext: string;
  };
}

export async function runSessionStartHook(): Promise<void> {
  const startedAt = Date.now();
  const raw = await readHookStdin();
  const payload = parseHookPayload(raw);
  const payloadSessionId = payload.session_id ?? null;
  const source = payload.source ?? null;
  const cwdInput = payload.cwd ?? process.cwd();
  const repoRoot = resolveRepoRoot(cwdInput);
  const shimWarnings: string[] = [];
  syncActiveVersionShim(shimWarnings);

  if (repoRoot === null) {
    // Repos NOT adopted: show the banner suggesting `cairn init` if it
    // looks like a project root, else stay silent. Surface any shim
    // failures so the operator can diagnose statusline-install issues
    // without having to be in an adopted project to see them.
    //
    // decline-never recorded for this cwd → suppress the banner
    // entirely. The cairn-adopt skill's Step 1 already aborts on
    // decline-never, but the banner instructs the agent to invoke the
    // skill before checking, burning a turn. Gate at the banner layer
    // so declined repos see no surface at all.
    const declineState = readAdoptionState(cwdInput);
    const banner =
      declineState === "declined" ? "" : renderAdoptionBanner(cwdInput);
    const shimNote = renderShimWarningsBanner(shimWarnings);
    const additionalContext =
      shimNote === null ? banner : banner.length === 0 ? shimNote : `${banner}\n\n${shimNote}`;
    emitShapeB(additionalContext, "SessionStart");
    return;
  }

  // Keep `.cli-path` current every session. A plugin upgrade rotates the
  // bundled `cli.mjs` path, but the bootstrap-only runJoin (gated on
  // hooksPathSet) never re-fires once hooks are wired — so a stale path would
  // persist and the git hooks, which `eval` it, would hard-fail commits.
  // repoRoot non-null here ⇒ adopted (resolveRepoRoot requires config.yaml).
  // Best-effort: writeCliPathFile try/catches internally and never throws.
  writeCliPathFile(repoRoot);

  const sessionWarnings: string[] = [...shimWarnings];
  const sessionId = resolveSessionId({ session_id: payloadSessionId ?? undefined });
  try {
    ensureSessionDir({ repoRoot, sessionId });
    writeStatusJson(repoRoot, sessionId, defaultStatusJson());
    seedEventsMarker({ repoRoot, sessionId });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sessionWarnings.push(
      `session_dir_init_failed: ${message}`,
    );
  }
  try {
    const gc = gcStaleSessions({ repoRoot });
    if (gc.removed.length > 0) sessionWarnings.push(`gc_removed:${gc.removed.length}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sessionWarnings.push(
      `session_gc_failed: ${message}`,
    );
  }
  try {
    const eventsGc = gcStaleEvents({ repoRoot });
    if (eventsGc.removed.length > 0) {
      sessionWarnings.push(`events_gc_removed:${eventsGc.removed.length}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sessionWarnings.push(
      `events_gc_failed: ${message}`,
    );
  }
  // Footprint prune — rotate telemetry logs, sweep the stale Haiku cache, reap
  // old baseline snapshots. Cheap (stat-based) + safe (derived/advisory state
  // only), so it runs every session open rather than waiting on the 24h GC
  // autotrigger, which is what let these reach tens of MB in the field.
  try {
    const pruned = runRuntimePrune({ repoRoot });
    if (pruned.bytesFreed > 0) {
      sessionWarnings.push(`runtime_pruned:${Math.round(pruned.bytesFreed / 1024)}KiB`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sessionWarnings.push(
      `runtime_prune_failed: ${message}`,
    );
  }
  // Rebuild the gitignored derived ground state (ledgers, scope-index,
  // manifest, sot-bindings, sot-cache, file-candidates) from the
  // committed DEC/INV sources. Must run BEFORE buildSessionStartContext
  // reads the ledgers.
  try {
    const rebuilt = rebuildDerived(repoRoot);
    sessionWarnings.push(
      `derived_rebuilt:dec=${rebuilt.decisions},inv=${rebuilt.invariants},bindings=${rebuilt.bindings}`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sessionWarnings.push(
      `derived_rebuild_failed: ${message}`,
    );
  }

  // Auto-apply `safe`-class `.cairn/` migrations on session open (D2), and
  // bump the stale `cairn_version` pin. Never blocks: a held lock or a
  // failure degrades to a warning. `review`-class migrations are surfaced
  // for the operator via the banner, never auto-applied.
  let migrationResult: RunMigrationsResult | null = null;
  try {
    migrationResult = await runMigrations({ repoRoot });
    const applied = migrationResult.outcomes.filter((o) => o.status === "applied");
    if (applied.length > 0) {
      sessionWarnings.push(`migrations_applied:${applied.map((o) => o.id).join(",")}`);
    }
    if (migrationResult.newPin !== null) {
      sessionWarnings.push(`pin_bumped:${migrationResult.newPin}`);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sessionWarnings.push(`migrations_failed: ${message}`);
  }

  // Best-effort "newer Cairn available" notice. Throttled to one network hit
  // per day per machine; a cache hit is pure FS. Never blocks past its tight
  // timeout, never throws. Surfaced as a banner below.
  let updateBanner: string | null = null;
  try {
    updateBanner = await runUpdateCheck(VERSION, Date.now());
  } catch {
    /* never blocks session start */
  }

  const isResume = source === "resume";
  const buildArgs: Parameters<typeof buildSessionStartContext>[0] = { repoRoot };
  if (isResume) buildArgs.maxChars = 4_000;
  if (source !== null) buildArgs.source = source;
  if (cwdInput !== repoRoot && cwdInput.startsWith(repoRoot)) {
    buildArgs.scopeRelPath = cwdInput.slice(repoRoot.length + 1);
  }
  const result = await buildSessionStartContext(buildArgs);
  const active = readActiveTaskSummary(repoRoot);
  const bypassCount = readDeferState(repoRoot, "bypass")?.flagged_shas.length ?? 0;

  try {
    writeStatusJson(repoRoot, sessionId, {
      decisions_in_scope: result.counts.decisions,
      invariants_in_scope: result.counts.invariants,
      attention_count:
        result.counts.pendingDrafts +
        result.counts.baselineFindings +
        result.counts.driftFindings,
      task_state: active?.taskState ?? "idle",
      task_id: active?.taskId ?? null,
      task_module: active?.taskModule ?? null,
      bypass_count: bypassCount,
      updated_at: new Date().toISOString(),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sessionWarnings.push(
      `session_status_patch_failed: ${message}`,
    );
  }

  const bootstrapBanner = renderBootstrapBanner(repoRoot);
  const resumeBanner = renderResumeBanner(repoRoot, sessionId);
  const midAdoptionBanner = renderMidAdoptionBanner(repoRoot);
  const migrationBanner =
    migrationResult !== null ? renderMigrationBanner(migrationResult) : null;
  const staleStatuslineBanner = renderStaleStatuslineBanner();
  const banners = [
    bootstrapBanner,
    resumeBanner,
    midAdoptionBanner,
    migrationBanner,
    staleStatuslineBanner,
    updateBanner,
  ].filter((b): b is string => b !== null);
  const additionalContext =
    banners.length === 0
      ? result.additionalContext
      : `${banners.join("\n\n")}\n\n${result.additionalContext}`;

  appendTelemetry({
    repoRoot,
    sessionId,
    kind: "session-start",
    durationMs: Date.now() - startedAt,
    source,
    warnings: sessionWarnings,
    extra: {
      is_resume: isResume,
      attention_count: result.counts.pendingDrafts,
      baseline_count: result.counts.baselineFindings,
      has_active_task: active !== null,
    },
  });

  // Spawn a detached drain if there's any attention.
  if (
    result.counts.pendingDrafts > 0 ||
    result.counts.baselineFindings > 0 ||
    result.counts.driftFindings > 0
  ) {
    spawnDetachedDrain(repoRoot, sessionId);
  }

  emitShapeB(additionalContext, "SessionStart");
}

/**
 * Launch `cairn align drain` as a detached subprocess. It will poll
 * for attention items and resolve them via Haiku / deterministic re-check.
 */
function spawnDetachedDrain(repoRoot: string, sessionId: string): void {
  const node = process.argv[0] ?? "node";
  const here = dirname(new URL(import.meta.url).pathname);
  const cli = join(here, "..", "..", "..", "cli.mjs");
  if (!existsSync(cli)) return;

  const args = [cli, "align", "drain", "--session-id", sessionId, "--repo", repoRoot];
  try {
    const child = spawn(node, args, {
      detached: true,
      stdio: "ignore",
      env: { ...process.env, CAIRN_IS_DETACHED: "true" },
    });
    child.unref();
  } catch {
    /* ignore */
  }
}

function renderBootstrapBanner(repoRoot: string): string | null {
  if (!existsSync(join(repoRoot, ".git"))) return null;
  if (!existsSync(cairnDir(repoRoot, "config.yaml"))) return null;
  const state = inspectJoinState({ repoRoot });
  if (state.hooksPathSet) return null;

  // Foreign `core.hooksPath` (husky / lefthook / custom): Cairn won't clobber
  // it (§3.3 seam 5). Re-running join can't wire the hooks, so surface a calm,
  // honest conflict notice instead of attempting bootstrap (which would report
  // a false "hooks wired" success every session).
  if (state.hooksPathConflict) {
    return [
      "## Cairn — git hooks not wired (core.hooksPath conflict)",
      "",
      `This repo's \`core.hooksPath\` is held by \`${state.hooksPathValue}\` ` +
        "(husky / lefthook / a custom hooks dir), so Cairn did **not** override " +
        "it — your existing hooks stay intact.",
      "",
      "Cairn still runs via SessionStart + MCP and ground state is loaded; only " +
        "the **local pre-commit sensor sweep** is inactive. To enable it, chain " +
        "Cairn's hooks (run `<cairn-home>/git-hooks/<hook>` from your existing " +
        "hook), or clear `core.hooksPath` and re-run join.",
    ].join("\n");
  }

  const result = runJoin({ repoRoot });
  if (result.bootstrapped) {
    const lines: string[] = [];
    lines.push("## Cairn — first session on this clone");
    lines.push("");
    lines.push(
      "`cairn join` just finished on this clone (per-clone hooks now " +
        "wired). Cairn ground state from `.cairn/` is loaded for this " +
        "session — see the `Cairn ground state` summary below for the " +
        "decision + invariant counts in scope.",
    );
    lines.push("");
    lines.push(
      "**On the operator's first reply this session, briefly acknowledge " +
        "Cairn is active.** Even on a casual greeting, surface a one-line " +
        "summary like \"Cairn loaded — N decisions, M invariants in scope.\" " +
        "Then continue with the operator's actual ask.",
    );
    lines.push("");
    lines.push(
      "Subsequent sessions on this clone skip this banner; the silent " +
        "ground-state load is the normal idle path.",
    );
    return lines.join("\n");
  }

  const lines: string[] = [];
  lines.push("## Cairn — bootstrap failed");
  lines.push("");
  lines.push(
    "This clone is cairn-adopted but `cairn join` did not finish. " +
      "MCP write tools refuse and local commits skip attestation until " +
      "this resolves.",
  );
  lines.push("");
  for (const step of result.steps) {
    if (step.status === "error") {
      lines.push(`- **${step.step}** — ${step.detail}`);
    }
  }
  lines.push("");
  lines.push(
    "Re-run manually: `node \"${CLAUDE_PLUGIN_ROOT}/dist/cli.mjs\" join`",
  );
  return lines.join("\n");
}

/**
 * Render a resume banner when SessionStart detects an active task
 * whose journal has entries from a different session. The fresh
 * session is picking up cold after a `/clear` — the banner is a
 * directive primer that tells the model to (a) treat this task as
 * the focus instead of presenting a "next task" picker, and (b)
 * auto-invoke `cairn_resume` + Read the recently-touched files so
 * the first Edit doesn't trip Claude Code's per-session Read tracker.
 *
 * Returns null when no resume condition is met (no active task, no
 * journal, all entries from the current session, or the journal is
 * empty).
 */
function renderResumeBanner(
  repoRoot: string,
  sessionId: string,
): string | null {
  const taskId = findCurrentActiveTask(repoRoot);
  if (taskId === null) return null;
  const journal = readTaskJournal(repoRoot, taskId, "active");
  if (journal.length === 0) return null;

  // Resume only when at least one entry came from a DIFFERENT session.
  // Same-session journal entries indicate continued work in-flight, not
  // a cold-resume condition.
  const fromOtherSession = journal.some(
    (e) => e.session_id !== null && e.session_id !== sessionId,
  );
  if (!fromOtherSession) return null;

  const lastEntry = journal[journal.length - 1];
  if (lastEntry === undefined) return null;
  const recent = journal.slice(-5);

  // Dedup files_touched across recent entries, most-recent first.
  const seenFiles = new Set<string>();
  const filesTouched: string[] = [];
  for (let i = recent.length - 1; i >= 0; i -= 1) {
    const entry = recent[i];
    const ft = entry?.files_touched;
    if (!Array.isArray(ft)) continue;
    for (const f of ft) {
      if (typeof f !== "string" || f.length === 0) continue;
      if (seenFiles.has(f)) continue;
      seenFiles.add(f);
      filesTouched.push(f);
    }
  }

  const lines: string[] = [];
  lines.push(`## Cairn — resuming \`${taskId}\` cold (active task — DO NOT show next-task picker)`);
  lines.push("");
  lines.push(
    `An active task has journal entries from a prior session. **${taskId}** is the focus of this session.`,
  );
  lines.push("");
  lines.push("**Recent journal:**");
  for (const e of recent) {
    lines.push(`- ${e.summary}`);
  }
  lines.push("");
  if (lastEntry.next_step !== undefined && lastEntry.next_step.length > 0) {
    lines.push(`**Next step:** ${lastEntry.next_step}`);
    lines.push("");
  }
  lines.push("**Auto-resume primer — on your first turn this session, run BEFORE answering the operator:**");
  lines.push("");
  lines.push(
    "1. `ToolSearch(select:mcp__plugin_cairn_cairn__cairn_resume,mcp__plugin_cairn_cairn__cairn_in_scope,mcp__plugin_cairn_cairn__cairn_task_journal_append,mcp__plugin_cairn_cairn__cairn_task_complete)`",
  );
  lines.push(
    `2. \`cairn_resume({ task_id: "${taskId}" })\` — pulls the spec, goal, in-scope DECs/INVs, full journal tail, and the \`files_touched\` union.`,
  );
  if (filesTouched.length > 0) {
    const cap = filesTouched.slice(0, 8);
    const moreNote =
      filesTouched.length > cap.length
        ? ` …(${filesTouched.length - cap.length} more in \`cairn_resume.files_touched\`)`
        : "";
    lines.push(
      `3. \`Read\` each recently-touched file so the first Edit doesn't trip the per-session Read tracker:`,
    );
    for (const f of cap) lines.push(`   - \`${f}\``);
    if (moreNote.length > 0) lines.push(`   -${moreNote}`);
  } else {
    lines.push(
      "3. `Read` `.cairn/tasks/active/<task_id>/spec.tightened.md` for the constraint set.",
    );
  }
  lines.push("");
  lines.push(
    "If the operator's first message is a continuation (`continue`, `go`, `next`, `keep going`), do NOT ask which task — pick up directly from the **Next step** above. If their message is a different ask, run the Step 0.5 pivot detection in `cairn-direction`.",
  );
  return lines.join("\n");
}

/**
 * Render a "resume cairn-adopt" banner when `.cairn/init-state.json`
 * exists. Phase 4-seed writes `.cairn/config.yaml` early, so
 * `resolveRepoRoot` matches mid-adoption repos as fully-adopted —
 * without this banner the operator sees the normal session-start
 * surface and the adoption loop never restarts. The banner directs
 * the agent to invoke the cairn-adopt skill, whose trigger gate
 * detects `init-state.json` and resumes via `cairn_init_resume`
 * instead of re-running consent.
 */
function renderMidAdoptionBanner(repoRoot: string): string | null {
  const initStatePath = cairnDir(repoRoot, "init-state.json");
  if (!existsSync(initStatePath)) return null;
  let phaseLabel = "an in-progress phase";
  try {
    const raw = readFileSync(initStatePath, "utf8");
    const parsed = JSON.parse(raw) as { currentPhase?: unknown };
    if (typeof parsed.currentPhase === "string" && parsed.currentPhase.length > 0) {
      phaseLabel = `\`${parsed.currentPhase}\``;
    }
  } catch {
    // Unparseable init-state.json — keep the generic label and still
    // surface the banner. The skill probe handles parse failure too.
  }
  return [
    "## Cairn — adoption mid-stream",
    "",
    `Adoption was started but never finished — the loop is paused at ${phaseLabel}.`,
    "",
    "**On the operator's first reply this session — even a casual greeting —",
    "immediately invoke `Skill(cairn:cairn-adopt)`. The skill's trigger gate",
    "detects the in-progress state and resumes via `cairn_init_resume` without",
    "re-asking consent. Do NOT pre-ask inline.**",
  ].join("\n");
}

/**
 * Render a one-line surface when migrations changed `.cairn/` on session
 * open, or when `review`-class migrations are waiting. Returns null when
 * nothing applied and nothing is pending (the silent steady state).
 *
 * `.cairn/` is usually committed, so an auto-applied migration produces a
 * working-tree diff — the banner tells the operator to commit it with their
 * normal flow (Cairn never auto-commits).
 */
function renderMigrationBanner(result: RunMigrationsResult): string | null {
  const applied = result.outcomes.filter((o) => o.status === "applied");
  if (applied.length === 0 && result.pendingReview.length === 0 && result.newPin === null) {
    return null;
  }
  const lines: string[] = [];
  lines.push("## Cairn — migrations");
  lines.push("");
  if (applied.length > 0) {
    lines.push(
      `Auto-applied ${applied.length} safe migration(s) to \`.cairn/\` on session open:`,
    );
    for (const o of applied) lines.push(`- \`${o.id}\` — ${o.detail}`);
    lines.push("");
    lines.push(
      "These changed committed `.cairn/` state — review the diff and commit it with your normal flow (Cairn does not auto-commit).",
    );
    lines.push("");
  }
  if (result.newPin !== null) {
    lines.push(`Pin advanced to \`${result.newPin}\`.`);
    lines.push("");
  }
  if (result.pendingReview.length > 0) {
    const describeById = new Map(MIGRATIONS.map((m) => [m.id, m.describe]));
    lines.push(
      `${result.pendingReview.length} review migration(s) are pending — they rewrite or hard-delete committed \`.cairn/\` state, so Cairn does not auto-apply them:`,
    );
    for (const id of result.pendingReview) {
      lines.push(`- \`${id}\` — ${describeById.get(id) ?? "(see migration registry)"}`);
    }
    lines.push("");
    lines.push(
      "**Action:** summarize what these do for the operator, then — once they confirm — apply them in this session by calling the `cairn_migrate` MCP tool (use `dry_run: true` first to preview). Do not just tell the operator to run a CLI command; clear the queue inline.",
    );
  }
  return lines.join("\n").trimEnd();
}

/**
 * Render a banner exposing shim-write failures so the operator sees
 * the real cause when `/cairn:cairn-statusline-setup` later complains the
 * shim is missing. Empty array → null (no surface).
 */
function renderShimWarningsBanner(warnings: string[]): string | null {
  const lines = warnings.filter((w) => w.startsWith("statusline_shim"));
  if (lines.length === 0) return null;
  const out: string[] = [];
  out.push("## Cairn — statusline shim issue");
  out.push("");
  out.push(
    "The plugin's SessionStart hook tried to write the statusline shim and reported:",
  );
  out.push("");
  for (const w of lines) out.push(`- \`${w}\``);
  out.push("");
  out.push(
    "If `/cairn:cairn-statusline-setup` later says the shim is missing, this is the cause. Common fixes: confirm the plugin is enabled (`/plugin status`), check `CLAUDE_PLUGIN_ROOT` resolves, or rebuild the plugin bundle.",
  );
  return out.join("\n");
}

/**
 * Detect a legacy cairn statusline launcher in user-level settings.
 *
 * The launcher lives in `~/.claude/settings.json` (machine-global, not repo
 * state — a migration can't reach it), and `/cairn:cairn-statusline-setup`
 * is "one-time per machine", so a launcher written by an older Cairn never
 * gets rewritten. The first-generation form was a shell pipe —
 * `bash -c '… ls …/.active-version-path … | head -1 … node "$(cat "$shim")" status-line'`
 * — which has no fallback (goes blank the moment the pointed-to version dir
 * is GC'd) and can `head -1` its way into another plugin's bundle. The
 * current form is a shell-free Node `-e` launcher with shim + glob fallback.
 *
 * We fingerprint the OLD form specifically: the cairn-only
 * `.active-version-path` marker AND a `bash`/shell invocation. The Node
 * launcher carries the marker too but never shells out, so it reads as
 * current. Anything we can't parse → not stale (never nag on a launcher we
 * don't recognize).
 */
function detectStaleStatuslineLauncher(): boolean {
  const settingsPath = join(homedir(), ".claude", "settings.json");
  if (!existsSync(settingsPath)) return false;
  let cmd: string;
  try {
    const parsed: unknown = JSON.parse(readFileSync(settingsPath, "utf8"));
    if (parsed === null || typeof parsed !== "object") return false;
    const sl = (parsed as Record<string, unknown>)["statusLine"];
    if (sl === null || typeof sl !== "object") return false;
    const c = (sl as Record<string, unknown>)["command"];
    if (typeof c !== "string") return false;
    cmd = c;
  } catch {
    return false;
  }
  const isCairnLauncher = cmd.includes(".active-version-path");
  const isShellForm = /\bbash\b|\bsh -c\b|\| *head\b/.test(cmd);
  return isCairnLauncher && isShellForm;
}

/**
 * Agent-actionable banner when the user-level statusline launcher is the
 * legacy shell form. Returns null when the launcher is current/absent.
 */
function renderStaleStatuslineBanner(): string | null {
  if (!detectStaleStatuslineLauncher()) return null;
  return [
    "## Cairn — statusline launcher is outdated",
    "",
    "Your user-level `~/.claude/settings.json` runs the legacy shell-pipe statusline launcher. It has no fallback — the badge goes blank once the plugin version dir it points at rotates — and the `head -1` glob can spawn an unrelated plugin's bundle.",
    "",
    "**Action:** offer to re-run `/cairn:cairn-statusline-setup`, which rewrites the launcher to the current shell-free Node form (shim + glob fallback, self-healing, Windows-safe). One-time; no repo changes.",
  ].join("\n");
}

function looksLikeProjectRoot(dir: string): boolean {
  return (
    existsSync(join(dir, "package.json")) ||
    existsSync(join(dir, "requirements.txt")) ||
    existsSync(join(dir, "Cargo.toml")) ||
    existsSync(join(dir, "go.mod")) ||
    existsSync(join(dir, "mix.exs")) ||
    existsSync(join(dir, ".git"))
  );
}

function findAdoptableChildren(dir: string): string[] {
  try {
    const entries = readdirSync(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .filter((e) => looksLikeProjectRoot(join(dir, e.name)))
      .filter((e) => !existsSync(join(dir, e.name, ".cairn")))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

function renderAdoptionBanner(cwd: string): string {
  if (looksLikeProjectRoot(cwd)) {
    return [
      "Cairn adoption suggested for this project root.",
      "",
      "**On the operator's first reply this session — even a casual greeting —",
      "immediately invoke `Skill(cairn:cairn-adopt)` before responding to anything",
      "else. Do NOT wait for the operator to ask explicitly. The adoption wizard",
      "handles the consent gate (yes / not now / never); do not pre-ask inline.**",
    ].join("\n");
  }
  const children = findAdoptableChildren(cwd);
  if (children.length === 0) return "";
  const lines: string[] = [];
  if (children.length === 1) {
    lines.push(
      `The subdirectory \`${children[0]}/\` looks like a project root, ` +
        "and it has no `.cairn/`. Cairn can adopt it once the operator `cd`s in.",
    );
    lines.push("");
    lines.push("Suggested first reply (edit if the operator prefers a different surface):");
    lines.push("");
    lines.push(
      `> Cairn can adopt \`${children[0]}/\`. \`cd\` in and reopen Claude Code, ` +
        "or stay here for read-only access.",
    );
  } else {
    lines.push(
      `The current dir isn't a project root, but ${children.length} ` +
        "immediate subdirs look adoptable:",
    );
    lines.push("");
    for (const c of children) {
      lines.push(`- \`${c}/\``);
    }
    lines.push("");
    lines.push("Suggest the operator `cd` into one of them to adopt.");
  }
  lines.push("");
  lines.push(
    "Do NOT auto-invoke `cairn-adopt` from this surface — the skill " +
      "operates on `cwd`, not subdirs. Surface the suggestion in chat " +
      "and let the operator change directory.",
  );
  return lines.join("\n");
}

