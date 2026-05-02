#!/usr/bin/env tsx
/**
 * smoke-uat — Phase 11 acceptance sensor (mechanical).
 *
 * Per docs/INTEGRATION_PLAN.md §5 Phase 11:
 *   "synthetic UAT failure produces 🔴-able artifact set; bare `touch` of
 *    .uat-passed rejected (SHA mismatch)."
 *
 * Exercises:
 *   - http probe against in-process node http server (status + body shape)
 *   - cli probe via `node --version`
 *   - ui/sql/integration probes → structured "skipped" result
 *   - bundle: writeSummary, writeEvidenceFile, verifyEvidenceFile
 *   - bare-touch detection
 *   - post-hoc artifact mod detection
 *   - extra-file-after-evidence detection
 *   - persistent UAT.md round-trip
 *
 * Pure mechanical — no claude calls.
 */

import { createServer, type Server } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  EVIDENCE_FILE_NAME,
  executeProbe,
  readUatTaskFile,
  runCliProbe,
  runHttpProbe,
  uatDirFor,
  upsertUatTask,
  verifyEvidenceFile,
  writeEvidenceFile,
  writeSummary,
  type UatSummary,
} from "../src/uat/index.js";

const cleanups: string[] = [];
const servers: Server[] = [];

function header(line: string): void {
  console.log(`\n── ${line}`);
}

function fail(reason: string): never {
  console.error(`smoke-uat FAIL: ${reason}`);
  cleanup();
  process.exit(1);
}

