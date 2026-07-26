/**
 * `SessionEnd` hook runner — removes the per-session directory.
 *
 * Spec: PLUGIN_ARCHITECTURE §7. Best-effort; stale sessions GC'd at
 * the next SessionStart anyway.
 */

import { resolveRepoRoot } from "../../session-start/index.js";
import { cleanupSession } from "../../session/index.js";
import {
  emitContinue,
  parseHookPayload,
  readHookStdin,
  resolveHookCwd,
  appendTelemetry,
} from "./payload.js";
import {
  resolveAgentHost,
  type HookRunOptions,
} from "../hook-platform.js";

export async function runSessionEndHook(options: HookRunOptions = {}): Promise<void> {
  const startedAt = Date.now();
  const host = resolveAgentHost(options.host);
  const raw = await readHookStdin();
  const payload = parseHookPayload(raw);
  const sessionId = typeof payload.session_id === "string" ? payload.session_id : null;
  const cwdInput = resolveHookCwd(payload);
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

  if (host === "cursor") {
    process.stdout.write("{}");
    return;
  }
  emitContinue();
}
