#!/usr/bin/env tsx
/**
 * smoke-ux-cleanups — §3.4 acceptance.
 *
 * Three exercises, all via stub adapter (no claude / discord burn):
 *
 *   1. Per-Q walk with replaceBundleId — three sequential requestDialog
 *      calls, each (after the first) carrying replaceBundleId pointing
 *      at the previous step. Asserts the chain is preserved end-to-end
 *      and the final confirm dialog also carries replaceBundleId.
 *
 *   2. Failure class + remediation — completeRun with various error
 *      strings ("sensors failed…", "reviewer …", "uat …",
 *      "halted by operator", unknown). Asserts each PostUpdate has the
 *      expected failureClass + remediation.suggestedActions includes
 *      class-appropriate next moves (`/ship-anyway`, `/resume`, etc.).
 *
 *   3. body > 1024 truncation marker remains intact (regression guard
 *      from §3.3) when failureClass is set.
 */

import { execSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ensureMirror,
  mirrorPath,
  mirrorRecordPath,
} from "../src/mirror/index.js";
import { Orchestrator } from "../src/orchestrator/index.js";
import { StubFrontendAdapter } from "../src/frontend/stub/index.js";
import type {
  DialogResponse,
  PostUpdate,
  RunPhase,
} from "../src/orchestrator/index.js";
import type { DialogSpec } from "../src/frontend/types.js";

const projectName = `smoke_ux_${Date.now()}`;
const cleanupPaths: string[] = [];

function header(line: string): void {
  console.log(`\n── ${line}`);
}

function fail(reason: string): never {
  console.error(`smoke-ux-cleanups FAIL: ${reason}`);
  cleanup();
  process.exit(1);
}

