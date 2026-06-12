#!/usr/bin/env tsx
/**
 * smoke-init-progress-heartbeat — adoption progress.json round-trip.
 *
 * The cairn-adopt long ingestion phases (3-mapper, 6, 7b, 7c) write
 * `.cairn/init/progress.json` after each batch / module / doc / section
 * so the statusline reader can render `⏳ adopt <phase> X/Y (P%) ~Nm`.
 * This smoke covers the read/write/clear cycle + the format module's
 * priority handling (progress beats every other signal).
 *
 * Pure-mechanical (no LLM burn). No network, no Haiku.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearProgress,
  formatStatus,
  progressAbsPath,
  readProgress,
  readStatusForCLI,
  writeProgress,
  type ProgressSnapshot,
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
      /* best-effort */
    }
  }
}

function mkFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "cairn-smoke-progress-"));
  cleanups.push(dir);
  mkdirSync(join(dir, ".cairn"), { recursive: true });
  return dir;
}

function syntheticStatus(overrides: Partial<StatusJson> = {}): StatusJson {
  return {
    updated_at: "2026-05-06T14:32:00Z",
    decisions_in_scope: 0,
    invariants_in_scope: 0,
    task_state: "idle",
    task_id: null,
    task_module: null,
    gc_running: false,
    attention_count: 0,
    bypass_count: 0,
    last_run_result: null,
    last_run_at: null,
    ...overrides,
  };
}

function runSmoke(): void {
  console.log("smoke-init-progress-heartbeat — start");

  // ── Step 1 — read with no progress.json → null ─────────────────
  {
    const repoRoot = mkFixture();
    const out = readProgress(repoRoot);
    assert(out === null, `Step 1: missing progress.json → null, got ${JSON.stringify(out)}`);
    console.log("  ✓ Step 1 — missing progress → null");
  }

  // ── Step 2 — write/read round-trip ─────────────────────────────
  {
    const repoRoot = mkFixture();
    const startedAt = Date.now();
    const snap: ProgressSnapshot = {
      phase: "7b-source-comments",
      batch: 5,
      total: 20,
      classified: 95,
      failed: 0,
      startedAt,
    };
    writeProgress(repoRoot, snap);
    const out = readProgress(repoRoot);
    assert(out !== null, "Step 2: write+read should round-trip a snapshot");
    assert(out.phase === "7b-source-comments", `Step 2: phase, got ${out.phase}`);
    assert(out.batch === 5 && out.total === 20, "Step 2: batch/total");
    console.log("  ✓ Step 2 — write/read round-trip");
  }

  // ── Step 3 — clearProgress removes the file ────────────────────
  {
    const repoRoot = mkFixture();
    writeProgress(repoRoot, {
      phase: "3-mapper",
      batch: 1,
      total: 3,
      startedAt: Date.now(),
    });
    assert(readProgress(repoRoot) !== null, "Step 3 setup: progress.json present");
    clearProgress(repoRoot);
    assert(readProgress(repoRoot) === null, "Step 3: clearProgress removes file");
    console.log("  ✓ Step 3 — clearProgress removes file");
  }

  // ── Step 4 — formatStatus renders ⏳ adopt with the progress arg ─
  {
    const startedAt = Date.now() - 60_000;
    const out = formatStatus(syntheticStatus(), undefined, {
      phase: "7-topic-index",
      batch: 5,
      total: 20,
      startedAt,
    });
    assert(out.includes("⏳"), `Step 4: progress glyph missing, got ${out}`);
    // The statusline shows a plain label, NOT the internal phase id.
    assert(out.includes("tidying notes"), `Step 4: friendly phase label missing, got ${out}`);
    assert(!out.includes("7-topic-index"), `Step 4: raw phase id leaked, got ${out}`);
    assert(out.includes("5/20"), `Step 4: batch/total missing, got ${out}`);
    assert(out.includes("25%"), `Step 4: pct missing, got ${out}`);
    console.log("  ✓ Step 4 — formatStatus ⏳ adopt render (plain label)");
  }

  // ── Step 5 — progress beats every other signal ─────────────────
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
      undefined,
      {
        phase: "7b-source-comments",
        batch: 1,
        total: 10,
        startedAt: Date.now(),
      },
    );
    assert(out.includes("⏳"), `Step 5: progress should win, got ${out}`);
    assert(!out.includes("⚠"), `Step 5: bypass should be hidden, got ${out}`);
    assert(!out.includes("⚑"), `Step 5: attention hidden, got ${out}`);
    assert(!out.includes("◐"), `Step 5: gc hidden, got ${out}`);
    assert(!out.includes("TSK-0099"), `Step 5: task hidden, got ${out}`);
    console.log("  ✓ Step 5 — progress priority over all");
  }

  // ── Step 6 — readStatusForCLI surfaces progress on ground fallback ─
  {
    const repoRoot = mkFixture();
    writeProgress(repoRoot, {
      phase: "3-mapper",
      batch: 2,
      total: 8,
      startedAt: Date.now(),
    });
    const out = readStatusForCLI(repoRoot, null);
    assert(out.includes("⏳"), `Step 6: ground fallback should render progress, got ${out}`);
    assert(out.includes("mapping project"), `Step 6: friendly phase label missing, got ${out}`);
    assert(out.includes("2/8"), `Step 6: batch/total missing, got ${out}`);
    console.log("  ✓ Step 6 — ground fallback surfaces progress (plain label)");
  }

  // ── Step 7 — progressAbsPath stable + reflects expected layout ──
  {
    const repoRoot = mkFixture();
    const abs = progressAbsPath(repoRoot);
    assert(
      abs.endsWith(".cairn/init/progress.json") ||
        abs.endsWith(".cairn\\init\\progress.json"),
      `Step 7: progress path layout, got ${abs}`,
    );
    console.log("  ✓ Step 7 — progressAbsPath layout");
  }

  console.log("smoke-init-progress-heartbeat — pass");
}

try {
  runSmoke();
} finally {
  cleanup();
}
