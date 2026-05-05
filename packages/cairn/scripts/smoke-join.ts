#!/usr/bin/env tsx
/**
 * smoke-join — verifies `cairn join` per-clone bootstrap.
 *
 * Spec: PLUGIN_ARCHITECTURE §17 Layer 2.
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  inspectJoinState,
  installMultiDev,
  patchPackageJsonPrepare,
  runJoin,
  seedCairnLayout,
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

function mkRepoRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "cairn-smoke-join-"));
  cleanups.push(dir);
  return dir;
}

function gitInit(repoRoot: string): void {
  execFileSync("git", ["init", "-q", "--initial-branch=main"], { cwd: repoRoot });
  execFileSync("git", ["config", "user.email", "smoke@example.com"], { cwd: repoRoot });
  execFileSync("git", ["config", "user.name", "Smoke"], { cwd: repoRoot });
}

function step(label: string): void {
  console.log(`── ${label}`);
}

async function main(): Promise<void> {
  step("Step 1 — runJoin without .cairn/ → locate-repo error");
  const empty = mkRepoRoot();
  gitInit(empty);
  const empt = runJoin({ cwd: empty });
  assert(empt.repoRoot === null, "no repoRoot found");
  assert(empt.bootstrapped === false, "not bootstrapped");
  const locate = empt.steps.find((s) => s.step === "locate-repo");
  assert(locate?.status === "error", "locate-repo error reported");
  console.log("  ✓ Step 1 — empty dir → error");

  step("Step 2 — runJoin success path");
  const repoRoot = mkRepoRoot();
  gitInit(repoRoot);
  // Seed the cairn layout so .cairn/git-hooks/ + config exists.
  seedCairnLayout({ repoRoot, projectSlug: "smoke-join" });
  // Write a minimal config.yaml with cairn_version pinned to "0.0.0".
  writeFileSync(
    join(repoRoot, ".cairn", "config.yaml"),
    "version: 1\ncairn_version: 0.0.0\nslug: smoke-join\n",
    "utf8",
  );

  const ok = runJoin({ cwd: repoRoot });
  assert(ok.repoRoot === repoRoot, "repoRoot resolved");
  assert(ok.bootstrapped === true, "bootstrap reported true");
  const setHooks = ok.steps.find((s) => s.step === "set-hooks-path");
  assert(setHooks?.status === "ok", "set-hooks-path ok");
  // Verify git config landed.
  const hooksPathOut = execFileSync("git", ["config", "--get", "core.hooksPath"], {
    cwd: repoRoot,
    encoding: "utf8",
  }).trim();
  assert(hooksPathOut === ".cairn/git-hooks", "git config core.hooksPath set");
  console.log("  ✓ Step 2 — success path");

  step("Step 3 — runJoin idempotency");
  const ok2 = runJoin({ cwd: repoRoot });
  assert(ok2.bootstrapped === true, "second run still bootstrapped");
  const session = ok2.steps.find((s) => s.step === "ensure-sessions-dir");
  assert(session?.status === "skipped", "sessions dir reported skipped");
  console.log("  ✓ Step 3 — idempotent");

  step("Step 4 — version mismatch surfaces warn");
  // Bump the project's pinned version above the CLI VERSION.
  writeFileSync(
    join(repoRoot, ".cairn", "config.yaml"),
    "version: 1\ncairn_version: 9.9.9\nslug: smoke-join\n",
    "utf8",
  );
  const mismatch = runJoin({ cwd: repoRoot });
  const versionStep = mismatch.steps.find((s) => s.step === "version-check");
  assert(versionStep?.status === "warn", "version mismatch is warn");
  assert(versionStep?.detail.includes("9.9.9"), "warn cites pinned version");
  console.log("  ✓ Step 4 — version mismatch");

  step("Step 5 — inspectJoinState reports state");
  const state = inspectJoinState({ repoRoot });
  assert(state.hooksPathSet === true, "hooks path set");
  assert(state.sessionsDirReady === true, "sessions dir ready");
  assert(state.projectCairnVersion === "9.9.9", "version reported");
  console.log("  ✓ Step 5 — inspectJoinState");

  step("Step 6 — multi-dev: detects node-package-json without patching");
  const repoRoot2 = mkRepoRoot();
  const originalPkg =
    JSON.stringify({ name: "x", scripts: { test: "echo" } }, null, 2) + "\n";
  writeFileSync(join(repoRoot2, "package.json"), originalPkg, "utf8");
  const mres = installMultiDev({ repoRoot: repoRoot2 });
  assert(mres.hostKinds.includes("node-package-json"), "node host detected");
  assert(
    mres.preparePatched === false,
    "phase 12 no longer auto-patches prepare (plugin owns bootstrap)",
  );
  const afterPkg = readFileSync(join(repoRoot2, "package.json"), "utf8");
  assert(afterPkg === originalPkg, "package.json untouched");
  assert(
    mres.manualHints.some((h) => h.includes("SessionStart bootstrap banner")),
    "manual hint cites SessionStart path",
  );
  console.log("  ✓ Step 6 — node host detected, package.json untouched");

  step("Step 7 — multi-dev: non-Node hint surfaces");
  const repoRoot3 = mkRepoRoot();
  writeFileSync(join(repoRoot3, "Makefile"), "all:\n\techo hi\n", "utf8");
  const mres3 = installMultiDev({ repoRoot: repoRoot3 });
  assert(mres3.hostKinds.includes("makefile"), "makefile detected");
  assert(
    mres3.manualHints.some((h) => h.includes("Makefile detected")),
    "makefile manual hint",
  );
  // Patch only fires when package.json present — nothing should land here.
  assert(mres3.preparePatched === false, "no prepare patch without package.json");
  console.log("  ✓ Step 7 — non-Node hint");

  step("Step 8 — patchPackageJsonPrepare preserves existing prepare");
  const pkgPath = join(mkRepoRoot(), "package.json");
  writeFileSync(
    pkgPath,
    JSON.stringify({ name: "y", scripts: { prepare: "husky install" } }, null, 2) + "\n",
    "utf8",
  );
  const out = patchPackageJsonPrepare(pkgPath, false);
  assert(out.step.status === "ok", "patch ok");
  const after = JSON.parse(
    readFileSync(pkgPath, "utf8"),
  ) as { scripts: { prepare: string } };
  assert(after.scripts.prepare.startsWith("cairn join || true"), "cairn fragment first");
  assert(after.scripts.prepare.includes("husky install"), "existing husky preserved");
  console.log("  ✓ Step 8 — preserves existing prepare command");

  step("Cleanup");
  cleanup();
  console.log("\nsmoke-join — pass");
}

main().catch((err) => {
  console.error("smoke-join — fail");
  console.error(err);
  cleanup();
  process.exit(1);
});
