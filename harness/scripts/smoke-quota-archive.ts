#!/usr/bin/env tsx
/**
 * smoke-quota-archive — §3.5 acceptance.
 *
 * Two exercises:
 *
 *   1. Plan-quota — synthetic rate-limit + overloaded errors fed via the
 *      `recordQuotaSignal` test seam. After 3 consecutive quota-class
 *      errors the orchestrator flips dispatchPaused, emits a notify, and
 *      `/status` reports the pause line. /unpause clears + resets counter.
 *
 *   2. /archive — drop a file in the mirror, slash `/archive <path>`,
 *      assert it lives at `.archive/<YYYY-MM-DD>/<path>` afterwards and
 *      a `chore(archive): move ...` commit landed on the mirror's HEAD.
 */

import { execSync } from "node:child_process";
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
  ensureMirror,
  mirrorPath,
  mirrorRecordPath,
} from "../src/mirror/index.js";
import { Orchestrator } from "../src/orchestrator/index.js";
import { StubFrontendAdapter } from "../src/frontend/stub/index.js";
import {
  classifyClaudeError,
  isQuotaKind,
} from "../src/claude/error.js";
import type { ClaudeErrorKind } from "../src/claude/error.js";
import type { SlashEvent } from "../src/frontend/types.js";

const projectName = `smoke_qa_${Date.now()}`;
const cleanupPaths: string[] = [];

function header(line: string): void {
  console.log(`\n── ${line}`);
}

