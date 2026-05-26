#!/usr/bin/env tsx
/**
 * smoke-bug-mine-0.13.8 — Phase 5: stall-cue accuracy + throttle.
 *
 * Spec: docs/bug-mine-r3/PHASES.md Phase 5.
 *
 * Scenarios:
 *   1. Task idle 45 min + transcript records tool_use 2 min ago
 *      → cue does NOT fire (45 min < 2 h threshold).
 *   2. Task idle 2.5 h + transcript records tool_use 10 min ago
 *      → cue fires (above threshold + session-activity gate clear).
 *   3. Task idle 2.5 h + transcript records tool_use 2 min ago
 *      → cue does NOT fire (session-activity gate triggers).
 *   4. After a successful cue fires, a second Stop tick inside the
 *      one-hour per-session window suppresses the cue (global
 *      rate-limit).
 *   5. PostToolUse on AskUserQuestion auto-stamps the active task's
 *      status.yaml with `blocked_on: operator`; the next Stop tick
 *      skips that task even when 2.5 h idle.
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");
const STOP_BIN = join(REPO_ROOT, "packages", "cairn-core", "dist", "hooks", "stop.js");
const ASK_USER_BLOCKED_BIN = join(
  REPO_ROOT,
  "packages",
  "cairn-core",
  "dist",
  "hooks",
  "ask-user-blocked.js",
);

const cleanups: string[] = [];

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) {
    console.error(`✗ ${message}`);
    cleanup();
    process.exit(1);
  }
}

function cleanup(): void {
  for (const path of cleanups.reverse()) {
    try {
      rmSync(path, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}

function mkFreshRepo(sessionId: string): { repoRoot: string; sessionDir: string } {
  const dir = mkdtempSync(join(tmpdir(), "cairn-smoke-stall-tuning-"));
  cleanups.push(dir);
  mkdirSync(join(dir, ".cairn"), { recursive: true });
  writeFileSync(join(dir, ".cairn", "config.yaml"), "cairn_version: 0.13.8\n", "utf8");
  const sessionDir = join(dir, ".cairn", "sessions", sessionId);
  mkdirSync(sessionDir, { recursive: true });
  writeFileSync(
    join(sessionDir, "events-marker.json"),
    JSON.stringify({ ts: Date.now() - 60_000, last_polled_ts: Date.now() - 60_000 }),
    "utf8",
  );
  writeFileSync(
    join(sessionDir, "status.json"),
    JSON.stringify({
      updated_at: new Date(Date.now() - 30_000).toISOString(),
      decisions_in_scope: 0,
      invariants_in_scope: 0,
      task_state: "running",
      task_module: null,
      gc_running: false,
      attention_count: 0,
      bypass_count: 0,
    }),
    "utf8",
  );
  // Predate the session dir's birthtime so the first-turn warmup
  // doesn't suppress the stall scan.
  const ancient = new Date(Date.now() - 10 * 60 * 1000);
  try {
    utimesSync(sessionDir, ancient, ancient);
  } catch {
    /* best-effort */
  }
  return { repoRoot: dir, sessionDir };
}

function seedActiveTask(repoRoot: string, taskId: string, idleMs: number): string {
  const taskDir = join(repoRoot, ".cairn", "tasks", "active", taskId);
  mkdirSync(taskDir, { recursive: true });
  const spec = `---\nid: ${taskId}\ntitle: smoke ${taskId}\n---\n# ${taskId}\n`;
  writeFileSync(join(taskDir, "spec.tightened.md"), spec, "utf8");
  const status = `id: ${taskId}\nphase: running\ntitle: smoke ${taskId}\nmodule: .\n`;
  const statusPath = join(taskDir, "status.yaml");
  writeFileSync(statusPath, status, "utf8");
  const at = new Date(Date.now() - idleMs);
  try {
    utimesSync(statusPath, at, at);
    utimesSync(join(taskDir, "spec.tightened.md"), at, at);
  } catch {
    /* best-effort */
  }
  return taskDir;
}

