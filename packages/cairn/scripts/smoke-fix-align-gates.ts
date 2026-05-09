#!/usr/bin/env tsx
/**
 * smoke-fix-align-gates — `cairn fix align` operator-consent gates.
 *
 *   Step 1 — Missing sentinel: validate returns `missing` against a
 *            repo that never ran --dry-run.
 *   Step 2 — Round-trip: write sentinel, validate same args → ok.
 *   Step 3 — Args drifted: validate with a different --include glob
 *            after writing → `args-drifted`.
 *   Step 4 — Stale sentinel: write sentinel, validate at now + 31 min
 *            → `stale`.
 *   Step 5 — HEAD drifted: write sentinel, add a fresh commit,
 *            validate → `head-drifted`.
 *   Step 6 — Dirty-tree clean: no modifications → empty result.
 *   Step 7 — Dirty-tree in scope: untracked file inside --include glob
 *            → reported.
 *   Step 8 — Dirty-tree out of scope: untracked file outside --include
 *            globs → empty result.
 *   Step 9 — Dirty-tree no scope: empty include = full repo, every
 *            modified file shows up.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  fixAlignSentinelPath,
  gitDirtyPathsInScope,
  validateFixAlignSentinel,
  writeFixAlignSentinel,
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
      /* best-effort */
    }
  }
}

function mkRepoRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "cairn-smoke-fa-gates-"));
  cleanups.push(dir);
  execFileSync("git", ["init", "-q", "--initial-branch=main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "smoke@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Smoke"], { cwd: dir });
  // Initial commit so HEAD resolves.
  writeFile(dir, "README.md", "# init\n");
  commitAll(dir, "init");
  return dir;
}

function writeFile(repoRoot: string, rel: string, body: string): void {
  const abs = join(repoRoot, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body, "utf8");
}

function commitAll(repoRoot: string, msg: string): void {
  execFileSync("git", ["add", "."], { cwd: repoRoot });
  execFileSync("git", ["commit", "-q", "-m", msg], { cwd: repoRoot });
}

const baseArgs = {
  include: [] as string[],
  exclude: [] as string[],
  skipCreation: false,
  maxCost: null as number | null,
};

function main(): void {
  console.log("smoke-fix-align-gates — start");

  // ── Step 1 — Missing sentinel ───────────────────────────────────
  {
    const repoRoot = mkRepoRoot();
    const v = validateFixAlignSentinel(repoRoot, baseArgs);
    assert(v.ok === false, "Step 1: expected missing");
    if (!v.ok) {
      assert(v.reason === "missing", `Step 1: reason=missing, got ${v.reason}`);
    }
    console.log("  ✓ Step 1 — Missing sentinel reports `missing`");
  }

  // ── Step 2 — Round-trip same args → ok ──────────────────────────
  {
    const repoRoot = mkRepoRoot();
    writeFixAlignSentinel(repoRoot, baseArgs);
    const v = validateFixAlignSentinel(repoRoot, baseArgs);
    assert(v.ok === true, `Step 2: expected ok, got ${JSON.stringify(v)}`);
    console.log("  ✓ Step 2 — Round-trip with identical args validates");
  }

  // ── Step 3 — Args drifted ───────────────────────────────────────
  {
    const repoRoot = mkRepoRoot();
    writeFixAlignSentinel(repoRoot, baseArgs);
    const v = validateFixAlignSentinel(repoRoot, {
      ...baseArgs,
      include: ["src/**"],
    });
    assert(v.ok === false, "Step 3: expected drift");
    if (!v.ok) {
      assert(v.reason === "args-drifted", `Step 3: reason=args-drifted, got ${v.reason}`);
    }
    console.log("  ✓ Step 3 — Different --include glob reports `args-drifted`");
  }

  // ── Step 4 — Stale sentinel ─────────────────────────────────────
  {
    const repoRoot = mkRepoRoot();
    writeFixAlignSentinel(repoRoot, baseArgs);
    const future = Date.now() + 31 * 60 * 1000;
    const v = validateFixAlignSentinel(repoRoot, baseArgs, future);
    assert(v.ok === false, "Step 4: expected stale");
    if (!v.ok) {
      assert(v.reason === "stale", `Step 4: reason=stale, got ${v.reason}`);
    }
    console.log("  ✓ Step 4 — Sentinel older than 30 min reports `stale`");
  }

  // ── Step 5 — HEAD drifted ───────────────────────────────────────
  {
    const repoRoot = mkRepoRoot();
    writeFixAlignSentinel(repoRoot, baseArgs);
    writeFile(repoRoot, "src/new.ts", "export const a = 1;\n");
    commitAll(repoRoot, "advance HEAD");
    const v = validateFixAlignSentinel(repoRoot, baseArgs);
    assert(v.ok === false, "Step 5: expected head drift");
    if (!v.ok) {
      assert(v.reason === "head-drifted", `Step 5: reason=head-drifted, got ${v.reason}`);
    }
    console.log("  ✓ Step 5 — Fresh commit after sentinel reports `head-drifted`");
  }

  // ── Step 6 — Dirty-tree clean ───────────────────────────────────
  {
    const repoRoot = mkRepoRoot();
    const dirty = gitDirtyPathsInScope(repoRoot, []);
    assert(dirty.length === 0, `Step 6: expected 0 dirty, got ${dirty.length}`);
    console.log("  ✓ Step 6 — Clean tree → no dirty paths");
  }

  // ── Step 7 — Dirty-tree in scope ────────────────────────────────
  {
    const repoRoot = mkRepoRoot();
    writeFile(repoRoot, "src/dirty.ts", "export const a = 1;\n");
    const dirty = gitDirtyPathsInScope(repoRoot, ["src/**"]);
    assert(dirty.length === 1, `Step 7: expected 1 dirty in scope, got ${dirty.length}`);
    assert(dirty[0]?.path === "src/dirty.ts", `Step 7: path=src/dirty.ts, got ${dirty[0]?.path}`);
    console.log("  ✓ Step 7 — Untracked file inside include glob reported");
  }

  // ── Step 8 — Dirty-tree out of scope ────────────────────────────
  {
    const repoRoot = mkRepoRoot();
    writeFile(repoRoot, "docs/draft.md", "# wip\n");
    const dirty = gitDirtyPathsInScope(repoRoot, ["src/**"]);
    assert(dirty.length === 0, `Step 8: expected 0 (out of scope), got ${dirty.length}`);
    console.log("  ✓ Step 8 — Untracked file outside include glob ignored");
  }

  // ── Step 9 — Dirty-tree no scope = full repo ────────────────────
  {
    const repoRoot = mkRepoRoot();
    writeFile(repoRoot, "docs/draft.md", "# wip\n");
    writeFile(repoRoot, "src/dirty.ts", "export const a = 1;\n");
    const dirty = gitDirtyPathsInScope(repoRoot, []);
    assert(dirty.length === 2, `Step 9: expected 2 (no scope = full repo), got ${dirty.length}`);
    console.log("  ✓ Step 9 — Empty include glob = full-repo dirty scope");
  }

  // ── Step 10 — Sentinel path under .cairn/state ──────────────────
  {
    const repoRoot = mkRepoRoot();
    const expected = join(repoRoot, ".cairn", "state", "fix-align-dryrun.json");
    assert(fixAlignSentinelPath(repoRoot) === expected, "Step 10: sentinel path");
    console.log("  ✓ Step 10 — Sentinel writes to .cairn/state/fix-align-dryrun.json");
  }

  cleanup();
  console.log("smoke-fix-align-gates — OK");
}

try {
  main();
} catch (err) {
  console.error("smoke-fix-align-gates — fail:", err);
  cleanup();
  process.exit(1);
}
