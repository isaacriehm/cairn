/**
 * `SessionEnd` hook runner — removes the per-session directory.
 *
 * Spec: PLUGIN_ARCHITECTURE §7. Best-effort; stale sessions GC'd at
 * the next SessionStart anyway.
 */

import { resolveRepoRoot } from "../../session-start/index.js";
import { cleanupSession } from "../../session/index.js";
import {
  emitShapeB,
  parseHookPayload,
  readHookStdin,
  appendTelemetry,
} from "./payload.js";

interface SessionEndShapeBOutput {
  continue: boolean;
}

export async function runSessionEndHook(): Promise<void> {
  const startedAt = Date.now();
  const raw = await readHookStdin();
  const payload = parseHookPayload(raw);
  const sessionId = typeof payload.session_id === "string" ? payload.session_id : null;
  const cwdInput = typeof payload.cwd === "string" ? payload.cwd : process.cwd();
  const repoRoot = resolveRepoRoot(cwdInput);

  let removed = false;
  const warnings: string[] = [];
  if (repoRoot !== null && sessionId !== null && sessionId.length > 0) {
    try {
      removed = cleanupSession(repoRoot, sessionId);
    } catch (err) {
      warnings.push(
        `cleanup_failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    appendTelemetry({
      repoRoot: repoRoot as string,
      sessionId,
      kind: "session-end",
      durationMs: Date.now() - startedAt,
      source: null,
      warnings,
      extra: { removed },
    });
  }

  const out: SessionEndShapeBOutput = { continue: true };
  emitShapeB("");
}
