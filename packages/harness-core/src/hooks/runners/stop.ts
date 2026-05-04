/**
 * `Stop` hook runner — fires when the assistant turn ends.
 *
 * Current scope:
 *   • Drain `.harness/events/` since the per-session marker; stamp the
 *     poll cursor so the next Stop only sees newer events.
 *   • Scan `.harness/tasks/active/<id>/` for tasks that have a
 *     tightened spec but no `attestation.yaml`; surface a reviewer-
 *     spawn hint in additionalContext so main Claude can spawn the
 *     reviewer subagent on the next assistant turn.
 *   • Patch the per-session status.json `updated_at` (heartbeat).
 *
 * Future scope (steps 7–8 per PLUGIN_ARCHITECTURE §10):
 *   • Run sensors on staged + unstaged diff; surface findings inline.
 *   • Compare HEAD's last 5 commits against `.attested-commits` marker;
 *     surface backfill prompt for `--no-verify` bypasses.
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  eventsSince,
  type InvalidationEvent,
} from "../../events/index.js";
import {
  renderBypassHint,
  scanBypassedCommits,
  type BypassedCommit,
} from "../bypass-detection.js";
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

interface PendingReview {
  task_id: string;
  spec_path: string;
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
  let pendingReviews: PendingReview[] = [];
  let bypassed: BypassedCommit[] = [];
  let additionalContext = "";

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
      pendingReviews = scanPendingReviews(repoRoot);
      if (pendingReviews.length > 0) {
        additionalContext = renderReviewerHint(pendingReviews);
      }
    } catch (err) {
      warnings.push(
        `pending_review_scan_failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    try {
      const bypassResult = scanBypassedCommits(repoRoot);
      bypassed = bypassResult.bypassed;
      if (bypassed.length > 0) {
        const hint = renderBypassHint(bypassed);
        additionalContext = additionalContext.length > 0
          ? `${additionalContext}\n\n${hint}`
          : hint;
      }
    } catch (err) {
      warnings.push(
        `bypass_scan_failed: ${err instanceof Error ? err.message : String(err)}`,
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

  const out: StopShapeBOutput = {
    continue: true,
    hookSpecificOutput: {
      hookEventName: "Stop",
      additionalContext,
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
    extra: {
      events_drained: drained.length,
      pending_reviews: pendingReviews.length,
      bypassed_commits: bypassed.length,
    },
  });
}

/**
 * Scan `.harness/tasks/active/<id>/` for tasks that have a tightened
 * spec but no `attestation.yaml`. Per PLUGIN_ARCHITECTURE §10, the
 * Stop hook spawns the reviewer subagent for those.
 *
 * Window: only tasks whose spec has been touched in the last 6 hours.
 * Older orphans are stale; the operator deals with them via attention
 * rather than spawning reviewers blindly.
 */
function scanPendingReviews(repoRoot: string): PendingReview[] {
  const activeDir = join(repoRoot, ".harness", "tasks", "active");
  if (!existsSync(activeDir)) return [];
  const out: PendingReview[] = [];
  const cutoffMs = Date.now() - 6 * 60 * 60 * 1000;
  let entries;
  try {
    entries = readdirSync(activeDir, { withFileTypes: true, encoding: "utf8" });
  } catch {
    return [];
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const taskId = entry.name;
    const taskDir = join(activeDir, taskId);
    const tightenedSpec = join(taskDir, "spec.tightened.md");
    if (!existsSync(tightenedSpec)) continue;
    const attestation = join(taskDir, "attestation.yaml");
    if (existsSync(attestation)) continue;
    let mtime = 0;
    try {
      mtime = statSync(tightenedSpec).mtimeMs;
    } catch {
      continue;
    }
    if (mtime < cutoffMs) continue;
    out.push({
      task_id: taskId,
      spec_path: `.harness/tasks/active/${taskId}/spec.tightened.md`,
    });
  }
  return out;
}

function renderReviewerHint(pending: PendingReview[]): string {
  const lines: string[] = [];
  lines.push(
    `## Reviewer pending (${pending.length} task${pending.length === 1 ? "" : "s"})`,
  );
  lines.push("");
  for (const p of pending) {
    lines.push(`- **${p.task_id}** — ${p.spec_path}`);
  }
  lines.push("");
  lines.push(
    "Spawn the `reviewer` subagent (defined at `agents/reviewer.md` in the harness plugin) via the Task tool to attest each pending task. The subagent reads the diff, collects subagent attestation files, extracts non-obvious DECs, and writes the consolidated `attestation.yaml`. Once written, this hook will stop surfacing the reminder.",
  );
  return lines.join("\n");
}
