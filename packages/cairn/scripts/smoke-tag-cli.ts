#!/usr/bin/env tsx
/**
 * smoke-tag-cli — `cairn tag --insert-marker` safety + idempotency.
 *
 * Asserts the four safety properties from PHASE_6_REDESIGN §4.8:
 *   1. Git-aware  — refuses on dirty tree without --force.
 *   2. --force    — escape hatch for the git-aware guard.
 *   3. Impact     — refuses files where pattern matches >30% of lines
 *                   without --force-pattern.
 *   4. --force-pattern — escape hatch for the impact circuit breaker.
 *   5. Idempotent — 3-line lookahead prevents re-insertion when there's
 *                   a blank line between heading and existing marker.
 *   6. No matches — clean run with zero matches inserts nothing.
 */

import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { runTag } from "../src/cli/tag.js";

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

function mkRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "cairn-smoke-tag-"));
  cleanups.push(dir);
  execFileSync("git", ["init", "-q", "--initial-branch=main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "smoke@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Smoke"], { cwd: dir });
  return dir;
}

function writeFile(repo: string, rel: string, body: string): string {
  const abs = join(repo, rel);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body, "utf8");
  return abs;
}

function commit(repo: string, msg = "init"): void {
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["commit", "-q", "-m", msg], { cwd: repo });
}

function captureRun(args: {
  repo: string;
  insertMarker: string;
  targets: string[];
  force?: boolean;
  forcePattern?: boolean;
}): { exitCode: number; stdout: string; stderr: string; totalInserted: number; filesSkippedHighImpact: number } {
  let stdout = "";
  let stderr = "";
  const result = runTag({
    insertMarker: args.insertMarker,
    targets: args.targets,
    repoRoot: args.repo,
    force: args.force ?? false,
    forcePattern: args.forcePattern ?? false,
    stdout: (s: string): void => { stdout += s; },
    stderr: (s: string): void => { stderr += s; },
  });
  return {
    exitCode: result.exitCode,
    stdout,
    stderr,
    totalInserted: result.totalInserted,
    filesSkippedHighImpact: result.filesSkippedHighImpact,
  };
}

function step(label: string): void {
  console.log(`── ${label}`);
}

