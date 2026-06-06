#!/usr/bin/env tsx
/**
 * smoke-bypass-detection — Stop hook layer for `git commit --no-verify` catch.
 *
 * Spec: PLUGIN_ARCHITECTURE §17 Layer 1.
 */

import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  renderBypassHint,
  scanBypassedCommits,
} from "@isaacriehm/cairn-core";

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
      // best-effort
    }
  }
}

function mkRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "cairn-smoke-bypass-"));
  cleanups.push(dir);
  execFileSync("git", ["init", "-q", "--initial-branch=main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "smoke@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Smoke"], { cwd: dir });
  return dir;
}

function commit(repoRoot: string, message: string): string {
  writeFileSync(
    join(repoRoot, "f.txt"),
    `${message}\n${Date.now()}\n${Math.random()}\n`,
    "utf8",
  );
  execFileSync("git", ["add", "f.txt"], { cwd: repoRoot });
  execFileSync("git", ["commit", "-q", "-m", message], { cwd: repoRoot });
  return execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();
}

function step(label: string): void {
  console.log(`── ${label}`);
}

async function main(): Promise<void> {
  step("Step 1 — non-git dir → no bypassed");
  const tmp = mkdtempSync(join(tmpdir(), "cairn-smoke-bypass-empty-"));
  cleanups.push(tmp);
  const r1 = scanBypassedCommits(tmp);
  assert(r1.bypassed.length === 0, "no bypassed in non-git dir");
  assert(r1.inspected === 0, "inspected = 0");
  console.log("  ✓ Step 1 — non-git → empty");

  step("Step 2 — fresh git, no .attested-commits → all bypassed");
  const repoRoot = mkRepo();
  const sha1 = commit(repoRoot, "first");
  const sha2 = commit(repoRoot, "second");
  const r2 = scanBypassedCommits(repoRoot);
  const shas = r2.bypassed.map((b) => b.sha);
  assert(shas.includes(sha1), "sha1 flagged");
  assert(shas.includes(sha2), "sha2 flagged");
  assert(r2.attestedFileExists === false, "attested file absent");
  console.log("  ✓ Step 2 — all flagged when no attested file");

  step("Step 3 — attested file masks recorded shas");
  mkdirSync(join(repoRoot, ".cairn"), { recursive: true });
  writeFileSync(join(repoRoot, ".cairn", ".attested-commits"), `${sha1}\n${sha2}\n`, "utf8");
  const r3 = scanBypassedCommits(repoRoot);
  assert(r3.bypassed.length === 0, "no bypassed when both attested");
  assert(r3.attestedFileExists === true, "attested file detected");
  console.log("  ✓ Step 3 — attested shas masked");

  step("Step 4 — partial attest → only un-attested flagged");
  const sha3 = commit(repoRoot, "third (no-verify)");
  // sha3 NOT appended to .attested-commits (simulating --no-verify)
  const r4 = scanBypassedCommits(repoRoot);
  assert(r4.bypassed.length === 1, "one bypassed commit");
  assert(r4.bypassed[0]?.sha === sha3, "sha3 is the bypassed one");
  assert(r4.bypassed[0]?.shortSha.length === 7, "short sha 7 chars");
  assert(r4.bypassed[0]?.subject === "third (no-verify)", "subject captured");
  console.log("  ✓ Step 4 — partial attest");

  step("Step 5 — only inspects last 5 SHAs");
  // Add 5 more attested commits — sha3 should fall out of the 5-commit window.
  for (let i = 0; i < 5; i++) {
    const sha = commit(repoRoot, `attested-${i}`);
    appendFileSync(join(repoRoot, ".cairn", ".attested-commits"), `${sha}\n`, "utf8");
  }
  const r5 = scanBypassedCommits(repoRoot);
  assert(r5.inspected === 5, "inspected = 5");
  assert(r5.bypassed.length === 0, "sha3 out of window — no bypasses");
  console.log("  ✓ Step 5 — 5-commit lookback window");

  step("Step 6 — renderBypassHint instructs cairn-attention skill");
  const hint = renderBypassHint([
    { sha: "abcdef0123456", shortSha: "abcdef0", subject: "feat: thing" },
  ]);
  // Stop-hook prose is Claude-facing additionalContext — it must
  // instruct the cairn-attention skill (which renders the
  // record/acknowledge/defer choice through AskUserQuestion) instead
  // of inlining `[a]/[b]/[c]` text that nobody renders.
  assert(/cairn-attention/.test(hint), "renders cairn-attention skill instruction");
  assert(/record bypass/.test(hint), "renders record-bypass intent");
  assert(/acknowledge/.test(hint), "renders acknowledge intent");
  assert(/defer/.test(hint), "renders defer intent");
  assert(hint.includes("abcdef0"), "renders short sha");
  assert(hint.includes("feat: thing"), "renders subject");
  console.log("  ✓ Step 6 — render delegates to cairn-attention skill");

  step("Step 7 — commits on a remote are excluded (multi-dev false-positive guard)");
  // `.attested-commits` is per-clone. A teammate's commit pulled into
  // this clone lives on origin but is NOT in our local attested set —
  // it must NOT be flagged. Only local, unpushed work is a bypass
  // candidate (`git log HEAD --not --remotes`).
  const teamRepo = mkRepo();
  const bare = mkdtempSync(join(tmpdir(), "cairn-smoke-bypass-remote-"));
  cleanups.push(bare);
  execFileSync("git", ["init", "-q", "--bare", bare]);
  const shared = commit(teamRepo, "shared (on remote, not attested)");
  execFileSync("git", ["remote", "add", "origin", bare], { cwd: teamRepo });
  execFileSync("git", ["push", "-q", "origin", "main"], { cwd: teamRepo });
  // A local, unpushed commit that skipped attestation (the real bypass).
  const localBypass = commit(teamRepo, "local bypass (unpushed)");
  const r7 = scanBypassedCommits(teamRepo);
  const flagged7 = r7.bypassed.map((b) => b.sha);
  assert(!flagged7.includes(shared), "remote/pushed commit excluded from bypass scan");
  assert(flagged7.includes(localBypass), "local unpushed bypass still flagged");
  console.log("  ✓ Step 7 — remote commits excluded, local bypass flagged");

  step("Cleanup");
  cleanup();
  console.log("\nsmoke-bypass-detection — pass");
}

main().catch((err) => {
  console.error("smoke-bypass-detection — fail");
  console.error(err);
  cleanup();
  process.exit(1);
});
