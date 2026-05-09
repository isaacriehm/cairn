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

import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import {
  writeDecisionsLedger,
  writeInvariantsLedger,
} from "@isaacriehm/cairn-state";
import {
  resolveRepoRoot,
  buildSessionStartContext,
} from "../../session-start/index.js";
import { inspectJoinState, runJoin } from "../../join/index.js";
import {
  resolveSessionId,
  ensureSessionDir,
  seedEventsMarker,
  gcStaleSessions,
} from "../../session/index.js";
import { writeStatusJson, defaultStatusJson } from "../../status-line/index.js";
import { gcStaleEvents } from "../../events/reader.js";
import { rescanScopeIndex } from "@isaacriehm/cairn-state";
import { readActiveTaskSummary } from "../../context/task-summary.js";

import { readDeferState } from "../defer.js";
import {
  readHookStdin,
  parseHookPayload,
  emitShapeB,
  appendTelemetry,
} from "./payload.js";
import { spawn } from "node:child_process";

/**
 * Sync the bundle entry point into the homedir shim so `cairn-lens`
 * (and any other external TUI tools) can find the CLI executable
 * regardless of where the plugin bundle is currently installed.
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
    const message = err instanceof Error ? err.message : String(err);
    warnings.push(
      `statusline_shim_failed: ${message}`,
    );
  }
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
    // looks like a project root, else stay silent.
    const banner = renderAdoptionBanner(cwdInput);
    emitShapeB(banner, "SessionStart");
    return;
  }

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
  try {
    const rescan = rescanScopeIndex(repoRoot);
    if (rescan.dirty) {
      sessionWarnings.push(
        `scope_rescan_dirty:added=${rescan.entriesAdded},updated=${rescan.entriesUpdated}`,
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sessionWarnings.push(
      `scope_rescan_failed: ${message}`,
    );
  }
  try {
    writeDecisionsLedger({ repoRoot });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sessionWarnings.push(
      `decisions_ledger_rebuild_failed: ${message}`,
    );
  }
  try {
    writeInvariantsLedger({ repoRoot });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    sessionWarnings.push(
      `invariants_ledger_rebuild_failed: ${message}`,
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
  const additionalContext =
    bootstrapBanner === null
      ? result.additionalContext
      : `${bootstrapBanner}\n\n${result.additionalContext}`;

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
  if (!existsSync(join(repoRoot, ".cairn", "config.yaml"))) return null;
  const state = inspectJoinState({ repoRoot });
  if (state.hooksPathSet) return null;

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
    return (
      "Cairn adoption suggested for this project root.\n" +
      "Run `/cairn-adopt` (or `cairn init`) to enable ground state tracking."
    );
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