function fail(reason: string): never {
  console.error(`smoke-quota-archive FAIL: ${reason}`);
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

function buildSlash(opts: {
  command: string;
  options?: Record<string, string>;
}): SlashEvent {
  return {
    source: "stub",
    command: opts.command,
    options: opts.options ?? {},
    authorId: "smoke",
    receivedAt: new Date().toISOString(),
  };
}

interface OrchSeam {
  recordQuotaSignal: (kind: ClaudeErrorKind, message: string) => Promise<void>;
}

async function main(): Promise<void> {
  // Step 0 — sanity: classifier matches the canonical error strings.
  header("Step 0: classifyClaudeError sanity");
  const cases: { msg: string; expect: ClaudeErrorKind; quota: boolean }[] = [
    { msg: "Error: Rate limit exceeded", expect: "rate_limit", quota: true },
    { msg: "HTTP 429 Too Many Requests", expect: "rate_limit", quota: true },
    { msg: "overloaded_error: API capacity exceeded", expect: "overloaded", quota: true },
    { msg: "503 Service Unavailable", expect: "overloaded", quota: true },
    { msg: "401 Unauthorized: invalid API key", expect: "auth", quota: false },
    { msg: "credit balance is too low", expect: "auth", quota: false },
    { msg: "claude exited 1: parse error in stdin", expect: "other", quota: false },
  ];
  for (const c of cases) {
    const k = classifyClaudeError({ message: c.msg });
    assert(
      k === c.expect,
      `classify "${c.msg}" expected ${c.expect}, got ${k}`,
    );
    assert(
      isQuotaKind(k) === c.quota,
      `isQuotaKind for ${k} expected ${c.quota}`,
    );
  }
  console.log(`  ✓ ${cases.length} classifier cases match`);

  // Setup mirror.
  const root = mkdtempSync(join(tmpdir(), "harness-smoke-qa-"));
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
  // Pre-create a stale doc to archive in step 2.
  mkdirSync(join(userTree, "docs", "old"), { recursive: true });
  writeFileSync(
    join(userTree, "docs", "old", "stale-design.md"),
    "# stale design\n\nold notes\n",
  );
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
  const seam = orchestrator as unknown as OrchSeam;

  // ── Step 1: 3 consecutive rate-limit errors → dispatch paused.
  header("Step 1: 3 consecutive quota errors → dispatchPaused");
  const beforeNotice = stub.recorded.notifications.length;
  await seam.recordQuotaSignal("rate_limit", "Error: Rate limit exceeded (1)");
  await seam.recordQuotaSignal("overloaded", "503 Service Unavailable (2)");
  await seam.recordQuotaSignal("rate_limit", "Error: Rate limit exceeded (3)");
  const pauseNotice = await pollFor(
    () =>
      stub.recorded.notifications
        .slice(beforeNotice)
        .find((n) => n.message.startsWith("⛔ Dispatch PAUSED")),
    { timeoutMs: 3000, intervalMs: 100, what: "pause notification" },
  );
  assert(
    pauseNotice.level === "error",
    `pause notification should be error level, got ${pauseNotice.level}`,
  );
  console.log(`  ✓ pause notify fired after 3 consecutive`);

  // /status should show pause line.
  await stub.pushSlash(buildSlash({ command: "status" }));
  const statusNotice = await pollFor(
    () =>
      stub.recorded.notifications
        .slice(-5)
        .find(
          (n) =>
            n.message.startsWith("📊 Harness status") &&
            n.message.includes("DISPATCH PAUSED"),
        ),
    { timeoutMs: 3000, intervalMs: 100, what: "/status PAUSED line" },
  );
  console.log(`  ✓ /status reports DISPATCH PAUSED`);
  void statusNotice;

  // quota.jsonl recorded the events.
  const quotaLog = join(mirror, ".harness", "staleness", "quota.jsonl");
  assert(existsSync(quotaLog), "quota.jsonl not created");
  const quotaLines = readFileSync(quotaLog, "utf8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
  assert(
    quotaLines.length >= 4,
    `expected >=4 quota log entries (3 + the pause-marker), got ${quotaLines.length}`,
  );
  const pausedEntry = quotaLines.find((q) => q["paused"] === true);
  assert(pausedEntry !== undefined, "no paused=true entry in quota.jsonl");
  console.log(`  ✓ quota.jsonl persisted (${quotaLines.length} entries)`);

  // /unpause clears.
  const beforeUnpause = stub.recorded.notifications.length;
  await stub.pushSlash(buildSlash({ command: "unpause" }));
  const unpauseNotice = await pollFor(
    () =>
      stub.recorded.notifications
        .slice(beforeUnpause)
        .find((n) => n.message.startsWith("▶ Dispatch UNPAUSED")),
    { timeoutMs: 3000, intervalMs: 100, what: "/unpause notification" },
  );
  console.log(`  ✓ /unpause cleared (${unpauseNotice.message.slice(0, 60)}…)`);

  // ── Step 2: /archive moves file + commits.
  header("Step 2: /archive moves file + commits");
  const targetPath = "docs/old/stale-design.md";
  // Ensure file exists in mirror.
  const sourceAbs = join(mirror, targetPath);
  assert(existsSync(sourceAbs), `pre-archive: ${targetPath} should exist in mirror`);
  await stub.pushSlash(
    buildSlash({ command: "archive", options: { path: targetPath } }),
  );
  const archiveNotice = await pollFor(
    () =>
      stub.recorded.notifications.find((n) =>
        n.message.startsWith("📦 /archive"),
      ),
    { timeoutMs: 4000, intervalMs: 100, what: "/archive notification" },
  );
  assert(
    /commit `[0-9a-f]{8}`/.test(archiveNotice.message),
    `/archive notice missing commit sha: ${archiveNotice.message}`,
  );
  // Source gone, archive present.
  assert(!existsSync(sourceAbs), "source file should be moved");
  const today = new Date().toISOString().slice(0, 10);
  const archiveAbs = join(mirror, ".archive", today, targetPath);
  assert(
    existsSync(archiveAbs),
    `expected file at .archive/${today}/${targetPath}`,
  );
  // HEAD commit message matches.
  const headMessage = execSync("git log -1 --pretty=%B", { cwd: mirror, encoding: "utf8" });
  assert(
    headMessage.includes("chore(archive): move docs/old/stale-design.md"),
    `HEAD commit message mismatch: ${headMessage}`,
  );
  console.log(`  ✓ file moved + commit landed on mirror HEAD`);

  // ── Step 3: /archive refuses bad paths.
  header("Step 3: /archive refuses .git / absolute / .. paths");
  const refuseCases: { path: string; expect: RegExp }[] = [
    { path: ".git/HEAD", expect: /refusing to archive inside \.git/ },
    { path: ".harness/config.yaml", expect: /refusing to archive inside \.harness/ },
    { path: "/etc/passwd", expect: /must be repo-relative/ },
    { path: "../escape.md", expect: /must be repo-relative/ },
    { path: "node_modules/something/file.js", expect: /refusing to archive inside node_modules/ },
  ];
  for (const c of refuseCases) {
    const before = stub.recorded.notifications.length;
    await stub.pushSlash(
      buildSlash({ command: "archive", options: { path: c.path } }),
    );
    const refuse = await pollFor(
      () =>
        stub.recorded.notifications
          .slice(before)
          .find((n) => /\/archive/.test(n.message)),
      { timeoutMs: 3000, intervalMs: 100, what: `refuse for ${c.path}` },
    );
    assert(
      c.expect.test(refuse.message),
      `refuse message for "${c.path}" doesn't match ${c.expect}: ${refuse.message}`,
    );
  }
  console.log(`  ✓ ${refuseCases.length} unsafe paths refused`);

  await orchestrator.stop();
  await stub.stop();
  header("Cleanup");
  cleanup();
  console.log("\nsmoke-quota-archive: OK");
}

main().catch((err) => {
  console.error("smoke-quota-archive threw:", err);
  cleanup();
  process.exit(1);
});
