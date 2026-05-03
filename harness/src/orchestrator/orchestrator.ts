import { mkdir, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import chokidar, { type FSWatcher } from "chokidar";
import { join } from "node:path";
import { logger } from "../logger.js";
import { matchAnyGlob } from "../ground/glob.js";
import { requireMirrorRecord } from "../mirror/index.js";
import {
  formatReviewerRemediation,
  runReviewer,
  type ReviewerResult,
} from "../reviewer/index.js";
import { getDiff, runSensors } from "../sensors/index.js";
import type { SensorSweepResult } from "../sensors/index.js";
import {
  decisionsInScope,
  loadAcceptedDecisions,
} from "../sensors/decisions.js";
import { tightenSpec } from "../tightener/index.js";
import type { TightenerOutput } from "../tightener/index.js";
import { summarizeActivity } from "./activity-summarizer.js";
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
  isTaskRow,
  listInboxFiles,
  moveToProcessed,
  readInboxRow,
} from "./inbox.js";
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
    if (!isTaskRow(row)) {
      // Non-task rows (other slash, voice, interaction) are not dispatched
      // by Phase 8 — leave them for downstream consumers. Keep them out of
      // the inbox dir scan so we don't loop on them.
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
      try {
        runResult = await runImplementer({
          tier,
          prompt: promptBody,
          cwd: meta.mirror_path,
          eventsLogPath,
          addDirs: [meta.mirror_path],
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
        await this.completeRun(entry, meta, "failed", `agent: ${String(err)}`);
        return;
      } finally {
        stopRunnerTyping();
        stopActivityFeed();
      }
      meta.events_count = runResult.events;
      meta.duration_ms = runResult.durationMs;

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
        if (summary === lastSummary) return;
        lastSummary = summary;
        for (const adapter of this.opts.adapters) {
          try {
            await adapter.postTaskUpdate({
              taskId: entry.task_id,
              runId: entry.run_id,
              status: meta.phase,
              activity: summary,
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
  ): Promise<void> {
    meta.phase = phase;
    await this.writeMeta(meta);
    const channelId = entry.row.task.channelId;
    for (const adapter of this.opts.adapters) {
      try {
        await adapter.postTaskUpdate({
          taskId: entry.task_id,
          runId: entry.run_id,
          status: phase,
          ...(body !== undefined ? { body } : {}),
          ...(channelId !== undefined ? { channelId } : {}),
        });
      } catch (err) {
        log.warn({ err: String(err), adapter: adapter.name }, "postTaskUpdate failed");
      }
    }
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

    // ── Per-ambiguity walk (only when we have ≥2 candidates each). ─────
    for (let i = 0; i < walkable.length; i++) {
      const a = walkable[i]!;
      // Cap at 4 candidates so the dialog stays readable.
      const candidates = a.candidate_resolutions.slice(0, 4);
      // Discord truncates button labels at 80 chars and operator can't
      // read them. Move the full option text into the prompt body and
      // make buttons single-letter so they're scannable.
      const optionsBlock = candidates
        .map(
          (label, idx) =>
            `**${String.fromCharCode(0x41 + idx)}.** ${label}`,
        )
        .join("\n\n");
      const dialogSpec: import("../frontend/index.js").DialogSpec = {
        bundleId: `${args.entry.task_id}:${a.id}`,
        prompt: `**${a.id}** of ${walkable.length}: ${a.question}\n\n${optionsBlock}`,
        choices: candidates.map((_, idx) => ({
          id: String.fromCharCode(0x61 + idx), // a, b, c, d
          label: String.fromCharCode(0x41 + idx), // A, B, C, D
        })),
        timeoutMs: 5 * 60_000,
      };
      if (channelId !== undefined) dialogSpec.channelId = channelId;
      try {
        const response = await adapter.requestDialog(dialogSpec);
        if (response.timedOut) return { decision: "timeout" };
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
    await this.surfacePhase(entry, meta, phase);
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
}

// Suppress the TS6133 unused-import error if InboxTaskRow ends up unused.
export type { InboxTaskRow };

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
