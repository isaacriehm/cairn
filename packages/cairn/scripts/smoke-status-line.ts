#!/usr/bin/env tsx
/**
 * smoke-status-line — readStatusForCLI / writeStatusJson round-trip
 * against the per-session state partition.
 *
 * Pure-mechanical (no LLM burn). Writes a synthetic state JSON via
 * writeStatusJson, reads it back via readStatusForCLI, asserts on the
 * formatted output. Also verifies the placeholder when (a) the file is
 * absent and (b) no session id is supplied.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatStatus,
  readStatusForCLI,
  writeStatusJson,
  type StatusJson,
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

function mkFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "harness-smoke-status-line-"));
  cleanups.push(dir);
  return dir;
}

function syntheticStatus(overrides: Partial<StatusJson> = {}): StatusJson {
  return {
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
    ...overrides,
  };
}

function runSmoke(): void {
  console.log("smoke-status-line — start");

  // ── Step 1 — placeholder when state file missing ─────────────────
  {
    const out = readStatusForCLI("/no/such/dir/that/exists/anywhere", "abc-123");
    assert(out.includes("daemon:down"), `Step 1: expected daemon:down placeholder, got ${out}`);
    console.log("  ✓ Step 1 — missing state → placeholder");
  }

  // ── Step 2 — placeholder when sessionId is null/empty ────────────
  {
    const repoRoot = mkFixture();
    writeStatusJson(repoRoot, "session-x", syntheticStatus());
    const noId = readStatusForCLI(repoRoot, null);
    assert(noId.includes("daemon:down"), `Step 2: null id should yield placeholder, got ${noId}`);
    const empty = readStatusForCLI(repoRoot, "");
    assert(empty.includes("daemon:down"), `Step 2: empty id should yield placeholder, got ${empty}`);
    console.log("  ✓ Step 2 — null/empty session id → placeholder");
  }

  // ── Step 3 — round-trip + format ─────────────────────────────────
  {
    const repoRoot = mkFixture();
    writeStatusJson(repoRoot, "session-a", syntheticStatus());
    const out = readStatusForCLI(repoRoot, "session-a");
    assert(out.startsWith("⬡ harness"), `Step 3: should start with ⬡ harness, got ${out}`);
    assert(out.includes("ctx:847/4000"), `Step 3: ctx fragment missing, got ${out}`);
    assert(out.includes("task:idle"), `Step 3: task:idle fragment missing, got ${out}`);
    console.log("  ✓ Step 3 — round-trip + format");
  }

  // ── Step 4 — two sessions in same repo don't collide ─────────────
  {
    const repoRoot = mkFixture();
    writeStatusJson(repoRoot, "session-a", syntheticStatus({ task_state: "idle" }));
    writeStatusJson(repoRoot, "session-b", syntheticStatus({ task_state: "running" }));
    const a = readStatusForCLI(repoRoot, "session-a");
    const b = readStatusForCLI(repoRoot, "session-b");
    assert(a.includes("task:idle"), `Step 4: session-a task:idle missing, got ${a}`);
    assert(b.includes("task:running"), `Step 4: session-b task:running missing, got ${b}`);
    console.log("  ✓ Step 4 — concurrent sessions write isolated files");
  }

  // ── Step 5 — formatStatus priority: attention beats task ────────
  {
    const out = formatStatus(
      syntheticStatus({
        ctx_tokens_used: 100,
        decisions_in_scope: 0,
        invariants_in_scope: 0,
        task_state: "running",
        attention_count: 1,
        last_run_result: null,
        last_run_at: null,
      }),
    );
    assert(out.includes("attention:1"), `Step 5: attention:1 should override task field, got ${out}`);
    assert(out.includes("⚑"), `Step 5: attention icon ⚑ missing, got ${out}`);
    console.log("  ✓ Step 5 — attention priority");
  }

  // ── Step 6 — daemon down beats everything ───────────────────────
  {
    const out = formatStatus(
      syntheticStatus({
        daemon_alive: false,
        ctx_tokens_used: 100,
        decisions_in_scope: 0,
        invariants_in_scope: 0,
        task_state: "running",
        gc_running: true,
        attention_count: 5,
        last_run_result: null,
        last_run_at: null,
      }),
    );
    assert(out.includes("daemon:down"), `Step 6: daemon:down should win, got ${out}`);
    assert(out.includes("○"), `Step 6: down icon ○ missing, got ${out}`);
    console.log("  ✓ Step 6 — daemon-down priority");
  }

  console.log("smoke-status-line — pass");
}

try {
  runSmoke();
} finally {
  cleanup();
}
