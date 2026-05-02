#!/usr/bin/env tsx
/**
 * smoke-uat-question — Phase 11.y acceptance.
 *
 * Synthetic spec + diff + UAT summary + a question — verify the question
 * agent returns a non-empty answer with a confidence signal and at least
 * one citation. ~1 cheap haiku call. SKIPS without `claude`.
 */

import { claudeIsAvailable } from "../src/claude/index.js";
import { runQuestionAgent, type UatSummary } from "../src/uat/index.js";

function header(line: string): void {
  console.log(`\n── ${line}`);
}

function fail(reason: string): never {
  console.error(`smoke-uat-question FAIL: ${reason}`);
  process.exit(1);
}

function skip(reason: string): never {
  console.log(`smoke-uat-question SKIP: ${reason}`);
  process.exit(0);
}

const SUMMARY: UatSummary = {
  run_id: "run-q-1",
  task_id: "TSK-q-1",
  goal_one_liner: "Implement /healthz returning JSON {status:'ok', uptime_s}",
  diff_stats: { files_changed: 2, lines_added: 21, lines_removed: 0 },
  acceptance_results: [
    {
      id: "AC1",
      text: "GET /healthz returns 200",
      probe_kind: "http",
      status: "pass",
      evidence: "GET /healthz → 200",
    },
    {
      id: "AC2",
      text: "Response body has status='ok'",
      probe_kind: "http",
      status: "fail",
      evidence: "GET /healthz body[0..200]={\"status\":\"OK\"}",
      failure_reason: "json path status: expected \"ok\"; got \"OK\"",
    },
  ],
  artifacts: [],
  sensors_passed: ["stub-pattern-catalog", "attestation-cross-check", "decision-assertions"],
  reviewer_subagent_verdict: "pass",
  operator_decision_required: true,
  operator_options: [
    { id: "approve", label: "🟢 Approve & Push" },
    { id: "reject", label: "🔴 Reject" },
    { id: "ask", label: "❓ Ask follow-up" },
  ],
  all_passed: false,
};

async function main(): Promise<void> {
  if (!claudeIsAvailable()) skip("`claude` CLI not on PATH or not authenticated");

  header("Step 1: question agent answers a concrete bundle question");
  const out = await runQuestionAgent({
    question: "Why did AC2 fail and what specifically would the implementer need to change to make it pass?",
    tightened_spec: SUMMARY.goal_one_liner,
    acceptance_criteria: SUMMARY.acceptance_results.map((r) => r.text),
    changed_files: [
      { path: "src/health.controller.ts", status: "added" },
      { path: "src/app.module.ts", status: "modified" },
    ],
    summary: SUMMARY,
    reviewer: { verdict: "pass", summary: "Implementer added the endpoint cleanly; minor casing miss in body field." },
    decision_ids: [],
    tier: "haiku",
  });
  console.log(
    `  answer_chars=${out.answer.length} confidence=${out.confidence_signal} citations=${out.citations.length}`,
  );
  console.log(`  answer[0..200]: ${out.answer.slice(0, 200)}`);

  if (out.answer.trim().length === 0) fail("expected non-empty answer");
  // Question agent should at least mention casing or 'ok' or AC2.
  const a = out.answer.toLowerCase();
  if (!/ac2|case|casing|capital|uppercase|lowercase|"ok"|status/i.test(a)) {
    fail(`expected answer to reference the casing miss; got: ${out.answer.slice(0, 200)}`);
  }
  if (out.citations.length === 0) {
    fail("expected at least one citation");
  }

  console.log("\nsmoke-uat-question: OK");
}

try {
  await main();
} catch (err) {
  console.error(err);
  process.exit(1);
}
