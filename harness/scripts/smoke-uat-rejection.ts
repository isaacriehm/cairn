#!/usr/bin/env tsx
/**
 * smoke-uat-rejection — Phase 11.x acceptance.
 *
 * Exercises the rejection capture + retry-remediation pipeline:
 *   - captureUatRejection runs A/B/C/D dialog via stub adapter
 *   - voice URL is detected in dialog freeText (Whisper call mocked away
 *     by checking detection logic only — actual transcribe path covered
 *     by smoke-whisper)
 *   - writeRejectionYaml lands a well-formed YAML under uat/
 *   - formatUatRejectionRemediation produces an agent-prompt with the
 *     operator's category + note + failed acceptance criteria
 *
 * Pure mechanical — no claude burn, no Whisper invocation.
 */

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { StubFrontendAdapter } from "../src/frontend/stub/index.js";
import {
  captureUatRejection,
  extractAudioUrl,
  formatUatRejectionRemediation,
  writeRejectionYaml,
  type UatSummary,
} from "../src/uat/index.js";

const cleanups: string[] = [];

function header(line: string): void {
  console.log(`\n── ${line}`);
}

function fail(reason: string): never {
  console.error(`smoke-uat-rejection FAIL: ${reason}`);
  cleanup();
  process.exit(1);
}

