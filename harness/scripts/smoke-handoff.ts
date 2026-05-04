#!/usr/bin/env tsx
/**
 * smoke-handoff — buildHandoffBlock + buildSpecDelta empty-case behavior.
 *
 * Pure-mechanical (no LLM burn). Asserts that:
 *   1. buildHandoffBlock(repoRoot) returns null when there's no
 *      .harness/tasks/active/.
 *   2. buildSpecDelta(repoRoot, []) returns null (empty input → no delta).
 *   3. buildSpecDelta(repoRoot, ["src/foo.ts"]) returns null when the
 *      path has no git history.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildHandoffBlock, buildSpecDelta } from "@devplusllc/harness-core";

const cleanups: string[] = [];

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) {
    console.error(`✗ ${message}`);
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

function mkFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "harness-smoke-handoff-"));
  cleanups.push(dir);
  return dir;
}

async function runSmoke(): Promise<void> {
  console.log("smoke-handoff — start");

  // ── Step 1 — no .harness/tasks/active/ → null ────────────────────
  {
    const repoRoot = mkFixture();
    mkdirSync(join(repoRoot, ".harness"), { recursive: true });
    const result = await buildHandoffBlock(repoRoot);
    assert(
      result === null,
      `Step 1: expected null when no tasks/active/, got ${typeof result === "string" ? `string of ${result.length} chars` : String(result)}`,
    );
    console.log("  ✓ Step 1 — empty tasks/active → null");
  }

  // ── Step 2 — buildSpecDelta with empty taskScopePaths → null ─────
  {
    const repoRoot = mkFixture();
    mkdirSync(join(repoRoot, ".harness"), { recursive: true });
    const result = await buildSpecDelta(repoRoot, []);
    assert(
      result === null,
      `Step 2: expected null for empty taskScopePaths, got ${String(result)}`,
    );
    console.log("  ✓ Step 2 — empty scope paths → null");
  }

  // ── Step 3 — buildSpecDelta on path with no git history → null ───
  {
    const repoRoot = mkFixture();
    mkdirSync(join(repoRoot, ".harness"), { recursive: true });
    // No git init — path has no history. Should return null.
    const result = await buildSpecDelta(repoRoot, ["src/foo.ts"]);
    assert(
      result === null,
      `Step 3: expected null on path with no history, got ${String(result)}`,
    );
    console.log("  ✓ Step 3 — no git history → null");
  }

  console.log("smoke-handoff — pass");
}

try {
  await runSmoke();
} finally {
  cleanup();
}
