#!/usr/bin/env tsx
/**
 * smoke-sensor-gate — the live sensor sweep at the pre-commit (staged) and
 * CI (committed-range) gates (WS1 WIRE).
 *
 * Builds a real temp git repo and drives `runSensorsOnDiff` over the same
 * diffs the CLI feeds it (`getStagedDiff` / `getRangeDiff`). Verifies:
 *   - Layer A stub catalog fires on a staged `throw new Error("not implemented")`
 *   - a clean staged tree passes
 *   - decision-assertions fire on a staged file violating an in-scope DEC
 *   - the committed-range diff (CI mode) finds the same violation
 *
 * No LLM burn. Uses the package's shipped stub-patterns.yaml fallback.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  getRangeDiff,
  getStagedDiff,
  runSensorsOnDiff,
} from "@isaacriehm/cairn-core";

const cleanups: string[] = [];

function assert(cond: unknown, message: string): asserts cond {
  if (!cond) {
    console.error(`✗ ${message}`);
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

function git(repoRoot: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
}

function write(repoRoot: string, rel: string, body: string): void {
  const abs = join(repoRoot, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body, "utf8");
}

function mkRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "cairn-smoke-sensor-gate-"));
  cleanups.push(dir);
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "smoke@example.com"]);
  git(dir, ["config", "user.name", "smoke"]);
  git(dir, ["config", "commit.gpgsign", "false"]);
  git(dir, ["config", "core.hooksPath", "/dev/null"]);
  mkdirSync(join(dir, ".cairn", "ground", "decisions"), { recursive: true });
  write(dir, "README.md", "# fixture\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-qm", "init"]);
  return dir;
}

/** Write an accepted DEC carrying a single text_must_not_match assertion. */
function writeForbiddenTokenDec(repoRoot: string, token: string): void {
  const hash = "a".repeat(64);
  const body = [
    "---",
    "id: DEC-1111111",
    "title: Forbidden token must not appear in source",
    "type: adr",
    "status: accepted",
    "scope_globs:",
    "  - 'src/**/*.ts'",
    "assertions:",
    "  - id: no-forbidden-token",
    "    kind: text_must_not_match",
    `    pattern: '${token}'`,
    "    in_globs:",
    "      - 'src/**/*.ts'",
    "sot_kind: ledger",
    "sot_path: ledger",
    `sot_content_hash: ${hash}`,
    "---",
    "",
    "# DEC-1111111 — Forbidden token",
    "",
    `\`${token}\` must never appear in src.`,
    "",
  ].join("\n");
  write(repoRoot, ".cairn/ground/decisions/DEC-1111111.md", body);
}

function hardCount(sweep: { results: { findings: { severity: string }[] }[] }): number {
  return sweep.results.reduce(
    (n, r) => n + r.findings.filter((f) => f.severity === "hard").length,
    0,
  );
}

async function runSmoke(): Promise<void> {
  console.log("smoke-sensor-gate — start");

  // ── Step 1 — Layer A fires on a staged not-implemented throw ──────
  {
    const repoRoot = mkRepo();
    write(
      repoRoot,
      "src/app.ts",
      'export function go(): void {\n  throw new Error("not implemented");\n}\n',
    );
    git(repoRoot, ["add", "src/app.ts"]);
    const diff = await getStagedDiff(repoRoot);
    assert(
      diff.some((d) => d.path === "src/app.ts" && d.status === "added"),
      `Step 1: staged diff should include src/app.ts, got ${JSON.stringify(diff.map((d) => d.path))}`,
    );
    const sweep = await runSensorsOnDiff({ repoRoot, diff, runId: "test" });
    assert(
      sweep.ok === false && sweep.hard_failures > 0,
      `Step 1: expected hard failure from Layer A, got ${JSON.stringify({ ok: sweep.ok, hard: sweep.hard_failures })}`,
    );
    const stub = sweep.results.find((r) => r.sensor_id === "stub-pattern-catalog");
    assert(
      stub !== undefined && stub.findings.some((f) => f.severity === "hard"),
      "Step 1: stub-pattern-catalog should carry the hard finding",
    );
    console.log("  ✓ Step 1 — staged stub → hard failure");
  }

  // ── Step 2 — clean staged tree passes ─────────────────────────────
  {
    const repoRoot = mkRepo();
    write(repoRoot, "src/clean.ts", "export const sum = (a: number, b: number) => a + b;\n");
    git(repoRoot, ["add", "src/clean.ts"]);
    const diff = await getStagedDiff(repoRoot);
    const sweep = await runSensorsOnDiff({ repoRoot, diff, runId: "test" });
    assert(
      sweep.ok === true && hardCount(sweep) === 0,
      `Step 2: clean tree should pass, got ${JSON.stringify({ ok: sweep.ok, hard: hardCount(sweep) })}`,
    );
    console.log("  ✓ Step 2 — clean staged tree → pass");
  }

  // ── Step 3 — decision-assertion fires on staged violation ─────────
  {
    const repoRoot = mkRepo();
    writeForbiddenTokenDec(repoRoot, "WIRE_TRANSFER_BYPASS");
    write(repoRoot, "src/pay.ts", "export const mode = 'WIRE_TRANSFER_BYPASS';\n");
    git(repoRoot, ["add", "src/pay.ts"]);
    const diff = await getStagedDiff(repoRoot);
    const sweep = await runSensorsOnDiff({ repoRoot, diff, runId: "test" });
    const dec = sweep.results.find((r) => r.sensor_id === "decision-assertions");
    assert(
      dec !== undefined && dec.findings.some((f) => f.severity === "hard"),
      `Step 3: decision-assertions should fail, got ${JSON.stringify(dec?.findings)}`,
    );
    assert(sweep.ok === false, "Step 3: sweep should be not-ok on the DEC violation");
    console.log("  ✓ Step 3 — staged DEC violation → hard failure");
  }

  // ── Step 4 — CI range diff (committed) finds the same violation ────
  {
    const repoRoot = mkRepo();
    write(
      repoRoot,
      "src/feature.ts",
      'export function f(): void {\n  throw new Error("not implemented");\n}\n',
    );
    git(repoRoot, ["add", "."]);
    git(repoRoot, ["commit", "-qm", "add feature with stub"]);
    const diff = await getRangeDiff(repoRoot, "HEAD~1..HEAD");
    assert(
      diff.some((d) => d.path === "src/feature.ts"),
      `Step 4: range diff should include src/feature.ts, got ${JSON.stringify(diff.map((d) => d.path))}`,
    );
    const sweep = await runSensorsOnDiff({ repoRoot, diff, runId: "ci" });
    assert(
      sweep.ok === false && sweep.hard_failures > 0,
      `Step 4: CI range sweep should fail, got ${JSON.stringify({ ok: sweep.ok, hard: sweep.hard_failures })}`,
    );
    console.log("  ✓ Step 4 — committed-range diff → hard failure");
  }

  console.log("smoke-sensor-gate — pass");
}

try {
  await runSmoke();
} finally {
  cleanup();
}
