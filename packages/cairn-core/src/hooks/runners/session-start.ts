/**
 * `SessionStart` hook runner — composes the additionalContext payload
 * Claude Code injects on session open and seeds the per-session state
 * partition (status.json, events marker), then GCs stale sessions +
 * events.
 *
 * Spec: PLUGIN_ARCHITECTURE §7 + §10. Bin entrypoint at
 * `cairn-core/src/hooks/session-start.ts` calls into this runner.
 */

import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readActiveTaskSummary } from "../../context/index.js";
import { gcStaleEvents } from "../../events/index.js";
import { writeDecisionsLedger, writeInvariantsLedger } from "../../ground/ledgers.js";
import { rescanScopeIndex } from "../../ground/scope-index.js";
import { scanBypassedCommits } from "../bypass-detection.js";
import { inspectJoinState, runJoin } from "../../join/index.js";
import { resolveRepoRoot } from "../../session-start/index.js";
import { buildSessionStartContext } from "../../session-start/index.js";
import {
  ensureSessionDir,
  gcStaleSessions,
  resolveSessionId,
  seedEventsMarker,
} from "../../session/index.js";
import { defaultStatusJson, writeStatusJson } from "../../status-line/index.js";
import {
  emitShapeB,
  parseHookPayload,
  readHookStdin,
  recordHookTelemetry,
} from "./payload.js";

/**
 * Maintain the shim file the `/cairn-statusline-setup` command relies
 * on — a single line containing the absolute path to the active
 * bundle's `dist/cli.mjs`. The user's `~/.claude/settings.json`
 * statusLine command reads this path so plugin upgrades (which change
 * CLAUDE_PLUGIN_ROOT's version segment) don't break the badge.
 *
 * No-op when the hook isn't running under the Claude Code plugin
 * (CLAUDE_PLUGIN_ROOT unset) — terminal `cairn hook session-start`
 * invocations don't touch user-level settings.
 */
