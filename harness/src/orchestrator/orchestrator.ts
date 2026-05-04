import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { randomBytes } from "node:crypto";
import chokidar, { type FSWatcher } from "chokidar";
import { dirname, join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { logger } from "../logger.js";
import { matchAnyGlob } from "../ground/glob.js";
import { requireMirrorRecord } from "../mirror/index.js";
import {
  formatReviewerRemediation,
  runReviewer,
  type ReviewerResult,
} from "../reviewer/index.js";
import {
  decisionsInScope,
  getDiff,
  loadAcceptedDecisions,
  loadStubCatalog,
  runDecisionAssertions,
  runDtoNoFakeFields,
  runRouteHandlerNonEmpty,
  runSensors,
  runStubCatalog,
} from "../sensors/index.js";
import type {
  SensorResult,
  SensorSweepResult,
} from "../sensors/index.js";
import {
  asClaudeError,
  ClaudeError,
  isQuotaKind,
  type ClaudeErrorKind,
} from "../claude/error.js";
import { tightenSpec } from "../tightener/index.js";
import type { TightenerOutput } from "../tightener/index.js";
import { summarizeActivity } from "./activity-summarizer.js";
import {
  appendRunLogEntry,
  readRunLogTail,
  type RunLogEntry,
  type RunLogKind,
} from "./run-log.js";
import { digestIsEmpty, extractToolDigest, type ToolDigest } from "./tool-digest.js";
import {
  captureUatRejection,
  formatUatRejectionRemediation,
  runQuestionAgent,
  runUat,
} from "../uat/index.js";
import type {
  ApprovalGate,
  QuestionHandler,
  UatNotifier,
  UatRunResult,
} from "../uat/index.js";
import {
  directionAuthorOf,
  directionChannelOf,
  directionTextOf,
  ensureInboxDirs,
  isDirectionRow,
  isSlashRow,
  isTaskRow,
  listInboxFiles,
  moveToProcessed,
  readInboxRow,
  type InboxSlashRow,
} from "./inbox.js";
import type {
  ApprovalBundle,
  FrontendAdapter,
  PostUpdate,
} from "../frontend/index.js";
import { TaskQueue } from "./queue.js";
import { loadWorkflowTemplate, renderTemplate } from "./prompt.js";
import { runImplementer } from "./runner.js";
import type {
  InboxTaskRow,
  OrchestratorOptions,
  QueueEntry,
  RunMeta,
  RunPhase,
} from "./types.js";

const log = logger("orchestrator");

const RUNS_ACTIVE_REL = ".harness/runs/active";

/** §3.5 — pause dispatch after this many consecutive rate_limit/overloaded errors. */
const QUOTA_PAUSE_THRESHOLD = 3;

/**
 * Phase 8 orchestrator. Single-task FIFO pipeline:
 *
 *   inbox row → enqueue → tightening (optional) → workspace prep → run agent
 *   → write run meta → surface phase transitions to adapters
 *
 * No commit, no push, no UAT, no reviewer — those are Phases 9-11+.
 */
export class Orchestrator {
  private readonly opts: OrchestratorOptions;
  private readonly queue: TaskQueue;
  private readonly seenInboxFiles = new Set<string>();
  private watcher: FSWatcher | undefined;
  private questionsWatcher: FSWatcher | undefined;
  private answeredQuestions = new Set<string>();
  private pollTimer: NodeJS.Timeout | undefined;
  private running = false;
  private dispatching = false;
  private stopped = false;
  private adapterUnsubs: (() => void)[] = [];
  /**
   * Handle on the in-flight implementer run. Set by `dispatch` before
   * the runImplementer call; cleared in `completeRun` (or via abort).
   * `/halt` reads this to fire the abort controller; `/status` reads it
   * to render running-task line.
   */
  private activeRun:
    | {
        entry: QueueEntry;
        meta: RunMeta;
        abortController: AbortController;
        startedAt: number;
        /**
         * Updated on every external logRunEvent (excludes self-emitted
         * watchdog events so the watchdog doesn't reset its own clock).
         * The watchdog compares against now.
         */
        lastEventAt: number;
        /**
         * Wall-clock of the last watchdog stall post. Watchdog re-fires
         * only when (idle > stallSeconds) AND (since last post >
         * stallSeconds). Replaces the prior boolean flag which was
         * racing against the watchdog's own surfacePhaseWithBody call.
         */
        lastWatchdogPostedAt?: number;
      }
    | undefined;
  private watchdogTimer: NodeJS.Timeout | undefined;
  /**
   * §3.5 plan-quota — count of consecutive runs that hit a quota error
   * (rate_limit / overloaded). Reset on any successful agent call.
   * After `quotaPauseThreshold` (default 3) the dispatch loop pauses
   * and pages the operator. /unpause clears it.
   */
  private consecutiveQuotaErrors = 0;
  private dispatchPaused = false;
  private dispatchPauseReason = "";
  private dispatchPausedAt: string | undefined;

  constructor(opts: OrchestratorOptions) {
    this.opts = opts;
    this.queue = new TaskQueue(opts.repoRoot);
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await ensureInboxDirs(this.opts.repoRoot);
    await this.queue.load();
    await this.absorbExistingInbox();

    const inboxDir = join(this.opts.repoRoot, ".harness", "inbox");
    this.watcher = chokidar.watch(inboxDir, {
      ignored: (p) => p.includes("/processed/"),
      persistent: true,
      ignoreInitial: true,
      depth: 0,
    });
    this.watcher.on("add", (path) => {
      if (path.endsWith(".json")) void this.absorbInboxFile(path);
    });

    // Phase 16.x — agent-initiated operator questions land under
    // .harness/runs/active/<run_id>/questions/<id>.q.json (written by
    // the harness_ask_operator MCP tool). Watch the runs/active root
    // so any new question file fires the dialog flow.
    const runsActiveDir = join(this.opts.repoRoot, ".harness", "runs", "active");
    await mkdir(runsActiveDir, { recursive: true });
    this.questionsWatcher = chokidar.watch(runsActiveDir, {
      persistent: true,
      ignoreInitial: false,
      depth: 3,
    });
    this.questionsWatcher.on("add", (path) => {
      if (path.endsWith(".q.json")) void this.absorbQuestionFile(path);
    });

    // Subscribe to adapter task callbacks so live ingests still drive the
    // queue even before chokidar's filesystem event lands. Idempotent — the
    // queue dedupes by run_id.
    for (const adapter of this.opts.adapters) {
      adapter.onTask(() => {
        // Don't push from the callback payload directly; rely on the inbox
        // row that the adapter has just written. The chokidar handler will
        // pick it up. This keeps a single source of truth.
        void this.absorbExistingInbox();
      });
    }

    const intervalMs = this.opts.pollIntervalMs ?? 2000;
    this.pollTimer = setInterval(() => {
      if (this.stopped) return;
      void this.absorbExistingInbox();
      void this.tick();
    }, intervalMs);

    // Watchdog: detect dispatches that go silent in a "should be making
    // progress" phase. Operator-pending phases (`blocked`) are excluded
    // — those are intentionally idle until the operator clicks. Fires
    // once per stall (resets on next log event). Cheap (in-memory check).
    this.watchdogTimer = setInterval(() => {
      if (this.stopped) return;
      void this.checkRunWatchdog();
    }, 30_000);

    log.info(
      { project: this.opts.projectName, repoRoot: this.opts.repoRoot },
      "orchestrator started",
    );
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.stopped = true;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = undefined;
    }
    if (this.watcher) {
      await this.watcher.close();
      this.watcher = undefined;
    }
    if (this.questionsWatcher) {
      await this.questionsWatcher.close();
      this.questionsWatcher = undefined;
    }
    for (const fn of this.adapterUnsubs) fn();
    this.adapterUnsubs = [];
    this.running = false;
    await this.queue.persist();
    log.info("orchestrator stopped");
  }

  /** Synchronous queue-size accessor for smoke. */
  queueSize(): number {
    return this.queue.size();
  }

  // ── private ────────────────────────────────────────────────────────────

  private async absorbExistingInbox(): Promise<void> {
    const files = await listInboxFiles(this.opts.repoRoot);
    for (const file of files) await this.absorbInboxFile(file);
  }

  private async absorbInboxFile(file: string): Promise<void> {
    if (this.seenInboxFiles.has(file)) return;
    this.seenInboxFiles.add(file);

    let row: unknown;
    try {
      row = await readInboxRow(file);
    } catch (err) {
      log.warn({ err: String(err), file }, "failed to read inbox row");
      this.seenInboxFiles.delete(file); // allow retry on next tick
      return;
    }
    if (isDirectionRow(row)) {
      // Phase 14 — decision-capture flow. Run inline (independent of the
      // task FIFO) since it's adapter-driven and short-circuits without
      // burning sensors/UAT quota. Best-effort: failures log + drop the
      // row without poisoning the queue.
      void this.handleDirectionRow(row, file);
      return;
    }
    if (isSlashRow(row)) {
      // §3.2 steering surface — /halt /status /queue /eval /resume /oops.
      // Routed inline; never enqueued. Per WORKFLOW_GUIDE §3 trust posture.
      void this.handleSlashRow(row, file);
      return;
    }
    if (!isTaskRow(row)) {
      // Non-task rows (voice, interaction, unrecognized slash) are not
      // dispatched here — leave them for downstream consumers. Keep them
      // out of the inbox dir scan so we don't loop on them.
      return;
    }
    const taskRow = row;
    const taskId = taskRow.task_id ?? `TSK-${Date.now().toString(36)}-${randomBytes(2).toString("hex")}`;
    const runId = `run-${Date.now().toString(36)}-${randomBytes(2).toString("hex")}`;
    const entry: QueueEntry = {
      run_id: runId,
      task_id: taskId,
      enqueued_at: new Date().toISOString(),
      row: { ...taskRow, task_id: taskId },
      inbox_file: file,
    };
    if (this.queue.enqueue(entry)) {
      log.info({ task_id: taskId, run_id: runId, file }, "task enqueued");
      await this.queue.persist();
      // Try to dispatch immediately; tick() also covers this on the timer.
      void this.tick();
    }
  }

  private async tick(): Promise<void> {
    if (this.dispatching || this.stopped) return;
    if (this.dispatchPaused) return;
    const next = this.queue.peek();
    if (!next) return;
    this.dispatching = true;
    try {
      await this.dispatch(next);
      this.queue.dequeue();
      await this.queue.persist();
    } catch (err) {
      log.error({ err: String(err), task_id: next.task_id }, "dispatch threw");
      this.queue.dequeue();
      await this.queue.persist();
      try {
        await moveToProcessed(this.opts.repoRoot, next.inbox_file, "failed");
        this.seenInboxFiles.delete(next.inbox_file);
      } catch {
        // best effort
      }
    } finally {
      this.dispatching = false;
    }
  }

  private async dispatch(entry: QueueEntry): Promise<void> {
    // Pre-flight: skip the run if the per-task channel is gone (operator
    // deleted it). Otherwise we'd burn LLM quota on tightener / agent /
    // sensors with no operator visibility, and dialogs would silently
    // time-out into failed runs. Cleaner to abandon up front.
    const channelId = entry.row.task.channelId;
    if (channelId !== undefined) {
      const alive = await this.isChannelAlive(channelId);
      if (!alive) {
        log.warn(
          { task_id: entry.task_id, channelId },
          "task abandoned — channel gone (operator deleted it before dispatch)",
        );
        try {
          await moveToProcessed(this.opts.repoRoot, entry.inbox_file, "failed");
        } catch (err) {
          log.warn(
            { err: String(err), file: entry.inbox_file },
            "abandon-move failed",
          );
        }
        this.seenInboxFiles.delete(entry.inbox_file);
        return;
      }
    }

    const tier = this.opts.defaultTier ?? "haiku";
    const taskBody = entry.row.task.rawText;
    const taskTitle = entry.row.title ?? taskBody.slice(0, 80);
    const meta: RunMeta = {
      run_id: entry.run_id,
      task_id: entry.task_id,
      agent_role: "implementer",
      phase: "queued",
      started_at: new Date().toISOString(),
      tier,
      model: tier,
      mirror_path: requireMirrorRecord(this.opts.projectName).mirrorPath,
      events_count: 0,
      ...(entry.row.task.channelId !== undefined
        ? { channel_id: entry.row.task.channelId }
        : {}),
    };
    await this.writeMeta(meta);
    await this.logRunEvent(entry, {
      kind: "run_started",
      summary: `${tier} · ${taskTitle.slice(0, 60)}`,
      data: { tier, title: taskTitle },
    });

    // ── Tightener (Phase 7) ────────────────────────────────────────────
    let tightenedSpec: string | undefined;
    if (this.opts.bypassTightener !== true) {
      await this.surfacePhase(entry, meta, "tightening");
      const stopTighteningTyping = this.startTaskTyping(entry);
      try {
        const tightened = await tightenSpec({
          title: taskTitle,
          body: taskBody,
          ...(entry.row.ship_anyway === true ? { ship_anyway: true } : {}),
        });
        stopTighteningTyping();
        meta.tightener_score = tightened.output.spec_quality_score;
        meta.tightener_ready = tightened.ready;
        tightenedSpec = tightened.output.tightened_spec_proposal;
        await this.logRunEvent(entry, {
          kind: "tightener_done",
          summary: `score ${tightened.output.spec_quality_score}/10 · ready=${tightened.ready}`,
          data: {
            score: tightened.output.spec_quality_score,
            ready: tightened.ready,
            ambiguities: tightened.output.ambiguities.length,
          },
        });
        if (!tightened.ready) {
          const walkable = tightened.output.ambiguities.filter(
            (a) => a.candidate_resolutions.length >= 2,
          );
          const blockedNote =
            walkable.length > 0
              ? `spec quality ${tightened.output.spec_quality_score}/10 — walking ${walkable.length} ambiguit${walkable.length === 1 ? "y" : "ies"}…`
              : `spec quality ${tightened.output.spec_quality_score}/10 — no candidate resolutions to walk.`;
          await this.surfacePhaseWithBody(entry, meta, "blocked", blockedNote);
          const result = await this.requestTightenerDecision({
            entry,
            meta,
            tightened,
          });
          if (result.decision === "approve") {
            tightenedSpec =
              result.resolved_spec ?? tightened.output.tightened_spec_proposal;
            meta.tightener_user_choice = "approve_proposed";
            await this.surfacePhase(entry, meta, "tightening");
          } else if (result.decision === "ship_anyway") {
            tightenedSpec = taskBody;
            meta.tightener_user_choice = "ship_anyway";
            await this.surfacePhase(entry, meta, "tightening");
          } else {
            meta.tightener_user_choice = result.decision;
            await this.completeRun(
              entry,
              meta,
              "failed",
              `tightener: operator chose ${result.decision}`,
            );
            return;
          }
        }
      } catch (err) {
        stopTighteningTyping();
        await this.completeRun(entry, meta, "failed", `tightener: ${String(err)}`);
        return;
      } finally {
        stopTighteningTyping();
      }
    }

    // ── Workspace prep ────────────────────────────────────────────────
    await this.surfacePhase(entry, meta, "prepping");
    const { prepareWorkspace } = await import("./workspace.js");
    let prep;
    try {
      prep = await prepareWorkspace({
        projectName: this.opts.projectName,
        ...(entry.row.target_path_globs !== undefined
          ? { targetGlobs: entry.row.target_path_globs }
          : {}),
      });
    } catch (err) {
      await this.completeRun(entry, meta, "failed", `workspace: ${String(err)}`);
      return;
    }
    meta.sha_pin = prep.sha_pin;
    if (prep.dirty_overlap?.overlap === true) {
      // Phase 8 minimum: log + fail. Phase 17 wires the operator dialog
      // (stash / cancel / wait) via adapter.requestDialog.
      await this.completeRun(
        entry,
        meta,
        "failed",
        `dirty-overlap: ${prep.dirty_overlap.overlappingFiles.join(", ")}`,
      );
      return;
    }

    // ── Agent run + sensor retry loop ─────────────────────────────────
    const eventsLogPath = join(
      this.opts.repoRoot,
      RUNS_ACTIVE_REL,
      entry.run_id,
      "events.jsonl",
    );
    const basePrompt = await this.renderPrompt({
      runId: entry.run_id,
      mirrorPath: meta.mirror_path,
      shaPin: prep.sha_pin,
      taskBody,
      acceptance: entry.row.acceptance_criteria ?? [],
    });

    const maxAttempts = this.opts.maxAttempts ?? 3;
    let remediationBody = "";
    meta.attempts = 0;
    meta.sensor_history = [];
    meta.reviewer_history = [];

    let lastSweep: SensorSweepResult | undefined;
    let lastReviewer: ReviewerResult | undefined;
    meta.uat_history = [];
    let attempt = 1;
    while (attempt <= maxAttempts) {
      meta.attempts = attempt;
      await this.surfacePhase(entry, meta, "running");

      const promptBody = remediationBody.length > 0
        ? `${basePrompt}\n\n${remediationBody}`
        : basePrompt;

      let runResult;
      const stopRunnerTyping = this.startTaskTyping(entry);
      // Tier-0 activity feed — sliding window of recent events that
      // gets summarized every 8s and surfaced into the live status
      // embed's `activity` field. Operator sees what the agent is
      // doing in present tense ("Reading X", "Editing Y") instead of
      // a static "running" badge.
      const activityWindow: Record<string, unknown>[] = [];
      const stopActivityFeed = this.startActivityFeed(entry, meta, activityWindow);
      // Per-run abort controller — `/halt` flips this to interrupt the
      // claude subprocess (SIGTERM via spawn signal; SIGKILL after 30s
      // grace via runner.ts escalation).
      const abortController = new AbortController();
      this.activeRun = {
        entry,
        meta,
        abortController,
        startedAt: Date.now(),
        lastEventAt: Date.now(),
      };
      try {
        runResult = await runImplementer({
          tier,
          prompt: promptBody,
          cwd: meta.mirror_path,
          eventsLogPath,
          addDirs: [meta.mirror_path],
          abortSignal: abortController.signal,
          ...(this.opts.allowedTools !== undefined
            ? { allowedTools: this.opts.allowedTools }
            : {}),
          ...(this.opts.runTimeoutMs !== undefined
            ? { timeoutMs: this.opts.runTimeoutMs }
            : {}),
          onEvent: (e) => {
            meta.events_count += 1;
            if (e["type"] === "assistant" || e["type"] === "result") {
              void this.writeMeta(meta);
            }
            activityWindow.push(e);
            // Keep window bounded so memory doesn't grow on long runs.
            if (activityWindow.length > 60) activityWindow.splice(0, activityWindow.length - 60);
          },
        });
      } catch (err) {
        stopRunnerTyping();
        stopActivityFeed();
        const reason = abortController.signal.aborted
          ? `halted by operator (/halt)`
          : `agent: ${String(err)}`;
        // §3.5 — classify quota errors so the dispatch loop can pause
        // before draining the operator's coding-plan budget on doomed
        // retries. Non-quota errors don't increment.
        const claudeErr =
          err instanceof ClaudeError ? err : asClaudeError(err);
        await this.recordQuotaSignal(claudeErr.kind, claudeErr.message);
        await this.completeRun(entry, meta, "failed", reason);
        return;
      } finally {
        stopRunnerTyping();
        stopActivityFeed();
      }
      meta.events_count = runResult.events;
      meta.duration_ms = runResult.durationMs;
      // Successful agent dispatch — clear consecutive quota counter.
      this.consecutiveQuotaErrors = 0;

      if (!runResult.ok) {
        await this.completeRun(entry, meta, "failed", "agent reported is_error=true");
        return;
      }

      // ── Sensor sweep ────────────────────────────────────────────────
      if (this.opts.bypassSensors === true) {
        await this.completeRun(entry, meta, "succeeded");
        return;
      }
      await this.surfacePhase(entry, meta, "sensing");
      const finalText =
        typeof runResult.result["result"] === "string"
          ? (runResult.result["result"] as string)
          : "";
      try {
        lastSweep = await runSensors({
          mirrorPath: meta.mirror_path,
          shaPin: prep.sha_pin,
          finalAssistantText: finalText,
          languages: this.opts.sensorLanguages ?? ["typescript"],
          projectGlobs: this.opts.projectGlobs ?? {},
          runId: entry.run_id,
          attempt,
          maxAttempts,
        });
      } catch (err) {
        await this.completeRun(entry, meta, "failed", `sensors: ${String(err)}`);
        return;
      }
      await this.persistSensorAttempt(entry.run_id, attempt, lastSweep);
      meta.sensor_history.push({
        attempt,
        ok: lastSweep.ok,
        hard_failures: lastSweep.hard_failures,
        soft_findings: lastSweep.soft_findings,
        sensor_ids_failed: lastSweep.results
          .filter((r) => !r.ok)
          .map((r) => r.sensor_id),
      });
      meta.last_sensor_sweep = {
        ok: lastSweep.ok,
        hard_failures: lastSweep.hard_failures,
        soft_findings: lastSweep.soft_findings,
      };
      await this.writeMeta(meta);
      await this.logRunEvent(entry, {
        kind: "sensor_sweep",
        summary: `attempt ${attempt} · ${lastSweep.ok ? "PASS" : "FAIL"} · ${lastSweep.hard_failures} hard / ${lastSweep.soft_findings} soft`,
        data: {
          attempt,
          ok: lastSweep.ok,
          hard_failures: lastSweep.hard_failures,
          soft_findings: lastSweep.soft_findings,
        },
      });

      if (!lastSweep.ok) {
        // Sensor hard fail. If attempts left, append remediation + loop.
        if (attempt >= maxAttempts) {
          await this.completeRun(
            entry,
            meta,
            "failed",
            `sensors failed-honesty-check after ${attempt} attempt(s); ${lastSweep.hard_failures} hard failure(s)`,
          );
          return;
        }
        remediationBody = lastSweep.remediation_prompt;
        attempt += 1;
        continue;
      }

      // ── Reviewer subagent (Layer C, Phase 10) ────────────────────────
      if (this.opts.bypassReviewer === true) {
        await this.completeRun(entry, meta, "succeeded");
        return;
      }
      await this.surfacePhase(entry, meta, "reviewing");
      const stopReviewerTyping = this.startTaskTyping(entry);
      try {
        lastReviewer = await this.runReviewerStep({
          mirrorPath: meta.mirror_path,
          shaPin: prep.sha_pin,
          tightenedSpec: tightenedSpec ?? taskBody,
          acceptanceCriteria: entry.row.acceptance_criteria ?? [],
          tier,
          softFindings: lastSweep.results.flatMap((r) =>
            r.findings.filter((f) => f.severity === "soft"),
          ),
          highStakesGlobs: this.opts.projectGlobs?.high_stakes_globs ?? [],
        });
      } catch (err) {
        stopReviewerTyping();
        await this.completeRun(entry, meta, "failed", `reviewer: ${String(err)}`);
        return;
      } finally {
        stopReviewerTyping();
      }
      await this.persistReviewerAttempt(entry.run_id, attempt, lastReviewer);
      const hardGapCount = lastReviewer.output.gaps.filter(
        (g) => g.severity === "hard",
      ).length;
      const softGapCount = lastReviewer.output.gaps.filter(
        (g) => g.severity === "soft",
      ).length;
      meta.reviewer_history.push({
        attempt,
        ok: lastReviewer.ok,
        verdict: lastReviewer.output.verdict,
        hard_gaps: hardGapCount,
        soft_gaps: softGapCount,
        confidence_signal: lastReviewer.output.confidence_signal,
      });
      meta.last_reviewer = {
        ok: lastReviewer.ok,
        verdict: lastReviewer.output.verdict,
        hard_gaps: hardGapCount,
        soft_gaps: softGapCount,
        confidence_signal: lastReviewer.output.confidence_signal,
      };
      await this.writeMeta(meta);
      await this.logRunEvent(entry, {
        kind: "reviewer_verdict",
        summary: `${lastReviewer.output.verdict} · ${hardGapCount} hard / ${softGapCount} soft · conf=${lastReviewer.output.confidence_signal}`,
        data: {
          verdict: lastReviewer.output.verdict,
          hard_gaps: hardGapCount,
          soft_gaps: softGapCount,
          confidence: lastReviewer.output.confidence_signal,
        },
      });

      if (!lastReviewer.ok) {
        // Reviewer rejected. Retry if attempts left, else fail.
        if (attempt >= maxAttempts) {
          await this.completeRun(
            entry,
            meta,
            "failed",
            `reviewer failed-honesty-check after ${attempt} attempt(s); ${hardGapCount} hard gap(s); verdict=${lastReviewer.output.verdict}`,
          );
          return;
        }
        remediationBody = formatReviewerRemediation(lastReviewer.output, {
          attempt,
          maxAttempts,
        });
        attempt += 1;
        continue;
      }

      // ── UAT pipeline (Layer U, Phase 11) ───────────────────────────────
      if (this.opts.bypassUat === true) {
        await this.completeRun(entry, meta, "succeeded");
        return;
      }
      await this.surfacePhase(entry, meta, "uat");
      let uatResult: UatRunResult;
      const stopUatTyping = this.startTaskTyping(entry);
      try {
        uatResult = await this.runUatStep({
          mirrorPath: meta.mirror_path,
          shaPin: prep.sha_pin,
          tightenedSpec: tightenedSpec ?? taskBody,
          acceptanceCriteria: entry.row.acceptance_criteria ?? [],
          taskId: entry.task_id,
          runId: entry.run_id,
          tier,
          sensorIdsPassed: lastSweep.results.filter((r) => r.ok).map((r) => r.sensor_id),
          highStakesGlobs: this.opts.projectGlobs?.high_stakes_globs ?? [],
        });
      } catch (err) {
        stopUatTyping();
        await this.completeRun(entry, meta, "failed", `uat: ${String(err)}`);
        return;
      } finally {
        stopUatTyping();
      }
      const probeFailures = uatResult.probe_results.filter((r) => !r.passed && !r.skipped_reason).length;
      meta.uat_history.push({
        attempt,
        ok: uatResult.ok,
        all_passed: uatResult.summary.all_passed,
        probe_failures: probeFailures,
        operator_decision: uatResult.operator_decision ?? "pending",
      });
      meta.last_uat = {
        ok: uatResult.ok,
        all_passed: uatResult.summary.all_passed,
        probe_failures: probeFailures,
        operator_decision: uatResult.operator_decision ?? "pending",
      };
      await this.writeMeta(meta);
      await this.logRunEvent(entry, {
        kind: "uat_decision",
        summary: `${uatResult.operator_decision ?? "pending"} · ${uatResult.summary.all_passed ? "all probes passed" : `${probeFailures} probe failures`}`,
        data: {
          operator_decision: uatResult.operator_decision ?? "pending",
          all_passed: uatResult.summary.all_passed,
          probe_failures: probeFailures,
        },
      });

      if (uatResult.ok) {
        // ── Backprop subagent (Phase 13) ───────────────────────────────
        if (this.opts.bypassBackprop !== true) {
          await this.surfacePhase(entry, meta, "backpropping");
          await this.runBackpropStep({
            mirrorPath: meta.mirror_path,
            shaPin: prep.sha_pin,
            tightenedSpec: tightenedSpec ?? taskBody,
            acceptanceCriteria: entry.row.acceptance_criteria ?? [],
            runId: entry.run_id,
            tier: this.opts.backpropTier ?? tier,
            softFindings: (lastSweep?.results ?? []).flatMap((r) =>
              r.findings.filter((f) => f.severity === "soft").map((f) => f.message),
            ),
            uatRejectionNote: uatResult.rejection?.operator_note,
            taskBody,
            meta,
          });
          await this.writeMeta(meta);
        }
        await this.completeRun(entry, meta, "succeeded");
        return;
      }

      // UAT-rejection-driven retry (Phase 11.x). When operator rejects with
      // a captured A/B/C/D rejection AND attempts remain, write the
      // rejection back to the implementer as remediation context and let
      // the loop re-dispatch. Probe-only failures with operator approval
      // path through `uatResult.ok=true`; probe-only failures without
      // operator action terminal-fail since the operator never weighed in.
      const isOperatorReject =
        uatResult.operator_decision === "reject" && uatResult.rejection !== undefined;
      if (isOperatorReject && attempt < maxAttempts) {
        remediationBody = formatUatRejectionRemediation({
          rejection: uatResult.rejection!,
          summary: uatResult.summary,
          attempt: attempt + 1,
          maxAttempts,
        });
        attempt += 1;
        continue;
      }

      const reason = isOperatorReject
        ? `uat rejected by operator after ${attempt} attempt(s) [${uatResult.rejection!.category}]: ${uatResult.rejection!.operator_note || "(no note)"}`
        : !uatResult.summary.all_passed
          ? `uat probes failed: ${probeFailures} of ${uatResult.probe_results.length}`
          : `uat decision=${uatResult.operator_decision ?? "pending"}; not approved`;
      await this.completeRun(entry, meta, "failed", reason);
      return;
    }
  }

  private async persistSensorAttempt(
    runId: string,
    attempt: number,
    sweep: SensorSweepResult,
  ): Promise<void> {
    const dir = join(this.opts.repoRoot, RUNS_ACTIVE_REL, runId, "sensors");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, `attempt-${attempt}.json`),
      JSON.stringify(sweep, null, 2),
      "utf8",
    );
  }

  private async persistReviewerAttempt(
    runId: string,
    attempt: number,
    result: ReviewerResult,
  ): Promise<void> {
    const dir = join(this.opts.repoRoot, RUNS_ACTIVE_REL, runId, "reviewer");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, `attempt-${attempt}.json`),
      JSON.stringify(result, null, 2),
      "utf8",
    );
  }

  /**
   * Phase 14 — process a Discord-issued direction row through the
   * decision-capture flow. Runs the Tier-1 extractor → writes a draft →
   * fires the confirm dialog through the first-registered adapter →
   * accepts / edits / rejects + regenerates the ledger.
   *
   * Independent of the task FIFO. Failures are logged and the inbox row
   * is moved to processed/ regardless so we never replay.
   */
  /**
   * Phase 16.x — agent-initiated operator question (`harness_ask_operator`
   * MCP tool). The implementer agent writes a `<id>.q.json` under
   * `.harness/runs/active/<run_id>/questions/`; chokidar fires this
   * handler. We:
   *   1. Find the active run's task channel.
   *   2. Build a pinging dialog spec (alerts the operator on mobile).
   *   3. requestDialog → operator answers (or times out).
   *   4. Write `<id>.a.json` with the answer; the MCP tool's poller
   *      picks it up and returns to the agent.
   */
  private async absorbQuestionFile(file: string): Promise<void> {
    if (this.answeredQuestions.has(file)) return;
    this.answeredQuestions.add(file);

    const { readFile, writeFile: writeFileAsync } = await import("node:fs/promises");
    let payload: {
      id: string;
      run_id: string;
      question: string;
      options?: string[];
      category?: string;
      timeout_ms?: number;
    };
    try {
      const raw = await readFile(file, "utf8");
      payload = JSON.parse(raw);
    } catch (err) {
      log.warn({ err: String(err), file }, "failed to parse question file");
      return;
    }
    const adapter = this.opts.adapters[0];
    const aPath = file.replace(/\.q\.json$/, ".a.json");
    if (adapter === undefined) {
      log.warn({ file }, "no adapter — answering question with timed_out");
      try {
        await writeFileAsync(
          aPath,
          JSON.stringify({
            answered_at: new Date().toISOString(),
            answer: "",
            timed_out: true,
          }),
          "utf8",
        );
      } catch (err) {
        log.warn({ err: String(err), aPath }, "failed to write answer");
      }
      return;
    }

    // Look up the channelId from active runs/<run_id>/meta.json.
    let channelId: string | undefined;
    try {
      const metaPath = join(
        this.opts.repoRoot,
        ".harness",
        "runs",
        "active",
        payload.run_id,
        "meta.json",
      );
      const raw = await readFile(metaPath, "utf8");
      const meta = JSON.parse(raw) as { channel_id?: string };
      if (typeof meta.channel_id === "string") channelId = meta.channel_id;
    } catch {
      // best-effort
    }

    const options = payload.options ?? [];
    const choices =
      options.length > 0
        ? options.slice(0, 4).map((label, idx) => ({
            id: String.fromCharCode(0x61 + idx),
            label: String.fromCharCode(0x41 + idx),
          }))
        : [{ id: "ack", label: "👍 noted (free-form reply not yet supported)" }];
    const optionsBlock =
      options.length > 0
        ? options
            .slice(0, 4)
            .map(
              (label, idx) => `**${String.fromCharCode(0x41 + idx)}.** ${label}`,
            )
            .join("\n\n")
        : "_(agent did not provide options — replying with 👍 records `ack`; future versions support free-form replies)_";
    const categoryBadge = payload.category
      ? `**[${payload.category.toUpperCase()}]** `
      : "";
    const dialogSpec: import("../frontend/index.js").DialogSpec = {
      bundleId: `ask:${payload.run_id}:${payload.id}`,
      prompt: `🛑 **Agent paused — ${payload.run_id}**\n\n${categoryBadge}${payload.question}\n\n${optionsBlock}`,
      choices,
      timeoutMs: payload.timeout_ms ?? 10 * 60_000,
      pingOperators: true,
    };
    if (channelId !== undefined) dialogSpec.channelId = channelId;

    let answer: { answered_at: string; answer: string; choice_id?: string; timed_out?: boolean } = {
      answered_at: new Date().toISOString(),
      answer: "",
      timed_out: true,
    };
    try {
      const response = await adapter.requestDialog(dialogSpec);
      if (response.timedOut) {
        answer = {
          answered_at: new Date().toISOString(),
          answer: "",
          timed_out: true,
        };
      } else if (options.length > 0) {
        const idx = response.choiceId.charCodeAt(0) - 0x61;
        const chosen = options[idx];
        answer = {
          answered_at: new Date().toISOString(),
          answer: chosen ?? response.choiceId,
          choice_id: response.choiceId,
        };
      } else {
        answer = {
          answered_at: new Date().toISOString(),
          answer: response.freeText ?? "ack",
          choice_id: response.choiceId,
        };
      }
    } catch (err) {
      log.warn({ err: String(err), file }, "ask-operator dialog threw");
    }

    try {
      await writeFileAsync(aPath, JSON.stringify(answer, null, 2), "utf8");
    } catch (err) {
      log.warn({ err: String(err), aPath }, "failed to write answer");
    }
  }

  private async handleDirectionRow(
    row: import("./inbox.js").InboxDirectionRow,
    file: string,
  ): Promise<void> {
    const adapter = this.opts.adapters[0];
    const rawText = directionTextOf(row);
    const authorId = directionAuthorOf(row);
    const channelId = directionChannelOf(row);
    if (rawText.length === 0 || adapter === undefined) {
      log.warn(
        { file, has_adapter: adapter !== undefined, raw_text_len: rawText.length },
        "direction row dropped — empty text or no adapter",
      );
      await moveToProcessed(this.opts.repoRoot, file, "ignored");
      return;
    }

    const { runDecisionCapture } = await import("../decision-capture/index.js");
    try {
      const result = await runDecisionCapture({
        repoRoot: this.opts.repoRoot,
        rawText,
        authorId,
        source: `${row.source}:${row.kind}`,
        receivedAt: row.received_at,
        adapter,
        ...(channelId !== undefined ? { channelId } : {}),
        tier: this.opts.decisionExtractorTier ?? "haiku",
        ...(this.opts.decisionConfirmTimeoutMs !== undefined
          ? { confirmTimeoutMs: this.opts.decisionConfirmTimeoutMs }
          : {}),
        ...(this.opts.bypassRefinement === true
          ? { bypassRefinement: true }
          : {}),
        ...(this.opts.refinementTier !== undefined
          ? { refinementTier: this.opts.refinementTier }
          : {}),
        ...(this.opts.refinementDialogTimeoutMs !== undefined
          ? { refinementDialogTimeoutMs: this.opts.refinementDialogTimeoutMs }
          : {}),
      });
      log.info(
        {
          source: row.source,
          kind: row.kind,
          short_circuited: result.short_circuited,
          decision: result.confirm?.decision,
          accepted_path: result.confirm?.accepted_path,
        },
        "decision-capture complete",
      );
    } catch (err) {
      log.error({ err: String(err), file }, "decision-capture threw");
    }
    await moveToProcessed(this.opts.repoRoot, file, "succeeded");
  }

  private async runBackpropStep(args: {
    mirrorPath: string;
    shaPin: string;
    tightenedSpec: string;
    acceptanceCriteria: string[];
    runId: string;
    tier: "haiku" | "sonnet" | "opus";
    softFindings: string[];
    uatRejectionNote: string | undefined;
    taskBody: string;
    meta: RunMeta;
  }): Promise<void> {
    const { runBackprop } = await import("../backprop/index.js");
    const { simpleGit } = await import("simple-git");

    const diff = await getDiff({ mirrorPath: args.mirrorPath, shaPin: args.shaPin });
    const decisions = loadAcceptedDecisions(args.mirrorPath);
    const inScope = decisionsInScope(decisions, diff);
    const decisionIds = inScope.map((d) => d.id);

    const failureSummaryParts: string[] = [];
    if (args.uatRejectionNote) failureSummaryParts.push(`UAT rejection: ${args.uatRejectionNote}`);
    if (args.softFindings.length > 0) {
      failureSummaryParts.push(`Soft sensor findings on this run: ${args.softFindings.join("; ")}`);
    }
    if (failureSummaryParts.length === 0) {
      failureSummaryParts.push(
        `No prior failure recorded — task body: ${args.taskBody.slice(0, 500)}`,
      );
    }
    const failure_summary = failureSummaryParts.join("\n\n");

    let result;
    try {
      result = await runBackprop({
        mirrorPath: args.mirrorPath,
        tightened_spec: args.tightenedSpec,
        acceptance_criteria: args.acceptanceCriteria,
        diff,
        failure_summary,
        run_id: args.runId,
        in_scope_decision_ids: decisionIds,
        tier: args.tier,
      });
    } catch (err) {
      args.meta.last_backprop = {
        ok: false,
        invariant_id: "",
        invariant_path: "",
        sensor_path: "",
        enforcement_kind: "regex_sensor",
        error: String(err),
      };
      log.warn({ run_id: args.runId, err: String(err) }, "backprop failed");
      return;
    }

    // Persist result for telemetry.
    const dir = join(this.opts.repoRoot, RUNS_ACTIVE_REL, args.runId, "backprop");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "result.json"), JSON.stringify(result, null, 2), "utf8");

    // Commit the invariant + sensor in the mirror.
    let commitSha: string | undefined;
    try {
      const git = simpleGit({ baseDir: args.mirrorPath });
      await git.add([result.invariant_path, result.sensor_path]);
      const subject = `chore(invariants): add §${result.id} from run ${args.runId}`;
      const body = `Backprop subagent extracted invariant ${result.id} (${result.output.title}) from this run.\n\nEnforcement: ${result.output.enforcement.kind}\nInvariant: ${result.invariant_path}\nSensor: ${result.sensor_path}\n`;
      await git.commit(`${subject}\n\n${body}`);
      commitSha = (await git.revparse(["HEAD"])).trim();
    } catch (err) {
      log.warn(
        { run_id: args.runId, err: String(err) },
        "backprop commit failed — invariant + sensor written but uncommitted",
      );
    }

    args.meta.last_backprop = {
      ok: true,
      invariant_id: result.id,
      invariant_path: result.invariant_path,
      sensor_path: result.sensor_path,
      enforcement_kind: result.output.enforcement.kind,
      ...(commitSha !== undefined ? { commit_sha: commitSha } : {}),
    };
  }

  private async runUatStep(args: {
    mirrorPath: string;
    shaPin: string;
    tightenedSpec: string;
    acceptanceCriteria: string[];
    taskId: string;
    runId: string;
    tier: "haiku" | "sonnet" | "opus";
    sensorIdsPassed: string[];
    highStakesGlobs: string[];
  }): Promise<UatRunResult> {
    const diff = await getDiff({ mirrorPath: args.mirrorPath, shaPin: args.shaPin });
    const isHighStakes =
      args.highStakesGlobs.length > 0 &&
      diff.some((d) => matchAnyGlob(d.path, args.highStakesGlobs));

    const linesAdded = diff.reduce(
      (n, e) => n + countAddedLines(e.beforeContent, e.afterContent),
      0,
    );
    const linesRemoved = diff.reduce(
      (n, e) => n + countAddedLines(e.afterContent, e.beforeContent),
      0,
    );

    const approvalGate: ApprovalGate = async (gateArgs) => {
      const adapter = this.opts.adapters[0];
      if (!adapter) {
        // No adapter — auto-approve when all probes passed; otherwise reject
        // with a synthetic D-category rejection so the retry loop has a
        // stable shape (the smoke env exercises this branch).
        if (gateArgs.summary.all_passed) return { decision: "approve" };
        return {
          decision: "reject",
          rejection: {
            category: "D",
            operator_note: "no frontend adapter configured; auto-rejected on probe failure",
            rejected_at: new Date().toISOString(),
          },
        };
      }
      const approval = await adapter.requestApproval({
        bundleId: `uat-${gateArgs.runId}`,
        runId: gateArgs.runId,
        taskId: gateArgs.taskId,
        goal: gateArgs.summary.goal_one_liner,
        diffSummary: `${gateArgs.summary.diff_stats.files_changed} files / +${gateArgs.summary.diff_stats.lines_added} -${gateArgs.summary.diff_stats.lines_removed}`,
        acceptance: gateArgs.summary.acceptance_results.map((r) => ({
          id: r.id,
          status: r.status === "skipped" ? "pending" : r.status,
          ...(r.failure_reason !== undefined ? { note: r.failure_reason } : {}),
        })),
        artifacts: gateArgs.summary.artifacts.map((a) => ({
          kind: a.kind === "screenshot"
            ? "screenshot"
            : a.kind === "video"
              ? "gif"
              : a.kind === "transcript"
                ? "log"
                : a.kind === "log"
                  ? "log"
                  : "text" as const,
          path: a.path,
          ...(a.caption !== undefined ? { label: a.caption } : {}),
        })),
      });
      const decision: "approve" | "reject" | "ask" =
        approval.decision === "approve"
          ? "approve"
          : approval.decision === "reject"
            ? "reject"
            : "ask";
      const out: {
        decision: "approve" | "reject" | "ask" | "abandoned";
        rejection?: import("../uat/index.js").UatRejection;
        questionText?: string;
      } = {
        decision: approval.timedOut === true ? "abandoned" : decision,
      };
      if (decision === "reject") {
        // Run the post-reject A/B/C/D dialog (with optional voice URL
        // transcription) to get a structured UatRejection.
        out.rejection = await captureUatRejection({
          adapter,
          runId: gateArgs.runId,
          taskId: gateArgs.taskId,
          ...(approval.reason !== undefined ? { initialReason: approval.reason } : {}),
          ...(this.opts.uatRejectDialogTimeoutMs !== undefined
            ? { timeoutMs: this.opts.uatRejectDialogTimeoutMs }
            : {}),
        });
      }
      if (decision === "ask") {
        // Pass the operator's question text through (Approval.reason
        // carries it). runUat's loop will call questionHandler + notifier.
        if (approval.reason !== undefined) out.questionText = approval.reason;
      }
      return out;
    };

    // Build the question handler for the ❓ Ask loop. Reuses the same tier
    // as the implementer (cheap; reading-only) — operator can override
    // explicitly via opts.uatQuestionTier.
    const questionHandler: QuestionHandler | undefined = (() => {
      // Always offer a handler — runUat gracefully degrades if absent.
      return async (qArgs) => {
        return runQuestionAgent({
          question: qArgs.question,
          tightened_spec: args.tightenedSpec,
          acceptance_criteria: args.acceptanceCriteria,
          changed_files: diff.map((d) => ({ path: d.path, status: d.status })),
          summary: qArgs.summary,
          ...(this.opts.uatQuestionTier !== undefined
            ? { tier: this.opts.uatQuestionTier }
            : {}),
        });
      };
    })();

    const notifier: UatNotifier | undefined = (() => {
      const adapter = this.opts.adapters[0];
      if (!adapter) return undefined;
      return async (level, message) => {
        try {
          await adapter.notify(level, message);
        } catch (err) {
          log.warn({ err: String(err) }, "uat notifier failed");
        }
      };
    })();

    const hints = this.opts.uatHints ?? {};
    return runUat({
      repoRoot: args.mirrorPath,
      runId: args.runId,
      taskId: args.taskId,
      runnerInput: {
        tightened_spec: args.tightenedSpec,
        acceptance_criteria: args.acceptanceCriteria,
        changed_files: diff.map((d) => ({ path: d.path, status: d.status })),
        hints,
        is_high_stakes: isHighStakes,
        tier: args.tier,
      },
      diffStats: {
        files_changed: diff.length,
        lines_added: linesAdded,
        lines_removed: linesRemoved,
      },
      sensorsPassed: args.sensorIdsPassed,
      reviewerVerdict: this.opts.bypassReviewer === true ? "skipped" : "pass",
      approvalGate,
      ...(this.opts.uatColdStartCommand !== undefined
        ? { coldStartCommand: this.opts.uatColdStartCommand }
        : {}),
      ...(questionHandler !== undefined ? { questionHandler } : {}),
      ...(notifier !== undefined ? { notifier } : {}),
      ...(this.opts.uatMaxQuestionRounds !== undefined
        ? { maxQuestionRounds: this.opts.uatMaxQuestionRounds }
        : {}),
    });
  }

  private async runReviewerStep(args: {
    mirrorPath: string;
    shaPin: string;
    tightenedSpec: string;
    acceptanceCriteria: string[];
    tier: "haiku" | "sonnet" | "opus";
    softFindings: import("../sensors/index.js").SensorFinding[];
    highStakesGlobs: string[];
  }): Promise<ReviewerResult> {
    const diff = await getDiff({
      mirrorPath: args.mirrorPath,
      shaPin: args.shaPin,
    });
    const accepted = loadAcceptedDecisions(args.mirrorPath);
    const inScope = decisionsInScope(accepted, diff);
    const isHighStakes =
      args.highStakesGlobs.length > 0 &&
      diff.some((d) => matchAnyGlob(d.path, args.highStakesGlobs));
    return runReviewer({
      tightened_spec: args.tightenedSpec,
      acceptance_criteria: args.acceptanceCriteria,
      diff,
      decisions_in_scope: inScope,
      soft_findings: args.softFindings,
      is_high_stakes: isHighStakes,
      tier: args.tier,
    });
  }

  private async renderPrompt(args: {
    runId: string;
    mirrorPath: string;
    shaPin: string;
    taskBody: string;
    acceptance: string[];
  }): Promise<string> {
    let template: string;
    try {
      template = loadWorkflowTemplate(this.opts.repoRoot);
    } catch {
      // Repo doesn't ship a workflow.md (e.g. fresh smoke env). Use a
      // minimal inline default — same shape, fewer placeholders.
      template = [
        "## Identity",
        "You are running inside the harness as agent role `{{agent_role}}` for project `{{project_name}}`. Your run-id is `{{run_id}}`. The mirror checkout is at `{{mirror_path}}` pinned to origin/main SHA `{{sha_pin}}`. Do not modify files outside the mirror. Do not commit; do not push.",
        "",
        "## Task",
        "{{tightened_spec_body}}",
        "",
        "## Acceptance criteria",
        "{{#each acceptance_criteria}}",
        "- {{this}}",
        "{{/each}}",
      ].join("\n");
    }
    return renderTemplate(template, {
      agent_role: "implementer",
      project_name: this.opts.projectName,
      run_id: args.runId,
      mirror_path: args.mirrorPath,
      sha_pin: args.shaPin,
      tightened_spec_body: args.taskBody,
      acceptance_criteria: args.acceptance,
      in_scope_decisions: [],
      in_scope_invariants: [],
      off_limits: [".git", ".env", ".env.local"],
      scoped_sensors: [],
    });
  }

  private async surfacePhase(
    entry: QueueEntry,
    meta: RunMeta,
    phase: RunPhase,
  ): Promise<void> {
    return this.surfacePhaseWithBody(entry, meta, phase);
  }

  /**
   * Ask any adapter that supports it whether `channelId` is still
   * reachable. Adapters that don't expose `isChannelAlive` (CLI / stub)
   * are treated as "always alive." If multiple adapters answer, ALL
   * must say true — any single dead vote → false (dispatching to a
   * dead channel for one adapter would lose surfacing on that adapter).
   */
  private async isChannelAlive(channelId: string): Promise<boolean> {
    let answered = false;
    for (const adapter of this.opts.adapters) {
      if (typeof adapter.isChannelAlive === "function") {
        try {
          const alive = await adapter.isChannelAlive(channelId);
          if (!alive) return false;
          answered = true;
        } catch (err) {
          log.warn(
            { err: String(err), adapter: adapter.name },
            "isChannelAlive threw — treating as dead",
          );
          return false;
        }
      }
    }
    // No adapter answered → no channel-aware adapter registered. Treat
    // as alive so CLI / stub dispatch normally.
    void answered;
    return true;
  }

  /**
   * During the implementer phase, summarize recent stream-jsonl events
   * via Tier-0 every ~8s and patch the live status embed's `activity`
   * field. Operator sees the agent's tool calls + text in plain
   * English ("Reading X", "Running tsc") instead of a static
   * "running" badge.
   *
   * Returns a stop fn that clears the interval. Safe to call when
   * adapters are missing or channelId is undefined.
   */
  private startActivityFeed(
    entry: QueueEntry,
    meta: RunMeta,
    window: Record<string, unknown>[],
  ): () => void {
    const channelId = entry.row.task.channelId;
    if (channelId === undefined) return () => {};
    let stopped = false;
    let lastSummary = "";
    const tick = async () => {
      if (stopped) return;
      // Skip when the window's barely populated to avoid burning the
      // first call on system-init noise.
      if (window.length < 2) return;
      try {
        const summary = await summarizeActivity({
          events: window.slice(),
        });
        if (stopped) return;
        // §3.3 win 2 — second-source tool digest from raw events.
        // Independent of Ollama; surfaces even when summary fails.
        const tools = extractToolDigest(window);
        const recentEvents = await this.readLogTailFormatted(entry.run_id, 5);
        if (summary === lastSummary && digestIsEmpty(tools)) return;
        lastSummary = summary;
        const taskBody = entry.row.task.rawText;
        for (const adapter of this.opts.adapters) {
          try {
            await adapter.postTaskUpdate({
              taskId: entry.task_id,
              runId: entry.run_id,
              status: meta.phase,
              activity: summary,
              ...(taskBody !== undefined && taskBody.length > 0
                ? { taskBody }
                : {}),
              ...(digestIsEmpty(tools) ? {} : { tools }),
              ...(recentEvents.length > 0 ? { recentEvents } : {}),
              ...(channelId !== undefined ? { channelId } : {}),
            });
          } catch (err) {
            log.warn(
              { err: String(err), adapter: adapter.name },
              "activity-feed postTaskUpdate failed",
            );
          }
        }
      } catch (err) {
        log.warn({ err: String(err) }, "activity-feed tick failed");
      }
    };
    // First summary fires after ~5s so the agent has time to do
    // something interesting; subsequent ticks every 8s.
    const initial = setTimeout(() => void tick(), 5_000);
    const interval = setInterval(() => void tick(), 8_000);
    return () => {
      stopped = true;
      clearTimeout(initial);
      clearInterval(interval);
    };
  }

  /**
   * Start a Discord-style "typing" indicator on the task's channel for
   * any adapter that supports it. Returns a stop fn that clears the
   * heartbeat. Safe to call when no adapter / no channelId — returns
   * a no-op stop fn.
   */
  private startTaskTyping(entry: QueueEntry): () => void {
    const channelId = entry.row.task.channelId;
    if (channelId === undefined) return () => {};
    const stops: Array<() => void> = [];
    for (const adapter of this.opts.adapters) {
      if (typeof adapter.startTyping === "function") {
        try {
          stops.push(adapter.startTyping(channelId));
        } catch (err) {
          log.warn(
            { err: String(err), adapter: adapter.name },
            "startTyping threw — skipping",
          );
        }
      }
    }
    return () => {
      for (const s of stops) {
        try {
          s();
        } catch {
          // best-effort
        }
      }
    };
  }

  private async surfacePhaseWithBody(
    entry: QueueEntry,
    meta: RunMeta,
    phase: RunPhase,
    body?: string,
    extras?: {
      failureClass?: PostUpdate["failureClass"];
      remediation?: PostUpdate["remediation"];
    },
  ): Promise<void> {
    meta.phase = phase;
    await this.writeMeta(meta);
    // §3.3 — log the transition before reading the tail so the entry
    // appears in the embed's recent-events strip.
    await this.logRunEvent(entry, {
      kind: "phase_changed",
      summary: `→ ${phase}${body !== undefined && body.length > 0 ? ` (with body ${body.length} chars)` : ""}`,
    });
    const channelId = entry.row.task.channelId;
    const recentEvents = await this.readLogTailFormatted(entry.run_id, 5);
    const tools = await this.readToolDigestFromEvents(entry.run_id);
    const taskBody = entry.row.task.rawText;
    for (const adapter of this.opts.adapters) {
      try {
        await adapter.postTaskUpdate({
          taskId: entry.task_id,
          runId: entry.run_id,
          status: phase,
          ...(taskBody !== undefined && taskBody.length > 0
            ? { taskBody }
            : {}),
          ...(body !== undefined ? { body } : {}),
          ...(channelId !== undefined ? { channelId } : {}),
          ...(recentEvents.length > 0 ? { recentEvents } : {}),
          ...(digestIsEmpty(tools) ? {} : { tools }),
          ...(extras?.failureClass !== undefined
            ? { failureClass: extras.failureClass }
            : {}),
          ...(extras?.remediation !== undefined
            ? { remediation: extras.remediation }
            : {}),
        });
      } catch (err) {
        log.warn({ err: String(err), adapter: adapter.name }, "postTaskUpdate failed");
      }
    }
  }

  // §3.3 — run-log + tool-digest helpers used by surfacePhase + activityFeed.

  private async logRunEvent(
    entry: QueueEntry,
    args: { kind: RunLogKind; summary: string; data?: Record<string, unknown> },
  ): Promise<void> {
    await appendRunLogEntry({
      repoRoot: this.opts.repoRoot,
      runId: entry.run_id,
      taskId: entry.task_id,
      kind: args.kind,
      summary: args.summary,
      ...(args.data !== undefined ? { data: args.data } : {}),
    });
    // Self-emitted watchdog events (and the phase_changed they trigger
    // via surfacePhaseWithBody) do NOT count as progress — otherwise the
    // watchdog would reset its own idle clock and re-fire forever.
    if (
      this.activeRun?.entry.run_id === entry.run_id &&
      args.kind !== "watchdog_stall"
    ) {
      this.activeRun.lastEventAt = Date.now();
    }
  }

  /**
   * Watchdog tick — runs every 30s. If the active run has been silent
   * past `stallSeconds` AND the phase is one that should be producing
   * events, post a single remediation embed pointing the operator at
   * `/halt` + `/status`. Operator-pending phases (`blocked`) are
   * excluded — those wait for the human and are silent on purpose.
   * Fires once per stall episode; resets on the next log event.
   */
  private async checkRunWatchdog(): Promise<void> {
    const a = this.activeRun;
    if (a === undefined) return;
    const stallSeconds =
      this.opts.watchdogStallSeconds ?? 90;
    const now = Date.now();
    const idleMs = now - a.lastEventAt;
    if (idleMs < stallSeconds * 1000) return;
    // Throttle: don't re-post within stallSeconds of the last post.
    if (
      a.lastWatchdogPostedAt !== undefined &&
      now - a.lastWatchdogPostedAt < stallSeconds * 1000
    ) {
      return;
    }
    const phase = a.meta.phase;
    const watchedPhases: RunPhase[] = [
      "tightening",
      "prepping",
      "running",
      "sensing",
      "reviewing",
      "uat",
      "backpropping",
    ];
    if (!watchedPhases.includes(phase)) return;
    a.lastWatchdogPostedAt = now;
    log.warn(
      { run_id: a.meta.run_id, phase, idle_seconds: Math.floor(idleMs / 1000) },
      "watchdog: run silent past threshold",
    );
    await this.logRunEvent(a.entry, {
      kind: "watchdog_stall",
      summary: `silent ${Math.floor(idleMs / 1000)}s in ${phase}`,
      data: { phase, idle_seconds: Math.floor(idleMs / 1000) },
    });
    try {
      await this.surfacePhaseWithBody(
        a.entry,
        a.meta,
        phase,
        `Run ${a.meta.run_id} is idle in **${phase}** for ${Math.floor(idleMs / 1000)}s. If you think it's hung, \`/halt\` clears it; \`/status\` shows queue + recent runs.`,
        {
          remediation: {
            reason: `no events in ${Math.floor(idleMs / 1000)}s during ${phase}`,
            suggestedActions: [
              `\`/halt ${a.meta.run_id}\` — kill this run`,
              `\`/status\` — see queue + recent runs`,
              `wait — agents can pause briefly between tool calls`,
            ],
          },
        },
      );
    } catch (err) {
      log.warn({ err: String(err) }, "watchdog surface failed");
    }
  }

  private async readLogTailFormatted(
    runId: string,
    n: number,
  ): Promise<string[]> {
    const entries = await readRunLogTail({
      repoRoot: this.opts.repoRoot,
      runId,
      n,
    });
    return entries.map((e) => formatRunLogLine(e));
  }

  private async readToolDigestFromEvents(runId: string): Promise<ToolDigest> {
    const path = join(
      this.opts.repoRoot,
      RUNS_ACTIVE_REL,
      runId,
      "events.jsonl",
    );
    if (!existsSync(path)) return { files: [], bash: [], searches: [] };
    let text: string;
    try {
      text = await readFile(path, "utf8");
    } catch {
      return { files: [], bash: [], searches: [] };
    }
    const lines = text.split("\n").filter((s) => s.length > 0);
    const tail = lines.slice(Math.max(0, lines.length - 250));
    const events: Record<string, unknown>[] = [];
    for (const line of tail) {
      try {
        const parsed = JSON.parse(line) as Record<string, unknown>;
        events.push(parsed);
      } catch {
        // skip malformed
      }
    }
    return extractToolDigest(events);
  }

  /**
   * Walk the tightener's ambiguities one-at-a-time, then dispatch with
   * the resolved spec.
   *
   * Per operator pivot: replace the single-blob dialog with per-question
   * A/B/C walks. Each ambiguity dialog has up to 4 buttons (the LLM's
   * candidate_resolutions, capped at 4) plus a final approve/ship-anyway/
   * cancel confirm after the walk.
   *
   * Returns:
   *   - { decision: "approve", resolved_spec }   → run with this spec
   *   - { decision: "ship_anyway" }              → run with original body
   *   - { decision: "edit"|"cancel"|"timeout" }  → fail run
   */
  private async requestTightenerDecision(args: {
    entry: QueueEntry;
    meta: RunMeta;
    tightened: import("../tightener/index.js").TightenerResult;
  }): Promise<{
    decision: "approve" | "ship_anyway" | "edit" | "cancel" | "timeout";
    resolved_spec?: string;
  }> {
    const adapter = this.opts.adapters[0];
    if (adapter === undefined) {
      log.warn(
        { task_id: args.entry.task_id },
        "no adapter registered — cannot dialog; defaulting to cancel",
      );
      return { decision: "cancel" };
    }
    const channelId = args.entry.row.task.channelId;
    const ambiguities = args.tightened.output.ambiguities;
    const walkable = ambiguities.filter((a) => a.candidate_resolutions.length >= 2);
    const resolutions: { id: string; question: string; choice: string }[] = [];

    // §3.4 win 1 — per-Q walk threads replaceBundleId so the adapter edits
    // ONE message in place across all steps + the final confirm. First
    // step is a fresh send; subsequent steps reuse the same message id.
    let prevBundleId: string | undefined;

    // ── Per-ambiguity walk (only when we have ≥2 candidates each). ─────
    for (let i = 0; i < walkable.length; i++) {
      const a = walkable[i]!;
      // Cap at 4 candidates so the dialog stays readable.
      const candidates = a.candidate_resolutions.slice(0, 4);
      // Tightened prompt: bold step indicator, single-line options
      // anchored by bold letter + middle-dot. No double-newline mush.
      const optionsBlock = candidates
        .map(
          (label, idx) =>
            `**${String.fromCharCode(0x41 + idx)}** · ${label}`,
        )
        .join("\n");
      const stepBundleId = `${args.entry.task_id}:${a.id}`;
      const dialogSpec: import("../frontend/index.js").DialogSpec = {
        bundleId: stepBundleId,
        prompt: `**${a.id} of ${walkable.length}** — ${a.question}\n\n${optionsBlock}`,
        choices: candidates.map((_, idx) => ({
          id: String.fromCharCode(0x61 + idx), // a, b, c, d
          label: String.fromCharCode(0x41 + idx), // A, B, C, D
        })),
        timeoutMs: 5 * 60_000,
        // Walk steps must NOT compact — the next requestDialog edits
        // this same message in place via replaceBundleId. Compaction
        // would race the edit and the answer annotation can drop the
        // next prompt entirely (operator stuck on Qn answered, no Qn+1).
        compactOnAnswer: false,
      };
      if (channelId !== undefined) dialogSpec.channelId = channelId;
      if (prevBundleId !== undefined) dialogSpec.replaceBundleId = prevBundleId;
      try {
        const response = await adapter.requestDialog(dialogSpec);
        if (response.timedOut) {
          await this.logRunEvent(args.entry, {
            kind: "tightener_q_timeout",
            summary: `${a.id} timed out`,
            data: { ambiguity: a.id },
          });
          return { decision: "timeout" };
        }
        const idx = response.choiceId.charCodeAt(0) - 0x61;
        const chosenText = candidates[idx];
        if (chosenText === undefined) {
          log.warn(
            {
              task_id: args.entry.task_id,
              ambiguity: a.id,
              choice: response.choiceId,
            },
            "unknown ambiguity choice — treating as cancel",
          );
          return { decision: "cancel" };
        }
        resolutions.push({ id: a.id, question: a.question, choice: chosenText });
        prevBundleId = stepBundleId;
        await this.logRunEvent(args.entry, {
          kind: "tightener_q_answered",
          summary: `${a.id}: ${response.choiceId.toUpperCase()} — ${chosenText.slice(0, 60)}`,
          data: {
            ambiguity: a.id,
            choice_id: response.choiceId,
            choice_text: chosenText,
            step: i + 1,
            total: walkable.length,
          },
        });
        // Refresh the live status with the answered Q so operator sees
        // walk progress in the recent feed even before the next Q's
        // edit-in-place lands.
        await this.surfacePhase(args.entry, args.meta, "blocked");
      } catch (err) {
        log.error(
          { err: String(err), task_id: args.entry.task_id, ambiguity: a.id },
          "ambiguity dialog threw — defaulting to cancel",
        );
        return { decision: "cancel" };
      }
    }

    // ── Final confirm. ────────────────────────────────────────────────
    const summary =
      resolutions.length > 0
        ? `Resolutions captured for ${resolutions.length} ambiguit${resolutions.length === 1 ? "y" : "ies"}. Dispatch?`
        : `Spec quality ${args.tightened.output.spec_quality_score}/10 below floor ${args.tightened.quality_floor} (no per-question walk available). How to proceed?`;
    const confirmSpec: import("../frontend/index.js").DialogSpec = {
      bundleId: `${args.entry.task_id}:confirm`,
      prompt: summary,
      choices: [
        { id: "approve", label: "🟢 dispatch with resolved spec" },
        { id: "ship_anyway", label: "⚡ /ship-anyway — use original body" },
        { id: "cancel", label: "🔴 cancel" },
      ],
      timeoutMs: 5 * 60_000,
    };
    if (channelId !== undefined) confirmSpec.channelId = channelId;
    if (prevBundleId !== undefined) confirmSpec.replaceBundleId = prevBundleId;
    try {
      const response = await adapter.requestDialog(confirmSpec);
      if (response.timedOut) return { decision: "timeout" };
      switch (response.choiceId) {
        case "approve": {
          const resolvedSpec = renderResolvedSpec({
            proposal: args.tightened.output.tightened_spec_proposal,
            resolutions,
          });
          return { decision: "approve", resolved_spec: resolvedSpec };
        }
        case "ship_anyway":
          return { decision: "ship_anyway" };
        case "cancel":
          return { decision: "cancel" };
        default:
          log.warn(
            { task_id: args.entry.task_id, choice: response.choiceId },
            "unknown confirm choice — treating as cancel",
          );
          return { decision: "cancel" };
      }
    } catch (err) {
      log.error(
        { err: String(err), task_id: args.entry.task_id },
        "confirm dialog threw — defaulting to cancel",
      );
      return { decision: "cancel" };
    }
  }

  private async completeRun(
    entry: QueueEntry,
    meta: RunMeta,
    phase: "succeeded" | "failed",
    error?: string,
  ): Promise<void> {
    meta.phase = phase;
    meta.finished_at = new Date().toISOString();
    if (error !== undefined) meta.error = error;
    await this.writeMeta(meta);
    await this.logRunEvent(entry, {
      kind: "run_completed",
      summary:
        error !== undefined
          ? `${phase} · ${error.slice(0, 80)}`
          : `${phase} · ${meta.attempts ?? 1} attempt(s)`,
      data: {
        phase,
        attempts: meta.attempts ?? 1,
        ...(error !== undefined ? { error } : {}),
      },
    });
    if (phase === "failed") {
      const failureClass = classifyFailure(error);
      const remediation = buildRemediation(failureClass, error, entry.run_id);
      await this.surfacePhaseWithBody(entry, meta, phase, undefined, {
        failureClass,
        remediation,
      });
    } else {
      await this.surfacePhase(entry, meta, phase);
    }
    try {
      await moveToProcessed(
        this.opts.repoRoot,
        entry.inbox_file,
        phase === "succeeded" ? "succeeded" : "failed",
      );
      this.seenInboxFiles.delete(entry.inbox_file);
    } catch (err) {
      log.warn({ err: String(err), file: entry.inbox_file }, "inbox move failed");
    }
    if (this.activeRun?.entry.run_id === entry.run_id) {
      this.activeRun = undefined;
    }
    log.info(
      { task_id: entry.task_id, run_id: entry.run_id, phase, error },
      "run complete",
    );
  }

  private async writeMeta(meta: RunMeta): Promise<void> {
    const dir = join(this.opts.repoRoot, RUNS_ACTIVE_REL, meta.run_id);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "meta.json"),
      JSON.stringify(meta, null, 2),
      "utf8",
    );
  }

  // ── Slash command surface (§3.2 — operator steering primitives) ─────

  private adapterForSource(source: string): FrontendAdapter | undefined {
    return this.opts.adapters.find((a) => a.name === source);
  }

  private async handleSlashRow(row: InboxSlashRow, file: string): Promise<void> {
    const cmd = row.slash.command;
    log.info(
      { cmd, by: row.slash.authorId, channel: row.slash.channelId },
      "slash dispatched",
    );
    try {
      switch (cmd) {
        case "halt":
          await this.handleHalt(row);
          break;
        case "status":
          await this.handleStatus(row);
          break;
        case "queue":
          await this.handleQueue(row);
          break;
        case "eval":
          await this.handleEval(row);
          break;
        case "resume":
          await this.handleResume(row);
          break;
        case "oops":
          await this.handleOops(row);
          break;
        case "help":
          await this.handleHelp(row);
          break;
        case "archive":
          await this.handleArchive(row);
          break;
        case "unpause":
          await this.handleUnpause(row);
          break;
        default: {
          log.info({ cmd }, "slash command not handled by orchestrator");
          const a = this.adapterForSource(row.source);
          if (a) await a.notify("info", `/${cmd} — not handled by orchestrator`);
        }
      }
    } catch (err) {
      log.warn({ err: String(err), cmd }, "slash handler threw");
      const a = this.adapterForSource(row.source);
      if (a) await a.notify("error", `/${cmd} failed: ${String(err)}`);
    } finally {
      try {
        await moveToProcessed(this.opts.repoRoot, file, "succeeded");
        this.seenInboxFiles.delete(file);
      } catch (err) {
        log.warn({ err: String(err), file }, "slash inbox move failed");
      }
    }
  }

  private async handleHalt(row: InboxSlashRow): Promise<void> {
    const adapter = this.adapterForSource(row.source);
    const requestedRunId =
      typeof row.slash.options["run-id"] === "string"
        ? (row.slash.options["run-id"] as string)
        : "";
    const active = this.activeRun;
    if (active === undefined) {
      await adapter?.notify("info", "/halt — no active run");
      return;
    }
    if (requestedRunId.length > 0 && requestedRunId !== active.meta.run_id) {
      await adapter?.notify(
        "warn",
        `/halt — run-id mismatch (requested ${requestedRunId}, active ${active.meta.run_id})`,
      );
      return;
    }
    log.warn(
      { run_id: active.meta.run_id, by: row.slash.authorId },
      "/halt requested",
    );
    await this.logRunEvent(active.entry, {
      kind: "halt_requested",
      summary: `by ${row.slash.authorId} during ${active.meta.phase}`,
      data: { by: row.slash.authorId, during: active.meta.phase },
    });
    active.abortController.abort("halted");
    await adapter?.notify(
      "warn",
      `🟥 /halt — SIGTERM sent to ${active.meta.run_id} (phase: ${active.meta.phase}); SIGKILL after 30s grace`,
    );
  }

  private async handleStatus(row: InboxSlashRow): Promise<void> {
    const adapter = this.adapterForSource(row.source);
    if (adapter === undefined) return;
    await adapter.notify("info", this.collectStatus());
  }

  private collectStatus(): string {
    const lines: string[] = [];
    lines.push("📊 Harness status");
    if (this.dispatchPaused) {
      lines.push(
        `  ⛔ DISPATCH PAUSED — ${this.dispatchPauseReason} (paused at ${this.dispatchPausedAt ?? "?"}; \`/unpause\` to clear)`,
      );
    }
    if (this.activeRun !== undefined) {
      const a = this.activeRun;
      const ageS = ((Date.now() - a.startedAt) / 1000).toFixed(0);
      lines.push(`  ▶ active run: ${a.meta.run_id} (task ${a.entry.task_id})`);
      lines.push(
        `    phase: ${a.meta.phase}  ·  attempt: ${a.meta.attempts ?? 1}  ·  ${ageS}s in flight`,
      );
    } else {
      lines.push("  ▶ active run: none");
    }
    lines.push(`  ▦ queue depth: ${this.queue.size()}`);
    if (this.consecutiveQuotaErrors > 0 && !this.dispatchPaused) {
      lines.push(
        `  ⚠ consecutive quota errors: ${this.consecutiveQuotaErrors}/${QUOTA_PAUSE_THRESHOLD}`,
      );
    }
    const peeked = this.queue.peek();
    if (peeked !== undefined) {
      lines.push(`    next: ${peeked.task_id} (enqueued ${peeked.enqueued_at})`);
    }
    const recent = this.collectRecentRuns(5);
    if (recent.length > 0) {
      lines.push(`  ◷ recent runs (${recent.length}):`);
      for (const r of recent) {
        const dur =
          r.duration_ms !== undefined
            ? `${(r.duration_ms / 1000).toFixed(1)}s`
            : "—";
        lines.push(`    - ${r.run_id} · ${r.phase} · ${dur}`);
      }
    }
    const gcAge = this.gcAgeMs();
    if (gcAge !== null) {
      const days = (gcAge / (1000 * 60 * 60 * 24)).toFixed(1);
      lines.push(`  🗑 GC last ran: ${days}d ago`);
    }
    return lines.join("\n");
  }

  private collectRecentRuns(
    limit: number,
  ): { run_id: string; phase: string; duration_ms?: number }[] {
    const runsActiveDir = join(this.opts.repoRoot, RUNS_ACTIVE_REL);
    if (!existsSync(runsActiveDir)) return [];
    let entries: string[];
    try {
      entries = readdirSync(runsActiveDir);
    } catch {
      return [];
    }
    const collected: {
      run_id: string;
      phase: string;
      duration_ms?: number;
      mtime: number;
    }[] = [];
    for (const id of entries) {
      const metaPath = join(runsActiveDir, id, "meta.json");
      if (!existsSync(metaPath)) continue;
      try {
        const text = readFileSync(metaPath, "utf8");
        const meta = JSON.parse(text) as Record<string, unknown>;
        const stat = statSync(metaPath);
        const item: {
          run_id: string;
          phase: string;
          duration_ms?: number;
          mtime: number;
        } = {
          run_id:
            typeof meta["run_id"] === "string"
              ? (meta["run_id"] as string)
              : id,
          phase:
            typeof meta["phase"] === "string"
              ? (meta["phase"] as string)
              : "unknown",
          mtime: stat.mtimeMs,
        };
        if (typeof meta["duration_ms"] === "number") {
          item.duration_ms = meta["duration_ms"] as number;
        }
        collected.push(item);
      } catch {
        // skip malformed
      }
    }
    return collected
      .sort((a, b) => b.mtime - a.mtime)
      .slice(0, limit)
      .map(({ mtime: _mtime, ...rest }) => rest);
  }

  private gcAgeMs(): number | null {
    const manifestPath = join(
      this.opts.repoRoot,
      ".harness",
      "ground",
      "manifest.yaml",
    );
    if (!existsSync(manifestPath)) return null;
    try {
      const stat = statSync(manifestPath);
      return Date.now() - stat.mtimeMs;
    } catch {
      return null;
    }
  }

  private async handleQueue(row: InboxSlashRow): Promise<void> {
    const adapter = this.adapterForSource(row.source);
    if (adapter === undefined) return;
    const entries = this.queue.list();
    if (entries.length === 0) {
      await adapter.notify("info", "▦ queue: empty");
      return;
    }
    const lines: string[] = [`▦ queue (${entries.length}):`];
    for (const e of entries) {
      const channel = e.row.task.channelId
        ? ` · <#${e.row.task.channelId}>`
        : "";
      lines.push(
        `  - ${e.task_id} (run ${e.run_id})${channel} · enqueued ${e.enqueued_at}`,
      );
    }
    await adapter.notify("info", lines.join("\n"));
  }

  private async handleEval(row: InboxSlashRow): Promise<void> {
    const adapter = this.adapterForSource(row.source);
    const scope =
      typeof row.slash.options["scope"] === "string"
        ? (row.slash.options["scope"] as string)
        : "";
    let mirrorPath: string;
    try {
      mirrorPath = requireMirrorRecord(this.opts.projectName).mirrorPath;
    } catch (err) {
      await adapter?.notify(
        "error",
        `/eval — mirror not registered for ${this.opts.projectName}: ${String(err)}`,
      );
      return;
    }
    let baseSha: string;
    try {
      const { simpleGit } = await import("simple-git");
      const git = simpleGit({ baseDir: mirrorPath });
      baseSha = (await git.revparse(["origin/main"])).trim();
    } catch (err) {
      await adapter?.notify(
        "error",
        `/eval — could not resolve origin/main on mirror: ${String(err)}`,
      );
      return;
    }
    let diff;
    try {
      diff = await getDiff({ mirrorPath, shaPin: baseSha });
    } catch (err) {
      await adapter?.notify("error", `/eval — diff failed: ${String(err)}`);
      return;
    }
    const projectGlobs = this.opts.projectGlobs ?? {
      route_handler_globs: [],
      dto_globs: [],
      generator_source_globs: [],
      high_stakes_globs: [],
    };
    let stubCatalog;
    try {
      stubCatalog = loadStubCatalog(mirrorPath);
    } catch (err) {
      await adapter?.notify(
        "error",
        `/eval — stub catalog load failed: ${String(err)}`,
      );
      return;
    }
    const accepted = loadAcceptedDecisions(mirrorPath);
    const inScope = decisionsInScope(accepted, diff);
    const results: SensorResult[] = [];
    results.push(
      runStubCatalog({
        diff,
        catalog: stubCatalog,
        languages: this.opts.sensorLanguages ?? ["typescript"],
      }),
    );
    results.push(
      runRouteHandlerNonEmpty({
        diff,
        globs: projectGlobs.route_handler_globs,
      }),
    );
    results.push(
      runDtoNoFakeFields({ diff, globs: projectGlobs.dto_globs }),
    );
    results.push(runDecisionAssertions({ mirrorPath, diff, decisions: inScope }));
    const hard = results.filter((r) => !r.ok).length;
    const soft = results.reduce(
      (n, r) => n + r.findings.filter((f) => f.severity === "soft").length,
      0,
    );
    const lines: string[] = [];
    lines.push(`🧪 /eval${scope.length > 0 ? ` (scope: ${scope})` : ""}`);
    lines.push(`  diff files: ${diff.length}  ·  base: ${baseSha.slice(0, 8)}`);
    lines.push(`  hard failures: ${hard}  ·  soft findings: ${soft}`);
    for (const r of results) {
      const tag = r.ok ? "✓" : "✗";
      const findingsCount = r.findings.length;
      lines.push(
        `  ${tag} ${r.sensor_id}${findingsCount > 0 ? ` — ${findingsCount} finding(s)` : ""}`,
      );
    }
    await adapter?.notify(hard === 0 ? "info" : "warn", lines.join("\n"));
  }

  private async handleResume(row: InboxSlashRow): Promise<void> {
    const adapter = this.adapterForSource(row.source);
    const runId =
      typeof row.slash.options["run-id"] === "string"
        ? (row.slash.options["run-id"] as string)
        : "";
    if (runId.length === 0) {
      await adapter?.notify("warn", "/resume — run-id required");
      return;
    }
    const metaPath = join(
      this.opts.repoRoot,
      RUNS_ACTIVE_REL,
      runId,
      "meta.json",
    );
    if (!existsSync(metaPath)) {
      await adapter?.notify(
        "warn",
        `/resume — no meta.json at .harness/runs/active/${runId}/`,
      );
      return;
    }
    let meta: RunMeta;
    try {
      meta = JSON.parse(await readFile(metaPath, "utf8")) as RunMeta;
    } catch (err) {
      await adapter?.notify(
        "error",
        `/resume — meta.json unreadable: ${String(err)}`,
      );
      return;
    }
    const decision = meta.last_uat?.operator_decision;
    if (decision !== undefined && decision !== "pending") {
      await adapter?.notify(
        "info",
        `/resume — run ${runId} already decided: ${decision}`,
      );
      return;
    }
    const summaryPath = join(
      this.opts.repoRoot,
      RUNS_ACTIVE_REL,
      runId,
      "uat",
      "summary.yaml",
    );
    if (!existsSync(summaryPath)) {
      await adapter?.notify(
        "warn",
        `/resume — no UAT bundle at .harness/runs/active/${runId}/uat/`,
      );
      return;
    }
    let summary: Record<string, unknown>;
    try {
      summary = (parseYaml(await readFile(summaryPath, "utf8")) ?? {}) as Record<
        string,
        unknown
      >;
    } catch (err) {
      await adapter?.notify(
        "error",
        `/resume — summary.yaml unreadable: ${String(err)}`,
      );
      return;
    }
    const goal =
      typeof summary["goal"] === "string"
        ? (summary["goal"] as string)
        : `Run ${runId}`;
    const acceptanceRaw = Array.isArray(summary["acceptance"])
      ? (summary["acceptance"] as Array<Record<string, unknown>>)
      : [];
    const acceptance = acceptanceRaw.map((a) => {
      const status =
        a["status"] === "pass" || a["status"] === "fail"
          ? (a["status"] as "pass" | "fail")
          : "pending";
      const entry: { id: string; status: "pass" | "fail" | "pending"; note?: string } = {
        id: typeof a["id"] === "string" ? (a["id"] as string) : "ac-?",
        status,
      };
      if (typeof a["note"] === "string") entry.note = a["note"] as string;
      return entry;
    });
    const bundle: ApprovalBundle = {
      bundleId: `resume:${runId}:${Date.now().toString(36)}`,
      runId,
      ...(meta.task_id ? { taskId: meta.task_id } : {}),
      goal,
      acceptance,
      ...(meta.channel_id ? { channelId: meta.channel_id } : {}),
    };
    if (adapter === undefined) return;
    await adapter.notify(
      "info",
      `🔁 /resume — re-firing UAT approval dialog for ${runId}`,
    );
    const approval = await adapter.requestApproval(bundle);
    log.info(
      { runId, decision: approval.decision },
      "/resume — approval response",
    );
    if (meta.last_uat !== undefined) {
      meta.last_uat = {
        ...meta.last_uat,
        operator_decision: approval.decision,
      };
      await this.writeMeta(meta);
    }
  }

  private async handleOops(row: InboxSlashRow): Promise<void> {
    const adapter = this.adapterForSource(row.source);
    if (adapter === undefined) return;
    const bundleBase = `oops:${Date.now().toString(36)}:${randomBytes(2).toString("hex")}`;
    const root = await adapter.requestDialog({
      bundleId: `${bundleBase}:root`,
      prompt: "Looking back at last 24h. What happened?",
      choices: [
        { id: "a", label: "A) Recent run produced wrong code" },
        { id: "b", label: "B) Doc became stale / contradicts current code" },
        { id: "c", label: "C) Decision was missed / ignored by an agent" },
        { id: "d", label: "D) Sensor false-positive / false-negative" },
        { id: "e_other", label: "E) Other (describe)" },
      ],
      ...(row.slash.channelId ? { channelId: row.slash.channelId } : {}),
    });
    if (root.timedOut === true) {
      await adapter.notify("info", "/oops — dialog timed out");
      return;
    }
    if (root.choiceId === "a") {
      const detail = await adapter.requestDialog({
        bundleId: `${bundleBase}:a-detail`,
        prompt: "What's wrong with the run?",
        choices: [
          {
            id: "wrong-direction",
            label: "A1) Wrong direction — revert + redo",
          },
          { id: "missed-edge", label: "A2) Right idea, missed edge case" },
          {
            id: "introduced-stub",
            label: "A3) Introduced a stub I want caught next time",
          },
          {
            id: "decision-conflict",
            label: "A4) Conflicts with a decision I haven't recorded yet",
          },
          { id: "e_other", label: "E) Other" },
        ],
        ...(row.slash.channelId ? { channelId: row.slash.channelId } : {}),
      });
      if (detail.choiceId === "introduced-stub") {
        await this.captureStubPatternFromOops({
          adapter,
          bundleBase,
          ...(row.slash.channelId ? { channelId: row.slash.channelId } : {}),
        });
        return;
      }
      await this.captureOopsLog({
        branch: `a:${detail.choiceId}`,
        ...(detail.freeText !== undefined ? { freeText: detail.freeText } : {}),
        row,
      });
      await adapter.notify(
        "info",
        `/oops — recorded under .harness/staleness/oops.jsonl (branch a:${detail.choiceId})`,
      );
      return;
    }
    await this.captureOopsLog({
      branch: root.choiceId,
      ...(root.freeText !== undefined ? { freeText: root.freeText } : {}),
      row,
    });
    await adapter.notify(
      "info",
      `/oops — recorded under .harness/staleness/oops.jsonl (branch ${root.choiceId})`,
    );
  }

  private async captureStubPatternFromOops(args: {
    adapter: FrontendAdapter;
    bundleBase: string;
    channelId?: string;
  }): Promise<void> {
    const patternResp = await args.adapter.requestDialog({
      bundleId: `${args.bundleBase}:stub-pattern`,
      prompt:
        "Paste the regex pattern (ECMAScript, multiline-mode). Choose `E) type pattern` then enter it as free text.",
      choices: [{ id: "e_other", label: "E) type pattern" }],
      ...(args.channelId ? { channelId: args.channelId } : {}),
    });
    const pattern = (patternResp.freeText ?? "").trim();
    if (pattern.length === 0) {
      await args.adapter.notify("warn", "/oops — empty pattern; aborted");
      return;
    }
    try {
      new RegExp(pattern, "m");
    } catch (err) {
      await args.adapter.notify(
        "error",
        `/oops — pattern invalid: ${String(err)}`,
      );
      return;
    }
    const sevResp = await args.adapter.requestDialog({
      bundleId: `${args.bundleBase}:stub-severity`,
      prompt: "Severity?",
      choices: [
        { id: "hard", label: "🟥 hard — match fails the run" },
        {
          id: "soft",
          label: "🟨 soft — match contributes to attestation cross-check",
        },
      ],
      ...(args.channelId ? { channelId: args.channelId } : {}),
    });
    const severity = sevResp.choiceId === "hard" ? "hard" : "soft";
    const id = `oops-${Date.now().toString(36)}-${randomBytes(2).toString("hex")}`;
    await this.appendStubPattern({ id, pattern, severity });
    await args.adapter.notify(
      "info",
      `/oops — added pattern \`${id}\` (${severity}) to .harness/config/stub-patterns.yaml`,
    );
  }

  private async appendStubPattern(args: {
    id: string;
    pattern: string;
    severity: "hard" | "soft";
  }): Promise<void> {
    const path = join(
      this.opts.repoRoot,
      ".harness",
      "config",
      "stub-patterns.yaml",
    );
    let doc: { version?: number; patterns?: unknown[] } = {
      version: 1,
      patterns: [],
    };
    if (existsSync(path)) {
      try {
        doc = (parseYaml(await readFile(path, "utf8")) ?? {
          version: 1,
          patterns: [],
        }) as typeof doc;
        if (!Array.isArray(doc.patterns)) doc.patterns = [];
      } catch (err) {
        log.warn(
          { err: String(err) },
          "stub-patterns.yaml parse failed; rewriting",
        );
        doc = { version: 1, patterns: [] };
      }
    }
    (doc.patterns as unknown[]).push({
      id: args.id,
      languages: ["typescript", "javascript"],
      description: "Added via /oops dialog",
      regex: args.pattern,
      severity: args.severity,
    });
    await mkdir(join(this.opts.repoRoot, ".harness", "config"), {
      recursive: true,
    });
    await writeFile(path, stringifyYaml(doc), "utf8");
  }

  private async captureOopsLog(args: {
    branch: string;
    freeText?: string;
    row: InboxSlashRow;
  }): Promise<void> {
    const dir = join(this.opts.repoRoot, ".harness", "staleness");
    await mkdir(dir, { recursive: true });
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      branch: args.branch,
      free_text: args.freeText ?? "",
      author: args.row.slash.authorId,
      channel: args.row.slash.channelId,
      source: args.row.source,
    });
    await writeFile(join(dir, "oops.jsonl"), `${line}\n`, {
      flag: "a",
      encoding: "utf8",
    });
  }

  private async handleHelp(row: InboxSlashRow): Promise<void> {
    const adapter = this.adapterForSource(row.source);
    if (adapter === undefined) return;
    const lines = [
      "Harness slash commands:",
      "  /task <body>      submit a task",
      "  /direction <text> capture a binding decision change",
      "  /halt [run-id]    kill the active run (SIGTERM → 30s grace → SIGKILL)",
      "  /status           queue depth, active run, recent runs, GC age, quota state",
      "  /queue            FIFO queue + per-task channel links",
      "  /eval [scope]     on-demand sensor sweep (no implementer dispatch)",
      "  /resume <run-id>  re-attach an AFK-timed-out UAT approval dialog",
      "  /oops             multi-step dialog: stub pattern / doc staleness / sensor false-pos",
      "  /archive <path>   move a stale doc/file to .archive/<date>/<path> + commit",
      "  /unpause          clear a quota-triggered dispatch pause",
      "  /ship-anyway      override the spec-tightener gate (logged)",
    ];
    await adapter.notify("info", lines.join("\n"));
  }

  // §3.5 plan-quota — record + maybe pause dispatch.

  private async recordQuotaSignal(
    kind: ClaudeErrorKind,
    message: string,
  ): Promise<void> {
    const isQuota = isQuotaKind(kind);
    if (!isQuota) {
      // Non-quota error doesn't reset the counter (we don't know if it
      // was a transient API blip vs an unrelated agent failure). The
      // counter only resets on a successful agent run. But we DO log
      // the event for retrospective analysis.
      await this.appendQuotaJsonl({ kind, message, paused: false });
      return;
    }
    this.consecutiveQuotaErrors += 1;
    log.warn(
      { kind, consecutive: this.consecutiveQuotaErrors, message },
      "quota error recorded",
    );
    await this.appendQuotaJsonl({
      kind,
      message,
      consecutive: this.consecutiveQuotaErrors,
      paused: false,
    });
    if (this.consecutiveQuotaErrors >= QUOTA_PAUSE_THRESHOLD) {
      this.dispatchPaused = true;
      this.dispatchPauseReason = `${this.consecutiveQuotaErrors} consecutive ${kind} errors — coding-plan quota likely exhausted`;
      this.dispatchPausedAt = new Date().toISOString();
      await this.appendQuotaJsonl({
        kind,
        message,
        consecutive: this.consecutiveQuotaErrors,
        paused: true,
      });
      log.error(
        { reason: this.dispatchPauseReason },
        "dispatch PAUSED on quota threshold",
      );
      for (const adapter of this.opts.adapters) {
        try {
          await adapter.notify(
            "error",
            `⛔ Dispatch PAUSED — ${this.dispatchPauseReason}.\nUse \`/unpause\` to resume after the rate-limit window resets.`,
          );
        } catch (err) {
          log.warn(
            { err: String(err), adapter: adapter.name },
            "pause notify failed",
          );
        }
      }
    }
  }

  private async appendQuotaJsonl(entry: {
    kind: ClaudeErrorKind;
    message: string;
    consecutive?: number;
    paused: boolean;
  }): Promise<void> {
    const dir = join(this.opts.repoRoot, ".harness", "staleness");
    try {
      await mkdir(dir, { recursive: true });
      const line = JSON.stringify({
        ts: new Date().toISOString(),
        ...entry,
        message: entry.message.slice(0, 200),
      });
      await appendFile(join(dir, "quota.jsonl"), `${line}\n`, "utf8");
    } catch (err) {
      log.warn({ err: String(err) }, "quota.jsonl append failed");
    }
  }

  private async handleUnpause(row: InboxSlashRow): Promise<void> {
    const adapter = this.adapterForSource(row.source);
    if (!this.dispatchPaused) {
      await adapter?.notify("info", "/unpause — dispatch was not paused");
      return;
    }
    this.dispatchPaused = false;
    const reason = this.dispatchPauseReason;
    this.dispatchPauseReason = "";
    this.dispatchPausedAt = undefined;
    this.consecutiveQuotaErrors = 0;
    log.info({ by: row.slash.authorId, prior: reason }, "/unpause cleared");
    await adapter?.notify(
      "info",
      `▶ Dispatch UNPAUSED (was: ${reason}). Counter reset to 0; tick will resume on next interval.`,
    );
  }

  // §3.5 /archive — quarantine a file under .archive/<date>/<path>.

  private async handleArchive(row: InboxSlashRow): Promise<void> {
    const adapter = this.adapterForSource(row.source);
    const rawPath =
      typeof row.slash.options["path"] === "string"
        ? (row.slash.options["path"] as string).trim()
        : "";
    if (rawPath.length === 0) {
      await adapter?.notify("warn", "/archive — path required");
      return;
    }
    if (rawPath.startsWith("/") || rawPath.includes("..")) {
      await adapter?.notify(
        "warn",
        `/archive — path must be repo-relative without "..": got "${rawPath}"`,
      );
      return;
    }
    const FORBIDDEN = [".git/", ".harness/", ".archive/", "node_modules/"];
    for (const forbidden of FORBIDDEN) {
      if (rawPath.startsWith(forbidden)) {
        await adapter?.notify(
          "warn",
          `/archive — refusing to archive inside ${forbidden}`,
        );
        return;
      }
    }
    let mirrorPath: string;
    try {
      mirrorPath = requireMirrorRecord(this.opts.projectName).mirrorPath;
    } catch (err) {
      await adapter?.notify(
        "error",
        `/archive — mirror not registered: ${String(err)}`,
      );
      return;
    }
    const sourceAbs = join(mirrorPath, rawPath);
    if (!existsSync(sourceAbs)) {
      await adapter?.notify("warn", `/archive — file not found: ${rawPath}`);
      return;
    }
    const today = new Date().toISOString().slice(0, 10);
    const archiveRel = join(".archive", today, rawPath);
    const archiveAbs = join(mirrorPath, archiveRel);
    try {
      await mkdir(dirname(archiveAbs), { recursive: true });
      const { simpleGit } = await import("simple-git");
      const git = simpleGit({ baseDir: mirrorPath });
      await git.mv(rawPath, archiveRel);
      await git.add(archiveRel);
      await git.commit(
        `chore(archive): move ${rawPath} → ${archiveRel}\n\nVia /archive by ${row.slash.authorId}.`,
      );
      const sha = (await git.revparse(["HEAD"])).trim();
      log.info(
        { from: rawPath, to: archiveRel, sha, by: row.slash.authorId },
        "/archive committed",
      );
      await adapter?.notify(
        "info",
        `📦 /archive — moved \`${rawPath}\` → \`${archiveRel}\` (commit \`${sha.slice(0, 8)}\`). Push manually via \`harness mirror push\`.`,
      );
    } catch (err) {
      await adapter?.notify(
        "error",
        `/archive failed: ${String(err)}`,
      );
    }
  }
}