function writeTranscript(
  repoRoot: string,
  sessionId: string,
  lastToolUseAgeMs: number,
): string {
  const path = join(repoRoot, ".cairn", "sessions", sessionId, "transcript.jsonl");
  mkdirSync(dirname(path), { recursive: true });
  const ts = new Date(Date.now() - lastToolUseAgeMs).toISOString();
  // Minimal Claude Code transcript line shape that satisfies the
  // hook's `lastToolUseAgeMs` reader: any JSON object with a
  // top-level `timestamp` string and a stringified `"tool_use"`
  // marker somewhere on the same line.
  const line = JSON.stringify({
    type: "assistant",
    timestamp: ts,
    message: {
      content: [{ type: "tool_use", name: "Read", input: {} }],
    },
  });
  writeFileSync(path, `${line}\n`, "utf8");
  return path;
}

interface StopOutput {
  decision?: "block";
  reason?: string;
  continue?: true;
}

function runStop(
  repoRoot: string,
  sessionId: string,
  transcriptPath: string | null,
): { parsed: StopOutput; status: number; stderr: string } {
  const payload: Record<string, unknown> = { session_id: sessionId, cwd: repoRoot };
  if (transcriptPath !== null) payload["transcript_path"] = transcriptPath;
  const result = spawnSync("node", [STOP_BIN], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    timeout: 30_000,
  });
  const parsed: StopOutput = result.stdout
    ? (JSON.parse(result.stdout.trim()) as StopOutput)
    : { continue: true };
  return { parsed, status: result.status ?? -1, stderr: result.stderr ?? "" };
}

function runAskUserBlocked(repoRoot: string, sessionId: string): number {
  const payload = {
    session_id: sessionId,
    cwd: repoRoot,
    tool_name: "AskUserQuestion",
    tool_input: { question: "smoke" },
  };
  const result = spawnSync("node", [ASK_USER_BLOCKED_BIN], {
    input: JSON.stringify(payload),
    encoding: "utf8",
    timeout: 30_000,
  });
  return result.status ?? -1;
}

function expectFire(out: StopOutput, taskId: string, label: string): void {
  assert(out.decision === "block", `${label}: expected decision:block; got ${JSON.stringify(out)}`);
  const reason = out.reason ?? "";
  assert(/stalled/.test(reason), `${label}: expected stalled hint; got: ${reason}`);
  assert(reason.includes(taskId), `${label}: hint should cite ${taskId}; got: ${reason}`);
}

function expectNoFire(out: StopOutput, label: string): void {
  const reason = out.reason ?? "";
  assert(!/stalled/.test(reason), `${label}: expected no stalled hint; got: ${reason}`);
}

