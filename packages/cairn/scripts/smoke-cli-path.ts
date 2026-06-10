#!/usr/bin/env tsx
/**
 * smoke-cli-path — `.cairn/.cli-path` freshness + git-hook self-heal.
 *
 * Two guarantees:
 *
 *   1. `writeCliPathFile` writes a quoted invocation of the current CLI entry,
 *      so SessionStart can refresh it every session (a plugin upgrade rotates
 *      the bundled cli.mjs path; the bootstrap-only runJoin never re-fires once
 *      hooks are wired).
 *
 *   2. The shipped pre-commit / commit-msg hooks SELF-HEAL a stale `.cli-path`:
 *      if the recorded target no longer exists (deleted by a plugin upgrade),
 *      the hook blanks CAIRN_CMD and falls through to a global `cairn` instead
 *      of `eval`-ing a dead path (which, under `set -e`, hard-fails the commit).
 *
 * Run: pnpm -F @isaacriehm/cairn smoke:cli-path
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { writeCliPathFile } from "@isaacriehm/cairn-core";

let failed = 0;
function assert(cond: boolean, msg: string): void {
  if (cond) {
    console.log(`  ✓ ${msg}`);
  } else {
    console.error(`  ✗ ${msg}`);
    failed += 1;
  }
}

const repoRoot = resolve(import.meta.dirname, "..", "..", "..");

/* ── 1. writeCliPathFile writes a quoted invocation ─────────────────────── */

const tmp = mkdtempSync(join(tmpdir(), "cairn-cli-path-"));
try {
  const step = writeCliPathFile(tmp);
  const cliPath = join(tmp, ".cairn", ".cli-path");
  assert(step.status === "ok", "writeCliPathFile reports ok");
  assert(existsSync(cliPath), ".cli-path written");
  const content = readFileSync(cliPath, "utf8").trim();
  // process.argv[1] (this smoke under tsx) is quoted; a .mjs/.js entry also
  // gets a `node ` prefix. Either way the path is double-quoted.
  assert(/"[^"]+"\s*$/.test(content), `invocation is quoted: ${content}`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

/* ── 2. Hook self-heal block — drift guard + behavior ───────────────────── */

const SELF_HEAL = [
  '  CAIRN_BIN="${CAIRN_CMD#node }"',
  '  CAIRN_BIN="${CAIRN_BIN#\\"}"',
  '  CAIRN_BIN="${CAIRN_BIN%\\"}"',
  '  if [ -n "$CAIRN_BIN" ] && [ ! -f "$CAIRN_BIN" ]; then',
  '    CAIRN_CMD=""',
  "  fi",
].join("\n");

for (const hook of ["pre-commit", "commit-msg"]) {
  const tpl = readFileSync(
    join(repoRoot, "packages/cairn-core/templates/.cairn/git-hooks", hook),
    "utf8",
  );
  assert(tpl.includes(SELF_HEAL), `${hook} template carries the self-heal block`);
}

/** Run the shipped self-heal snippet with a given CAIRN_CMD; return its result. */
function resolveCmd(input: string): string {
  const script = `CAIRN_CMD="${input}"\n${SELF_HEAL}\nprintf '%s' "$CAIRN_CMD"`;
  return execFileSync("sh", ["-c", script], { encoding: "utf8" });
}

const realFile = resolve(import.meta.dirname, "smoke-cli-path.ts"); // exists
const deadFile = "/nonexistent/cairn/cache/v0/dist/cli.mjs";

assert(resolveCmd(`node \\"${deadFile}\\"`) === "", "stale node-path → CAIRN_CMD blanked (falls back)");
assert(resolveCmd(`\\"${deadFile}\\"`) === "", "stale bare-path → CAIRN_CMD blanked (falls back)");
assert(resolveCmd(`node \\"${realFile}\\"`) === `node "${realFile}"`, "live node-path → preserved");
assert(resolveCmd(`\\"${realFile}\\"`) === `"${realFile}"`, "live bare-path → preserved");

if (failed > 0) {
  console.error(`smoke-cli-path — FAIL (${failed})`);
  process.exit(1);
}
console.log("smoke-cli-path — pass");
