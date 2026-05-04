/**
 * `Stop` hook runner — fires when the assistant turn ends.
 *
 * Step 4 scope (this implementation):
 *   • Drain `.harness/events/` since the per-session marker; stamp the
 *     poll cursor so the next Stop only sees newer events.
 *   • Patch the per-session status.json `updated_at` (heartbeat).
 *   • Emit empty additionalContext — surface text comes from the
 *     harness-attention skill once it lands (step 5).
 *
 * Future scope (steps 5–8 per PLUGIN_ARCHITECTURE §10):
 *   • Run sensors on staged + unstaged diff; surface findings inline.
 *   • Filter drained events to in-scope DEC/§V; surface refresh prompt.
 *   • Spawn reviewer subagent for tasks created this session without
 *     attestation.yaml.
 *   • Compare HEAD's last 5 commits against `.attested-commits` marker;
 *     surface backfill prompt for `--no-verify` bypasses.
 */

import {
  eventsSince,
  type InvalidationEvent,
} from "../../events/index.js";
import { resolveRepoRoot } from "../../session-start/index.js";
import {
  readEventsMarker,
  stampEventsPoll,
} from "../../session/index.js";
import { writeStatusJson } from "../../status-line/index.js";
import {
  emitShapeB,
  parseHookPayload,
  readHookStdin,
  recordHookTelemetry,
} from "./payload.js";

interface StopShapeBOutput {
  continue: boolean;
  hookSpecificOutput: {
    hookEventName: "Stop";
    additionalContext: string;
  };
}

export async function runStopHook(): Promise<void> {
  const startedAt = Date.now();
  const raw = await readHookStdin();
  const payload = parseHookPayload(raw);
  const sessionId = typeof payload.session_id === "string" ? payload.session_id : null;
  const cwdInput = typeof payload.cwd === "string" ? payload.cwd : process.cwd();
  const repoRoot = resolveRepoRoot(cwdInput);
  const warnings: string[] = [];

  let drained: InvalidationEvent[] = [];
  if (repoRoot !== null && sessionId !== null && sessionId.length > 0) {
    try {
      const marker = readEventsMarker(repoRoot, sessionId);
      const since = marker?.last_polled_ts ?? Date.now() - 60_000;
      const result = eventsSince({ repoRoot, sinceMs: since });
      drained = result.events;
      if (result.malformed.length > 0) {
        warnings.push(`malformed_events:${result.malformed.length}`);
      }
      stampEventsPoll({ repoRoot, sessionId, ts: Date.now() });
    } catch (err) {
      warnings.push(
        `events_poll_failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    try {
      writeStatusJson(repoRoot, sessionId, {
        updated_at: new Date().toISOString(),
      });
    } catch (err) {
      warnings.push(
        `status_heartbeat_failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Step 4: empty additionalContext. Future steps surface drained
  // events via the harness-attention skill rather than inline text.
  const out: StopShapeBOutput = {
    continue: true,
    hookSpecificOutput: {
      hookEventName: "Stop",
      additionalContext: "",
    },
  };
  emitShapeB(out);

  recordHookTelemetry({
    hook: "stop",
    repoRoot,
    sessionId,
    source: null,
    durationMs: Date.now() - startedAt,
    warnings,
    extra: { events_drained: drained.length },
  });
}
