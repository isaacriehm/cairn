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

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { homedir } from "node:os";
import {
  writeDecisionsLedger,
  writeInvariantsLedger,
  buildDecisionsLedger,
  buildInvariantsLedger,
  matchAnyGlob,
} from "@isaacriehm/cairn-state";
import {
  resolveRepoRoot,
} from "../../session-start/index.js";
import {
  resolveSessionId,
  ensureSessionDir,
  seedEventsMarker,
  gcStaleSessions,
} from "../../session/index.js";
import { writeStatusJson, defaultStatusJson } from "../../status-line/index.js";
import { gcStaleEvents } from "../../events/reader.js";
import { rescanScopeIndex } from "@isaacriehm/cairn-state";
import { buildHandoffBlock } from "../../context/handoff-builder.js";
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
    emitShapeB(banner);
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
  const buildArgs = { repoRoot };
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
    bootstrapBanner + (isResume ? result.resumePayload : result.openPayload);

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

  emitShapeB(additionalContext);
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

async function buildSessionStartContext(args: { repoRoot: string }): Promise<{
  openPayload: string;
  resumePayload: string;
  counts: {
    decisions: number;
    invariants: number;
    pendingDrafts: number;
    baselineFindings: number;
    driftFindings: number;
  };
}> {
  const decs = buildDecisionsLedger({ repoRoot: args.repoRoot });
  const invs = buildInvariantsLedger({ repoRoot: args.repoRoot });
  const handoff = await buildHandoffBlock(args.repoRoot);

  return {
    openPayload: "Session started.",
    resumePayload: handoff ?? "Session resumed.",
    counts: {
      decisions: decs.length,
      invariants: invs.length,
      pendingDrafts: 0,
      baselineFindings: 0,
      driftFindings: 0,
    },
  };
}

function renderBootstrapBanner(repoRoot: string): string {
  const bannerPath = join(repoRoot, ".cairn", "config", "banner.md");
  if (existsSync(bannerPath)) {
    try {
      return readFileSync(bannerPath, "utf8") + "\n\n";
    } catch {
      return "";
    }
  }
  return "";
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

