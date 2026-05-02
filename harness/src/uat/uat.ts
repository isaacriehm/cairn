/**
 * UAT pipeline orchestrator.
 *
 * Steps (per UAT_PIPELINE.md §3):
 *   1. UAT-runner agent picks one probe per acceptance criterion.
 *   2. (If cold_start_smoke) run the project's start command first.
 *   3. Execute every probe; collect ProbeRunResult[].
 *   4. Build UatSummary; write summary.yaml.
 *   5. Persist UAT.md per task.
 *   6. Request operator approval via the configured frontend adapter.
 *   7. On approve: write evidence file (.uat-passed) with operator_decision.
 *      On reject: collect rejection reason; bundle stays without approval.
 *   8. Return the aggregated UatRunResult.
 *
 * The orchestrator's pre-push gate calls `verifyEvidenceFile` separately
 * before allowing `git push`.
 */

import { logger } from "../logger.js";
import { writeEvidenceFile, writeSummary } from "./bundle.js";
import { upsertUatTask } from "./persistent.js";
import { executeProbe } from "./probes/index.js";
import { generateUatChecks } from "./runner.js";
import type {
  ProbeRunResult,
  UatRejection,
  UatRunResult,
  UatRunnerInput,
  UatSummary,
} from "./types.js";

const log = logger("uat");

export interface ApprovalGateArgs {
  runId: string;
  taskId: string;
  summary: UatSummary;
}

/** Operator approval surface — the orchestrator passes its adapter through. */
export type ApprovalGate = (
  args: ApprovalGateArgs,
) => Promise<{ decision: "approve" | "reject" | "ask" | "abandoned"; rejection?: UatRejection }>;

export interface RunUatArgs {
  /** Repo root (mirror checkout). */
  repoRoot: string;
  /** Run id from the orchestrator. */
  runId: string;
  /** Task id (drives persistent UAT.md). */
  taskId: string;
  /** Inputs the UAT-runner agent needs to pick probes. */
  runnerInput: UatRunnerInput;
  /** Diff stats for summary.yaml. */
  diffStats: { files_changed: number; lines_added: number; lines_removed: number };
  /** Sensors that already passed in this attempt. */
  sensorsPassed: string[];
  /** Reviewer verdict if any. */
  reviewerVerdict: "pass" | "fail" | "skipped";
  /** Operator approval surface. Adapter renders the bundle and waits for a decision. */
  approvalGate: ApprovalGate;
  /**
   * Optional cold-start-smoke command. If `runner_output.cold_start_smoke`
   * is true and this isn't supplied, the smoke is recorded as `skipped`.
   */
  coldStartCommand?: { command: string; args: string[]; cwd?: string };
}

