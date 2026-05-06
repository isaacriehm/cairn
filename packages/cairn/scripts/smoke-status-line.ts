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

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
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
  const dir = mkdtempSync(join(tmpdir(), "cairn-smoke-status-line-"));
  cleanups.push(dir);
  // writeStatusJson refuses to write when `.cairn/` is missing
  // (defensive — keeps non-adopted projects clean). Seed it so the
  // round-trip cases below work.
  mkdirSync(join(dir, ".cairn"), { recursive: true });
  return dir;
}

function syntheticStatus(overrides: Partial<StatusJson> = {}): StatusJson {
  return {
    updated_at: "2026-05-04T14:32:00Z",
    decisions_in_scope: 12,
    invariants_in_scope: 8,
    task_state: "idle",
    task_id: null,
    task_module: null,
    gc_running: false,
    attention_count: 0,
    bypass_count: 0,
    last_run_result: "succeeded",
    last_run_at: "2026-05-04T14:20:00Z",
    ...overrides,
  };
}

function runSmoke(): void {
  console.log("smoke-status-line — start");

  // ── Step 1 — no .cairn/ dir → empty string (badge hidden) ───────
  {
    const out = readStatusForCLI("/no/such/dir/that/exists/anywhere", "abc-123");
    assert(out === "", `Step 1: expected empty string when no .cairn/, got ${JSON.stringify(out)}`);
    console.log("  ✓ Step 1 — no .cairn/ → empty string");
  }

  // ── Step 2 — null/empty sessionId with .cairn/ → ground fallback ─
  {
    const repoRoot = mkFixture();
    mkdirSync(join(repoRoot, ".cairn"), { recursive: true });
    writeStatusJson(repoRoot, "session-x", syntheticStatus());
    const noId = readStatusForCLI(repoRoot, null);
    assert(noId.startsWith("⬡ cairn"), `Step 2: null id fallback should start with ⬡ cairn, got ${noId}`);
    assert(!noId.includes("no session"), `Step 2: fallback should not say 'no session', got ${noId}`);
    const emptyId = readStatusForCLI(repoRoot, "");
    assert(emptyId.startsWith("⬡ cairn"), `Step 2: empty id fallback should start with ⬡ cairn, got ${emptyId}`);
    console.log("  ✓ Step 2 — null/empty session id → ground fallback");
  }

  // ── Step 3 — idle session → just `⬡ cairn` (compact, no signal) ──
  {
    const repoRoot = mkFixture();
    writeStatusJson(repoRoot, "session-a", syntheticStatus());
    const out = readStatusForCLI(repoRoot, "session-a");
    assert(out === "⬡ cairn", `Step 3: idle/no-attention should be exactly "⬡ cairn", got ${out}`);
    console.log("  ✓ Step 3 — idle compact");
  }

  // ── Step 4 — concurrent sessions render disjoint signals ────────
  {
    const repoRoot = mkFixture();
    writeStatusJson(repoRoot, "session-a", syntheticStatus({ task_state: "idle" }));
    writeStatusJson(
      repoRoot,
      "session-b",
      syntheticStatus({
        task_state: "running",
        task_id: "TSK-0042",
        task_module: "wiring auth middleware",
      }),
    );
    const a = readStatusForCLI(repoRoot, "session-a");
    const b = readStatusForCLI(repoRoot, "session-b");
    assert(a === "⬡ cairn", `Step 4: session-a idle should be "⬡ cairn", got ${a}`);
    assert(
      b.includes("TSK-0042 wiring auth middleware"),
      `Step 4: session-b should surface "TSK-0042 wiring auth middleware", got ${b}`,
    );
    console.log("  ✓ Step 4 — concurrent sessions");
  }

  // ── Step 5 — attention beats task ───────────────────────────────
  {
    const out = formatStatus(
      syntheticStatus({
        task_state: "running",
        task_module: "wiring auth",
        attention_count: 3,
      }),
    );
    assert(out.includes("⚑ 3 pending"), `Step 5: attention beats task, got ${out}`);
    assert(!out.includes("wiring auth"), `Step 5: task surface should be hidden, got ${out}`);
    console.log("  ✓ Step 5 — attention priority");
  }

  // ── Step 6 — gc beats task ──────────────────────────────────────
  {
    const out = formatStatus(
      syntheticStatus({
        task_state: "running",
        task_module: "wiring auth",
        gc_running: true,
      }),
    );
    assert(out.includes("◐ gc"), `Step 6: gc beats task, got ${out}`);
    assert(!out.includes("wiring auth"), `Step 6: task surface should be hidden, got ${out}`);
    console.log("  ✓ Step 6 — gc priority");
  }

  // ── Step 7 — ctx meter renders + colors absolute-token thresholds ─
  {
    const green = formatStatus(syntheticStatus(), { usedPct: 30, usedTokens: 60_000 });
    assert(green.includes("\x1b[32m"), `Step 7: <100k used should be green, got ${green}`);
    assert(green.includes("30%"), `Step 7: pct missing, got ${green}`);

    const yellow = formatStatus(syntheticStatus(), { usedPct: 50, usedTokens: 200_000 });
    assert(yellow.includes("\x1b[33m"), `Step 7: <300k used should be yellow, got ${yellow}`);

    const orange = formatStatus(syntheticStatus(), { usedPct: 50, usedTokens: 500_000 });
    assert(
      orange.includes("\x1b[38;5;208m"),
      `Step 7: <600k used should be orange, got ${orange}`,
    );

    const red = formatStatus(syntheticStatus(), { usedPct: 70, usedTokens: 700_000 });
    assert(red.includes("\x1b[31m"), `Step 7: ≥600k used should be red, got ${red}`);
    console.log("  ✓ Step 7 — ctx meter color thresholds");
  }

  // ── Step 8 — task surface with task_id + task_module ────────────
  {
    const both = formatStatus(
      syntheticStatus({
        task_state: "running",
        task_id: "TSK-0042",
        task_module: "wiring auth middleware",
      }),
    );
    assert(
      both === "⬡ cairn  TSK-0042 wiring auth middleware",
      `Step 8: should be "⬡ cairn  TSK-0042 wiring auth middleware", got ${both}`,
    );

    const idOnly = formatStatus(
      syntheticStatus({ task_state: "running", task_id: "TSK-0042" }),
    );
    assert(
      idOnly === "⬡ cairn  TSK-0042",
      `Step 8b: id-only should be "⬡ cairn  TSK-0042", got ${idOnly}`,
    );
    console.log("  ✓ Step 8 — task surface composition");
  }

  // ── Step 9 — bypass beats every other signal ────────────────────
  {
    const out = formatStatus(
      syntheticStatus({
        bypass_count: 2,
        attention_count: 5,
        gc_running: true,
        task_state: "running",
        task_id: "TSK-0099",
        task_module: "anything",
      }),
    );
    assert(
      out.includes("⚠ 2 unattested"),
      `Step 9: bypass should beat all, got ${out}`,
    );
    assert(!out.includes("pending"), `Step 9: attention surface hidden, got ${out}`);
    assert(!out.includes("gc"), `Step 9: gc hidden, got ${out}`);
    assert(!out.includes("TSK-0099"), `Step 9: task hidden, got ${out}`);
    console.log("  ✓ Step 9 — bypass priority");
  }

  console.log("smoke-status-line — pass");
}

try {
  runSmoke();
} finally {
  cleanup();
}
