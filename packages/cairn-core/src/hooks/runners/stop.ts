/**
 * `Stop` hook runner — fires when the assistant turn ends.
 *
 * Current scope:
 *   • Drain `.cairn/events/` since the per-session marker; stamp the
 *     poll cursor so the next Stop only sees newer events.
 *   • Scan `.cairn/tasks/active/<id>/` for tasks that have a
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
import { isDeferActive, readDeferState } from "../defer.js";
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

/** Init in progress means `.cairn/init-state.json` exists at repoRoot. */
function isInitInProgress(repoRoot: string): boolean {
  return existsSync(join(repoRoot, ".cairn", "init-state.json"));
}

interface StopShapeBOutput {
  continue: boolean;
  systemMessage?: string;
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

    const now = new Date();
    // Suppress reviewer + bypass surfaces while init is mid-flight —
    // `.cairn/.attested-commits` may not yet be seeded, and the
    // adoption skill owns the operator's attention until phase 12
    // returns nextPhase=null. The MCP init-phases tool clears the
    // state file as soon as the final phase completes, after which
    // the next Stop tick scans normally.
    const initInProgress = isInitInProgress(repoRoot);
    if (initInProgress) {
      warnings.push("init_in_progress:scans_suppressed");
    }

    if (!initInProgress) {
      try {
        pendingReviews = scanPendingReviews(repoRoot);
        if (pendingReviews.length > 0) {
          const reviewDefer = readDeferState(repoRoot, "review");
          const suppressed =
            reviewDefer !== null &&
            isDeferActive(reviewDefer, now, {
              kind: "task_ids",
              values: pendingReviews.map((p) => p.task_id),
            });
          if (suppressed) {
            warnings.push(`review_suppressed_until:${reviewDefer.deferred_at}`);
          } else {
            additionalContext = renderReviewerHint(pendingReviews);
          }
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
          const bypassDefer = readDeferState(repoRoot, "bypass");
          const suppressed =
            bypassDefer !== null &&
            isDeferActive(bypassDefer, now, {
              kind: "shas",
              values: bypassed.map((b) => b.sha),
            });
          if (suppressed) {
            warnings.push(`bypass_suppressed_until:${bypassDefer.deferred_at}`);
          } else {
            const hint = renderBypassHint(bypassed);
            additionalContext =
              additionalContext.length > 0
                ? `${additionalContext}\n\n${hint}`
                : hint;
          }
        }
      } catch (err) {
        warnings.push(
          `bypass_scan_failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
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

  // Claude Code's Stop hook schema rejects hookSpecificOutput. Surface
  // text via the top-level systemMessage field; empty payload is fine.
  const out: StopShapeBOutput = { continue: true };
  if (additionalContext.length > 0) out.systemMessage = additionalContext;
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
 * Scan `.cairn/tasks/active/<id>/` for tasks that have a tightened
 * spec but no `attestation.yaml`. Per PLUGIN_ARCHITECTURE §10, the
 * Stop hook spawns the reviewer subagent for those.
 *
 * Window: only tasks whose spec has been touched in the last 6 hours.
 * Older orphans are stale; the operator deals with them via attention
 * rather than spawning reviewers blindly.
 */
function scanPendingReviews(repoRoot: string): PendingReview[] {
  const activeDir = join(repoRoot, ".cairn", "tasks", "active");
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
      spec_path: `.cairn/tasks/active/${taskId}/spec.tightened.md`,
    });
  }
  return out;
}

function renderReviewerHint(pending: PendingReview[]): string {
  const lines: string[] = [];
  const noun = pending.length === 1 ? "task" : "tasks";
  lines.push(
    `**Cairn — ${pending.length} ${noun} awaiting reviewer attestation.**`,
  );
  lines.push("");
  for (const p of pending) {
    lines.push(`- \`${p.task_id}\``);
  }
  lines.push("");
  lines.push(
    "`[a]` spawn reviewer · `[b]` skip · `[c]` defer 24h",
  );
  return lines.join("\n");
}
