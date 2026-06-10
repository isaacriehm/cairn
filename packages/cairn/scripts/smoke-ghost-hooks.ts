#!/usr/bin/env tsx
/**
 * smoke-ghost-hooks — git hooks resolve state + mode from their own location.
 *
 * core.hooksPath points at <cairnHome>/git-hooks in BOTH modes, so each hook
 * derives CAIRN_HOME = dirname(dirname($0)): in-repo `.cairn/` for committed,
 * out-of-repo `~/.cairn/state/<id>/` for ghost. Ghost = home outside the repo
 * tree → the sensor sweep is ADVISORY (never blocks a client-code commit).
 *
 * Runs the SHIPPED hook templates under real `git commit` in both modes:
 *   - committed: attested SHA lands in <repo>/.cairn; a failing sensor BLOCKS.
 *   - ghost:     attested SHA lands out-of-repo; NO <repo>/.cairn appears; a
 *                failing sensor does NOT block (advisory).
 *
 * Covers ghost-mode design.
 *
 * Run: pnpm -F @isaacriehm/cairn smoke:ghost-hooks
 */

import { execFileSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

let failed = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) console.log(`  ✓ ${msg}`);
  else {
    console.error(`  ✗ ${msg}`);
    failed += 1;
  }
}

const repoRootSrc = resolve(import.meta.dirname, "..", "..", "..");
const TEMPLATE_HOOKS = join(
  repoRootSrc,
  "packages/cairn-core/templates/.cairn/git-hooks",
);
const HOOKS = ["pre-commit", "commit-msg", "post-commit"] as const;

const realHome = process.env.HOME;
const realUserProfile = process.env.USERPROFILE;
const tmpHome = mkdtempSync(join(tmpdir(), "cairn-hooks-home-"));
const work = mkdtempSync(join(tmpdir(), "cairn-hooks-work-"));

// A stand-in CLI: exits 1 for `sensor-run` only when the sentinel file exists,
// else exits 0. Lets us toggle "blocking finding" via env between commits.
const fakeCli = join(work, "fake-cli.cjs");
writeFileSync(
  fakeCli,
  [
    "const fs = require('fs');",
    "const sentinel = process.env.CAIRN_FAKE_FAIL;",
    "const cmd = process.argv[2];",
    "if (cmd === 'sensor-run' && sentinel && fs.existsSync(sentinel)) process.exit(1);",
    "process.exit(0);",
  ].join("\n"),
  "utf8",
);
const sentinel = join(work, "FAIL_SENSOR");

function installHooks(hooksDir: string, cliPathFile: string): void {
  mkdirSync(hooksDir, { recursive: true });
  for (const h of HOOKS) {
    const dst = join(hooksDir, h);
    copyFileSync(join(TEMPLATE_HOOKS, h), dst);
    chmodSync(dst, 0o755);
  }
  writeFileSync(cliPathFile, `node "${fakeCli}"\n`, "utf8");
}

function initRepo(dir: string): (...a: string[]) => string {
  const git = (...a: string[]) =>
    execFileSync("git", ["-C", dir, ...a], { encoding: "utf8" });
  git("init", "-q", "--initial-branch=main");
  git("config", "user.email", "smoke@example.com");
  git("config", "user.name", "Smoke");
  return git;
}

/** Stage a file + commit; returns true on success, false if the hook blocked. */
function tryCommit(dir: string, file: string, body: string, fail: boolean): boolean {
  writeFileSync(join(dir, file), body, "utf8");
  execFileSync("git", ["-C", dir, "add", "-A"]);
  if (fail) writeFileSync(sentinel, "1", "utf8");
  else if (existsSync(sentinel)) rmSync(sentinel);
  try {
    execFileSync("git", ["-C", dir, "commit", "-q", "-m", "change"], {
      env: { ...process.env, CAIRN_FAKE_FAIL: sentinel },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return true;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;
  const { registerGhostRepo, cairnDir } = await import("@isaacriehm/cairn-core");

  /* ── Committed mode ──────────────────────────────────────────────────── */
  const cRepo = join(work, "committed");
  mkdirSync(cRepo, { recursive: true });
  const cgit = initRepo(cRepo);
  installHooks(join(cRepo, ".cairn", "git-hooks"), join(cRepo, ".cairn", ".cli-path"));
  cgit("config", "core.hooksPath", ".cairn/git-hooks");
  // seed an initial commit (clean sensor)
  assert(tryCommit(cRepo, "a.ts", "export const a = 1;\n", false), "committed: clean commit succeeds");
  const cAttested = join(cRepo, ".cairn", ".attested-commits");
  assert(existsSync(cAttested) && readFileSync(cAttested, "utf8").trim().length === 40, "committed: SHA attested in <repo>/.cairn");
  // failing sensor BLOCKS in committed mode
  assert(tryCommit(cRepo, "b.ts", "export const b = 2;\n", true) === false, "committed: failing sensor BLOCKS the commit");

  /* ── Ghost mode ──────────────────────────────────────────────────────── */
  const gRepo = join(work, "ghost");
  mkdirSync(gRepo, { recursive: true });
  const ggit = initRepo(gRepo);
  const entry = registerGhostRepo(gRepo);
  const ghostHome = cairnDir(gRepo); // out-of-repo state dir
  installHooks(join(ghostHome, "git-hooks"), join(ghostHome, ".cli-path"));
  ggit("config", "core.hooksPath", join(ghostHome, "git-hooks")); // absolute
  assert(entry.state_dir.startsWith(tmpHome), "ghost: state home is out-of-repo");

  // failing sensor must NOT block in ghost (advisory)
  assert(tryCommit(gRepo, "c.ts", "export const c = 3;\n", true) === true, "ghost: failing sensor does NOT block (advisory)");
  const gAttested = join(ghostHome, ".attested-commits");
  assert(existsSync(gAttested) && readFileSync(gAttested, "utf8").trim().length === 40, "ghost: SHA attested OUT-OF-REPO (<cairnHome>/.attested-commits)");
  assert(!existsSync(join(gRepo, ".cairn")), "ghost: NO <repo>/.cairn created by the hooks");
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
      console.error(`smoke-ghost-hooks — FAIL (${failed})`);
      process.exit(1);
    }
    console.log("smoke-ghost-hooks — pass");
  });
