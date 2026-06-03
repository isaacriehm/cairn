#!/usr/bin/env tsx
/**
 * smoke-repo-root-anchor — subdir/worktree launches anchor at the ONE
 * repo-root `.cairn/`, never the launch subdir.
 *
 * Regression guard for "tasks land in <repo>/core/.cairn/ when Claude is
 * launched from a package subdir". The MCP server + CLI subcommands use
 * `resolveAnchorRoot`, which must:
 *
 *   1. adopted repo, launched from a subdir → return the adopted root;
 *   2. git repo with NO .cairn, from a subdir → return the git root
 *      (the fix — the old `?? resolve(cwd)` anchored at the subdir);
 *   3. neither git nor adopted → return cwd (last resort);
 *   4. `resolveRepoRoot` still returns null for an un-adopted dir
 *      (hooks rely on null to skip — must not regress).
 */

import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAnchorRoot, resolveRepoRoot } from "@isaacriehm/cairn-core";

const cleanups: string[] = [];

function fail(msg: string): never {
  console.error(`\n  ✗ ${msg}`);
  process.exit(1);
}
function pass(msg: string): void {
  console.log(`  ✓ ${msg}`);
}
function real(p: string): string {
  return realpathSync(p);
}
function gitInit(dir: string): void {
  execFileSync("git", ["init"], { cwd: dir, stdio: "ignore" });
}

async function main(): Promise<void> {
  console.log("smoke-repo-root-anchor — start");

  // 1. Adopted repo, launched from a nested package subdir.
  {
    const repo = mkdtempSync(join(tmpdir(), "cairn-anchor-adopted-"));
    cleanups.push(repo);
    mkdirSync(join(repo, ".cairn"), { recursive: true });
    writeFileSync(join(repo, ".cairn", "config.yaml"), "name: smoke\n", "utf8");
    const sub = join(repo, "packages", "core");
    mkdirSync(sub, { recursive: true });
    gitInit(repo);
    const got = resolveAnchorRoot(sub);
    if (real(got) !== real(repo)) fail(`adopted subdir: expected ${real(repo)}, got ${real(got)}`);
    if (real(got) === real(sub)) fail("adopted subdir anchored at the subdir (the bug)");
    pass("adopted repo + subdir launch → adopted root");
  }

  // 2. Git repo, NO .cairn, launched from a subdir → git root (the fix).
  {
    const repo = mkdtempSync(join(tmpdir(), "cairn-anchor-gitonly-"));
    cleanups.push(repo);
    const sub = join(repo, "core");
    mkdirSync(sub, { recursive: true });
    gitInit(repo);
    const got = resolveAnchorRoot(sub);
    if (real(got) !== real(repo)) fail(`git-only subdir: expected git root ${real(repo)}, got ${real(got)}`);
    if (real(got) === real(sub)) fail("git-only subdir anchored at the subdir (the bug)");
    if (resolveRepoRoot(sub) !== null) fail("resolveRepoRoot must stay null for an un-adopted repo");
    pass("git repo (no .cairn) + subdir → git root; resolveRepoRoot stays null");
  }

  // 3. Neither git nor adopted → cwd (last resort).
  {
    const plain = mkdtempSync(join(tmpdir(), "cairn-anchor-plain-"));
    cleanups.push(plain);
    const got = resolveAnchorRoot(plain);
    if (real(got) !== real(plain)) fail(`plain dir: expected ${real(plain)}, got ${real(got)}`);
    pass("no git, no .cairn → cwd last resort");
  }

  console.log("\nsmoke-repo-root-anchor — pass");
}

main()
  .catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => {
    for (const dir of cleanups) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
  });