async function main(): Promise<void> {
  console.log("smoke-bug-mine-0.13.8 — start");
  assert(existsSync(STOP_BIN), `compiled stop bin missing — run pnpm -r build`);
  assert(
    existsSync(ASK_USER_BLOCKED_BIN),
    `compiled ask-user-blocked bin missing — run pnpm -r build`,
  );

  // Scenario 1 — 45 min idle + recent tool_use → no fire (below threshold)
  {
    const sessionId = "smoke-stall-1";
    const { repoRoot } = mkFreshRepo(sessionId);
    const taskId = "TSK-stall-45m-aaaaaaa";
    seedActiveTask(repoRoot, taskId, 45 * 60 * 1000);
    const transcriptPath = writeTranscript(repoRoot, sessionId, 2 * 60 * 1000);
    const { parsed, status } = runStop(repoRoot, sessionId, transcriptPath);
    assert(status === 0, `Scenario 1: stop exit ${status}`);
    expectNoFire(parsed, "Scenario 1");
    console.log("  ✓ Scenario 1 — 45min idle + recent tool_use → no cue (below 2h threshold)");
  }

  // Scenario 2 — 2.5h idle + stale tool_use → cue fires
  {
    const sessionId = "smoke-stall-2";
    const { repoRoot } = mkFreshRepo(sessionId);
    const taskId = "TSK-stall-2h-bbbbbbb";
    seedActiveTask(repoRoot, taskId, 2.5 * 60 * 60 * 1000);
    const transcriptPath = writeTranscript(repoRoot, sessionId, 10 * 60 * 1000);
    const { parsed, status } = runStop(repoRoot, sessionId, transcriptPath);
    assert(status === 0 || status === 2, `Scenario 2: stop exit ${status}`);
    expectFire(parsed, taskId, "Scenario 2");
    console.log("  ✓ Scenario 2 — 2.5h idle + stale tool_use → cue fires");
  }

  // Scenario 3 — 2.5h idle + recent tool_use (2 min) → no fire (activity gate)
  {
    const sessionId = "smoke-stall-3";
    const { repoRoot } = mkFreshRepo(sessionId);
    const taskId = "TSK-stall-active-ccccccc";
    seedActiveTask(repoRoot, taskId, 2.5 * 60 * 60 * 1000);
    const transcriptPath = writeTranscript(repoRoot, sessionId, 2 * 60 * 1000);
    const { parsed, status } = runStop(repoRoot, sessionId, transcriptPath);
    assert(status === 0, `Scenario 3: stop exit ${status}`);
    expectNoFire(parsed, "Scenario 3");
    console.log("  ✓ Scenario 3 — 2.5h idle + recent tool_use → session-activity gate suppresses");
  }

  // Scenario 4 — per-session rate-limit: second Stop within 1 h is silenced
  {
    const sessionId = "smoke-stall-4";
    const { repoRoot } = mkFreshRepo(sessionId);
    const taskId = "TSK-stall-ratelim-ddddddd";
    seedActiveTask(repoRoot, taskId, 3 * 60 * 60 * 1000);
    const transcriptPath = writeTranscript(repoRoot, sessionId, 30 * 60 * 1000);
    const first = runStop(repoRoot, sessionId, transcriptPath);
    expectFire(first.parsed, taskId, "Scenario 4 — first Stop");
    // Stamp the per-task throttle marker so the per-task gate doesn't
    // suppress the second tick on its own (we want the per-session
    // global gate to be the assertion). Both gates fire independently
    // — the per-session one is what 0.13.8 adds.
    const taskMarkerDir = join(repoRoot, ".cairn", ".stalled-warned");
    try {
      rmSync(taskMarkerDir, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
    const second = runStop(repoRoot, sessionId, transcriptPath);
    expectNoFire(second.parsed, "Scenario 4 — second Stop within session window");
    console.log("  ✓ Scenario 4 — second Stop within 1h session window is silenced");
  }

  // Scenario 5 — AskUserQuestion PostToolUse stamps blocked_on: operator,
  //              subsequent Stop tick skips the task.
  {
    const sessionId = "smoke-stall-5";
    const { repoRoot } = mkFreshRepo(sessionId);
    const taskId = "TSK-stall-blocked-eeeeeee";
    seedActiveTask(repoRoot, taskId, 3 * 60 * 60 * 1000);
    const askExit = runAskUserBlocked(repoRoot, sessionId);
    assert(askExit === 0, `Scenario 5: ask-user-blocked exit ${askExit}`);
    const statusBody = readFileSync(
      join(repoRoot, ".cairn", "tasks", "active", taskId, "status.yaml"),
      "utf8",
    );
    assert(
      /^blocked_on:\s*operator/m.test(statusBody),
      `Scenario 5: status.yaml should carry blocked_on: operator after AskUserQuestion;\n${statusBody}`,
    );
    const transcriptPath = writeTranscript(repoRoot, sessionId, 30 * 60 * 1000);
    const { parsed } = runStop(repoRoot, sessionId, transcriptPath);
    expectNoFire(parsed, "Scenario 5 — blocked_on: operator suppresses cue");
    console.log("  ✓ Scenario 5 — AskUserQuestion → blocked_on: operator → Stop skips task");
  }

  cleanup();
  console.log("smoke-bug-mine-0.13.8 — pass");
}

main().catch((err: unknown) => {
  console.error("smoke-bug-mine-0.13.8 — fail");
  console.error(err);
  cleanup();
  process.exit(1);
});
