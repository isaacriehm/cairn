#!/usr/bin/env node
/**
 * sync-from-claudecode — copy the shared build artifacts from
 * cairn-frontend-claudecode into this package so both frontends ship
 * identical skills, agents, commands, and the cairn CLI bundle.
 *
 * Canonical source: packages/cairn-frontend-claudecode/
 * Run automatically as part of `pnpm build` for this package.
 */

import { cpSync, existsSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(HERE, "..");
const CC_ROOT = resolve(PKG_ROOT, "..", "cairn-frontend-claudecode");

if (!existsSync(CC_ROOT)) {
  console.error(
    `sync-from-claudecode: source package not found at ${CC_ROOT}`,
  );
  process.exit(1);
}

const DIRS = ["skills", "agents", "commands", "dist"];

for (const dir of DIRS) {
  const src = resolve(CC_ROOT, dir);
  const dst = resolve(PKG_ROOT, dir);
  if (!existsSync(src)) {
    console.warn(`sync-from-claudecode: skipping ${dir} (not built yet)`);
    continue;
  }
  rmSync(dst, { recursive: true, force: true });
  cpSync(src, dst, { recursive: true });
  console.log(`sync-from-claudecode: ${dir}/`);
}

console.log("sync-from-claudecode: done");