// Suppress the TS6133 unused-import error if InboxTaskRow ends up unused.
export type { InboxTaskRow };

/**
 * §3.4 — classify a `completeRun(failed, error)` reason into one of five
 * failure classes the embed renders distinctly. Falls back to "hard" when
 * the error string doesn't match a known prefix.
 */
function classifyFailure(error?: string): PostUpdate["failureClass"] {
  if (error === undefined) return "hard";
  const e = error.toLowerCase();
  if (e.includes("halted by operator")) return "halt";
  if (e.startsWith("sensors")) return "sensor";
  if (e.startsWith("reviewer")) return "reviewer";
  if (e.startsWith("uat")) return "uat";
  if (e.startsWith("tightener")) return "hard";
  if (e.startsWith("workspace")) return "hard";
  if (e.startsWith("agent")) return "hard";
  return "hard";
}

/**
 * Per failure class, build a remediation block — reason + 1-3 next-action
 * suggestions the operator can act on directly. Sensor / reviewer fails
 * usually want `/ship-anyway` or re-submit; UAT fails want `/resume`;
 * halt wants re-submit; hard errors point at the log.
 */
function buildRemediation(
  cls: PostUpdate["failureClass"],
  error: string | undefined,
  runId: string,
): PostUpdate["remediation"] {
  const reason = error ?? "unknown failure";
  switch (cls) {
    case "sensor":
      return {
        reason,
        suggestedActions: [
          "Re-submit task with the corrections the remediation prompt named",
          "`/ship-anyway` — override the sensor gate (logged for audit)",
          "`/oops` — propose a new stub-pattern if a false-negative slipped through",
        ],
      };
    case "reviewer":
      return {
        reason,
        suggestedActions: [
          "Re-submit with the reviewer's gaps addressed (see log.jsonl `reviewer_verdict` entry)",
          "`/ship-anyway` — override the reviewer (logged for audit)",
        ],
      };
    case "uat":
      return {
        reason,
        suggestedActions: [
          `\`/resume ${runId}\` — re-fire the UAT approval dialog`,
          "Re-submit task with the rejection feedback baked in",
        ],
      };
    case "halt":
      return {
        reason,
        suggestedActions: [
          "Re-submit task to retry from scratch",
          "`/oops` — describe what was wrong so it gets caught next time",
        ],
      };
    case "hard":
    default:
      return {
        reason,
        suggestedActions: [
          `Read \`.harness/runs/active/${runId}/log.jsonl\` for the full transition trace`,
          "Re-submit task to retry",
        ],
      };
  }
}

