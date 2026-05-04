#!/usr/bin/env tsx
/**
 * smoke-status-line — readStatusForCLI / writeStatusJson round-trip.
 *
 * Pure-mechanical (no LLM burn). Writes a synthetic state JSON via
 * writeStatusJson, reads it back via readStatusForCLI, and asserts on the
 * formatted output. Also verifies the placeholder string when the state
 * file is absent.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatStatus,
  readStatusForCLI,
  writeStatusJson,
  type StatusJson,
} from "@devplusllc/harness-core";

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

function mkFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "harness-smoke-status-line-"));
  cleanups.push(dir);
  return dir;
}

function runSmoke(): void {
  console.log("smoke-status-line — start");

  // ── Step 1 — placeholder when state file missing ─────────────────
  {
    const noStateDir = "/no/such/dir/that/exists/anywhere";
    const out = readStatusForCLI(noStateDir);
    assert(
      out.includes("daemon:down"),
      `Step 1: expected placeholder daemon:down, got ${out}`,
    );
    console.log("  ✓ Step 1 — missing state → placeholder");
  }

  // ── Step 2 — writeStatusJson + readStatusForCLI round-trip ──────
  {
    const repoRoot = mkFixture();
    const synthetic: StatusJson = {
      updated_at: "2026-05-04T14:32:00Z",
      daemon_alive: true,
      ctx_tokens_used: 847,
      ctx_tokens_budget: 4000,
      decisions_in_scope: 12,
      invariants_in_scope: 8,
      task_state: "idle",
      task_module: null,
      gc_running: false,
      attention_count: 0,
      last_run_result: "succeeded",
      last_run_at: "2026-05-04T14:20:00Z",
    };
    writeStatusJson(repoRoot, synthetic);
    const out = readStatusForCLI(repoRoot);
    assert(
      out.startsWith("⬡ harness"),
      `Step 2: output should start with ⬡ harness, got ${out}`,
    );
    assert(
      out.includes("ctx:847/4000"),
      `Step 2: ctx fragment missing, got ${out}`,
    );
    assert(
      out.includes("task:idle"),
      `Step 2: task:idle fragment missing, got ${out}`,
    );
    console.log("  ✓ Step 2 — round-trip + format");
  }

  // ── Step 3 — formatStatus priority: attention beats task ────────
  {
    const synthetic: StatusJson = {
      updated_at: "2026-05-04T14:32:00Z",
      daemon_alive: true,
      ctx_tokens_used: 100,
      ctx_tokens_budget: 4000,
      decisions_in_scope: 0,
      invariants_in_scope: 0,
      task_state: "running",
      task_module: null,
      gc_running: false,
      attention_count: 1,
      last_run_result: null,
      last_run_at: null,
    };
    const out = formatStatus(synthetic);
    assert(
      out.includes("attention:1"),
      `Step 3: attention:1 should override task field, got ${out}`,
    );
    assert(
      out.includes("⚑"),
      `Step 3: attention icon ⚑ missing, got ${out}`,
    );
    console.log("  ✓ Step 3 — attention priority");
  }

  // ── Step 4 — daemon down beats everything ───────────────────────
  {
    const synthetic: StatusJson = {
      updated_at: "2026-05-04T14:32:00Z",
      daemon_alive: false,
      ctx_tokens_used: 100,
      ctx_tokens_budget: 4000,
      decisions_in_scope: 0,
      invariants_in_scope: 0,
      task_state: "running",
      task_module: null,
      gc_running: true,
      attention_count: 5,
      last_run_result: null,
      last_run_at: null,
    };
    const out = formatStatus(synthetic);
    assert(
      out.includes("daemon:down"),
      `Step 4: daemon:down should win, got ${out}`,
    );
    assert(out.includes("○"), `Step 4: down icon ○ missing, got ${out}`);
    console.log("  ✓ Step 4 — daemon-down priority");
  }

  console.log("smoke-status-line — pass");
}

try {
  runSmoke();
} finally {
  cleanup();
}