function cleanup(): void {
  for (const s of servers) {
    try {
      s.close();
    } catch {
      // best effort
    }
  }
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

async function main(): Promise<void> {
  // ── Step 1: http probe against in-process server ────────────────────
  header("Step 1: http probe — happy path");
  const port = await new Promise<number>((resolve) => {
    const s = createServer((req, res) => {
      if (req.url === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ status: "ok", uptime_s: 42 }));
      } else if (req.url === "/forbidden") {
        res.writeHead(403, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "forbidden" }));
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    s.listen(0, () => {
      const addr = s.address();
      if (addr === null || typeof addr === "string") {
        throw new Error("could not get http server port");
      }
      servers.push(s);
      resolve(addr.port);
    });
  });
  console.log(`  test server on http://localhost:${port}`);

  let result = await runHttpProbe({
    probe: {
      kind: "http",
      id: "AC-health-200",
      description: "GET /health returns 200 with status=ok",
      request: { method: "GET", url: `http://localhost:${port}/health` },
      expect: {
        status: 200,
        body_contains: ['"status":"ok"'],
        json_path_equals: [{ path: "uptime_s", value: 42 }],
      },
    },
  });
  assert(result.passed, `expected http probe pass; reason=${result.failure_reason}`);
  console.log(`  ok=true evidence=${result.evidence.slice(0, 80)}`);

  header("Step 2: http probe — wrong status fails");
  result = await runHttpProbe({
    probe: {
      kind: "http",
      id: "AC-health-201",
      description: "GET /health returns 201 (will fail)",
      request: { method: "GET", url: `http://localhost:${port}/health` },
      expect: { status: 201 },
    },
  });
  assert(!result.passed, "expected http probe fail on wrong status");
  assert(
    (result.failure_reason ?? "").includes("expected status 201"),
    "expected failure reason to cite status mismatch",
  );
  console.log(`  ok=false reason="${result.failure_reason?.slice(0, 80)}"`);

  header("Step 3: http probe — cross-tenant 403 (high-stakes shape)");
  result = await runHttpProbe({
    probe: {
      kind: "http",
      id: "AC-cross-tenant",
      description: "user B's request against user A's resource → 403",
      request: { method: "GET", url: `http://localhost:${port}/forbidden` },
      expect: { status: 403, json_path_equals: [{ path: "error", value: "forbidden" }] },
    },
  });
  assert(result.passed, `cross-tenant probe failed: ${result.failure_reason}`);
  console.log("  ok=true (cross-tenant denial verified)");

  header("Step 4: cli probe — node --version");
  result = await runCliProbe({
    probe: {
      kind: "cli",
      id: "AC-node-runs",
      description: "node --version exits 0",
      command: "node",
      args: ["--version"],
      expect: {
        exit_code: 0,
        stdout_matches_regex: "^v\\d+\\.\\d+\\.\\d+",
      },
    },
  });
  assert(result.passed, `cli probe failed: ${result.failure_reason}`);
  console.log(`  ok=true evidence=${result.evidence.slice(0, 80)}`);

  header("Step 5: cli probe — wrong exit code fails");
  result = await runCliProbe({
    probe: {
      kind: "cli",
      id: "AC-cli-fail",
      description: "node -e 'process.exit(7)' should exit 0 (will fail)",
      command: "node",
      args: ["-e", "process.exit(7)"],
      expect: { exit_code: 0 },
    },
  });
  assert(!result.passed, "expected fail on exit_code mismatch");
  assert(
    (result.failure_reason ?? "").includes("expected exit_code 0; got 7"),
    "expected failure reason to cite exit code",
  );
  console.log(`  ok=false reason="${result.failure_reason?.slice(0, 80)}"`);

  header("Step 6: ui/sql/integration probes return skipped_reason");
  for (const kind of ["ui", "sql", "integration"] as const) {
    const probeBase = {
      kind,
      id: `AC-${kind}`,
      description: `${kind} probe placeholder`,
    };
    let probe;
    if (kind === "ui") {
      probe = {
        ...probeBase,
        url: "http://localhost:0",
        steps: [],
        expect: {},
      };
    } else if (kind === "sql") {
      probe = {
        ...probeBase,
        connection: "default",
        query: "SELECT 1",
        expect: { rowcount: 1 },
      };
    } else {
      probe = {
        ...probeBase,
        compose_file: "docker-compose.yml",
        service: "api",
        ready_check: { kind: "http" as const, url: "http://localhost:0" },
        test: {
          kind: "cli" as const,
          id: "inner",
          description: "x",
          command: "true",
          args: [],
          expect: { exit_code: 0 },
        },
      };
    }
    const r = await executeProbe({ probe: probe as never, outputDir: "/tmp" });
    assert(r.skipped_reason !== undefined, `${kind} probe should be skipped`);
    console.log(`  ${kind}: skipped_reason="${r.skipped_reason?.slice(0, 80)}"`);
  }

  // ── Step 7: bundle + evidence-file gate ──────────────────────────────
  header("Step 7: bundle write + evidence file");
  const root = mkdtempSync(join(tmpdir(), "harness-smoke-uat-"));
  cleanups.push(root);
  const runId = "run-smoke-uat-1";
  const summary: UatSummary = {
    run_id: runId,
    task_id: "TSK-smoke-1",
    goal_one_liner: "GET /health returns 200",
    diff_stats: { files_changed: 1, lines_added: 5, lines_removed: 0 },
    acceptance_results: [
      {
        id: "AC-health-200",
        text: "GET /health returns 200",
        probe_kind: "http",
        status: "pass",
        evidence: "GET /health → 200",
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
    all_passed: true,
  };
  await writeSummary({ repoRoot: root, runId, summary });
  const evidence = await writeEvidenceFile({
    repoRoot: root,
    runId,
    operatorDecision: "approve",
  });
  console.log(`  bundle_sha256=${evidence.bundleSha.slice(0, 12)} files=${evidence.entries.length}`);

  header("Step 8: verifyEvidenceFile clean → ok");
  let verify = verifyEvidenceFile({ repoRoot: root, runId });
  assert(verify.ok, `expected verify ok, got: ${verify.reason}`);
  console.log("  ok=true");

  header("Step 9: bare-touch .uat-passed → reject");
  const evidencePath = join(uatDirFor(root, runId), EVIDENCE_FILE_NAME);
  writeFileSync(evidencePath, "");
  verify = verifyEvidenceFile({ repoRoot: root, runId });
  assert(!verify.ok, "expected verify to reject empty file");
  assert(
    (verify.reason ?? "").includes("not an object") ||
      (verify.reason ?? "").includes("missing required fields"),
    `expected bare-touch reason; got: ${verify.reason}`,
  );
  console.log(`  ok=false reason="${verify.reason?.slice(0, 80)}"`);

  header("Step 10: post-hoc artifact mod → reject");
  // Re-write evidence cleanly first.
  await writeEvidenceFile({ repoRoot: root, runId, operatorDecision: "approve" });
  // Then tamper with summary.yaml.
  const summaryPath = join(uatDirFor(root, runId), "summary.yaml");
  const original = readFileSync(summaryPath, "utf8");
  writeFileSync(summaryPath, `${original}\n# tampered\n`);
  verify = verifyEvidenceFile({ repoRoot: root, runId });
  assert(!verify.ok, "expected verify to reject post-hoc mod");
  assert(
    (verify.reason ?? "").includes("modified after evidence written"),
    `expected mod-detection reason; got: ${verify.reason}`,
  );
  console.log(`  ok=false reason="${verify.reason?.slice(0, 80)}"`);

  header("Step 11: extra-file-after-evidence → reject");
  // Re-write evidence cleanly.
  writeFileSync(summaryPath, original);
  await writeEvidenceFile({ repoRoot: root, runId, operatorDecision: "approve" });
  // Add an extra file post-hoc.
  writeFileSync(join(uatDirFor(root, runId), "extra.log"), "post-hoc\n");
  verify = verifyEvidenceFile({ repoRoot: root, runId });
  assert(!verify.ok, "expected verify to reject extra file");
  assert(
    (verify.reason ?? "").includes("added after evidence written"),
    `expected extra-file reason; got: ${verify.reason}`,
  );
  console.log(`  ok=false reason="${verify.reason?.slice(0, 80)}"`);

  header("Step 12: requireDecision check");
  // Re-write evidence with `pending`; verify with default (approve) → reject.
  rmSync(join(uatDirFor(root, runId), "extra.log"));
  await writeEvidenceFile({ repoRoot: root, runId, operatorDecision: "pending" });
  verify = verifyEvidenceFile({ repoRoot: root, runId });
  assert(!verify.ok, "expected verify to reject pending decision when approve required");
  assert(
    (verify.reason ?? "").includes("operator_decision"),
    `expected decision reason; got: ${verify.reason}`,
  );
  console.log(`  ok=false reason="${verify.reason?.slice(0, 80)}"`);

  // ── Step 13: persistent UAT.md round-trip ────────────────────────────
  header("Step 13: persistent UAT.md write + read");
  const taskRoot = mkdtempSync(join(tmpdir(), "harness-smoke-uat-task-"));
  cleanups.push(taskRoot);
  const taskId = "TSK-roundtrip-1";
  await upsertUatTask({
    repoRoot: taskRoot,
    taskId,
    runId: "run-rt-1",
    summary,
    status: "pending",
  });
  const recordA = readUatTaskFile(taskRoot, taskId);
  assert(recordA !== null, "expected uat.md present after upsert");
  assert(recordA?.attempt === 1, "expected attempt=1 on first upsert");
  assert(recordA?.related_run_ids[0] === "run-rt-1", "expected run id recorded");
  console.log(`  attempt=${recordA?.attempt} status=${recordA?.status}`);

  // Second run on same task → attempt increments.
  await upsertUatTask({
    repoRoot: taskRoot,
    taskId,
    runId: "run-rt-2",
    summary,
    status: "passed",
    resolveGaps: [],
  });
  const recordB = readUatTaskFile(taskRoot, taskId);
  assert(recordB?.attempt === 2, `expected attempt=2 after second upsert, got ${recordB?.attempt}`);
  assert(
    recordB?.related_run_ids.length === 2 && recordB?.related_run_ids[1] === "run-rt-2",
    "expected second run id appended",
  );
  console.log(`  attempt=${recordB?.attempt} status=${recordB?.status}`);

  // Add a new gap and resolve a different one in subsequent calls.
  await upsertUatTask({
    repoRoot: taskRoot,
    taskId,
    runId: "run-rt-3",
    summary,
    status: "failed",
    newGap: { run_id: "run-rt-3", description: "Toast text wrong" },
  });
  await upsertUatTask({
    repoRoot: taskRoot,
    taskId,
    runId: "run-rt-4",
    summary,
    status: "passed",
    resolveGaps: ["Toast text wrong"],
  });
  const recordC = readUatTaskFile(taskRoot, taskId);
  assert(
    recordC?.gaps_open.length === 0 && recordC?.gaps_resolved.length === 1,
    `expected gap moved to resolved; got open=${recordC?.gaps_open.length} resolved=${recordC?.gaps_resolved.length}`,
  );
  console.log(
    `  gaps_resolved=${recordC?.gaps_resolved.length} gaps_open=${recordC?.gaps_open.length}`,
  );

  cleanup();
  console.log("\nsmoke-uat: OK");
}

try {
  await main();
} catch (err) {
  console.error(err);
  cleanup();
  process.exit(1);
}
