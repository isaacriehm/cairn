#!/usr/bin/env tsx
/**
 * smoke-completion-integrity — GC completion-integrity pass.
 *
 * Locks the dead-check removal: the pass used to REQUIRE attestation.yaml
 * in the run dir, but nothing writes it there (the optional reviewer writes
 * attestation.yaml into the TASK dir). So every completed run was flagged,
 * and the `continue` even short-circuited the sha-pin reachability check.
 *
 *   Step 1 — a completed task with meta.json (reachable sha_pin) and NO
 *            attestation.yaml produces ZERO findings.
 *   Step 2 — a real defect (missing meta.json) still flags, so the pass
 *            wasn't gutted — it just no longer requires attestation.yaml.
 */

import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { stringify as stringifyYaml } from "yaml";
import { runCompletionIntegrity } from "@isaacriehm/cairn-core";

const cleanups: string[] = [];

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) {
    console.error(`✗ ${message}`);
    cleanup();
    process.exit(1);
  }
}

function cleanup(): void {
  for (const p of cleanups.reverse()) {
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
}

function mkRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "cairn-smoke-ci-"));
  cleanups.push(dir);
  execFileSync("git", ["init", "-q", "--initial-branch=main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "smoke@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Smoke"], { cwd: dir });
  return dir;
}

function commitFile(repoRoot: string): string {
  writeFileSync(join(repoRoot, "f.txt"), "hello\n", "utf8");
  execFileSync("git", ["add", "."], { cwd: repoRoot });
  execFileSync("git", ["commit", "-q", "-m", "seed"], { cwd: repoRoot });
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot }).toString().trim();
}

function seedDoneTask(repoRoot: string, taskId: string, runId: string): void {
  const taskDir = join(repoRoot, ".cairn", "tasks", "done", taskId);
  mkdirSync(taskDir, { recursive: true });
  writeFileSync(
    join(taskDir, "status.yaml"),
    stringifyYaml({ phase: "succeeded", related_run_ids: [runId] }),
    "utf8",
  );
}

function seedRunMeta(repoRoot: string, runId: string, shaPin: string): void {
  const runDir = join(repoRoot, ".cairn", "runs", "terminal", runId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(runDir, "meta.json"),
    JSON.stringify({ run_id: runId, task_id: "TSK-1", sha_pin: shaPin, model: "haiku" }, null, 2),
    "utf8",
  );
  // Deliberately NO attestation.yaml — it's written to the task dir by the
  // optional reviewer, never here; the pass must not require it.
}

async function main(): Promise<void> {
  console.log("smoke-completion-integrity — start");

  // ── Step 1 — completed run, reachable sha, no attestation.yaml → clean
  {
    const repo = mkRepo();
    const sha = commitFile(repo);
    seedDoneTask(repo, "TSK-1", "run-1");
    seedRunMeta(repo, "run-1", sha);
    const r = await runCompletionIntegrity({ repoRoot: repo });
    assert(
      r.findings.length === 0,
      `Step 1: expected 0 findings, got ${r.findings.length}: ${r.findings.map((f) => f.detail).join("; ")}`,
    );
    console.log("  ✓ Step 1 — no attestation.yaml in run dir → no finding");
  }

  // ── Step 2 — a real defect (missing meta.json) still flags
  {
    const repo = mkRepo();
    commitFile(repo);
    seedDoneTask(repo, "TSK-1", "run-1");
    // Run dir exists but has no meta.json.
    mkdirSync(join(repo, ".cairn", "runs", "terminal", "run-1"), { recursive: true });
    const r = await runCompletionIntegrity({ repoRoot: repo });
    assert(r.findings.length === 1, `Step 2: expected 1 finding, got ${r.findings.length}`);
    assert(
      r.findings[0]!.detail.includes("meta.json missing"),
      `Step 2: expected meta.json-missing finding, got ${r.findings[0]!.detail}`,
    );
    console.log("  ✓ Step 2 — missing meta.json still flagged (pass not gutted)");
  }

  cleanup();
  console.log("\nsmoke-completion-integrity — pass");
}

main().catch((err) => {
  console.error("smoke-completion-integrity — fail");
  console.error(err);
  cleanup();
  process.exit(1);
});
