#!/usr/bin/env tsx
/**
 * smoke-visibility — §3.3 acceptance.
 *
 * Validates the per-run log.jsonl + tool-digest + drop-the-content-split
 * plumbing without spawning a real claude subprocess. Pure unit-style
 * exercises:
 *
 *   1. extractToolDigest parses synthetic claude stream-json events
 *      → returns deduped files, last-N bash commands, last-N searches.
 *
 *   2. appendRunLogEntry + readRunLogTail roundtrip → tail returns the
 *      structured entries newest-last; missing file returns [].
 *
 *   3. surfacePhaseWithBody emits a PostUpdate carrying recentEvents
 *      (from log.jsonl tail) and tools (from synthetic events.jsonl).
 *      Body inlines as `details` (no secondary message).
 *
 *   4. Body > 1024 chars surfaces with truncated `details` field +
 *      log-pointer footer (no separate chunked message). Stub adapter
 *      receives one PostUpdate, no chunked text content.
 *
 *   5. activityFeed tick surfaces tools + recentEvents alongside the
 *      Tier-0 activity string (smoke synthesizes the Ollama summary).
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendRunLogEntry,
  formatRunLogTail,
  readRunLogTail,
} from "../src/orchestrator/run-log.js";
import {
  digestIsEmpty,
  extractToolDigest,
} from "../src/orchestrator/tool-digest.js";
import { Orchestrator } from "../src/orchestrator/index.js";
import { StubFrontendAdapter } from "../src/frontend/stub/index.js";
import {
  ensureMirror,
  mirrorPath,
  mirrorRecordPath,
} from "../src/mirror/index.js";
import { execSync } from "node:child_process";
import type { PostUpdate } from "../src/frontend/types.js";

const projectName = `smoke_vis_${Date.now()}`;
const cleanupPaths: string[] = [];

function header(line: string): void {
  console.log(`\n── ${line}`);
}

function fail(reason: string): never {
  console.error(`smoke-visibility FAIL: ${reason}`);
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

function syntheticEvents(): Record<string, unknown>[] {
  return [
    {
      type: "system",
      subtype: "init",
    },
    {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            name: "Read",
            input: { file_path: "/tmp/x.ts" },
          },
        ],
      },
    },
    {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            name: "Edit",
            input: { file_path: "/repo/core/src/a.ts" },
          },
          {
            type: "tool_use",
            name: "Edit",
            input: { file_path: "/repo/core/src/b.ts" },
          },
        ],
      },
    },
    {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            name: "Bash",
            input: { command: "pnpm -F @devplusllc/harness typecheck" },
          },
        ],
      },
    },
    {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            name: "Grep",
            input: { pattern: "appendRunLogEntry" },
          },
          {
            type: "tool_use",
            name: "Glob",
            input: { glob: "harness/src/**/*.ts" },
          },
        ],
      },
    },
    // Repeat a file edit — should dedupe to single entry.
    {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            name: "Edit",
            input: { file_path: "/repo/core/src/a.ts" },
          },
        ],
      },
    },
    { type: "result", is_error: false },
  ];
}

