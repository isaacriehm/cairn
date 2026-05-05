/**
 * `SessionStart` hook runner — composes the additionalContext payload
 * Claude Code injects on session open and seeds the per-session state
 * partition (status.json, events marker), then GCs stale sessions +
 * events.
 *
 * Spec: PLUGIN_ARCHITECTURE §7 + §10. Bin entrypoint at
 * `cairn-core/src/hooks/session-start.ts` calls into this runner.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { gcStaleEvents } from "../../events/index.js";
import { inspectJoinState } from "../../join/index.js";
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
 * Maintain the shim file the cairn-statusline-setup skill relies on —
 * a single line containing the absolute path to the active bundle's
 * `dist/cli.mjs`. The user's `~/.claude/settings.json` statusLine
 * command reads this path so plugin upgrades (which change
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

  const isResume = source === "resume";
  const buildArgs: Parameters<typeof buildSessionStartContext>[0] = { repoRoot };
  if (isResume) buildArgs.maxChars = 4_000;
  if (source !== null) buildArgs.source = source;
  if (cwdInput !== repoRoot && cwdInput.startsWith(repoRoot)) {
    buildArgs.scopeRelPath = cwdInput.slice(repoRoot.length + 1);
  }
  const result = await buildSessionStartContext(buildArgs);

  try {
    writeStatusJson(repoRoot, sessionId, {
      decisions_in_scope: result.counts.decisions,
      invariants_in_scope: result.counts.invariants,
      attention_count:
        result.counts.pendingDrafts +
        result.counts.baselineFindings +
        result.counts.driftFindings,
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
      ...(bootstrapBanner !== null ? ["bootstrap_required"] : []),
    ],
    extra: {
      sections_rendered: result.sectionsRendered,
      sections_dropped: result.sectionsDropped,
      total_chars: additionalContext.length,
    },
  });
}

/**
 * Per PLUGIN_ARCHITECTURE §17 Layer 4: when a clone is cairn-adopted
 * (`.cairn/config.yaml` present + `.git/` present) but `core.hooksPath`
 * is unset, the plugin enters degraded mode. The session opens — read
 * tools still work — but main Claude must surface the bootstrap prompt
 * inline before the operator engages with any cairn write surface. The
 * banner is the only contract: if the surrounding skill / agent does not
 * gate on it, the MCP write tools' BOOTSTRAP_REQUIRED envelope is the
 * server-side backstop.
 */
function renderBootstrapBanner(repoRoot: string): string | null {
  if (!existsSync(join(repoRoot, ".git"))) return null;
  if (!existsSync(join(repoRoot, ".cairn", "config.yaml"))) return null;
  const state = inspectJoinState({ repoRoot });
  if (state.hooksPathSet) return null;
  const lines: string[] = [];
  lines.push("## Cairn — bootstrap required");
  lines.push("");
  lines.push(
    "This project is cairn-adopted, but this clone is not bootstrapped. " +
      "Without bootstrap, MCP write tools refuse, the cairn-direction " +
      "skill blocks, and local commits will fail at the pre-commit hook.",
  );
  lines.push("");
  lines.push(
    `Project pinned to cairn ${state.projectCairnVersion ?? "(unset)"}.`,
  );
  lines.push("");
  lines.push("Surface this inline by invoking the `cairn-bootstrap` skill —");
  lines.push("it owns the prompt + the spawn of the bundled join command.");
  lines.push("Do not embed the join command directly in chat output; the");
  lines.push("skill keeps the bundle path versioned with the plugin.");
  return lines.join("\n");
}

/**
 * Per PLUGIN_ARCHITECTURE §6: when the operator opens Claude Code in a
 * git repo with no `.cairn/` directory, the plugin proactively offers
 * adoption inline. SessionStart has no DOM to draw on — it injects the
 * instruction here as additionalContext so Claude reads it on the first
 * user message and surfaces the inline A/B/C prompt.
 *
 * Returns null when cwd is not a git repo (Claude Code launched outside
 * any project) — silent in that case.
 */
function renderAdoptionBanner(cwd: string): string | null {
  if (!existsSync(join(cwd, ".git"))) return null;
  // Operator opted-out previously — never re-prompt.
  if (existsSync(join(cwd, ".cairn-skip"))) return null;
  // Walk upward briefly to make sure no parent has .cairn/ either —
  // monorepo subdirectories should not re-prompt for adoption.
  let dir = cwd;
  for (let i = 0; i < 40; i++) {
    if (existsSync(join(dir, ".cairn"))) return null;
    if (existsSync(join(dir, ".cairn-skip"))) return null;
    const parent = join(dir, "..");
    if (parent === dir) break;
    dir = parent;
    if (!existsSync(join(dir, ".git"))) break;
  }

  const lines: string[] = [];
  lines.push("## Cairn — adoption available");
  lines.push("");
  lines.push(
    "This project is a git repo with no `.cairn/` directory. Cairn " +
      "is installed and can adopt it: a one-time visual pass that " +
      "ingests existing decisions, source-comment essays, and " +
      "`CLAUDE.md` / `AGENTS.md` rules into queryable ground state.",
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
