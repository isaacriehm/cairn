#!/usr/bin/env tsx
/** smoke-cursor-plugin-bundle — cursor dist/cli.mjs runs like claudecode bundle */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const BUNDLE = join(REPO_ROOT, "packages", "cairn-plugin", "dist", "cli.mjs");
const CORE_VER = JSON.parse(
  readFileSync(join(REPO_ROOT, "packages", "cairn-core", "package.json"), "utf8"),
) as { version: string };

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) {
    console.error(`✗ ${message}`);
    process.exit(1);
  }
}

console.log("smoke-cursor-plugin-bundle — start");
assert(existsSync(BUNDLE), "dist/cli.mjs missing");
const head = readFileSync(BUNDLE, "utf8").slice(0, 32);
assert(head.startsWith("#!/usr/bin/env node"), "bundle missing shebang");

const ver = spawnSync("node", [BUNDLE, "--version"], { encoding: "utf8", timeout: 10_000 });
assert(ver.status === 0, `--version failed: ${ver.stderr}`);
assert(ver.stdout.trim() === CORE_VER.version, "version mismatch");

console.log("smoke-cursor-plugin-bundle — pass");
