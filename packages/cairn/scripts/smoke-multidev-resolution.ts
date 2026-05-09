#!/usr/bin/env tsx
/**
 * smoke-multidev-resolution — multi-dev hook-resolution + version-skew acceptance.
 *
 * Locks two multi-dev contracts:
 *
 *   1. Both git hook templates (`pre-commit` + `commit-msg`) must
 *      resolve the cairn binary via `.cairn/.cli-path` BEFORE falling
 *      back to `command -v cairn`. Without this priority, dogfood
 *      forks gate against the previously-published global binary
 *      instead of the local dev build (chicken-and-egg).
 *
 *   2. `cairn doctor` must surface a version-skew warning when the
 *      running binary's `VERSION` disagrees with `.cairn/config.yaml`'s
 *      `cairn_version` — and pass clean when they match. Operators
 *      catch silent schema drift from `cairn doctor` instead of from
 *      a sensor that interprets a YAML field that no longer exists.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION, runDoctor } from "@isaacriehm/cairn-core";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..");
const HOOK_TEMPLATE_DIR = join(
  REPO_ROOT,
  "packages",
  "cairn-core",
  "templates",
  ".cairn",
  "git-hooks",
);

const cleanups: string[] = [];

function header(msg: string): void {
  console.log(`\n── ${msg}`);
}

function fail(msg: string): never {
  console.error(`\n  ✗ ${msg}`);
  process.exit(1);
}

function pass(msg: string): void {
  console.log(`  ✓ ${msg}`);
}

function mkRepo(opts: { cairnVersion?: string | null } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "cairn-smoke-multidev-"));
  cleanups.push(dir);
  mkdirSync(join(dir, ".cairn"), { recursive: true });
  if (opts.cairnVersion === null) {
    // explicit: omit cairn_version key
    writeFileSync(
      join(dir, ".cairn", "config.yaml"),
      "version: 1\nslug: smoke\n",
      "utf8",
    );
  } else if (typeof opts.cairnVersion === "string") {
    writeFileSync(
      join(dir, ".cairn", "config.yaml"),
      `version: 1\ncairn_version: ${opts.cairnVersion}\nslug: smoke\n`,
      "utf8",
    );
  }
  return dir;
}

function findCheck(checks: { label: string; status: string; detail: string }[], label: string) {
  const match = checks.find((c) => c.label === label);
  if (match === undefined) fail(`doctor missing check '${label}'`);
  return match;
}

interface HookContract {
  cliPathLine: number;
  fallbackLine: number;
}

function parseResolutionOrder(content: string): HookContract {
  const lines = content.split("\n");
  let cliPathLine = -1;
  let fallbackLine = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (cliPathLine < 0 && line.includes(".cli-path")) cliPathLine = i + 1;
    if (fallbackLine < 0 && /command -v cairn/.test(line)) fallbackLine = i + 1;
  }
  if (cliPathLine < 0) fail("hook template missing .cli-path resolution branch");
  if (fallbackLine < 0) fail("hook template missing `command -v cairn` fallback branch");
  return { cliPathLine, fallbackLine };
}

function main(): void {
  console.log("smoke-multidev-resolution — start");

  header("Step 1 — pre-commit template resolves .cli-path BEFORE command -v cairn");
  {
    const path = join(HOOK_TEMPLATE_DIR, "pre-commit");
    if (!existsSync(path)) fail(`missing ${path}`);
    const c = parseResolutionOrder(readFileSync(path, "utf8"));
    if (c.cliPathLine >= c.fallbackLine) {
      fail(`pre-commit: .cli-path at line ${c.cliPathLine} must precede command -v cairn at line ${c.fallbackLine}`);
    }
    pass(`.cli-path branch (line ${c.cliPathLine}) precedes fallback (line ${c.fallbackLine})`);
  }

  header("Step 2 — commit-msg template resolves .cli-path BEFORE command -v cairn");
  {
    const path = join(HOOK_TEMPLATE_DIR, "commit-msg");
    if (!existsSync(path)) fail(`missing ${path}`);
    const c = parseResolutionOrder(readFileSync(path, "utf8"));
    if (c.cliPathLine >= c.fallbackLine) {
      fail(`commit-msg: .cli-path at line ${c.cliPathLine} must precede command -v cairn at line ${c.fallbackLine}`);
    }
    pass(`.cli-path branch (line ${c.cliPathLine}) precedes fallback (line ${c.fallbackLine})`);
  }

  header("Step 3 — doctor warns on version skew");
  {
    const repo = mkRepo({ cairnVersion: "0.0.0-bogus" });
    const report = runDoctor({ repoRoot: repo });
    const check = findCheck(report.checks, "cairn version");
    if (check.status !== "warn") {
      fail(`expected warn on version mismatch, got ${check.status} — detail=${check.detail}`);
    }
    if (!check.detail.includes("0.0.0-bogus")) {
      fail(`detail should cite the project version, got: ${check.detail}`);
    }
    if (!check.detail.includes(VERSION)) {
      fail(`detail should cite the running version, got: ${check.detail}`);
    }
    pass(`version skew surfaced: ${check.detail}`);
  }

  header("Step 4 — doctor passes when versions match");
  {
    const repo = mkRepo({ cairnVersion: VERSION });
    const report = runDoctor({ repoRoot: repo });
    const check = findCheck(report.checks, "cairn version");
    if (check.status !== "ok") {
      fail(`expected ok on matching versions, got ${check.status} — detail=${check.detail}`);
    }
    pass(`matched versions report ok: ${check.detail}`);
  }

  header("Step 5 — doctor warns when cairn_version key missing");
  {
    const repo = mkRepo({ cairnVersion: null });
    const report = runDoctor({ repoRoot: repo });
    const check = findCheck(report.checks, "cairn version");
    if (check.status !== "warn") {
      fail(`expected warn on missing key, got ${check.status} — detail=${check.detail}`);
    }
    if (!check.detail.toLowerCase().includes("cairn_version")) {
      fail(`detail should cite the missing key, got: ${check.detail}`);
    }
    pass(`missing cairn_version key surfaced: ${check.detail}`);
  }

  header("Step 6 — doctor warns when config.yaml absent entirely");
  {
    const repo = mkdtempSync(join(tmpdir(), "cairn-smoke-multidev-noconfig-"));
    cleanups.push(repo);
    mkdirSync(join(repo, ".cairn"), { recursive: true });
    const report = runDoctor({ repoRoot: repo });
    const check = findCheck(report.checks, "cairn version");
    if (check.status !== "warn") {
      fail(`expected warn on missing config.yaml, got ${check.status} — detail=${check.detail}`);
    }
    pass(`missing config.yaml surfaced: ${check.detail}`);
  }

  console.log("\nsmoke-multidev-resolution — pass");
}

try {
  main();
} finally {
  for (const dir of cleanups) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  }
}
