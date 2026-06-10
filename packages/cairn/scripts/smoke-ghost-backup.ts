#!/usr/bin/env tsx
/**
 * smoke-ghost-backup — the out-of-repo state dir is its own git repo (§5.4).
 *
 * Ghost state never rides the client repo's history, so Cairn versions it
 * itself: `ghostBackupCommit` `git init`s the state dir on first call and
 * auto-commits durable ground state every Stop. The seeded `.gitignore`
 * (the `.cairn` denylist, redirected out-of-repo) keeps churn — sessions,
 * caches, locks — out of the snapshot.
 *
 * Asserts: init + snapshot on first call; durable files tracked, churn
 * ignored; clean re-call makes no empty commit; a real change makes a second
 * commit; committed-mode control is a pure no-op (no nested .git).
 *
 * Isolation: `$HOME` points at a throwaway dir.
 *
 * Run: pnpm -F @isaacriehm/cairn smoke:ghost-backup
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
const tmpHome = mkdtempSync(join(tmpdir(), "cairn-backup-home-"));
const repoRoot = mkdtempSync(join(tmpdir(), "cairn-backup-repo-"));
const plainRoot = mkdtempSync(join(tmpdir(), "cairn-backup-plain-"));

function gitInit(dir: string): void {
  const git = (...a: string[]) =>
    execFileSync("git", ["-C", dir, ...a], { stdio: ["ignore", "pipe", "ignore"] });
  git("init", "-q", "--initial-branch=main");
  git("config", "user.email", "smoke@example.com");
  git("config", "user.name", "Smoke");
  writeFileSync(join(dir, "README.md"), `# ${dir}\n`, "utf8");
  git("add", "-A");
  git("commit", "-q", "-m", "init");
}

function lsFiles(dir: string): string[] {
  return execFileSync("git", ["-C", dir, "ls-files"], { encoding: "utf8" })
    .split("\n")
    .filter((l) => l.length > 0);
}

function commitCount(dir: string): number {
  try {
    return Number(
      execFileSync("git", ["-C", dir, "rev-list", "--count", "HEAD"], {
        encoding: "utf8",
      }).trim(),
    );
  } catch {
    return 0;
  }
}

async function main(): Promise<void> {
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  const { registerGhostRepo, seedCairnLayout, ghostBackupCommit, cairnDir, decisionsDir } =
    await import("@isaacriehm/cairn-core");

  gitInit(repoRoot);
  gitInit(plainRoot);
  registerGhostRepo(repoRoot);
  seedCairnLayout({ repoRoot, projectSlug: "backup-smoke" }); // seeds out-of-repo (.gitignore included)

  const stateDir = cairnDir(repoRoot);
  assert(existsSync(join(stateDir, ".gitignore")), "denylist .gitignore seeded at the state-dir root");

  // A durable ground file (tracked) + churn (must be ignored).
  mkdirSync(decisionsDir(repoRoot), { recursive: true });
  writeFileSync(join(decisionsDir(repoRoot), "DEC-aaaa1111.md"), "---\nid: DEC-aaaa1111\n---\nbody\n", "utf8");
  mkdirSync(cairnDir(repoRoot, "cache"), { recursive: true });
  writeFileSync(cairnDir(repoRoot, "cache", "x.json"), "{}\n", "utf8");
  mkdirSync(cairnDir(repoRoot, "sessions"), { recursive: true });
  writeFileSync(cairnDir(repoRoot, "sessions", "s.json"), "{}\n", "utf8");

  /* ── first call: init + snapshot ───────────────────────────────────────── */
  const r1 = ghostBackupCommit(repoRoot);
  assert(r1.initialized === true && r1.committed === true, "first call inits the state repo + commits a snapshot");
  assert(existsSync(join(stateDir, ".git")), "state dir is now its own git repo");
  assert(commitCount(stateDir) === 1, "exactly one snapshot commit");

  const tracked = lsFiles(stateDir);
  assert(
    tracked.includes("ground/decisions/DEC-aaaa1111.md"),
    "durable ground file is tracked in the backup",
  );
  assert(
    !tracked.some((f) => f.startsWith("cache/") || f.startsWith("sessions/")),
    "churn (cache/, sessions/) is NOT tracked (denylist applied)",
  );

  /* ── clean re-call: no empty commit ────────────────────────────────────── */
  const r2 = ghostBackupCommit(repoRoot);
  assert(r2.committed === false && r2.reason === "clean", "no-change re-call makes no empty commit");
  assert(commitCount(stateDir) === 1, "still exactly one commit");

  /* ── real change: second commit ────────────────────────────────────────── */
  writeFileSync(join(decisionsDir(repoRoot), "DEC-bbbb2222.md"), "---\nid: DEC-bbbb2222\n---\nbody\n", "utf8");
  const r3 = ghostBackupCommit(repoRoot);
  assert(r3.committed === true && r3.initialized === false, "a durable change commits a new snapshot (no re-init)");
  assert(commitCount(stateDir) === 2, "two snapshot commits now");

  /* ── committed control: pure no-op ─────────────────────────────────────── */
  const rc = ghostBackupCommit(plainRoot);
  assert(rc.committed === false && rc.reason === "not-ghost", "ghostBackupCommit no-ops on a non-ghost repo");
  assert(!existsSync(join(plainRoot, ".cairn", ".git")), "no nested backup repo created in a committed tree");
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
    rmSync(repoRoot, { recursive: true, force: true });
    rmSync(plainRoot, { recursive: true, force: true });
    if (failed > 0) {
      console.error(`smoke-ghost-backup — FAIL (${failed})`);
      process.exit(1);
    }
    console.log("smoke-ghost-backup — pass");
  });