function syncActiveVersionShim(warnings: string[]): void {
  const pluginRoot = process.env["CLAUDE_PLUGIN_ROOT"];
  if (typeof pluginRoot !== "string" || pluginRoot.length === 0) return;
  const bundlePath = join(pluginRoot, "dist", "cli.mjs");
  if (!existsSync(bundlePath)) {
    warnings.push(`statusline_shim_skipped: bundle missing at ${bundlePath}`);
    return;
  }
  const shimDir = join(homedir(), ".claude", "plugins", "cache", "isaacriehm-cairn");
  const shimPath = join(shimDir, ".active-version-path");
  try {
    mkdirSync(shimDir, { recursive: true });
    writeFileSync(shimPath, `${bundlePath}\n`, "utf8");
  } catch (err) {
    warnings.push(
      `statusline_shim_failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

interface SessionStartShapeBOutput {
  continue: boolean;
  hookSpecificOutput: {
    hookEventName: "SessionStart";
    additionalContext: string;
  };
}

export async function runSessionStartHook(): Promise<void> {
  const startedAt = Date.now();
  const raw = await readHookStdin();
  const payload = parseHookPayload(raw);
  const payloadSessionId = typeof payload.session_id === "string" ? payload.session_id : null;
  const source = typeof payload.source === "string" ? payload.source : null;
  const cwdInput = typeof payload.cwd === "string" ? payload.cwd : process.cwd();
  const repoRoot = resolveRepoRoot(cwdInput);
  const shimWarnings: string[] = [];
  syncActiveVersionShim(shimWarnings);

  if (repoRoot === null) {
    // No `.cairn/` found walking up from cwd. If cwd is itself a git
    // repo, this is an *unadopted* project — render the adoption banner
    // so Claude proactively offers `cairn-adopt`. Otherwise stay silent
    // (the operator launched Claude Code outside any project).
    const adoptionBanner = renderAdoptionBanner(cwdInput);
    const out: SessionStartShapeBOutput = {
      continue: true,
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: adoptionBanner ?? "",
      },
    };
    emitShapeB(out);
    recordHookTelemetry({
      hook: "session-start",
      repoRoot: null,
      sessionId: payloadSessionId,
      source,
      durationMs: Date.now() - startedAt,
      warnings: [
        ...(adoptionBanner !== null ? ["adoption_offered"] : ["no_cairn_dir_found"]),
        ...shimWarnings,
      ],
      extra: {
        sections_rendered: adoptionBanner !== null ? ["adoption_banner"] : [],
        sections_dropped: [],
        total_chars: adoptionBanner?.length ?? 0,
      },
    });
    return;
  }

  const sessionWarnings: string[] = [];
  const sessionId = resolveSessionId({ session_id: payloadSessionId ?? undefined });
  try {
    ensureSessionDir({ repoRoot, sessionId });
    writeStatusJson(repoRoot, sessionId, defaultStatusJson());
    seedEventsMarker({ repoRoot, sessionId });
  } catch (err) {
    sessionWarnings.push(
      `session_dir_init_failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  try {
    const gc = gcStaleSessions({ repoRoot });
    if (gc.removed.length > 0) sessionWarnings.push(`gc_removed:${gc.removed.length}`);
  } catch (err) {
    sessionWarnings.push(
      `session_gc_failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  try {
    const eventsGc = gcStaleEvents({ repoRoot });
    if (eventsGc.removed.length > 0) {
      sessionWarnings.push(`events_gc_removed:${eventsGc.removed.length}`);
    }
  } catch (err) {
    sessionWarnings.push(
      `events_gc_failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  // Deterministic scope-index sync — walk source files, regex for §INV/§DEC
  // tokens, fold into scope-index. No LLM. Cheap (~100ms on 50k files via
  // git ls-files). Keeps the in-scope tools accurate when an agent has
  // moved cite tokens between files since the last init / rebuild.
  try {
    const rescan = rescanScopeIndex(repoRoot);
    if (rescan.dirty) {
      sessionWarnings.push(
        `scope_rescan_dirty:added=${rescan.entriesAdded},updated=${rescan.entriesUpdated}`,
      );
    }
  } catch (err) {
    sessionWarnings.push(
      `scope_rescan_failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  // Defensive ledger rebuilds — operator may edit a DEC or INV .md file
  // out-of-band (text editor, git checkout of a different branch). The
  // ledger.yaml indices won't reflect that until the next accept/reject
  // landed via the MCP write path. Rebuild from on-disk frontmatter so
  // the in-scope tools never see a stale ledger. Pure JS, milliseconds.
  try {
    writeDecisionsLedger({ repoRoot });
  } catch (err) {
    sessionWarnings.push(
      `decisions_ledger_rebuild_failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  try {
    writeInvariantsLedger({ repoRoot });
  } catch (err) {
    sessionWarnings.push(
      `invariants_ledger_rebuild_failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const isResume = source === "resume";
  const buildArgs: Parameters<typeof buildSessionStartContext>[0] = { repoRoot };
  if (isResume) buildArgs.maxChars = 4_000;
  if (source !== null) buildArgs.source = source;
  if (cwdInput !== repoRoot && cwdInput.startsWith(repoRoot)) {
    buildArgs.scopeRelPath = cwdInput.slice(repoRoot.length + 1);
  }
  const result = await buildSessionStartContext(buildArgs);

  try {
    const active = readActiveTaskSummary(repoRoot);
    let bypassCount = 0;
    try {
      bypassCount = scanBypassedCommits(repoRoot).bypassed.length;
    } catch {
      bypassCount = 0;
    }
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
    sessionWarnings.push(
      `session_status_patch_failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  const bootstrapBanner = renderBootstrapBanner(repoRoot);
  const additionalContext =
    bootstrapBanner === null
      ? result.additionalContext
      : `${bootstrapBanner}\n\n${result.additionalContext}`;
  const out: SessionStartShapeBOutput = {
    continue: true,
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext,
    },
  };
  emitShapeB(out);

  recordHookTelemetry({
    hook: "session-start",
    repoRoot,
    sessionId,
    source,
    durationMs: Date.now() - startedAt,
    warnings: [
      ...result.warnings,
      ...sessionWarnings,
      ...shimWarnings,
      ...(bootstrapBanner !== null ? ["bootstrap_failed"] : []),
    ],
    extra: {
      sections_rendered: result.sectionsRendered,
      sections_dropped: result.sectionsDropped,
      total_chars: additionalContext.length,
      additional_context: additionalContext,
      ...(bootstrapBanner !== null ? { bootstrap_banner: bootstrapBanner } : {}),
    },
  });
}

/**
 * Per PLUGIN_ARCHITECTURE §17 Layer 4: when a clone is cairn-adopted
 * (`.cairn/config.yaml` present + `.git/` present) but `core.hooksPath`
 * is unset, run `cairn join` synchronously to wire the per-clone hooks.
 * Bootstrap is idempotent, local-clone-only state (git config + chmod +
 * gitignored sentinel files) — plugin install is implicit consent for
 * local config wiring, no operator prompt needed.
 *
 * Returns null on success (no banner needed) or when not in
 * bootstrap-required state. Returns a failure banner only when
 * `runJoin` errored — operator needs to know the write surface stayed
 * disabled.
 */
function renderBootstrapBanner(repoRoot: string): string | null {
  if (!existsSync(join(repoRoot, ".git"))) return null;
  if (!existsSync(join(repoRoot, ".cairn", "config.yaml"))) return null;
  const state = inspectJoinState({ repoRoot });
  if (state.hooksPathSet) return null;

  // Auto-run join. Idempotent — no harm if a parallel session beat us.
  const result = runJoin({ repoRoot });
  if (result.bootstrapped) return null;

  // Surface failure inline so operator knows the write surface is still
  // refused. Include each errored step's detail for diagnosis.
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
 * Per PLUGIN_ARCHITECTURE §6: when the operator opens Claude Code in a
 * project root with no `.cairn/` directory, the plugin proactively
 * offers adoption inline. SessionStart has no DOM to draw on — it
 * injects the instruction here as additionalContext so Claude reads it
 * on the first user message and surfaces the inline A/B/C prompt.
 *
 * Project-shape detection: cwd is a project if it has `.git/` OR any
 * common build manifest. The `cairn-adopt` skill's preflight handles
 * the no-git case (offers `git init`), so we don't need to gate on
 * `.git/` here. Returns null when cwd looks like a non-project dir
 * (e.g. `~/`, `/tmp/`) — silent in that case.
 */
const PROJECT_MARKERS = [
  ".git",
  "package.json",
  "pyproject.toml",
  "Cargo.toml",
  "go.mod",
  "Gemfile",
  "build.gradle",
  "build.gradle.kts",
  "pom.xml",
  "composer.json",
  "Package.swift",
  "deno.json",
  "bun.lockb",
];

function looksLikeProjectRoot(cwd: string): boolean {
  for (const marker of PROJECT_MARKERS) {
    if (existsSync(join(cwd, marker))) return true;
  }
  return false;
}

/**
 * Find direct child directories that look like project roots. When the
 * operator opens Claude Code in a parent dir (e.g. `~/projects/`)
 * that contains one or more adoptable projects in immediate subdirs,
 * we surface them so the operator can `cd` in. Caps at 8 children to
 * avoid spamming when launched in `~/` or similar.
 */
function findAdoptableChildren(cwd: string, max = 8): string[] {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(cwd, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith(".")) continue;
    const childPath = join(cwd, String(entry.name));
    if (!looksLikeProjectRoot(childPath)) continue;
    if (existsSync(join(childPath, ".cairn"))) continue; // already adopted
    if (existsSync(join(childPath, ".cairn-skip"))) continue;
    out.push(String(entry.name));
    if (out.length >= max) break;
  }
  return out;
}

function renderAdoptionBanner(cwd: string): string | null {
  if (existsSync(join(cwd, ".cairn-skip"))) return null;

  const cwdIsProject = looksLikeProjectRoot(cwd);

  if (cwdIsProject) {
    // Walk upward briefly to make sure no parent has .cairn/ either —
    // monorepo subdirectories should not re-prompt for adoption.
    let dir = cwd;
    for (let i = 0; i < 40; i++) {
      if (existsSync(join(dir, ".cairn"))) return null;
      if (existsSync(join(dir, ".cairn-skip"))) return null;
      const parent = join(dir, "..");
      if (parent === dir) break;
      dir = parent;
      if (!looksLikeProjectRoot(dir)) break;
    }

    const lines: string[] = [];
    lines.push("## Cairn — adoption available");
    lines.push("");
    lines.push(
      "This project has no `.cairn/` directory. Cairn is installed and " +
        "can adopt it: a one-time visual pass that ingests existing " +
        "decisions, source-comment essays, and `CLAUDE.md` / `AGENTS.md` " +
        "rules into queryable ground state.",
    );
    lines.push("");
    lines.push(
      "Invoke the `cairn-adopt` skill on the operator's first message — " +
        "even a casual greeting like \"hi\". The skill renders the " +
        "yes / not now / never prompt through `AskUserQuestion`; do not " +
        "duplicate the prompt as inline markdown.",
    );
    lines.push("");
    lines.push(
      "On `never for this project`, the skill writes a one-line " +
        "`.cairn-skip` file at the repo root so future sessions don't " +
        "re-prompt.",
    );
    lines.push("");
    lines.push(
      "If the operator asks what cairn does, summarize: persistent " +
        "ground state for AI agents — decisions, invariants, canonical " +
        "map, sensors. Stops re-debating settled choices across sessions.",
    );
    return lines.join("\n");
  }

  // cwd isn't itself a project — scan one level down for adoptable
  // children (e.g. operator opened Claude Code in `~/projects/parent/`
  // containing one or more child project directories).
  const children = findAdoptableChildren(cwd);
  if (children.length === 0) return null;

  const lines: string[] = [];
  lines.push("## Cairn — adoptable project in subdir");
  lines.push("");
  if (children.length === 1) {
    lines.push(
      `The current dir isn't a project root, but \`${children[0]}/\` is — ` +
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
