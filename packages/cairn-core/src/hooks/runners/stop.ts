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

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
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
import {
  type PhaseReadyHint,
  writePhaseReadyPending,
} from "./phase-ready-surface.js";
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
 * Returns true when the session was opened within `windowSeconds` ago,
 * gauged by the per-session dir's birth time. Used to suppress heavy
 * Stop-hook surfaces (stalled-task triage, phase-ready prompt,
 * ctx-threshold) on the first turn of a fresh session — those need
 * to wait for the SessionStart resume primer to land before the
 * operator can act on them.
 */
function inFirstTurnWarmup(
  repoRoot: string,
  sessionId: string | null,
  windowSeconds: number,
): boolean {
  if (sessionId === null || sessionId.length === 0) return false;
  const dir = join(repoRoot, ".cairn", "sessions", sessionId);
  try {
    const st = statSync(dir);
    const ageMs = Date.now() - st.birthtimeMs;
    return ageMs < windowSeconds * 1000;
  } catch {
    return false;
  }
}

/**
 * Cap the reason text that flows back to Claude Code via decision:block.
 * Both the reviewer hint and the bypass hint can fire on the same Stop
 * tick; 4 KB is generous for two A/B/C strips but small enough that
 * overflow is structurally impossible.
 */
const MAX_REASON_CHARS = 4_000;

/**
 * Single short cue prepended to non-empty Stop hook reasons. CC labels
 * every Stop `decision: block` as "Stop hook error" — the label is a
 * CC convention, not a failure signal. One short line keeps the chat
 * tidy without dropping the cue entirely.
 */
const REASON_PREAMBLE = "↳ Cairn hint — surface to operator at a natural stopping point. Don't interrupt productive work; quote / `AskUserQuestion` only when there's no obvious continuation.\n\n";

function clampReason(body: string): string {
  if (body.length === 0) return body;
  const withPreamble = `${REASON_PREAMBLE}${body}`;
  if (withPreamble.length <= MAX_REASON_CHARS) return withPreamble;
  const head = withPreamble.slice(0, MAX_REASON_CHARS - 80);
  return `${head}\n\n…(truncated; resolve via cairn-attention)`;
}

/**
 * Time window (ms) after which an identical Stop-cue payload may re-fire.
 * Suppresses cue spam — caught in bug-mine: same "5 commits not attested"
 * payload re-fired 3× across a 10-minute span while the operator was
 * mid-resolution, because `bypass_accept` silently no-op'd from a worktree
 * (Bug A / fixed via `resolveRepoRoot` worktree-collapse). Re-emit after
 * the window or whenever the payload hash changes.
 */
const CUE_DEBOUNCE_WINDOW_MS = 60 * 60 * 1000;

interface PriorCueState {
  hash: string;
  emitted_at: string;
}

function priorCuePath(repoRoot: string, sessionId: string): string {
  return join(repoRoot, ".cairn", "sessions", sessionId, "last-stop-cue.json");
}

function readPriorCue(repoRoot: string, sessionId: string): PriorCueState | null {
  const path = priorCuePath(repoRoot, sessionId);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<PriorCueState>;
    if (typeof parsed.hash !== "string" || typeof parsed.emitted_at !== "string") return null;
    return { hash: parsed.hash, emitted_at: parsed.emitted_at };
  } catch {
    return null;
  }
}

function writePriorCue(repoRoot: string, sessionId: string, state: PriorCueState): void {
  const path = priorCuePath(repoRoot, sessionId);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(state, null, 2), "utf8");
  } catch {
    // best-effort: a missed write only means the next identical cue will fire
  }
}

function hashCuePayload(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex").slice(0, 16);
}

/**
 * Stop hook emits `decision: "block"` + `reason` to inject markdown
 * context into Claude — used for ctx-threshold + reviewer/bypass
 * prompts that need the model to surface AskUserQuestion in the
 * same Stop tick. CC renders this as a "Stop hook error" frame
 * (visual convention, not a real failure); operator gets the
 * preamble explaining that.
 */
interface StopBlockOutput {
  decision: "block";
  reason: string;
  /**
   * Optional non-blocking operator-facing warning. Per CC's hook
   * spec, `systemMessage` is rendered as a notice to the operator
   * (not red error styling) and is NOT injected into Claude's
   * context. Used for the phase-ready surface — operator sees a
   * notice that a phase-exit prompt is pending and will surface on
   * the next prompt submission via UPS.
   */
  systemMessage?: string;
}

/**
 * Stop hook emits `continue: true` when nothing to inject. May still
 * carry a `systemMessage` operator notice (e.g. phase-ready pending)
 * without forcing a block.
 */