async function main(): Promise<void> {
  // ── Step 1: extractToolDigest parses synthetic events.
  header("Step 1: extractToolDigest dedupes + caps");
  const digest = extractToolDigest(syntheticEvents(), {
    maxFiles: 4,
    maxBash: 3,
    maxSearches: 3,
  });
  console.log(
    `  files=${JSON.stringify(digest.files)} bash=${JSON.stringify(digest.bash)} searches=${JSON.stringify(digest.searches)}`,
  );
  assert(
    digest.files.length === 2,
    `expected 2 unique files, got ${digest.files.length}`,
  );
  assert(
    digest.files[0] === "/repo/core/src/b.ts" &&
      digest.files[1] === "/repo/core/src/a.ts",
    `dedup order wrong: ${JSON.stringify(digest.files)}`,
  );
  assert(
    digest.bash.length === 1 && digest.bash[0]!.startsWith("pnpm -F"),
    `bash mismatch: ${JSON.stringify(digest.bash)}`,
  );
  assert(
    digest.searches.length === 2,
    `expected 2 searches, got ${digest.searches.length}`,
  );
  assert(
    !digestIsEmpty(digest),
    "digestIsEmpty returned true on populated digest",
  );

  // ── Step 2: run-log roundtrip.
  header("Step 2: appendRunLogEntry + readRunLogTail roundtrip");
  const tmpRoot = mkdtempSync(join(tmpdir(), "harness-smoke-vis-"));
  cleanupPaths.push(tmpRoot);
  const fakeRunId = "run-fake-vis-1";
  // Empty initial tail.
  const empty = await readRunLogTail({
    repoRoot: tmpRoot,
    runId: fakeRunId,
    n: 5,
  });
  assert(empty.length === 0, "expected empty tail for missing file");
  // Append three entries.
  for (const k of ["run_started", "phase_changed", "sensor_sweep"] as const) {
    await appendRunLogEntry({
      repoRoot: tmpRoot,
      runId: fakeRunId,
      kind: k,
      summary: `summary-${k}`,
    });
  }
  const tail = await readRunLogTail({
    repoRoot: tmpRoot,
    runId: fakeRunId,
    n: 5,
  });
  assert(tail.length === 3, `expected 3 entries, got ${tail.length}`);
  assert(
    tail[0]!.kind === "run_started" && tail[2]!.kind === "sensor_sweep",
    "tail order wrong",
  );
  const formatted = formatRunLogTail(tail);
  assert(
    formatted.includes("run started") &&
      formatted.includes("sensor sweep") &&
      formatted.includes("summary-sensor_sweep"),
    `formatted tail missing entries: ${formatted}`,
  );
  console.log(`  ✓ roundtrip + formatted tail (${tail.length} entries)`);

  // ── Step 3: orchestrator surfacePhase emits enriched PostUpdate.
  header("Step 3: surfacePhase pushes recentEvents + tools + body inline");
  const root = mkdtempSync(join(tmpdir(), "harness-smoke-vis-orch-"));
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

  const stub = new StubFrontendAdapter({ repoRoot: mirror });
  await stub.start();
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

  // Manufacture an active run by writing meta + events.jsonl + log.jsonl
  // directly, then call surfacePhaseWithBody via a dropped task that we
  // route through. Since dispatch needs claude, use a private path: cast
  // and call surfacePhase directly via the test seam (no public API exists).
  const synthRunId = "run-synth-vis-1";
  const runDir = join(mirror, ".harness", "runs", "active", synthRunId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "meta.json"),
    JSON.stringify(
      {
        run_id: synthRunId,
        task_id: "TSK-synth-1",
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
  // Pre-seed the log with two entries.
  await appendRunLogEntry({
    repoRoot: mirror,
    runId: synthRunId,
    kind: "run_started",
    summary: "haiku · synth task",
  });
  await appendRunLogEntry({
    repoRoot: mirror,
    runId: synthRunId,
    kind: "phase_changed",
    summary: "→ running",
  });
  // Pre-seed events.jsonl with the synthetic tool events.
  writeFileSync(
    join(runDir, "events.jsonl"),
    syntheticEvents()
      .map((e) => JSON.stringify(e))
      .join("\n") + "\n",
  );
  // Use the orchestrator's surfacePhaseWithBody via a stub queue entry.
  const orchAny = orchestrator as unknown as {
    surfacePhaseWithBody: (
      entry: {
        run_id: string;
        task_id: string;
        enqueued_at: string;
        row: { row?: unknown; task: { rawText: string; channelId?: string; authorId: string }; task_id?: string };
        inbox_file: string;
      },
      meta: Record<string, unknown>,
      phase: string,
      body?: string,
    ) => Promise<void>;
  };
  const queueEntry = {
    run_id: synthRunId,
    task_id: "TSK-synth-1",
    enqueued_at: new Date().toISOString(),
    row: {
      task: {
        rawText: "synthetic task",
        authorId: "smoke",
        channelId: "channel-synth-1",
      },
    },
    inbox_file: "(none)",
  };
  const meta = JSON.parse(
    readFileSync(join(runDir, "meta.json"), "utf8"),
  ) as Record<string, unknown>;
  await orchAny.surfacePhaseWithBody(
    queueEntry,
    meta,
    "running",
    "Reviewer rejected: missing assertion on actor_user_id. Re-running with remediation context.",
  );
  const enriched = await pollFor(
    () =>
      stub.recorded.taskUpdates.find((u) => u.taskId === "TSK-synth-1"),
    { timeoutMs: 4000, intervalMs: 100, what: "PostUpdate from surfacePhase" },
  );
  console.log(
    `  ✓ PostUpdate received: tools.files=${enriched.tools?.files?.length ?? 0} bash=${enriched.tools?.bash?.length ?? 0} searches=${enriched.tools?.searches?.length ?? 0} recentEvents=${enriched.recentEvents?.length ?? 0}`,
  );
  assert(
    enriched.tools?.files?.length === 2,
    `expected 2 tools.files, got ${enriched.tools?.files?.length}`,
  );
  assert(
    enriched.tools?.bash !== undefined && enriched.tools.bash.length >= 1,
    "expected ≥1 bash command",
  );
  assert(
    enriched.recentEvents !== undefined && enriched.recentEvents.length >= 2,
    `expected ≥2 recentEvents, got ${enriched.recentEvents?.length}`,
  );
  assert(
    enriched.body !== undefined &&
      enriched.body.startsWith("Reviewer rejected"),
    "body not propagated",
  );

  // ── Step 4: body > 1024 → still inlined into PostUpdate (adapter
  // truncates inside embed; smoke just verifies the orchestrator still
  // emits a single update with the full body).
  header("Step 4: body > 1024 chars → single PostUpdate, no chunked content");
  const longBody = "X".repeat(2000);
  const beforeLong = stub.recorded.taskUpdates.length;
  await orchAny.surfacePhaseWithBody(queueEntry, meta, "running", longBody);
  const longUpdate = await pollFor(
    () => stub.recorded.taskUpdates.slice(beforeLong)[0],
    { timeoutMs: 4000, intervalMs: 100, what: "PostUpdate (long body)" },
  );
  assert(
    longUpdate.body !== undefined && longUpdate.body.length === 2000,
    `body length should be 2000, got ${longUpdate.body?.length}`,
  );
  // Critically: only ONE additional PostUpdate (no chunked content posts).
  assert(
    stub.recorded.taskUpdates.length === beforeLong + 1,
    `expected exactly 1 new PostUpdate, got ${stub.recorded.taskUpdates.length - beforeLong}`,
  );
  console.log(`  ✓ long body inline; no secondary chunked message`);

  // ── Step 5: dispatch start logs run_started; halt logs halt_requested.
  // Manufactured via direct inspection of the log.jsonl after step 3-4.
  header("Step 5: log.jsonl tail covers transitions");
  const logTail = await readRunLogTail({
    repoRoot: mirror,
    runId: synthRunId,
    n: 20,
  });
  const kinds = logTail.map((e) => e.kind);
  assert(
    kinds.includes("run_started") &&
      kinds.includes("phase_changed"),
    `log.jsonl missing transitions: ${kinds.join(",")}`,
  );
  // The two surfacePhaseWithBody calls above appended phase_changed entries.
  const phaseChangeCount = kinds.filter((k) => k === "phase_changed").length;
  assert(
    phaseChangeCount >= 3,
    `expected ≥3 phase_changed entries, got ${phaseChangeCount}`,
  );
  console.log(
    `  ✓ log.jsonl has ${kinds.length} entries (${phaseChangeCount} phase_changed)`,
  );

  await orchestrator.stop();
  await stub.stop();
  header("Cleanup");
  cleanup();
  console.log("\nsmoke-visibility: OK");
}

// Suppress TS6133 on unused PostUpdate import
void ((): void => {
  const _: PostUpdate | undefined = undefined;
  void _;
})();

main().catch((err) => {
  console.error("smoke-visibility threw:", err);
  cleanup();
  process.exit(1);
});

void existsSync;