function cleanup(): void {
  for (const p of [
    mirrorRecordPath(projectName),
    mirrorPath(projectName),
    ...cleanupPaths,
  ]) {
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
}

function assert(cond: unknown, msg: string): void {
  if (!cond) fail(msg);
}

async function pollFor<T>(
  fn: () => T | undefined,
  opts: { timeoutMs: number; intervalMs: number; what: string },
): Promise<T> {
  const deadline = Date.now() + opts.timeoutMs;
  while (Date.now() < deadline) {
    const v = fn();
    if (v !== undefined) return v;
    await new Promise((r) => setTimeout(r, opts.intervalMs));
  }
  throw new Error(`timed out waiting for ${opts.what} (after ${opts.timeoutMs}ms)`);
}

interface OrchestratorTestSeam {
  surfacePhaseWithBody: (
    entry: unknown,
    meta: unknown,
    phase: RunPhase,
    body?: string,
    extras?: {
      failureClass?: PostUpdate["failureClass"];
      remediation?: PostUpdate["remediation"];
    },
  ) => Promise<void>;
  completeRun: (
    entry: unknown,
    meta: unknown,
    phase: "succeeded" | "failed",
    error?: string,
  ) => Promise<void>;
}

async function main(): Promise<void> {
  // ── Setup mirror + stub orchestrator ─────────────────────────────
  header("Step 0: mirror + stub adapter + orchestrator");
  const root = mkdtempSync(join(tmpdir(), "harness-smoke-ux-"));
  cleanupPaths.push(root);
  const originBare = join(root, "origin.git");
  const userTree = join(root, "user-tree");
  mkdirSync(originBare);
  execSync("git init --bare -b main", { cwd: originBare });
  mkdirSync(userTree);
  execSync("git init -b main", { cwd: userTree });
  execSync("git config user.email smoke@harness.local", { cwd: userTree });
  execSync("git config user.name smoke", { cwd: userTree });
  writeFileSync(join(userTree, "README.md"), "smoke\n");
  execSync("git add -A && git commit -m initial", { cwd: userTree });
  execSync(`git remote add origin ${originBare}`, { cwd: userTree });
  execSync("git push -u origin main", { cwd: userTree });
  const record = await ensureMirror({
    projectName,
    userTreePath: userTree,
    originUrl: originBare,
  });
  const mirror = record.mirrorPath;
  cleanupPaths.push(mirror);

  // ── Step 1: per-Q walk threads replaceBundleId.
  header("Step 1: per-Q walk dialog chain carries replaceBundleId");
  const stub = new StubFrontendAdapter({ repoRoot: mirror });
  await stub.start();
  // Override requestDialog to deterministic responses keyed by bundle suffix.
  let dialogIdx = 0;
  const dialogResponses: DialogResponse[] = [
    { bundleId: "", choiceId: "a" }, // Q1 → A
    { bundleId: "", choiceId: "b" }, // Q2 → B
    { bundleId: "", choiceId: "approve" }, // confirm → approve
  ];
  stub.requestDialog = async (spec: DialogSpec): Promise<DialogResponse> => {
    stub.recorded.dialogs.push(spec);
    const r = dialogResponses[dialogIdx++] ?? {
      bundleId: spec.bundleId,
      choiceId: "cancel",
    };
    return { ...r, bundleId: spec.bundleId };
  };

  const orchestrator = new Orchestrator({
    projectName,
    repoRoot: mirror,
    adapters: [stub],
    bypassTightener: true,
    bypassSensors: true,
    bypassReviewer: true,
    bypassUat: true,
    pollIntervalMs: 200,
  });
  await orchestrator.start();

  const seam = orchestrator as unknown as OrchestratorTestSeam & {
    requestTightenerDecision: (args: {
      entry: unknown;
      meta: unknown;
      tightened: unknown;
    }) => Promise<unknown>;
  };
  // Synthetic tightener result with two walkable ambiguities.
  const fakeEntry = {
    run_id: "run-ux-1",
    task_id: "TSK-ux-1",
    enqueued_at: new Date().toISOString(),
    row: {
      task: { rawText: "demo", authorId: "smoke" },
    },
    inbox_file: "(none)",
  };
  const fakeMeta = {
    run_id: "run-ux-1",
    task_id: "TSK-ux-1",
    agent_role: "implementer" as const,
    phase: "blocked" as const,
    started_at: new Date().toISOString(),
    tier: "haiku" as const,
    model: "haiku",
    mirror_path: mirror,
    events_count: 0,
  };
  const fakeTightened = {
    output: {
      ambiguities: [
        {
          id: "Q1",
          question: "Pick one",
          candidate_resolutions: ["alpha", "beta"],
        },
        {
          id: "Q2",
          question: "Pick another",
          candidate_resolutions: ["gamma", "delta", "epsilon"],
        },
      ],
      conflicts: [],
      missing_acceptance: [],
      scope_concerns: [],
      existing_stub_overlap: [],
      spec_quality_score: 5,
      ready_to_execute: false,
      tightened_spec_proposal: "tightened spec body",
    },
    tier: "haiku" as const,
    ready: false,
    quality_floor: 7,
    duration_ms: 100,
  };
  const result = await seam.requestTightenerDecision({
    entry: fakeEntry,
    meta: fakeMeta,
    tightened: fakeTightened,
  });
  console.log(
    `  walk produced ${stub.recorded.dialogs.length} dialog specs; result=${JSON.stringify(result)}`,
  );
  assert(
    stub.recorded.dialogs.length === 3,
    `expected exactly 3 dialogs (2 Q + 1 confirm), got ${stub.recorded.dialogs.length}`,
  );
  const [d1, d2, d3] = stub.recorded.dialogs;
  assert(d1!.replaceBundleId === undefined, "Q1 should NOT have replaceBundleId");
  assert(
    d2!.replaceBundleId === d1!.bundleId,
    `Q2 should chain to Q1 bundle (${d1!.bundleId}), got ${d2!.replaceBundleId}`,
  );
  assert(
    d3!.replaceBundleId === d2!.bundleId,
    `confirm should chain to Q2 bundle (${d2!.bundleId}), got ${d3!.replaceBundleId}`,
  );
  // Confirm bundleId always ends with `:confirm`.
  assert(
    d3!.bundleId.endsWith(":confirm"),
    `confirm bundleId should end with :confirm, got ${d3!.bundleId}`,
  );
  console.log(
    `  ✓ chain: ${d1!.bundleId} → ${d2!.bundleId} → ${d3!.bundleId}`,
  );
  // §3.4 — walk steps MUST set compactOnAnswer:false so the next step's
  // edit-in-place isn't race-overwritten by the click-time annotation.
  // Confirm step is terminal → defaults true (omitted).
  assert(
    d1!.compactOnAnswer === false,
    `Q1 must set compactOnAnswer:false (was ${String(d1!.compactOnAnswer)})`,
  );
  assert(
    d2!.compactOnAnswer === false,
    `Q2 must set compactOnAnswer:false (was ${String(d2!.compactOnAnswer)})`,
  );
  assert(
    d3!.compactOnAnswer !== false,
    `confirm step must compact on answer (was ${String(d3!.compactOnAnswer)})`,
  );
  // Run log should record both Q answers + show in recent feed.
  const logTail = readFileSync(
    join(mirror, ".harness", "runs", "active", "run-ux-1", "log.jsonl"),
    "utf8",
  );
  const qAnsweredCount = (logTail.match(/"tightener_q_answered"/g) ?? []).length;
  assert(
    qAnsweredCount === 2,
    `expected 2 tightener_q_answered events in log.jsonl, got ${qAnsweredCount}`,
  );
  console.log(`  ✓ compactOnAnswer wired; ${qAnsweredCount} Q-answered events logged`);
  // taskBody surfaced in the live status update on the per-Q surfacePhase.
  const haveTaskBody = stub.recorded.taskUpdates.some(
    (u) => u.taskBody === "demo",
  );
  assert(
    haveTaskBody,
    `live status updates should carry taskBody='demo'; got: ${JSON.stringify(
      stub.recorded.taskUpdates.map((u) => ({ status: u.status, taskBody: u.taskBody })),
    )}`,
  );
  console.log("  ✓ live status carries taskBody (drop card replaced)");

  // ── Step 2: failure class + remediation per error class.
  header("Step 2: completeRun with various errors → failureClass + remediation");
  const cases: {
    error: string | undefined;
    expectedClass: PostUpdate["failureClass"];
    expectedActionMatch: RegExp;
  }[] = [
    {
      error: "sensors failed-honesty-check after 3 attempts",
      expectedClass: "sensor",
      expectedActionMatch: /\/ship-anyway/,
    },
    {
      error: "reviewer failed-honesty-check after 2 attempts",
      expectedClass: "reviewer",
      expectedActionMatch: /reviewer/,
    },
    {
      error: "uat rejected by operator after 1 attempt",
      expectedClass: "uat",
      expectedActionMatch: /\/resume/,
    },
    {
      error: "halted by operator (/halt)",
      expectedClass: "halt",
      expectedActionMatch: /Re-submit/,
    },
    {
      error: "agent: claude exited 1",
      expectedClass: "hard",
      expectedActionMatch: /log\.jsonl/,
    },
    {
      error: undefined,
      expectedClass: "hard",
      expectedActionMatch: /Re-submit/,
    },
  ];

  for (let i = 0; i < cases.length; i++) {
    const c = cases[i]!;
    const runId = `run-ux-fail-${i + 1}`;
    const taskId = `TSK-ux-fail-${i + 1}`;
    const runDir = join(mirror, ".harness", "runs", "active", runId);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(
      join(runDir, "meta.json"),
      JSON.stringify(
        {
          run_id: runId,
          task_id: taskId,
          agent_role: "implementer",
          phase: "running",
          started_at: "2026-05-03T00:00:00Z",
          tier: "haiku",
          model: "haiku",
          mirror_path: mirror,
          events_count: 0,
        },
        null,
        2,
      ),
    );
    // Synthesize a queue-entry-shaped object so completeRun's inbox-move
    // path doesn't crash. The inbox_file is gibberish; the catch handles it.
    const entry = {
      run_id: runId,
      task_id: taskId,
      enqueued_at: new Date().toISOString(),
      row: {
        task: {
          rawText: "ux fail",
          authorId: "smoke",
          channelId: `ch-${runId}`,
        },
      },
      inbox_file: "(none)",
    };
    const meta = {
      run_id: runId,
      task_id: taskId,
      agent_role: "implementer",
      phase: "running",
      started_at: "2026-05-03T00:00:00Z",
      tier: "haiku",
      model: "haiku",
      mirror_path: mirror,
      events_count: 0,
    };
    const beforeCount = stub.recorded.taskUpdates.length;
    await seam.completeRun(entry, meta, "failed", c.error);
    const update = await pollFor(
      () =>
        stub.recorded.taskUpdates
          .slice(beforeCount)
          .find((u) => u.taskId === taskId && u.status === "failed"),
      { timeoutMs: 4000, intervalMs: 100, what: `PostUpdate for ${taskId}` },
    );
    console.log(
      `  case "${c.error ?? "(undefined)"}" → failureClass=${update.failureClass} actions=${update.remediation?.suggestedActions.length ?? 0}`,
    );
    assert(
      update.failureClass === c.expectedClass,
      `failureClass mismatch: expected ${c.expectedClass}, got ${update.failureClass}`,
    );
    assert(
      update.remediation !== undefined,
      `remediation missing for ${c.expectedClass}`,
    );
    const actions = update.remediation!.suggestedActions.join(" || ");
    assert(
      c.expectedActionMatch.test(actions),
      `actions don't match ${c.expectedActionMatch} for ${c.expectedClass}: ${actions}`,
    );
    assert(
      update.remediation!.reason.length > 0,
      `remediation.reason empty for ${c.expectedClass}`,
    );
  }
  console.log(`  ✓ all ${cases.length} failure classes routed correctly`);

  // ── Step 3: body > 1024 inline footer regression.
  header("Step 3: long body inlines with truncation footer (regression)");
  const beforeLong = stub.recorded.taskUpdates.length;
  const longBody = "X".repeat(2000);
  await seam.surfacePhaseWithBody(
    {
      run_id: "run-ux-long",
      task_id: "TSK-ux-long",
      enqueued_at: new Date().toISOString(),
      row: {
        task: { rawText: "demo", authorId: "smoke", channelId: "ch-long" },
      },
      inbox_file: "(none)",
    },
    {
      run_id: "run-ux-long",
      task_id: "TSK-ux-long",
      agent_role: "implementer",
      phase: "running",
      started_at: "2026-05-03T00:00:00Z",
      tier: "haiku",
      model: "haiku",
      mirror_path: mirror,
      events_count: 0,
    },
    "running",
    longBody,
  );
  const longUpdate = await pollFor(
    () => stub.recorded.taskUpdates.slice(beforeLong)[0],
    { timeoutMs: 4000, intervalMs: 100, what: "long-body PostUpdate" },
  );
  assert(
    longUpdate.body !== undefined && longUpdate.body.length === 2000,
    "long body should be passed through to adapter intact",
  );
  console.log(
    `  ✓ long body (${longUpdate.body!.length} chars) inline; adapter handles truncation`,
  );

  await orchestrator.stop();
  await stub.stop();

  header("Cleanup");
  cleanup();
  console.log("\nsmoke-ux-cleanups: OK");
}

main().catch((err) => {
  console.error("smoke-ux-cleanups threw:", err);
  cleanup();
  process.exit(1);
});