/** Format one log entry for the live status embed's recent-events strip. */
function formatRunLogLine(e: RunLogEntry): string {
  const time = e.ts.slice(11, 19);
  const kind = e.kind.replace(/_/g, " ");
  const summaryRoom = Math.max(0, 90 - time.length - kind.length - 12);
  const summary = e.summary.slice(0, summaryRoom);
  return `\`${time}\` · **${kind}** · ${summary}`;
}

/** Count lines present in `after` but not in `before`. */
function countAddedLines(before: string | undefined, after: string | undefined): number {
  if (after === undefined) return 0;
  if (before === undefined) return after.split(/\r?\n/).length;
  const beforeLines = new Set(before.split(/\r?\n/));
  let added = 0;
  for (const line of after.split(/\r?\n/)) {
    if (!beforeLines.has(line)) added += 1;
  }
  return added;
}

/**
 * Build the spec the implementer agent will see, baking the operator's
 * per-ambiguity resolutions into the tightener's proposal so the agent
 * works against settled answers instead of the LLM's defaults.
 */
function renderResolvedSpec(args: {
  proposal: string;
  resolutions: { id: string; question: string; choice: string }[];
}): string {
  if (args.resolutions.length === 0) return args.proposal;
  const lines: string[] = [];
  lines.push(args.proposal.trim());
  lines.push("");
  lines.push("## Operator-resolved ambiguities");
  for (const r of args.resolutions) {
    lines.push(`- **${r.id}** — ${r.question}`);
    lines.push(`  → ${r.choice}`);
  }
  return lines.join("\n");
}

