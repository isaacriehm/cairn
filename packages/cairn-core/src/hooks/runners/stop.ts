/**
 * `Stop` hook runner — fires when the assistant turn ends.
 *
 * Per PLUGIN_ARCHITECTURE §10:
 *   • Drains `.cairn/events/` since the per-session marker.
 *   • Scans `.cairn/tasks/active/<id>/` for tasks missing attestation.yaml.
 *   • Compares HEAD's last 5 commits against `.cairn/.attested-commits`;
 *     surfaces bypass hint for `--no-verify` commits.
 *   • Patches per-session status.json `updated_at` (heartbeat).
 *
 * When context to surface: emits `{ decision: "block", reason: "..." }` so
 * Claude reads the hint and invokes cairn-attention on the next turn.
 * When nothing: emits `{ continue: true }` and Claude stops normally.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { readActiveTaskSummary } from "../../context/index.js";
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
  completeTask,
  findCurrentActiveTask,
  readTaskAttestationState,
  transitionTaskPhase,
} from "../../tasks/index.js";
import {
  effectivePhaseExitGate,
  findActiveMission,
  readMissionState,
  readRoadmap,
} from "@isaacriehm/cairn-state";
import {
  checkContextThreshold,
  renderContextThresholdHint,
} from "./context-threshold.js";
import { runGcAutotriggerCheck } from "./gc-autotrigger.js";
import {
  emitShapeB,
  parseHookPayload,
  readHookStdin,
  appendTelemetry,
} from "./payload.js";

/** Init in progress means `.cairn/init-state.json` exists at repoRoot. */
function isInitInProgress(repoRoot: string): boolean {
  return existsSync(join(repoRoot, ".cairn", "init-state.json"));
}

/**
 * Cap the reason text that flows back to Claude Code via decision:block.
 * Both the reviewer hint and the bypass hint can fire on the same Stop
 * tick; 4 KB is generous for two A/B/C strips but small enough that
 * overflow is structurally impossible.
 */
const MAX_REASON_CHARS = 4_000;

function clampReason(body: string): string {
  if (body.length <= MAX_REASON_CHARS) return body;
  const head = body.slice(0, MAX_REASON_CHARS - 80);
  return `${head}\n\n…(truncated; resolve via cairn-attention)`;
}

/** Stop hook emits decision:block+reason to inject context into Claude. */
interface StopBlockOutput {
  decision: "block";
  reason: string;
}

/** Stop hook emits continue:true when nothing to surface. */
interface StopPassOutput {
  continue: true;
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
  const transcriptPath =
    typeof payload.transcript_path === "string" ? payload.transcript_path : null;
  const cwdInput = typeof payload.cwd === "string" ? payload.cwd : process.cwd();
  const repoRoot = resolveRepoRoot(cwdInput);
  const warnings: string[] = [];

