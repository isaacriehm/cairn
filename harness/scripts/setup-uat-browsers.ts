#!/usr/bin/env tsx
/**
 * setup:uat-browsers — install chromium for UI probes.
 *
 * Wraps `npx playwright install chromium`. Idempotent — Playwright skips
 * the download when the binary is already present at the expected
 * version. Runs `npx playwright install --with-deps chromium` only when
 * `--with-deps` is passed (Linux requires system libs; macOS/Windows
 * don't).
 */

import { spawn, spawnSync } from "node:child_process";

function detectPlaywrightAvailable(): boolean {
  try {
    const r = spawnSync("npx", ["playwright", "--version"], { encoding: "utf8" });
    return r.status === 0;
  } catch {
    return false;
  }
}

async function run(): Promise<number> {
  const force = process.argv.includes("--force");
  const withDeps = process.argv.includes("--with-deps");

  if (!detectPlaywrightAvailable()) {
    console.error(
      "playwright CLI not on PATH — install playwright-core (or playwright) in your project first:\n  pnpm add -D playwright-core",
    );
    return 1;
  }

  console.log(`installing chromium${force ? " (force)" : ""}${withDeps ? " (with-deps)" : ""}…`);
  const args = ["playwright", "install"];
  if (withDeps) args.push("--with-deps");
  args.push("chromium");
  if (force) args.push("--force");

  const exitCode = await new Promise<number>((resolve) => {
    const child = spawn("npx", args, {
      stdio: "inherit",
    });
    child.on("close", (code) => resolve(code ?? -1));
  });
  if (exitCode !== 0) {
    console.error(`\nplaywright install exited ${exitCode}`);
    return exitCode;
  }
  console.log("\nsetup-uat-browsers: OK");
  return 0;
}

const code = await run();
process.exit(code);