/**
 * Format the tightener's gap analysis as a per-task channel post body.
 * The operator's actionable output: ambiguities + missing acceptance +
 * scope concerns + the proposed tightened spec they can copy/paste/edit
 * + a `/ship-anyway` override hint.
 */
function renderTightenerFeedback(
  output: TightenerOutput,
  qualityFloor: number,
): string {
  const lines: string[] = [];
  lines.push(
    `**spec quality: ${output.spec_quality_score}/10** (floor ${qualityFloor}) — needs sharpening before dispatch`,
  );

  if (output.ambiguities.length > 0) {
    lines.push("");
    lines.push("**Ambiguities:**");
    for (const a of output.ambiguities.slice(0, 5)) {
      const candidates =
        a.candidate_resolutions.length > 0
          ? `  → ${a.candidate_resolutions.slice(0, 3).join(" | ")}`
          : "";
      lines.push(`- **${a.id}** ${a.question}${candidates}`);
    }
  }
  if (output.missing_acceptance.length > 0) {
    lines.push("");
    lines.push("**Missing acceptance criteria:**");
    for (const a of output.missing_acceptance.slice(0, 5)) lines.push(`- ${a}`);
  }
  if (output.scope_concerns.length > 0) {
    lines.push("");
    lines.push("**Scope concerns:**");
    for (const a of output.scope_concerns.slice(0, 5)) lines.push(`- ${a}`);
  }
  if (output.conflicts.length > 0) {
    lines.push("");
    lines.push("**Conflicts:**");
    for (const a of output.conflicts.slice(0, 5)) lines.push(`- ${a}`);
  }
  if (output.existing_stub_overlap.length > 0) {
    lines.push("");
    lines.push("**Stub overlap:**");
    for (const a of output.existing_stub_overlap.slice(0, 5)) lines.push(`- ${a}`);
  }
  if (output.tightened_spec_proposal.trim().length > 0) {
    lines.push("");
    lines.push("**Proposed tightened spec (copy / edit / re-submit):**");
    lines.push("```");
    const cap = 1500;
    const proposal = output.tightened_spec_proposal.trim();
    lines.push(proposal.length > cap ? proposal.slice(0, cap) + "\n…[truncated]" : proposal);
    lines.push("```");
  }
  lines.push("");
  lines.push(
    "_To bypass the quality gate (e.g. cosmetic / one-off), re-submit with `/ship-anyway`._",
  );
  // Discord 2000-char message cap with safety margin.
  const body = lines.join("\n");
  return body.length > 1900 ? body.slice(0, 1900) + "\n…[truncated]" : body;
}