async function main(): Promise<void> {
  step("Step 1 — git-status guard refuses on dirty file");
  {
    const repo = mkRepo();
    const target = writeFile(repo, "docs/decisions.md", "## Decision: foo bar\n\nbody\n");
    commit(repo);
    // Modify uncommitted.
    writeFileSync(target, "## Decision: foo bar\n\nbody\n\nuncommitted edit\n", "utf8");
    const r = captureRun({
      repo,
      insertMarker: "^## Decision:",
      targets: [target],
    });
    assert(r.exitCode === 1, "dirty without --force exits 1");
    assert(r.stderr.includes("uncommitted changes"), "stderr explains uncommitted changes");
    assert(r.totalInserted === 0, "no markers inserted");
    const after = readFileSync(target, "utf8");
    assert(!after.includes("<!-- cairn:decision -->"), "file untouched on abort");
    console.log("  ✓ Step 1 — dirty file aborts run");
  }

  step("Step 2 — --force escape hatch lets dirty run proceed");
  {
    const repo = mkRepo();
    const target = writeFile(repo, "docs/decisions.md", "## Decision: foo\n\nbody\n");
    commit(repo);
    writeFileSync(target, "## Decision: foo\n\nbody\n\nuncommitted edit\n", "utf8");
    const r = captureRun({
      repo,
      insertMarker: "^## Decision:",
      targets: [target],
      force: true,
    });
    assert(r.exitCode === 0, "--force returns 0");
    assert(r.totalInserted === 1, "one marker inserted under --force");
    const after = readFileSync(target, "utf8");
    assert(after.includes("<!-- cairn:decision -->"), "marker inserted");
    console.log("  ✓ Step 2 — --force allows dirty run");
  }

  step("Step 3 — impact circuit breaker skips high-match files");
  {
    const repo = mkRepo();
    // Every line matches `Decision` — 100% impact ratio.
    const dense = ["Decision A", "Decision B", "Decision C", "Decision D"].join("\n") + "\n";
    const a = writeFile(repo, "docs/dense.md", dense);
    // Realistic doc — 1 of 12 lines matches (~8%).
    const sparseLines = [
      "# Architecture log",
      "",
      "Some context paragraph.",
      "",
      "## Decision: pick HS512",
      "",
      "Body of the decision.",
      "",
      "More narrative.",
      "",
      "Final notes.",
      "",
    ];
    const sparse = sparseLines.join("\n") + "\n";
    const b = writeFile(repo, "docs/sparse.md", sparse);
    commit(repo);
    const r = captureRun({
      repo,
      insertMarker: "Decision",
      targets: [a, b],
    });
    assert(r.exitCode === 0, "impact breaker returns 0 (other files still process)");
    assert(r.filesSkippedHighImpact === 1, "exactly one file skipped");
    assert(r.stderr.includes("Skipping"), "warn message mentions Skipping");
    assert(r.stderr.includes("--force-pattern"), "warn message references --force-pattern");
    const denseAfter = readFileSync(a, "utf8");
    assert(!denseAfter.includes("<!-- cairn:decision -->"), "dense file untouched");
    const sparseAfter = readFileSync(b, "utf8");
    assert(sparseAfter.includes("<!-- cairn:decision -->"), "sparse file got marker");
    console.log("  ✓ Step 3 — high-impact file skipped, sparse file processed");
  }

  step("Step 4 — --force-pattern overrides impact circuit breaker");
  {
    const repo = mkRepo();
    const dense = ["Decision A", "Decision B", "Decision C", "Decision D"].join("\n") + "\n";
    const target = writeFile(repo, "docs/dense.md", dense);
    commit(repo);
    const r = captureRun({
      repo,
      insertMarker: "Decision",
      targets: [target],
      forcePattern: true,
    });
    assert(r.exitCode === 0, "--force-pattern returns 0");
    assert(r.totalInserted === 4, "all four matches got markers");
    const after = readFileSync(target, "utf8");
    const markerCount = (after.match(/<!-- cairn:decision -->/g) ?? []).length;
    assert(markerCount === 4, `expected 4 markers, got ${markerCount}`);
    console.log("  ✓ Step 4 — --force-pattern bypasses circuit breaker");
  }

  step("Step 5 — idempotent insertion w/ blank-line lookahead");
  {
    const repo = mkRepo();
    // Heading, blank line, marker on the next-next line.
    const body = [
      "## Decision: HS512",
      "",
      "<!-- cairn:decision -->",
      "",
      "Body.",
      "",
      "## Decision: KMS later",
      "",
      "<!-- cairn:decision -->",
      "",
      "Body.",
    ].join("\n") + "\n";
    const target = writeFile(repo, "docs/decisions.md", body);
    commit(repo);
    const r1 = captureRun({
      repo,
      insertMarker: "^## Decision:",
      targets: [target],
    });
    assert(r1.exitCode === 0, "first run returns 0");
    assert(r1.totalInserted === 0, "first run inserts nothing — markers already present");
    const after1 = readFileSync(target, "utf8");
    const count1 = (after1.match(/<!-- cairn:decision -->/g) ?? []).length;
    assert(count1 === 2, `expected 2 markers preserved, got ${count1}`);

    // Second run should be a no-op too (still idempotent).
    const r2 = captureRun({
      repo,
      insertMarker: "^## Decision:",
      targets: [target],
    });
    assert(r2.exitCode === 0, "second run returns 0");
    assert(r2.totalInserted === 0, "second run still idempotent");
    const after2 = readFileSync(target, "utf8");
    const count2 = (after2.match(/<!-- cairn:decision -->/g) ?? []).length;
    assert(count2 === 2, `still 2 markers after re-run, got ${count2}`);
    console.log("  ✓ Step 5 — 3-line lookahead handles blank-line gap, idempotent");
  }

  step("Step 6 — no matches → clean exit, no inserts");
  {
    const repo = mkRepo();
    const target = writeFile(
      repo,
      "docs/notes.md",
      "# Plain notes\n\nNothing matches the pattern here.\n",
    );
    commit(repo);
    const r = captureRun({
      repo,
      insertMarker: "^## Decision:",
      targets: [target],
    });
    assert(r.exitCode === 0, "no-match returns 0");
    assert(r.totalInserted === 0, "no-match inserts 0");
    const after = readFileSync(target, "utf8");
    assert(!after.includes("<!-- cairn:decision -->"), "file untouched");
    console.log("  ✓ Step 6 — no matches, no inserts, clean exit");
  }

  step("Cleanup");
  cleanup();
  console.log("\nsmoke-tag-cli — pass");
}

main().catch((err) => {
  console.error("smoke-tag-cli — fail");
  console.error(err);
  cleanup();
  process.exit(1);
});
