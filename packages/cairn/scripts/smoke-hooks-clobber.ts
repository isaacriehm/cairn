#!/usr/bin/env tsx
/**
 * smoke-hooks-clobber — the core.hooksPath clobber guard (§3.3 seam 5).
 *
 * git allows exactly ONE core.hooksPath. Cairn's bootstrap (`runJoin` →
 * `setGitHooksPath`) used to set it unconditionally — silently disabling a
 * client repo's existing hooks (husky / lefthook / custom) for the operator.
 * Worst in ghost, where the whole point is leaving the client's setup
 * untouched. The guard now refuses to override a foreign hooks path and warns
 * instead; never clobbers.
 *
 * Cases (committed + ghost — the guard is mode-agnostic):
 *   1. clean repo            → sets `.cairn/git-hooks`, status ok
 *   2. foreign hooksPath set → REFUSES (warn), foreign value preserved
 *   3. `.husky/` dir, unset  → sets Cairn's path + warns of future husky clobber
 *   4. already Cairn's path   → treated as ours, not foreign (status ok)
 *   5. ghost clean           → sets the absolute out-of-repo path, status ok
 *
 * Isolation: `$HOME` points at a throwaway dir (ghost registration + caches).
 *
 * Run: pnpm -F @isaacriehm/cairn smoke:hooks-clobber
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let failed = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`  ✓ ${msg}`);
  else {
    console.error(`  ✗ ${msg}`);
    failed += 1;
  }
}

const realHome = process.env.HOME;
const realUserProfile = process.env.USERPROFILE;
const tmpHome = mkdtempSync(join(tmpdir(), "cairn-clobber-home-"));
const work = mkdtempSync(join(tmpdir(), "cairn-clobber-work-"));

let repoSeq = 0;

function gitCfg(repoRoot: string): string {
  try {
    return execFileSync("git", ["-C", repoRoot, "config", "--get", "core.hooksPath"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

function newRepo(): string {
  const dir = join(work, `repo-${repoSeq++}`);
  mkdirSync(dir, { recursive: true });
  const git = (...a: string[]) =>
    execFileSync("git", ["-C", dir, ...a], { stdio: ["ignore", "pipe", "ignore"] });
  git("init", "-q", "--initial-branch=main");
  git("config", "user.email", "smoke@example.com");
  git("config", "user.name", "Smoke");
  // Unique content → distinct root-commit per repo (avoids ghost-registry
  // key collision across the fixtures).
  writeFileSync(join(dir, "README.md"), `# ${dir}\n`, "utf8");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
  return dir;
}

async function main(): Promise<void> {
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  const { runJoin, seedCairnLayout, registerGhostRepo, cairnDir } = await import(
    "@isaacriehm/cairn-core"
  );

  const stepOf = (repoRoot: string): { status?: string; detail?: string } => {
    const r = runJoin({ repoRoot });
    return (r.steps.find((s) => s.step === "set-hooks-path") ?? {}) as {
      status?: string;
      detail?: string;
    };
  };

  /* ── 1. clean committed repo ───────────────────────────────────────────── */
  const clean = newRepo();
  seedCairnLayout({ repoRoot: clean, projectSlug: "clobber-smoke" });
  let s = stepOf(clean);
  assert(s.status === "ok", "clean repo: set-hooks-path ok");
  assert(gitCfg(clean) === ".cairn/git-hooks", "clean repo: core.hooksPath = .cairn/git-hooks");

  /* ── 2. foreign hooksPath already set → REFUSE ─────────────────────────── */
  const foreign = newRepo();
  seedCairnLayout({ repoRoot: foreign, projectSlug: "clobber-smoke" });
  execFileSync("git", ["-C", foreign, "config", "core.hooksPath", ".husky/_"], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  s = stepOf(foreign);
  assert(s.status === "warn", "foreign hooksPath: set-hooks-path warns (no clobber)");
  assert(gitCfg(foreign) === ".husky/_", "foreign hooksPath: client value PRESERVED (not overridden)");
  assert(/will NOT override/i.test(s.detail ?? ""), "foreign hooksPath: warning explains the refusal");

  /* ── 3. .husky/ dir present, hooksPath unset → set + soft-warn ─────────── */
  const husky = newRepo();
  seedCairnLayout({ repoRoot: husky, projectSlug: "clobber-smoke" });
  mkdirSync(join(husky, ".husky"), { recursive: true });
  s = stepOf(husky);
  assert(s.status === "warn", "husky dir present: set-hooks-path warns (future clobber)");
  assert(gitCfg(husky) === ".cairn/git-hooks", "husky dir present: Cairn path still set (wired now)");

  /* ── 4. already Cairn's path → not treated as foreign ──────────────────── */
  const already = newRepo();
  seedCairnLayout({ repoRoot: already, projectSlug: "clobber-smoke" });
  execFileSync("git", ["-C", already, "config", "core.hooksPath", ".cairn/git-hooks"], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  s = stepOf(already);
  assert(s.status === "ok", "already Cairn's path: idempotent ok (not flagged foreign)");

  /* ── 5. ghost clean → absolute out-of-repo path accepted ───────────────── */
  const ghost = newRepo();
  registerGhostRepo(ghost);
  seedCairnLayout({ repoRoot: ghost, projectSlug: "clobber-smoke" }); // seeds out-of-repo
  s = stepOf(ghost);
  assert(s.status === "ok", "ghost clean: set-hooks-path ok");
  assert(
    gitCfg(ghost) === cairnDir(ghost, "git-hooks"),
    "ghost clean: core.hooksPath = absolute out-of-repo path",
  );
}

main()
  .catch((err) => {
    console.error(err);
    failed += 1;
  })
  .finally(() => {
    process.env.HOME = realHome;
    process.env.USERPROFILE = realUserProfile;
    rmSync(tmpHome, { recursive: true, force: true });
    rmSync(work, { recursive: true, force: true });
    if (failed > 0) {
      console.error(`smoke-hooks-clobber — FAIL (${failed})`);
      process.exit(1);
    }
    console.log("smoke-hooks-clobber — pass");
  });