function cleanup(): void {
  for (const p of cleanups) {
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
}

function assert(cond: unknown, msg: string): void {
  if (!cond) fail(msg);
}

const SUMMARY_FIXTURE: UatSummary = {
  run_id: "run-rej-1",
  task_id: "TSK-rej-1",
  goal_one_liner: "Add a /healthz endpoint returning {status:'ok'}",
  diff_stats: { files_changed: 2, lines_added: 18, lines_removed: 0 },
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
  sensors_passed: ["stub-pattern-catalog", "attestation-cross-check"],
  reviewer_subagent_verdict: "pass",
  operator_decision_required: true,
  operator_options: [
    { id: "approve", label: "🟢 Approve & Push" },
    { id: "reject", label: "🔴 Reject" },
  ],
  all_passed: false,
};

async function main(): Promise<void> {
  // ── Step 1: extractAudioUrl detects audio links ──────────────────────
  header("Step 1: extractAudioUrl detection");
  assert(
    extractAudioUrl("voice note: https://cdn.example.com/notes/abc.m4a please") ===
      "https://cdn.example.com/notes/abc.m4a",
    "expected to extract m4a URL",
  );
  assert(
    extractAudioUrl("https://files.example.org/v.MP3") === "https://files.example.org/v.MP3",
    "expected to extract uppercase mp3 URL",
  );
  assert(
    extractAudioUrl("plain text without an audio url") === undefined,
    "expected no URL match on plain text",
  );
  assert(
    extractAudioUrl("https://example.com/page.html") === undefined,
    "expected non-audio URL not to match",
  );
  console.log("  ok=true (3 audio URLs / 1 negative case)");

  // ── Step 2: captureUatRejection — category B + freeText ──────────────
  header("Step 2: captureUatRejection category=B w/ free text");
  const repoRoot = mkdtempSync(join(tmpdir(), "harness-smoke-rej-"));
  cleanups.push(repoRoot);
  const adapterB = new StubFrontendAdapter({
    repoRoot,
    dialogResponse: {
      bundleId: "uat-reject-run-rej-1",
      choiceId: "B",
      freeText: "Toast text says 'Created'; should say 'Indexed'",
    },
  });
  await adapterB.start();
  const rejB = await captureUatRejection({
    adapter: adapterB,
    runId: "run-rej-1",
    taskId: "TSK-rej-1",
    initialReason: "wrong wording on success toast",
  });
  await adapterB.stop();
  assert(rejB.category === "B", `expected category=B got ${rejB.category}`);
  assert(
    rejB.operator_note.includes("Toast text"),
    `expected operator_note to include freeText; got: ${rejB.operator_note}`,
  );
  assert(
    rejB.operator_note.includes("wrong wording"),
    `expected operator_note to include initialReason; got: ${rejB.operator_note}`,
  );
  assert(
    rejB.voice_transcript === undefined,
    "expected no voice_transcript without audio URL",
  );
  console.log(`  category=${rejB.category} note_len=${rejB.operator_note.length}`);

  // ── Step 3: captureUatRejection — invalid choice falls back to D ─────
  header("Step 3: invalid choice → category=D");
  const adapterX = new StubFrontendAdapter({
    repoRoot,
    dialogResponse: {
      bundleId: "uat-reject-run-rej-2",
      choiceId: "X", // not a valid A/B/C/D — implementation falls back to D
    },
  });
  await adapterX.start();
  const rejX = await captureUatRejection({
    adapter: adapterX,
    runId: "run-rej-2",
    taskId: "TSK-rej-1",
  });
  await adapterX.stop();
  assert(rejX.category === "D", `expected category=D fallback, got ${rejX.category}`);
  console.log(`  category=${rejX.category} (fell back from invalid choice)`);

  // ── Step 4: writeRejectionYaml round-trip ────────────────────────────
  header("Step 4: writeRejectionYaml writes a parseable YAML");
  const yamlPath = await writeRejectionYaml({
    repoRoot,
    runId: "run-rej-1",
    rejection: rejB,
    summary: SUMMARY_FIXTURE,
  });
  cleanups.push(yamlPath);
  const parsed = parseYaml(readFileSync(yamlPath, "utf8")) as Record<string, unknown>;
  assert(parsed["run_id"] === "run-rej-1", "expected run_id matched");
  assert(parsed["category"] === "B", "expected category B");
  assert(typeof parsed["category_label"] === "string", "expected category_label string");
  const failed = parsed["failed_acceptance_criteria"] as { id: string }[];
  assert(Array.isArray(failed) && failed.length === 1, "expected 1 failed AC");
  assert(failed[0]?.id === "AC2", "expected AC2 failed");
  console.log(`  yaml written at ${yamlPath} (${failed.length} failed AC captured)`);

  // ── Step 5: formatUatRejectionRemediation includes everything ────────
  header("Step 5: formatUatRejectionRemediation shape");
  const remediation = formatUatRejectionRemediation({
    rejection: rejB,
    summary: SUMMARY_FIXTURE,
    attempt: 2,
    maxAttempts: 3,
  });
  for (const needle of [
    "Operator rejected the UAT bundle",
    "Category:** B",
    "Toast text",
    "AC2",
    "Acceptance criteria that did not pass",
    "Re-emit your `attestation:` YAML",
  ]) {
    assert(
      remediation.includes(needle),
      `expected remediation to include "${needle.slice(0, 40)}…": got first 200=${remediation.slice(0, 200)}`,
    );
  }
  console.log(`  remediation length=${remediation.length} bytes; cites category B + AC2 + attestation`);

  // ── Step 6: category-specific guidance differs ──────────────────────
  header("Step 6: category-specific guidance differs");
  const guidance: Record<string, string> = {};
  for (const cat of ["A", "B", "C", "D"] as const) {
    const r = formatUatRejectionRemediation({
      rejection: { category: cat, operator_note: "x", rejected_at: new Date().toISOString() },
      summary: SUMMARY_FIXTURE,
      attempt: 2,
      maxAttempts: 3,
    });
    const idx = r.indexOf("## What to do");
    guidance[cat] = r.slice(idx, idx + 200);
  }
  assert(guidance["A"]?.includes("missing entirely"), "A guidance should mention missing");
  assert(guidance["B"]?.includes("UI / copy"), "B guidance should mention UI / copy");
  assert(guidance["C"]?.includes("Wrong behavior"), "C guidance should mention wrong behavior");
  assert(guidance["D"]?.includes("Other / mixed"), "D guidance should mention Other / mixed");
  console.log("  ok=true (4 categories produce distinct guidance)");

  cleanup();
  console.log("\nsmoke-uat-rejection: OK");
}

try {
  await main();
} catch (err) {
  console.error(err);
  cleanup();
  process.exit(1);
}
