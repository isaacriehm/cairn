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
      try {
        const tightened = await tightenSpec({
          title: taskTitle,
          body: taskBody,
          ...(entry.row.ship_anyway === true ? { ship_anyway: true } : {}),
        });
        meta.tightener_score = tightened.output.spec_quality_score;
        meta.tightener_ready = tightened.ready;
        tightenedSpec = tightened.output.tightened_spec_proposal;
        if (!tightened.ready) {
          await this.surfacePhase(entry, meta, "blocked");
          await this.completeRun(entry, meta, "failed", "tightener returned ready=false");
          return;
        }
      } catch (err) {
        await this.completeRun(entry, meta, "failed", `tightener: ${String(err)}`);
        return;
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
          },
        });
      } catch (err) {
        await this.completeRun(entry, meta, "failed", `agent: ${String(err)}`);
        return;
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
        await this.completeRun(entry, meta, "failed", `reviewer: ${String(err)}`);
        return;
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
        await this.completeRun(entry, meta, "failed", `uat: ${String(err)}`);
        return;
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
    meta.phase = phase;
    await this.writeMeta(meta);
    const channelId = entry.row.task.channelId;
    for (const adapter of this.opts.adapters) {
      try {
        await adapter.postTaskUpdate({
          taskId: entry.task_id,
          runId: entry.run_id,
          status: phase,
          ...(channelId !== undefined ? { channelId } : {}),
        });
      } catch (err) {
        log.warn({ err: String(err), adapter: adapter.name }, "postTaskUpdate failed");
      }
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
