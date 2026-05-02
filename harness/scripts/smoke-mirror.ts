#!/usr/bin/env tsx
/**
 * smoke-mirror — Phase 2 acceptance sensor.
 *
 * Per INTEGRATION_PLAN.md Phase 2: "dry-run mirror operation produces a clean
 * clone, can fetch, can reset, can push back". Uses ephemeral repos in os.tmpdir
 * so no real remote is touched and no mirror state outside ~/.local/harness/
 * leaks into the test.
 *
 * Steps:
 *   1. Create a bare "origin" repo in tmp.
 *   2. Create a "user-tree" working tree, push initial commit to origin.
 *   3. Run ensureMirror → expect clone exists.
 *   4. Add a commit to user-tree, push to origin.
 *   5. Run syncMirror → expect mirror's HEAD matches origin/main.
 *   6. Make a commit IN the mirror, run pushMirror → expect origin advanced.
 *   7. Cleanup.
 */

import { execSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import {
  ensureMirror,
  mirrorPath,
  mirrorRecordPath,
  pushMirror,
  syncMirror,
} from "../src/mirror/index.js";

const projectName = `smoke_${Date.now()}`;
let cleanupPaths: string[] = [];

function header(line: string): void {
  console.log(`\n── ${line}`);
}

function fail(reason: string): never {
  console.error(`smoke-mirror FAIL: ${reason}`);
  cleanup();
  process.exit(1);
}

function cleanup(): void {
  // Remove the test project's mirror clone + record (under ~/.local/harness/)
  // and the tmp paths we created in /tmp.
  const recordPath = mirrorRecordPath(projectName);
  const clonePath = mirrorPath(projectName);
  for (const p of [recordPath, clonePath, ...cleanupPaths]) {
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "harness-smoke-"));
  cleanupPaths.push(root);
  const originBare = join(root, "origin.git");
  const userTree = join(root, "user-tree");

  header("Step 1: create bare origin");
  mkdirSync(originBare);
  execSync("git init --bare -b main", { cwd: originBare });

  header("Step 2: seed user-tree + initial push");
  mkdirSync(userTree);
  execSync("git init -b main", { cwd: userTree });
  execSync("git config user.email smoke@harness.local", { cwd: userTree });
  execSync("git config user.name smoke", { cwd: userTree });
  writeFileSync(join(userTree, "README.md"), "smoke\n");
  execSync("git add README.md && git commit -m initial", { cwd: userTree });
  execSync(`git remote add origin ${originBare}`, { cwd: userTree });
  execSync("git push -u origin main", { cwd: userTree });

  header("Step 3: ensureMirror");
  const record = await ensureMirror({
    projectName,
    userTreePath: userTree,
    originUrl: originBare,
  });
  if (record.projectName !== projectName) fail("record.projectName mismatch");
  if (record.defaultBranch !== "main") fail(`expected default branch main, got ${record.defaultBranch}`);

  header("Step 4: advance origin via user-tree commit");
  writeFileSync(join(userTree, "FILE.md"), "added\n");
  execSync("git add FILE.md && git commit -m advance", { cwd: userTree });
  execSync("git push origin main", { cwd: userTree });
  const userTreeSha = execSync("git rev-parse HEAD", { cwd: userTree }).toString().trim();

  header("Step 5: syncMirror — expect HEAD to match user-tree HEAD");
  const sync = await syncMirror({ projectName });
  if (sync.sha !== userTreeSha) fail(`sync sha ${sync.sha} != userTree sha ${userTreeSha}`);
  if (sync.branch !== "main") fail(`sync branch ${sync.branch} != main`);

  header("Step 6: commit IN mirror, pushMirror — expect origin advanced");
  const mirrorRepo = simpleGit(record.mirrorPath);
  await mirrorRepo.addConfig("user.email", "smoke@harness.local", false, "local");
  await mirrorRepo.addConfig("user.name", "smoke", false, "local");
  writeFileSync(join(record.mirrorPath, "MIRROR.md"), "from-mirror\n");
  await mirrorRepo.add(["MIRROR.md"]);
  await mirrorRepo.commit("from-mirror");
  const pushed = await pushMirror({ projectName });
  const userTreeAfterFetch = simpleGit(userTree);
  await userTreeAfterFetch.fetch("origin");
  const originSha = (await userTreeAfterFetch.revparse(["origin/main"])).trim();
  if (pushed.sha !== originSha) {
    fail(`pushed.sha ${pushed.sha} != origin/main ${originSha} after fetch`);
  }

  header("Step 7: cleanup");
  cleanup();
  console.log("\nsmoke-mirror: OK");
}

try {
  await main();
} catch (err) {
  console.error(err);
  cleanup();
  process.exit(1);
}
