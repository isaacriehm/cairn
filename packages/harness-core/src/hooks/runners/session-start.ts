/**
 * `SessionStart` hook runner — composes the additionalContext payload
 * Claude Code injects on session open and seeds the per-session state
 * partition (status.json, events marker), then GCs stale sessions +
 * events.
 *
 * Spec: PLUGIN_ARCHITECTURE §7 + §10. Bin entrypoint at
 * `harness-core/src/hooks/session-start.ts` calls into this runner.
 */

import { gcStaleEvents } from "../../events/index.js";
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

  const out: SessionStartShapeBOutput = {
    continue: true,
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: result.additionalContext,
    },
  };
  emitShapeB(out);

  recordHookTelemetry({
    hook: "session-start",
    repoRoot,
    sessionId,
    source,
    durationMs: Date.now() - startedAt,
    warnings: [...result.warnings, ...sessionWarnings],
    extra: {
      sections_rendered: result.sectionsRendered,
      sections_dropped: result.sectionsDropped,
      total_chars: result.totalChars,
    },
  });
}
