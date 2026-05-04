#!/usr/bin/env tsx
/**
 * setup-whisper — build the smart-whisper native binding.
 *
 * Why a script: smart-whisper ships a node-gyp-built binding. node-gyp's
 * generated Makefile does not quote `module_root_dir` properly, so when the
 * project lives at a path that contains spaces (very common on macOS —
 * `<operator-home>/project`), the build fails with cryptic clang errors.
 *
 * Workaround: copy the package into a no-space tempdir, build there, copy
 * the resulting `build/` back into the real `node_modules` location. Operator
 * runs this once after `pnpm install`. Phase 16 init script will run it
 * automatically.
 *
 * Idempotent — bails early if the binding already exists, unless `--force`.
 *
 * Requirements: node-gyp (via pnpx), ffmpeg, Xcode CLI tools, Python 3.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgRoot = resolve(here, "..");
const require = createRequire(import.meta.url);

function header(line: string): void {
  console.log(`\n── ${line}`);
}

function fail(reason: string): never {
  console.error(`setup-whisper FAIL: ${reason}`);
  process.exit(1);
}

function findSmartWhisperRoot(): string {
  // Resolve smart-whisper relative to the harness package — works whether
  // invoked from repo dev or from an adopted project that depends on us.
  const entry = require.resolve("smart-whisper", { paths: [pkgRoot] });
  // entry: <root>/dist/index.js → walk up to package root
  return resolve(dirname(entry), "..");
}

const force = process.argv.includes("--force");

const swRoot = findSmartWhisperRoot();
const bindingPath = join(swRoot, "build", "Release", "smart-whisper.node");

if (existsSync(bindingPath) && !force) {
  console.log(`setup-whisper: binding already built at ${bindingPath} (pass --force to rebuild)`);
  process.exit(0);
}

header("Step 1: locate node-addon-api dep");
const addonApiPath = require.resolve("node-addon-api/package.json", { paths: [swRoot] });
const addonApiRoot = dirname(addonApiPath);

header("Step 2: stage in no-space tempdir");
const stage = mkdtempSync(join(tmpdir(), "harness-sw-"));
console.log(`  stage = ${stage}`);
cpSync(swRoot, join(stage, "smart-whisper"), {
  recursive: true,
  dereference: true,
  filter: (src) => !src.includes(`${swRoot}/build/`),
});
cpSync(addonApiRoot, join(stage, "smart-whisper", "node_modules", "node-addon-api"), {
  recursive: true,
  dereference: true,
});

header("Step 3: node-gyp rebuild (Metal+CoreML on M-series)");
const stageSw = join(stage, "smart-whisper");
const build = spawnSync("pnpx", ["node-gyp", "rebuild"], {
  cwd: stageSw,
  stdio: "inherit",
});
if (build.status !== 0) {
  rmSync(stage, { recursive: true, force: true });
  fail(`node-gyp rebuild exited ${build.status}`);
}

header("Step 4: copy build/ back into the resolved smart-whisper");
rmSync(join(swRoot, "build"), { recursive: true, force: true });
cpSync(join(stageSw, "build"), join(swRoot, "build"), { recursive: true });

rmSync(stage, { recursive: true, force: true });

if (!existsSync(bindingPath)) {
  fail(`expected ${bindingPath} after rebuild — copy did not land`);
}

console.log(`\nsetup-whisper: OK — ${bindingPath}`);
