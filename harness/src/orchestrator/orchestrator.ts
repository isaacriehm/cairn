import { mkdir, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import chokidar, { type FSWatcher } from "chokidar";
import { join } from "node:path";
import { logger } from "../logger.js";
import { requireMirrorRecord } from "../mirror/index.js";
import { tightenSpec } from "../tightener/index.js";
import {
  ensureInboxDirs,
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
    if (!isTaskRow(row)) {
      // Non-task rows (slash, free_text, voice, interaction) are not
      // dispatched in Phase 8 — leave them for downstream consumers.
      // Keep them out of the inbox dir scan so we don't loop on them.
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

    // ── Agent run ─────────────────────────────────────────────────────
    await this.surfacePhase(entry, meta, "running");
    const eventsLogPath = join(
      this.opts.repoRoot,
      RUNS_ACTIVE_REL,
      entry.run_id,
      "events.jsonl",
    );

    const promptBody = await this.renderPrompt({
      runId: entry.run_id,
      mirrorPath: meta.mirror_path,
      shaPin: prep.sha_pin,
      taskBody,
      acceptance: entry.row.acceptance_criteria ?? [],
    });

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
    await this.completeRun(
      entry,
      meta,
      runResult.ok ? "succeeded" : "failed",
      runResult.ok ? undefined : "agent reported is_error=true",
    );
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
