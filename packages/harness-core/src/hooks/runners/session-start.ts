/**
 * `SessionStart` hook runner — composes the additionalContext payload
 * Claude Code injects on session open and seeds the per-session state
 * partition (status.json, events marker), then GCs stale sessions +
 * events.
 *
 * Spec: PLUGIN_ARCHITECTURE §7 + §10. Bin entrypoint at
 * `harness-core/src/hooks/session-start.ts` calls into this runner.
 */

import { existsSync } from "node:fs";
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

  if (repoRoot === null) {
    const out: SessionStartShapeBOutput = {
      continue: true,
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: "",
      },
    };
    emitShapeB(out);
    recordHookTelemetry({
      hook: "session-start",
      repoRoot: null,
      sessionId: payloadSessionId,
      source,
      durationMs: Date.now() - startedAt,
      warnings: ["no_harness_dir_found"],
      extra: {
        sections_rendered: [],
        sections_dropped: [],
        total_chars: 0,
      },
    });
    return;
  }

  const sessionWarnings: string[] = [];
  const sessionId = resolveSessionId({ session_id: payloadSessionId ?? undefined });
  try {
    ensureSessionDir({ repoRoot, sessionId });
    writeStatusJson(repoRoot, sessionId, defaultStatusJson(true));
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
      attention_count: result.counts.pendingDrafts,
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
 * Per PLUGIN_ARCHITECTURE §17 Layer 4: when a clone is harness-adopted
 * (`.harness/config.yaml` present + `.git/` present) but `core.hooksPath`
 * is unset, the plugin enters degraded mode. The session opens — read
 * tools still work — but main Claude must surface the bootstrap prompt
 * inline before the operator engages with any harness write surface. The
 * banner is the only contract: if the surrounding skill / agent does not
 * gate on it, the MCP write tools' BOOTSTRAP_REQUIRED envelope is the
 * server-side backstop.
 */
function renderBootstrapBanner(repoRoot: string): string | null {
  if (!existsSync(join(repoRoot, ".git"))) return null;
  if (!existsSync(join(repoRoot, ".harness", "config.yaml"))) return null;
  const state = inspectJoinState({ repoRoot });
  if (state.hooksPathSet) return null;
  const lines: string[] = [];
  lines.push("## Harness — bootstrap required");
  lines.push("");
  lines.push(
    "This project is harness-adopted, but this clone is not bootstrapped. " +
      "Without `harness join`, MCP write tools refuse, the harness-direction " +
      "skill blocks, and your local commits will fail at the pre-commit hook.",
  );
  lines.push("");
  lines.push(
    `Project pinned to harness ${state.projectHarnessVersion ?? "(unset)"}.`,
  );
  lines.push("");
  lines.push("Surface this inline to the operator now:");
  lines.push("");
  lines.push("> This project uses harness, but your clone isn't bootstrapped.");
  lines.push("> `[a]` bootstrap now (run `harness join`, ~5s)");
  lines.push("> `[b]` skip (harness write surface stays disabled)");
  lines.push("");
  lines.push(
    "On `[a]`, run `harness join` from this repo's working directory and " +
      "wait for it to print `harness join: bootstrapped`. The next assistant " +
      "turn will pick up the unblocked surface.",
  );
  return lines.join("\n");
}