export async function runUat(args: RunUatArgs): Promise<UatRunResult> {
  const startedAt = Date.now();
  const goalOneLiner = args.runnerInput.tightened_spec.trim().split(/\r?\n/)[0] ?? "";

  // ── Step 1: UAT-runner picks probes ────────────────────────────────
  const runnerOutput = await generateUatChecks(args.runnerInput);

  // ── Step 2: cold-start smoke ───────────────────────────────────────
  let coldStartResult: { status: "pass" | "fail" | "skipped"; evidence?: string } | undefined;
  if (runnerOutput.cold_start_smoke) {
    if (args.coldStartCommand) {
      coldStartResult = await runColdStartSmoke(args.coldStartCommand);
    } else {
      coldStartResult = {
        status: "skipped",
        evidence: "cold_start_smoke requested but no coldStartCommand configured",
      };
    }
  }

  // ── Step 3: execute probes ─────────────────────────────────────────
  const uatOutputDir = `${args.repoRoot}/.harness/runs/active/${args.runId}/uat`;
  const probeResults: ProbeRunResult[] = [];
  for (const check of runnerOutput.acceptance_checks) {
    const result = await executeProbe({
      probe: check.probe,
      ...(args.runnerInput.hints.base_url !== undefined
        ? { baseUrl: args.runnerInput.hints.base_url }
        : {}),
      outputDir: uatOutputDir,
    });
    probeResults.push(result);
  }

  // ── Step 4: build summary ──────────────────────────────────────────
  const acceptanceResults: UatSummary["acceptance_results"] = runnerOutput.acceptance_checks.map(
    (check) => {
      const result = probeResults.find((r) => r.probe_id === check.id);
      const status: "pass" | "fail" | "pending" | "skipped" = result?.skipped_reason
        ? "skipped"
        : result?.passed
          ? "pass"
          : "fail";
      const row: UatSummary["acceptance_results"][number] = {
        id: check.id,
        text: check.text,
        probe_kind: check.probe.kind,
        status,
      };
      if (result?.evidence !== undefined) row.evidence = result.evidence;
      if (result?.failure_reason !== undefined) row.failure_reason = result.failure_reason;
      if (check.is_high_stakes_required === true) row.is_high_stakes_required = true;
      return row;
    },
  );

  const allPassed =
    acceptanceResults.every((r) => r.status === "pass") &&
    (coldStartResult?.status ?? "skipped") !== "fail" &&
    runnerOutput.acceptance_checks.length > 0;

  const summary: UatSummary = {
    run_id: args.runId,
    task_id: args.taskId,
    goal_one_liner: goalOneLiner,
    diff_stats: args.diffStats,
    acceptance_results: acceptanceResults,
    ...(coldStartResult !== undefined ? { cold_start_smoke: coldStartResult } : {}),
    artifacts: [], // UI artifacts populated by ui probe in Phase 11.5
    sensors_passed: args.sensorsPassed,
    reviewer_subagent_verdict: args.reviewerVerdict,
    operator_decision_required: true,
    operator_options: [
      { id: "approve", label: "🟢 Approve & Push" },
      { id: "reject", label: "🔴 Reject + tell me why" },
      { id: "ask", label: "❓ Ask follow-up" },
    ],
    all_passed: allPassed,
  };
  const summaryPath = await writeSummary({
    repoRoot: args.repoRoot,
    runId: args.runId,
    summary,
  });
  log.info({ run_id: args.runId, summary_path: summaryPath, all_passed: allPassed }, "summary written");

  // ── Step 5: persistent UAT.md ──────────────────────────────────────
  await upsertUatTask({
    repoRoot: args.repoRoot,
    taskId: args.taskId,
    runId: args.runId,
    summary,
    status: allPassed ? "passing" : "failed",
  });

  // ── Step 6: operator approval ──────────────────────────────────────
  const decision = await args.approvalGate({
    runId: args.runId,
    taskId: args.taskId,
    summary,
  });

  // ── Step 7: evidence file ──────────────────────────────────────────
  const evidence = await writeEvidenceFile({
    repoRoot: args.repoRoot,
    runId: args.runId,
    operatorDecision: decision.decision,
  });
  log.info(
    { run_id: args.runId, decision: decision.decision, bundle_sha256: evidence.bundleSha },
    "evidence file recorded",
  );

  // Update persistent UAT.md with the decision-derived terminal status.
  if (decision.decision === "approve") {
    await upsertUatTask({
      repoRoot: args.repoRoot,
      taskId: args.taskId,
      runId: args.runId,
      summary,
      status: "passed",
    });
  } else if (decision.decision === "reject") {
    await upsertUatTask({
      repoRoot: args.repoRoot,
      taskId: args.taskId,
      runId: args.runId,
      summary,
      status: "failed",
      ...(decision.rejection?.operator_note
        ? { newGap: { run_id: args.runId, description: decision.rejection.operator_note } }
        : {}),
    });
  } else if (decision.decision === "abandoned") {
    await upsertUatTask({
      repoRoot: args.repoRoot,
      taskId: args.taskId,
      runId: args.runId,
      summary,
      status: "abandoned",
    });
  }

  const ok = allPassed && decision.decision === "approve";
  return {
    summary,
    probe_results: probeResults,
    runner_output: runnerOutput,
    evidence_file_path: evidence.path,
    ok,
    operator_decision: decision.decision,
    ...(decision.rejection !== undefined ? { rejection: decision.rejection } : {}),
    duration_ms: Date.now() - startedAt,
  };
}

async function runColdStartSmoke(args: {
  command: string;
  args: string[];
  cwd?: string;
}): Promise<{ status: "pass" | "fail"; evidence: string }> {
  const { spawn } = await import("node:child_process");
  return new Promise((resolve) => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 60_000);
    let stdout = "";
    let stderr = "";
    const child = spawn(args.command, args.args, {
      cwd: args.cwd,
      signal: ctrl.signal,
    });
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const status: "pass" | "fail" = code === 0 ? "pass" : "fail";
      resolve({
        status,
        evidence: `cold-start: exit=${code}; stdout[0..200]=${stdout.slice(0, 200)}; stderr[0..200]=${stderr.slice(0, 200)}`,
      });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ status: "fail", evidence: `cold-start spawn error: ${String(err)}` });
    });
  });
}
