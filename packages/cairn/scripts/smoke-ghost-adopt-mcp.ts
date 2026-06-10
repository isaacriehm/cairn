#!/usr/bin/env tsx
/**
 * smoke-ghost-adopt-mcp — ghost reachability via the MCP phase pipeline.
 *
 * The CLI `cairn init --ghost` path already registers ghost before the first
 * write. This smoke covers the *plugin* path: the cairn-adopt skill drives the
 * `cairn_init_resume` / `cairn_init_run` MCP tools, so ghost registration must
 * ride the **first `cairn_init_resume` call** (`{ ghost: true }`) — before the
 * pipeline seeds its fresh init-state — or that state leaks in-repo.
 *
 * It also covers the other half of reachability: once adoption finishes,
 * `resolveRepoRoot` must recognize a ghost-adopted repo (no in-repo `.cairn/`,
 * state keyed in the registry) so SessionStart loads ground state instead of
 * re-nagging adoption every session.
 *
 * Isolation: `$HOME` points at a throwaway dir so registration + out-of-repo
 * state never touch the operator's real `~/.cairn`. (POSIX `os.homedir()`
 * honors `$HOME` — test isolation, not a config env var.)
 *
 * Covers ghost-mode design (cairn-adopt MCP registration) + the
 * SessionStart recognition gap.
 *
 * Run: pnpm -F @isaacriehm/cairn smoke:ghost-adopt-mcp
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
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
const tmpHome = mkdtempSync(join(tmpdir(), "cairn-ghost-home-"));
const repoRoot = mkdtempSync(join(tmpdir(), "cairn-ghost-repo-"));
const plainRoot = mkdtempSync(join(tmpdir(), "cairn-plain-repo-"));

function gitInit(root: string, msg: string): void {
  const git = (...a: string[]) =>
    execFileSync("git", ["-C", root, ...a], { stdio: ["ignore", "pipe", "ignore"] });
  git("init", "-q", "--initial-branch=main");
  git("config", "user.email", "smoke@example.com");
  git("config", "user.name", "Smoke");
  // Unique content per repo → distinct tree → distinct root-commit SHA, even
  // when both commits land in the same wall-clock second. The control assertion
  // depends on the two fixtures having different repo-ids (root commits).
  writeFileSync(join(root, "README.md"), `# fixture ${root}\n`, "utf8");
  git("add", "-A");
  git("commit", "-q", "-m", msg);
}

async function main(): Promise<void> {
  // Redirect the global Cairn home BEFORE importing the resolver-backed API.
  process.env.HOME = tmpHome;
  process.env.USERPROFILE = tmpHome;

  const { allTools, isGhost, resolveRepoRoot, cairnDir } = await import(
    "@isaacriehm/cairn-core"
  );

  // The barrel exposes the tool array, not each tool — look up by name (the
  // same way the MCP server registers them).
  const resumeTool = allTools.find((t) => t.name === "cairn_init_resume");
  if (resumeTool === undefined) {
    throw new Error("cairn_init_resume not found in allTools");
  }
  const runResume = resumeTool.handler as (
    ctx: { repoRoot: string },
    input: { ghost?: boolean },
  ) => Promise<unknown>;

  gitInit(repoRoot, "init");
  gitInit(plainRoot, "init"); // a second, *non*-ghost repo (control)

  // ── First resume call with ghost:true (the skill's Step 3 first call) ──
  const ctx = { repoRoot };
  const res = (await runResume(ctx, { ghost: true })) as {
    status?: string;
    nextPhase?: string | null;
    repoRoot?: string;
  };

  assert(res.status === "ready", "cairn_init_resume returns status=ready");
  assert(res.nextPhase === "1-detect", "next phase is 1-detect (fresh pipeline)");
  assert(isGhost(repoRoot) === true, "repo resolves as ghost after the resume call");

  // ── Headline: registration happened BEFORE the state write ─────────────
  assert(
    !existsSync(join(repoRoot, ".cairn")),
    "NO in-repo .cairn/ created by the resume call (headline)",
  );
  assert(
    existsSync(cairnDir(repoRoot, "init-state.json")),
    "fresh init-state.json landed out-of-repo (under cairnHome)",
  );
  assert(
    cairnDir(repoRoot, "init-state.json").startsWith(join(tmpHome, ".cairn", "state")),
    "out-of-repo init-state path is under ~/.cairn/state",
  );

  // registry carries the ghost entry
  const regRaw = existsSync(join(tmpHome, ".cairn", "registry.yaml"))
    ? readFileSync(join(tmpHome, ".cairn", "registry.yaml"), "utf8")
    : "";
  assert(/mode:\s*ghost/.test(regRaw), "registry.yaml records the ghost entry");

  // ── resolveRepoRoot recognition ────────────────────────────────────────
  // Before adoption finishes (no out-of-repo config.yaml yet) the repo is not
  // yet "adopted" to SessionStart — identical to committed mid-adoption.
  assert(
    resolveRepoRoot(repoRoot) === null,
    "resolveRepoRoot null while ghost adoption is mid-stream (no config.yaml yet)",
  );

  // Simulate Phase 4 having written config.yaml out-of-repo.
  mkdirSync(cairnDir(repoRoot), { recursive: true });
  writeFileSync(cairnDir(repoRoot, "config.yaml"), "project: ghost-smoke\n", "utf8");
  assert(
    resolveRepoRoot(repoRoot) === repoRoot,
    "resolveRepoRoot recognizes the adopted ghost repo (no in-repo .cairn)",
  );

  // Control: a different repo with no registry entry is NOT falsely matched
  // even though a ghost registry now exists.
  assert(
    resolveRepoRoot(plainRoot) === null,
    "resolveRepoRoot stays null for an un-adopted repo when a ghost registry exists",
  );
  assert(isGhost(plainRoot) === false, "control repo is not ghost");
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
      console.error(`smoke-ghost-adopt-mcp — FAIL (${failed})`);
      process.exit(1);
    }
    console.log("smoke-ghost-adopt-mcp — pass");
  });