interface StopPassOutput {
  continue: true;
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
  let reason = "";
  // Operator-facing notice (non-blocking, no banner). Used to alert
  // the operator that a phase-exit prompt is pending and will surface
  // on the next prompt submission via the UPS hook.
  let systemMessage = "";

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

    // First-turn warmup: if the session is very young (<30s since the
    // SessionStart hook seeded the per-session dir), suppress the
    // heavy stalled-task / phase-ready / ctx-threshold surfaces.
    // First-turn stops fire before the assistant has done any real
    // work (e.g. operator typed "continue", SessionStart resume primer
    // hasn't been processed yet) and surfacing prompts immediately
    // short-circuits the resume flow (bug-mine report #18).
    const isFirstTurnWarmup = inFirstTurnWarmup(repoRoot, sessionId, 30);
    if (isFirstTurnWarmup) warnings.push("first_turn_warmup:suppress_surfaces");

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

      // Stalled-task scanner — surfaces tasks stuck in phase=running
      // with no attestation for 30min+. Catches the failure mode where
      // the autonomous flow finished the work but skipped spawning the
      // reviewer subagent (no attestation → auto-graduator never fires
      // → task accumulates as orphaned). Only fires when no other
      // higher-priority surface (reviewer hint, ctx threshold) already
      // owns the reason channel — stalled-task triage is informational
      // catch-up, not blocking.
      //
      // Per-task suppression window: once a stalled hint fires for a
      // given task id, suppress re-fires on the same id for 60 min so
      // the operator isn't asked the same triage question every Stop
      // tick (bug-mine report #9 — same task flagged 3× in 90s).
      if (reason.length === 0 && !isFirstTurnWarmup) {
        try {
          gcStalledWarnedMarkers(repoRoot);
          const stalled = scanStalledRunningTasks(repoRoot, Date.now(), {
            currentSessionId: sessionId,
          });
          const surfaced = stalled.filter(
            (t) => !isStalledFireSuppressed(repoRoot, t.task_id),
          );
          if (surfaced.length > 0) {
            const reviewDefer = readDeferState(repoRoot, "review");
            const suppressed =
              reviewDefer !== null &&
              isDeferActive(reviewDefer, new Date(), {
                kind: "task_ids",
                values: surfaced.map((t) => t.task_id),
              });
            if (suppressed) {
              warnings.push(`stalled_suppressed_until:${reviewDefer.deferred_at}`);
            } else {
              reason = renderStalledTasksHint(surfaced);
              for (const t of surfaced) stampStalledFire(repoRoot, t.task_id);
              warnings.push(`stalled_running_tasks:${surfaced.length}`);
            }
          } else if (stalled.length > 0) {
            warnings.push(`stalled_window_suppressed:${stalled.length}`);
          }
        } catch (err) {
          warnings.push(
            `stalled_scan_failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }

      // Context-threshold check — fires inline AskUserQuestion prompt
      // when the transcript token estimate crosses the configured
      // window fraction. Stamps `ctx-threshold-warned.json` on hit so
      // re-fires are suppressed until usage climbs another +10 %.
      try {
        if (sessionId !== null && sessionId.length > 0 && !isFirstTurnWarmup) {
          const ctxResult = checkContextThreshold({
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

      // Phase-ready surface: hand off to the UserPromptSubmit hook via
      // a session-scoped pending file. The Stop hook deliberately does
      // NOT inject this into `reason` — `decision: block` makes Claude
      // Code render a red "Stop hook error" frame regardless of the
      // preamble we attach, and that visual reads as a real failure
      // for an informational prompt.
      //
      // Two-channel surface instead:
      //   1. `phase-ready-pending.json` — UPS reads it on the next
      //      prompt submission and injects via `additionalContext`.
      //      The model surfaces the AskUserQuestion in that turn.
      //   2. `systemMessage` — non-error operator notice in the same
      //      Stop tick. Lets the operator know a decision is pending
      //      and that submitting any prompt will render it. Critical
      //      because the assistant just ended its turn and the model
      //      isn't in the loop until UPS fires.
      //
      // Primary surface (when the model called `cairn_task_complete`
      // directly) lives in the MCP tool response itself — same-turn,
      // no hook handoff. This Stop-hook path only covers the
      // auto-graduator case (attestation written, task graduated
      // without an explicit MCP call in the same tick).
      try {
        const phaseHints = isFirstTurnWarmup
          ? []
          : collectPhaseReadyHints(repoRoot, drained);
        if (phaseHints.length > 0) {
          writePhaseReadyPending(repoRoot, sessionId, phaseHints);
          warnings.push(`mission_phase_ready_deferred_to_ups:${phaseHints.length}`);
          const phaseLabel = phaseHints[0]?.phase_title ?? phaseHints[0]?.phase_id ?? "phase";
          systemMessage = `⬡ Cairn — phase "${phaseLabel}" ready to exit. Submit any prompt to surface the move-on / keep-going decision.`;
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

  // Stop hook output channels:
  //   - `decision: "block"` + `reason` injects markdown into Claude's
  //     next inference, used for ctx-threshold + reviewer + bypass
  //     surfaces that need a same-turn AskUserQuestion render. CC
  //     frames this as a "Stop hook error" notice (visual convention,
  //     not a real failure).
  //   - `systemMessage` is a non-blocking operator-facing notice that
  //     does NOT inject into Claude's context. Used for phase-ready
  //     so the operator sees a clean alert while the actual prompt
  //     fires on the next UPS turn.
  //   - `continue: true` when neither channel is active.
  //
  // Stop does NOT support `hookSpecificOutput.additionalContext` —
  // that field is silently ignored by Claude Code for Stop events,
  // so we cannot reach the model context without `decision: "block"`.

  // Payload-hash debounce — suppress identical `reason` payloads within
  // CUE_DEBOUNCE_WINDOW_MS. Prevents the 3×-cue-spam pattern bug-mine
  // found: when the underlying scan keeps returning the same flagged
  // set (operator didn't act, OR resolve_attention silently no-op'd
  // pre-Bug-A-fix), the cue re-fired on every Stop. The hash includes
  // every surface (ctx-threshold, reviewer, bypass) so any change in
  // surfaced state breaks the suppression.
  let emitReason = reason;
  if (reason.length > 0 && repoRoot !== null && sessionId !== null && sessionId.length > 0) {
    const hash = hashCuePayload(reason);
    const prior = readPriorCue(repoRoot, sessionId);
    if (prior !== null && prior.hash === hash) {
      const ageMs = Date.now() - Date.parse(prior.emitted_at);
      if (Number.isFinite(ageMs) && ageMs >= 0 && ageMs < CUE_DEBOUNCE_WINDOW_MS) {
        emitReason = "";
        warnings.push(`cue_debounced:${hash}:${Math.floor(ageMs / 1000)}s`);
      }
    }
    if (emitReason.length > 0) {
      writePriorCue(repoRoot, sessionId, {
        hash,
        emitted_at: new Date().toISOString(),
      });
    }
  }

  const out: StopBlockOutput | StopPassOutput =
    emitReason.length > 0
      ? {
          decision: "block",
          reason: clampReason(emitReason),
          ...(systemMessage.length > 0 ? { systemMessage } : {}),
        }
      : {
          continue: true,
          ...(systemMessage.length > 0 ? { systemMessage } : {}),
        };
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
      ...(systemMessage.length > 0 ? { systemMessage } : {}),
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
 * Per-task stalled-fire suppression window. The Stop hook re-runs on
 * every assistant turn end; without a window, a stalled task gets the
 * same AskUserQuestion triage prompt every single turn until the
 * operator finally writes status.yaml. Stamp on fire, gate on read.
 *
 * 60-minute window matches the doubling of the 30-min idle threshold —
 * one stalled task ≈ one prompt per hour, not one per turn.
 */
const STALLED_FIRE_WINDOW_MS = 60 * 60 * 1000;

function stalledFireMarkerPath(repoRoot: string, taskId: string): string {
  return join(repoRoot, ".cairn", ".stalled-warned", `${taskId}.iso`);
}

function isStalledFireSuppressed(repoRoot: string, taskId: string): boolean {
  const path = stalledFireMarkerPath(repoRoot, taskId);
  if (!existsSync(path)) return false;
  try {
    const ms = statSync(path).mtimeMs;
    return Date.now() - ms < STALLED_FIRE_WINDOW_MS;
  } catch {
    return false;
  }
}

function stampStalledFire(repoRoot: string, taskId: string): void {
  const path = stalledFireMarkerPath(repoRoot, taskId);
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, new Date().toISOString(), "utf8");
  } catch {
    // best-effort
  }
}

/**
 * Drop `.stalled-warned/<task-id>.iso` files for tasks that have since
 * graduated (now under `tasks/done/`) or vanished entirely. Without
 * this, GC residue accumulates and the marker count looks alarming
 * even though every referenced task already shipped. Best-effort —
 * called on every Stop tick.
 */
function gcStalledWarnedMarkers(repoRoot: string): void {
  const dir = join(repoRoot, ".cairn", ".stalled-warned");
  if (!existsSync(dir)) return;
  const activeDir = join(repoRoot, ".cairn", "tasks", "active");
  let entries: import("node:fs").Dirent[] = [];
  try {
    entries = readdirSync(dir, { withFileTypes: true, encoding: "utf8" });
  } catch {
    return;
  }
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith(".iso")) continue;
    const taskId = e.name.replace(/\.iso$/, "");
    if (existsSync(join(activeDir, taskId))) continue;
    try {
      unlinkSync(join(dir, e.name));
    } catch {
      /* best-effort */
    }
  }
}

interface StalledTask {
  task_id: string;
  title: string;
  module: string | null;
  idle_minutes: number;
}

/**
 * Scan `tasks/active/` for tasks stuck in `phase: running` with no
 * attestation and no recent activity. The auto-graduator only fires
 * when a reviewer subagent has written attestation.yaml; tasks that
 * were committed manually (or where the autonomous flow skipped the
 * reviewer-spawn step) never graduate. They accumulate silently and
 * resurface only on a fresh session as "wait, why are these still
 * open?".
 *
 * Definition of stalled:
 *   - phase = "running"
 *   - tightened spec exists
 *   - no `attestation.yaml`
 *   - no `subagents/<id>/attestation.yaml` either (else the regular
 *     auto-graduator path will transition it)
 *   - `status.yaml` mtime > 30min ago (recent enough activity stays
 *     under the radar to avoid spamming during in-flight work)
 *   - upper bound 7d so we don't surface long-archived noise that
 *     the operator already mentally retired
 *
 * Returned list drives the Stop-hook hint that asks the operator to
 * triage stalled tasks — close, abort, or keep open while spawning
 * a reviewer.
 */
interface ScanStalledOpts {
  /** Active session id — tasks owned by other sessions get filtered out. */
  currentSessionId: string | null;
}

function scanStalledRunningTasks(
  repoRoot: string,
  nowMs: number = Date.now(),
  opts: ScanStalledOpts = { currentSessionId: null },
): StalledTask[] {
  const activeDir = join(repoRoot, ".cairn", "tasks", "active");
  if (!existsSync(activeDir)) return [];
  const out: StalledTask[] = [];
  const idleThresholdMs = 30 * 60 * 1000;
  const upperBoundMs = 7 * 24 * 60 * 60 * 1000;
  // When a task's last journal write came from a DIFFERENT live session
  // within this window, treat it as "owned by that session" and don't
  // surface the stall in the current session. Matches the case where
  // an operator runs two concurrent Claude Code windows on a single
  // checkout, each with its own active task.
  const crossSessionTakeoverMs = 90 * 60 * 1000;

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
    if (existsSync(join(taskDir, "attestation.yaml"))) continue;

    // If a subagent attestation already lives under subagents/, the
    // regular auto-graduator owns the transition. Skip — surfacing
    // would race that path.
    const subagentsDir = join(taskDir, "subagents");
    if (existsSync(subagentsDir)) {
      try {
        const subagentEntries = readdirSync(subagentsDir, {
          withFileTypes: true,
          encoding: "utf8",
        });
        let hasSubagentAttestation = false;
        for (const sub of subagentEntries) {
          if (sub.isDirectory() && existsSync(join(subagentsDir, sub.name, "attestation.yaml"))) {
            hasSubagentAttestation = true;
            break;
          }
        }
        if (hasSubagentAttestation) continue;
      } catch {
        // continue — best-effort
      }
    }

    if (readTaskPhase(taskDir) !== "running") continue;

    const statusPath = join(taskDir, "status.yaml");
    let statusMtime = 0;
    try {
      statusMtime = statSync(statusPath).mtimeMs;
    } catch {
      continue;
    }

    // Journal mtime is also a liveness signal — Bug 2 fix bumps
    // status.yaml on every appendTaskJournal, but a session running
    // an older client may write journal.jsonl only. Take the max so
    // either path counts.
    const journalPath = join(taskDir, "journal.jsonl");
    let journalMtime = 0;
    try {
      journalMtime = statSync(journalPath).mtimeMs;
    } catch {
      // missing journal is fine — fall through with statusMtime only
    }
    const liveMtime = Math.max(statusMtime, journalMtime);

    const idleMs = nowMs - liveMtime;
    if (idleMs < idleThresholdMs) continue;
    if (idleMs > upperBoundMs) continue;

    let title = taskId;
    let module: string | null = null;
    let lastJournalSession: string | null = null;
    let blockedOnOperator = false;
    try {
      const raw = readFileSync(statusPath, "utf8");
      for (const line of raw.split(/\r?\n/)) {
        const t = line.match(/^title:\s*(.+)$/);
        if (t && t[1] !== undefined) title = t[1].trim().replace(/^['"]|['"]$/g, "");
        const m = line.match(/^module:\s*(.+)$/);
        if (m && m[1] !== undefined) module = m[1].trim().replace(/^['"]|['"]$/g, "");
        const ljs = line.match(/^last_journal_session:\s*(.+)$/);
        if (ljs && ljs[1] !== undefined) {
          lastJournalSession = ljs[1].trim().replace(/^['"]|['"]$/g, "");
        }
        const bo = line.match(/^blocked_on:\s*(.+)$/);
        if (bo && bo[1] !== undefined) {
          const v = bo[1].trim().replace(/^['"]|['"]$/g, "").toLowerCase();
          if (v === "operator") blockedOnOperator = true;
        }
      }
    } catch {
      // fall through with id-as-title
    }

    // Session-affinity filter: another session journaled this task
    // recently — they own it. Skip surfacing in the current session.
    if (
      opts.currentSessionId !== null &&
      opts.currentSessionId.length > 0 &&
      lastJournalSession !== null &&
      lastJournalSession !== opts.currentSessionId &&
      idleMs < crossSessionTakeoverMs
    ) {
      continue;
    }

    // Operator-blocked task: the work itself can't progress without an
    // external action (e.g. browser repro, manual config). Surfacing
    // "stalled" interrupts the operator with a triage prompt for a
    // task they already know is paused.
    if (blockedOnOperator) continue;

    out.push({
      task_id: taskId,
      title,
      module,
      idle_minutes: Math.round(idleMs / 60000),
    });
  }

  return out;
}

function renderStalledTasksHint(stalled: StalledTask[]): string {
  if (stalled.length === 0) return "";
  const noun = stalled.length === 1 ? "task" : "tasks";
  const lines: string[] = [
    `## Cairn — ${stalled.length} stalled ${noun}`,
    ``,
    `${stalled.length} active ${noun} idle 30min+ with no attestation. ` +
      `Either the autonomous flow skipped the reviewer-spawn step, or the ` +
      `session was interrupted mid-task.`,
    ``,
  ];
  for (const t of stalled) {
    const mod = t.module !== null ? ` [${t.module}]` : "";
    lines.push(`- \`${t.task_id}\` — ${t.title}${mod} (idle ${t.idle_minutes}m)`);
  }
  lines.push("");
  lines.push("If you reach a stopping point with no obvious continuation, surface to operator (e.g. via `AskUserQuestion`):");
  lines.push("");
  lines.push(`> ${stalled.length} stalled ${noun}. Pick once for all (or address one at a time after):`);
  lines.push(`>`);
  lines.push(`> - [a] Mark all as \`succeeded\` — work landed but the reviewer skipped attestation. Closes each via \`cairn_task_complete\`.`);
  lines.push(`> - [b] Spawn reviewer subagent for each — proper attestation flow, slower but correct.`);
  lines.push(`> - [c] Keep open — they're still active; you'll resume the work.`);
  lines.push(``);
  lines.push("On [a], call `cairn_task_complete({task_id, outcome: \"succeeded\", summary: \"closing stalled task — work landed via prior session\"})` for each id above.");
  lines.push("On [b], dispatch the `reviewer` subagent for each task in turn (one task brief per Task call).");
  lines.push("On [c], end the turn — the prompt re-fires only when status.yaml stays idle past the next 30min mark.");
  lines.push("");
  lines.push("If you're actively working (Agent dispatch in flight, edits queued), ignore this hint and keep going — it will re-evaluate on the next Stop tick.");
  return lines.join("\n");
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
  // Lazy clean: if the marker is for a different mission/phase or its
  // until-timestamp already passed, unlink it on the read path so we
  // don't keep evaluating a stale file every Stop tick. Write-side
  // unlink happens on phase-advance + mission-close; this is the
  // belt-and-suspenders fallback for projects with markers stranded
  // pre-fix.
  const until = typeof o["deferred_until"] === "string" ? Date.parse(o["deferred_until"]) : NaN;
  const expired = Number.isFinite(until) && Date.now() >= until;
  const mismatch = o["mission_id"] !== missionId || o["phase_id"] !== phaseId;
  if (expired || (mismatch && Number.isFinite(until) && Date.now() >= until)) {
    try {
      unlinkSync(path);
    } catch {
      /* best-effort */
    }
    return false;
  }
  if (mismatch) return false;
  if (!Number.isFinite(until)) return false;
  return Date.now() < until;
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