  let drained: InvalidationEvent[] = [];
  let pendingReviews: PendingReview[] = [];
  let bypassed: BypassedCommit[] = [];
  let reason = "";

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
        const grad = autoGraduateTasks(repoRoot);
        if (grad.completed.length > 0) {
          warnings.push(`auto_graduated_completed:${grad.completed.length}`);
          const ids = grad.completed.map((id) => `\`${id}\``).join(", ");
          const noun = grad.completed.length === 1 ? "task" : "tasks";
          const hint = `## Cairn — ${grad.completed.length} ${noun} graduated\n\n✓ ${ids} → done. Final attestation written.`;
          reason = reason.length > 0 ? `${reason}\n\n${hint}` : hint;
        }
        if (grad.transitioned.length > 0) {
          warnings.push(`auto_graduated_review_ready:${grad.transitioned.length}`);
        }
      } catch (err) {
        warnings.push(
          `auto_graduate_failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      try {
        pendingReviews = scanPendingReviews(repoRoot);
        if (pendingReviews.length > 0) {
          const reviewDefer = readDeferState(repoRoot, "review");
          const suppressed =
            reviewDefer !== null &&
            isDeferActive(reviewDefer, new Date(), {
              kind: "task_ids",
              values: pendingReviews.map((p) => p.task_id),
            });
          if (suppressed) {
            warnings.push(`review_suppressed_until:${reviewDefer.deferred_at}`);
          } else {
            reason = renderReviewerHint(pendingReviews);
          }
        }
      } catch (err) {
        warnings.push(
          `pending_review_scan_failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      // Context-threshold check — fires inline AskUserQuestion prompt
      // when the transcript token estimate crosses the configured
      // window fraction. Stamps `ctx-threshold-warned.json` on hit so
      // re-fires are suppressed until usage climbs another +10 %.
      try {
        if (sessionId !== null && sessionId.length > 0 && transcriptPath !== null) {
          const ctxResult = checkContextThreshold({
            transcriptPath,
            repoRoot,
            sessionId,
          });
          if (ctxResult.hit) {
            const taskId = findCurrentActiveTask(repoRoot);
            const hint = renderContextThresholdHint(ctxResult, taskId);
            reason = reason.length > 0 ? `${reason}\n\n${hint}` : hint;
            warnings.push(`ctx_threshold_hit:${ctxResult.pct}%`);
          }
        }
      } catch (err) {
        warnings.push(
          `ctx_threshold_failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      try {
        const phaseHints = collectPhaseReadyHints(repoRoot, drained);
        if (phaseHints.length > 0) {
          const hint = renderPhaseReadyHint(phaseHints);
          reason = reason.length > 0 ? `${reason}\n\n${hint}` : hint;
          warnings.push(`mission_phase_ready:${phaseHints.length}`);
        }
      } catch (err) {
        warnings.push(
          `mission_phase_scan_failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      try {
        const bypassResult = scanBypassedCommits(repoRoot);
        bypassed = bypassResult.bypassed;
        if (bypassed.length > 0) {
          const bypassDefer = readDeferState(repoRoot, "bypass");
          const suppressed =
            bypassDefer !== null &&
            isDeferActive(bypassDefer, new Date(), {
              kind: "shas",
              values: bypassed.map((b) => b.sha),
            });
          if (suppressed) {
            warnings.push(`bypass_suppressed_until:${bypassDefer.deferred_at}`);
          } else {
            const hint = renderBypassHint(bypassed);
            reason = reason.length > 0 ? `${reason}\n\n${hint}` : hint;
          }
        }
      } catch (err) {
        warnings.push(
          `bypass_scan_failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }

      try {
        const gc = runGcAutotriggerCheck({ repoRoot });
        if (gc.triggered) {
          warnings.push(`gc_autotriggered:${gc.reason}`);
        } else if (gc.reason !== "fresh") {
          warnings.push(`gc_autotrigger_skipped:${gc.reason}`);
        }
      } catch (err) {
        warnings.push(
          `gc_autotrigger_failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }

    try {
      const active = readActiveTaskSummary(repoRoot);
      writeStatusJson(repoRoot, sessionId, {
        updated_at: new Date().toISOString(),
        task_state: active?.taskState ?? "idle",
        task_id: active?.taskId ?? null,
        task_module: active?.taskModule ?? null,
        bypass_count: bypassed.length,
      });
    } catch (err) {
      warnings.push(
        `status_heartbeat_failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // Stop hook uses decision:block+reason to inject context into Claude
  // (Stop does not support hookSpecificOutput.additionalContext — that
  // field is silently ignored by Claude Code for Stop events). When
  // reason is non-empty, blocking keeps the session alive so Claude
  // reads the reason and acts on it (e.g. invokes cairn-attention).
  const out: StopBlockOutput | StopPassOutput =
    reason.length > 0
      ? { decision: "block", reason: clampReason(reason) }
      : { continue: true };
  process.stdout.write(JSON.stringify(out) + "\n");

  appendTelemetry({
    repoRoot: repoRoot!,
    sessionId,
    kind: "stop",
    durationMs: Date.now() - startedAt,
    source: payload.source ?? "unknown",
    warnings,
    extra: {
      events_drained: drained.length,
      pending_reviews: pendingReviews.length,
      bypassed_commits: bypassed.length,
      decision: reason.length > 0 ? "block" : "continue",
      ...(reason.length > 0 ? { reason } : {}),
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
// Phases a task moves through. The reviewer-attestation prompt only
// fires for tasks that are explicitly ready for review — a fresh
// `running` task has work in flight, no reviewer needed yet.
const REVIEW_READY_PHASES = new Set(["ready_for_review", "awaiting_attestation"]);

function readTaskPhase(taskDir: string): string | null {
  const statusPath = join(taskDir, "status.yaml");
  if (!existsSync(statusPath)) return null;
  let raw: string;
  try {
    raw = readFileSync(statusPath, "utf8");
  } catch {
    return null;
  }
  // Cheap line scan — `phase: <value>` at top-level. Avoid a full
  // YAML parse (this runs on every Stop tick).
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^phase:\s*(\S+)/);
    if (m && m[1] !== undefined) return m[1].replace(/['"]/g, "");
  }
  return null;
}

function checkNeedsReview(specPath: string): boolean {
  try {
    const raw = readFileSync(specPath, "utf8");
    const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\n---/);
    if (!fmMatch) return true;
    const fm = fmMatch[1] ?? "";
    const m = fm.match(/^needs_review:\s*(true|false)/m);
    if (m && m[1] === "false") return false;
    return true;
  } catch {
    return true;
  }
}

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

    // Finding 4: Opt-in reviewer. Default to true, skip if explicitly false.
    if (!checkNeedsReview(tightenedSpec)) continue;

    // Phase gate — `running` / `tightening` / etc. are not review-ready.
    const phase = readTaskPhase(taskDir);
    if (phase !== null && !REVIEW_READY_PHASES.has(phase)) continue;
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

/**
 * Auto-graduate active tasks based on attestation presence.
 *
 * Rules (only acts on tasks with phase=running):
 *   1. Task-root `attestation.yaml` exists                     → succeeded → tasks/done/
 *      (reviewer subagent attested; nothing more to do)
 *   2. ≥1 subagents/<id>/attestation.yaml AND needs_review=false → succeeded → tasks/done/
 *      (trivial task, no reviewer scheduled)
 *   3. ≥1 subagents/<id>/attestation.yaml AND needs_review=true  → ready_for_review
 *      (reviewer hasn't run yet — `scanPendingReviews` will surface a hint)
 *
 * Tasks with no attestation activity stay `running` — they're either
 * still in flight or stalled (Q4 surfaces stall detection separately).
 */
function autoGraduateTasks(
  repoRoot: string,
): { completed: string[]; transitioned: string[] } {
  const activeDir = join(repoRoot, ".cairn", "tasks", "active");
  const result = { completed: [] as string[], transitioned: [] as string[] };
  if (!existsSync(activeDir)) return result;

  let entries;
  try {
    entries = readdirSync(activeDir, { withFileTypes: true, encoding: "utf8" });
  } catch {
    return result;
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const taskId = entry.name;
    const state = readTaskAttestationState(repoRoot, taskId);
    if (state === null) continue;
    if (state.phase !== "running") continue;

    if (state.rootAttestation) {
      const r = completeTask({
        repoRoot,
        taskId,
        outcome: "succeeded",
        source: "cairn_stop_auto_graduate",
      });
      if (r.ok) result.completed.push(taskId);
      continue;
    }

    if (state.subagentAttestations > 0) {
      if (!state.needsReview) {
        const r = completeTask({
          repoRoot,
          taskId,
          outcome: "succeeded",
          source: "cairn_stop_auto_graduate",
        });
        if (r.ok) result.completed.push(taskId);
        continue;
      }
      const ok = transitionTaskPhase({
        repoRoot,
        taskId,
        newPhase: "ready_for_review",
      });
      if (ok) result.transitioned.push(taskId);
    }
  }

  return result;
}

interface PhaseReadyHint {
  mission_id: string;
  mission_title: string;
  phase_id: string;
  phase_title: string;
  exit_criteria: string;
  exit_gate: "prompt" | "auto" | "manual";
}

/**
 * Read the latest `phase-ready-to-exit` event(s) for active missions
 * out of the drained event list. Cross-checks against the live mission
 * state (the event might be stale if the operator already advanced).
 * Skip events whose phase is no longer the cursor or already done.
 *
 * Suppresses events when the operator deferred the phase via
 * `cairn_mission_advance({choice: "defer"})` — read the defer file
 * directly since mission-phase defers don't share schema with the
 * bypass/review defer states.
 */
function collectPhaseReadyHints(
  repoRoot: string,
  drained: InvalidationEvent[],
): PhaseReadyHint[] {
  const candidates = drained.filter((e) => e.kind === "phase-ready-to-exit");
  if (candidates.length === 0) return [];

  const missionId = findActiveMission(repoRoot);
  if (missionId === null) return [];
  const roadmap = readRoadmap(repoRoot, missionId);
  const state = readMissionState(repoRoot, missionId);
  if (roadmap === null || state === null) return [];

  const cursorPhaseId = state.cursor.active_phase;
  if (cursorPhaseId === null) return [];
  if (state.phase_progress[cursorPhaseId]?.state === "done") return [];

  // Defer file check — `.cairn/.mission-phase-deferred-until` JSON.
  if (isMissionPhaseDeferActive(repoRoot, missionId, cursorPhaseId)) return [];

  const gate = effectivePhaseExitGate(roadmap.frontmatter, cursorPhaseId);
  if (gate !== "prompt") return [];

  const phase = roadmap.frontmatter.phases.find((p) => p.id === cursorPhaseId);
  if (phase === undefined) return [];

  return [
    {
      mission_id: missionId,
      mission_title: roadmap.frontmatter.title,
      phase_id: cursorPhaseId,
      phase_title: phase.title,
      exit_criteria: phase.exit_criteria,
      exit_gate: gate,
    },
  ];
}

function isMissionPhaseDeferActive(
  repoRoot: string,
  missionId: string,
  phaseId: string,
): boolean {
  const path = join(repoRoot, ".cairn", ".mission-phase-deferred-until");
  if (!existsSync(path)) return false;
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return false;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return false;
  }
  if (typeof parsed !== "object" || parsed === null) return false;
  const o = parsed as Record<string, unknown>;
  if (o["mission_id"] !== missionId || o["phase_id"] !== phaseId) return false;
  const until = typeof o["deferred_until"] === "string" ? Date.parse(o["deferred_until"]) : NaN;
  if (Number.isNaN(until)) return false;
  return Date.now() < until;
}

function renderPhaseReadyHint(hints: PhaseReadyHint[]): string {
  const lines: string[] = [];
  const h = hints[0];
  if (h === undefined) return "";
  lines.push(`## Cairn — phase ready to exit`);
  lines.push("");
  lines.push(`Mission \`${h.mission_id}\` (${h.mission_title}) — phase \`${h.phase_id}\`: ${h.phase_title}.`);
  lines.push("");
  lines.push(`Exit criteria: ${h.exit_criteria}`);
  lines.push("");
  lines.push(
    "**Operator picks — surface this via the `cairn-attention` skill or render the choice directly through `AskUserQuestion`. Do NOT call `cairn_mission_advance` yourself; the operator's answer is the only valid input to that tool.**",
  );
  lines.push("");
  lines.push("- `[a]` mark phase done, advance cursor (`choice: \"exit\"`)");
  lines.push("- `[b]` not yet — more tasks needed for this phase (`choice: \"not_yet\"`)");
  lines.push("- `[c]` defer 24h (`choice: \"defer\"`)");
  return lines.join("\n");
}

function renderReviewerHint(pending: PendingReview[]): string {
  const lines: string[] = [];
  const noun = pending.length === 1 ? "task" : "tasks";
  lines.push(
    `## Cairn — ${pending.length} ${noun} awaiting review attestation`,
  );
  lines.push("");
  for (const p of pending) {
    lines.push(`- \`${p.task_id}\``);
  }
  lines.push("");
  lines.push(
    "Invoke the `cairn-attention` skill on the next turn so the operator can pick run review / skip / defer through `AskUserQuestion`.",
  );
  return lines.join("\n");
}
