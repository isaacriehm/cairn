#!/usr/bin/env tsx
/**
 * smoke-doctor-exit — `cairn doctor` exit-code + cache-status contract.
 *
 * Locks the adopter-CI fix:
 *
 *   1. Advisory warnings DO NOT fail the process. A `cairn doctor` health
 *      job must stay green on a clean checkout. Exit 0 when warnings > 0
 *      and errors === 0, exit 2 only under `--strict`.
 *   2. Errors always exit 1, regardless of `--strict`.
 *   3. The rebuildable, gitignored caches (scope-index, *.ledger) report
 *      `info` — NOT `warn` — when absent on a clean tree, so a fresh runner
 *      sees no spurious warnings from caches it legitimately lacks.
 *
 * Real behavior: drives the actual `runDoctor` against temp repos on disk
 * and the pure `doctorExitCode` mapping the CLI uses.
 */

import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDoctor } from "@isaacriehm/cairn-core";
import { doctorExitCode } from "../src/cli/doctor.js";

const cleanups: string[] = [];

function fail(msg: string): never {
  console.error(`\n  ✗ ${msg}`);
  cleanup();
  process.exit(1);
}

function pass(msg: string): void {
  console.log(`  ✓ ${msg}`);
}

function cleanup(): void {
  for (const dir of cleanups.reverse()) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
}

/**
 * Adopted repo with no rebuildable caches and no sensors.yaml. `withWorkflow`
 * toggles the one hard requirement (`workflow.md`) so we can exercise the
 * warnings-only path vs the error path.
 */
function mkRepo(opts: { cairnVersion: string; withWorkflow: boolean }): string {
  const dir = mkdtempSync(join(tmpdir(), "cairn-smoke-doctor-exit-"));
  cleanups.push(dir);
  mkdirSync(join(dir, ".cairn", "config"), { recursive: true });
  writeFileSync(
    join(dir, ".cairn", "config.yaml"),
    `version: 1\ncairn_version: ${opts.cairnVersion}\nslug: smoke\n`,
    "utf8",
  );
  if (opts.withWorkflow) {
    writeFileSync(
      join(dir, ".cairn", "config", "workflow.md"),
      "# workflow\n",
      "utf8",
    );
  }
  return dir;
}

function findCheck(
  checks: { label: string; status: string; detail: string }[],
  label: string,
) {
  const match = checks.find((c) => c.label === label);
  if (match === undefined) fail(`doctor missing check '${label}'`);
  return match;
}

function main(): void {
  console.log("smoke-doctor-exit — start");

  console.log("\n── Step 1 — absent rebuildable caches report `info`, not `warn`");
  {
    // Bogus version forces a real `cairn version` warn; no caches present.
    const repo = mkRepo({ cairnVersion: "0.0.0-bogus", withWorkflow: true });
    const report = runDoctor({ repoRoot: repo });

    const scope = findCheck(report.checks, "scope-index");
    if (scope.status !== "info") {
      fail(`scope-index absent should be info, got ${scope.status} — ${scope.detail}`);
    }
    for (const kind of ["decisions.ledger", "invariants.ledger"] as const) {
      const led = findCheck(report.checks, kind);
      if (led.status !== "info") {
        fail(`${kind} absent should be info, got ${led.status} — ${led.detail}`);
      }
    }
    // The version skew is a genuine warning and must still surface.
    const ver = findCheck(report.checks, "cairn version");
    if (ver.status !== "warn") {
      fail(`version skew should warn, got ${ver.status} — ${ver.detail}`);
    }
    if (report.errors !== 0) {
      fail(`expected 0 errors with workflow.md present, got ${report.errors}`);
    }
    if (report.warnings < 1) {
      fail(`expected at least one warning (version skew), got ${report.warnings}`);
    }
    pass(`caches → info; version skew → warn; ${report.warnings} warning(s), 0 errors`);

    console.log("\n── Step 2 — warnings exit 0 by default, 2 under --strict");
    if (doctorExitCode(report, { strict: false }) !== 0) {
      fail("warnings must exit 0 without --strict");
    }
    if (doctorExitCode(report, { strict: true }) !== 2) {
      fail("warnings must exit 2 under --strict");
    }
    pass("exit 0 (default) / exit 2 (--strict) on warnings-only report");
  }

  console.log("\n── Step 3 — errors exit 1 regardless of --strict");
  {
    // Drop workflow.md → checkWorkflowMd is a hard error.
    const repo = mkRepo({ cairnVersion: "0.0.0-bogus", withWorkflow: false });
    const report = runDoctor({ repoRoot: repo });
    const wf = findCheck(report.checks, "workflow.md");
    if (wf.status !== "error") {
      fail(`missing workflow.md should error, got ${wf.status}`);
    }
    if (report.errors < 1) fail(`expected at least one error, got ${report.errors}`);
    if (doctorExitCode(report, { strict: false }) !== 1) {
      fail("errors must exit 1 without --strict");
    }
    if (doctorExitCode(report, { strict: true }) !== 1) {
      fail("errors must exit 1 even under --strict");
    }
    pass("errors → exit 1 under both default and --strict");
  }

  console.log("\n── Step 4 — clean report exits 0 under --strict");
  {
    // No errors, no warnings: matching version + workflow present. We can't
    // trivially zero the sensors.yaml warning, so synthesize the mapping.
    if (doctorExitCode({ errors: 0, warnings: 0 }, { strict: true }) !== 0) {
      fail("clean report must exit 0 even under --strict");
    }
    pass("clean → exit 0");
  }

  cleanup();
  console.log("\nsmoke-doctor-exit — pass");
}

try {
  main();
} catch (err) {
  console.error("smoke-doctor-exit — fail");
  console.error(err);
  cleanup();
  process.exit(1);
}
