#!/usr/bin/env tsx
/**
 * smoke-watch — Phase 3 acceptance sensor.
 *
 * Per INTEGRATION_PLAN.md Phase 3: "edit a file, daemon detects within 1s,
 * regenerates ground/* within 5s, manifest.yaml updated."
 *
 * Steps:
 *   1. Create a fake adopted-repo root in /tmp with canonical-zone files.
 *   2. Start the daemon programmatically (no subprocess — keeps the test tight).
 *   3. Initial sweep should produce manifest.yaml with the seeded files.
 *   4. Drop a new canonical doc; flush; manifest must include it.
 *   5. Drop an accepted decision file; flush; decisions ledger must include it.
 *   6. Stop the daemon, cleanup.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  decisionsLedgerPath,
  invariantsLedgerPath,
  manifestPath,
  qualityGradesPath,
} from "../src/ground/index.js";
import type { DecisionLedgerEntry, Manifest } from "../src/ground/index.js";
import { startDaemon } from "../src/watch/index.js";

const projectName = `smoke_watch_${Date.now()}`;
let cleanupPaths: string[] = [];

function header(line: string): void {
  console.log(`\n── ${line}`);
}

function fail(reason: string): never {
  console.error(`smoke-watch FAIL: ${reason}`);
  cleanup();
  process.exit(1);
}

function cleanup(): void {
  for (const p of cleanupPaths) {
    try {
      rmSync(p, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
}

function seedRepo(root: string): void {
  mkdirSync(join(root, ".harness", "config"), { recursive: true });
  mkdirSync(join(root, ".harness", "ground", "decisions"), { recursive: true });
  mkdirSync(join(root, ".harness", "ground", "invariants"), { recursive: true });
  mkdirSync(join(root, ".harness", "tasks", "active"), { recursive: true });
  mkdirSync(join(root, "docs"), { recursive: true });

  writeFileSync(
    join(root, "AGENTS.md"),
    "# Project orientation\n\n> seed for smoke test.\n",
  );
  writeFileSync(
    join(root, "CLAUDE.md"),
    "@AGENTS.md\n",
  );
  writeFileSync(
    join(root, ".harness", "config", "workflow.md"),
    "---\ntype: workflow-policy\nstatus: draft\naudience: dual\n---\n\nseed\n",
  );
  writeFileSync(
    join(root, "docs", "intro.md"),
    "---\ntype: doc\nstatus: draft\naudience: dual\nverified-at: 2026-05-02T00:00:00Z\n---\n\n# Intro\n",
  );
}

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "harness-smoke-watch-"));
  cleanupPaths.push(root);

  header("Step 1: seed fake adopted repo");
  seedRepo(root);

  header("Step 2: start daemon (initial sweep)");
  const daemon = await startDaemon({
    projectName,
    repoRoot: root,
    debounceMs: 50,
    noPidFile: true,
  });

  header("Step 3: assert manifest covers seeded files");
  if (!existsSync(manifestPath(root))) fail("manifest.yaml not written");
  let manifest = parseYaml(readFileSync(manifestPath(root), "utf8")) as Manifest;
  const seeded = ["AGENTS.md", "CLAUDE.md", ".harness/config/workflow.md", "docs/intro.md"];
  for (const path of seeded) {
    if (!manifest.files.some((f) => f.path === path)) {
      fail(`manifest missing seeded file ${path}`);
    }
  }
  if (!existsSync(qualityGradesPath(root))) fail("quality-grades.yaml not written");
  if (!existsSync(decisionsLedgerPath(root))) fail("decisions.ledger.yaml not written");
  if (!existsSync(invariantsLedgerPath(root))) fail("invariants.ledger.yaml not written");

  header("Step 4: drop a new canonical doc; flush; expect manifest update");
  writeFileSync(
    join(root, "docs", "added-after-start.md"),
    "---\ntype: doc\nstatus: draft\naudience: dual\nverified-at: 2026-05-02T00:00:00Z\n---\n\n# After start\n",
  );
  // Allow chokidar to emit the event before flush; flush waits for any pending fire.
  await new Promise((r) => setTimeout(r, 250));
  await daemon.flush();
  manifest = parseYaml(readFileSync(manifestPath(root), "utf8")) as Manifest;
  if (!manifest.files.some((f) => f.path === "docs/added-after-start.md")) {
    fail("manifest did not pick up docs/added-after-start.md after flush");
  }

  header("Step 5: drop accepted decision; flush; expect ledger update");
  writeFileSync(
    join(root, ".harness", "ground", "decisions", "DEC-0001.md"),
    [
      "---",
      "id: DEC-0001",
      "title: smoke decision",
      "type: adr",
      "status: accepted",
      "audience: dual",
      "scope_globs:",
      "  - docs/**",
      "---",
      "",
      "# DEC-0001 — smoke",
      "",
    ].join("\n"),
  );
  await new Promise((r) => setTimeout(r, 250));
  await daemon.flush();
  const ledger = parseYaml(readFileSync(decisionsLedgerPath(root), "utf8")) as DecisionLedgerEntry[];
  if (!Array.isArray(ledger) || ledger.length !== 1 || ledger[0]?.id !== "DEC-0001") {
    fail(`decisions ledger missing DEC-0001 — got ${JSON.stringify(ledger)}`);
  }

  header("Step 6: stop + cleanup");
  await daemon.stop();
  cleanup();
  console.log("\nsmoke-watch: OK");
}

try {
  await main();
} catch (err) {
  console.error(err);
  cleanup();
  process.exit(1);
}
