#!/usr/bin/env tsx
/**
 * smoke-stop-debounce — Stop hook bypass / review surface respects
 * the per-kind defer file written by cairn_resolve_attention.
 *
 * Spec: PLUGIN_ARCHITECTURE §10 (Stop hook). The defer contract:
 *   - choice=c writes .cairn/.{bypass,review}-deferred-until with
 *     a snapshot of flagged SHAs / task_ids and a 24h window
 *   - subsequent Stop hooks suppress as long as:
 *     (a) now < deferred_at + deferred_for_hours, AND
 *     (b) currently-flagged set ⊆ deferred snapshot
 *   - any new flagged item breaks the suppression
 *   - choice=a/b clears the defer file (the operator engaged)
 */

import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  allTools,
  deferStatePath,
  isDeferActive,
  readDeferState,
  writeDeferState,
  type McpContext,
} from "@isaacriehm/cairn-core";

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
  const dir = mkdtempSync(join(tmpdir(), "cairn-smoke-stop-debounce-"));
  cleanups.push(dir);
  execSync("git init -q", { cwd: dir });
  execSync('git config user.email smoke@example.com', { cwd: dir });
  execSync('git config user.name "smoke"', { cwd: dir });
  // Pre-create .cairn/ so the bootstrap-guard inside resolve_attention
  // doesn't refuse with BOOTSTRAP_REQUIRED.
  execSync(
    `mkdir -p ${JSON.stringify(join(dir, ".cairn"))} && echo cairn_version: 0.0.0 > ${JSON.stringify(join(dir, ".cairn", "config.yaml"))}`,
    { cwd: dir },
  );
  // Mark this clone as bootstrapped via core.hooksPath (the guard is
  // satisfied by either flag).
  execSync(`git config core.hooksPath .cairn/git-hooks`, { cwd: dir });
  return dir;
}

function mkCtx(repoRoot: string): McpContext {
  return { repoRoot, sessionId: null, runId: null } as McpContext;
}

async function runSmoke(): Promise<void> {
  console.log("smoke-stop-debounce — start");

  // ── Step 1 — defer file shape + isDeferActive within window ─────
  {
    const repo = mkRepo();
    const state = writeDeferState(repo, "bypass", {
      flagged_shas: ["abc1234", "def5678"],
    });
    assert(state.deferred_for_hours === 24, "Step 1: default 24h window");
    assert(
      existsSync(deferStatePath(repo, "bypass")),
      "Step 1: bypass defer file should exist",
    );
    const round = readDeferState(repo, "bypass");
    assert(round !== null, "Step 1: defer file readable");
    if (round === null) return;
    assert(
      round.flagged_shas.length === 2,
      `Step 1: shas should round-trip, got ${round.flagged_shas.length}`,
    );
    // Within window + subset → active.
    const inWindow = new Date(Date.parse(round.deferred_at) + 60 * 1000);
    const active = isDeferActive(round, inWindow, {
      kind: "shas",
      values: ["abc1234"],
    });
    assert(active, "Step 1: subset within window should be active");
    console.log("  ✓ Step 1 — defer write/read + isDeferActive subset");
  }

  // ── Step 2 — new flagged item breaks suppression ─────────────────
  {
    const repo = mkRepo();
    const state = writeDeferState(repo, "bypass", {
      flagged_shas: ["abc1234"],
    });
    const inWindow = new Date(Date.parse(state.deferred_at) + 60 * 1000);
    const active = isDeferActive(state, inWindow, {
      kind: "shas",
      values: ["abc1234", "newSha999"], // new item appeared
    });
    assert(!active, "Step 2: new item should break suppression");
    console.log("  ✓ Step 2 — new flagged item breaks defer");
  }

  // ── Step 3 — past window → suppression expires ──────────────────
  {
    const repo = mkRepo();
    const state = writeDeferState(repo, "bypass", {
      flagged_shas: ["abc1234"],
      hours: 1,
    });
    const past = new Date(Date.parse(state.deferred_at) + 2 * 60 * 60 * 1000);
    const active = isDeferActive(state, past, {
      kind: "shas",
      values: ["abc1234"],
    });
    assert(!active, "Step 3: past window should expire");
    console.log("  ✓ Step 3 — defer window expires");
  }

  // ── Step 4 — cairn_resolve_attention kind=bypass / choice=c ─────
  {
    const repo = mkRepo();
    const ctx = mkCtx(repo);
    const tool = allTools.find((t) => t.name === "cairn_resolve_attention");
    assert(tool !== undefined, "Step 4: cairn_resolve_attention missing");
    if (tool === undefined) return;
    const result = (await tool.handler(ctx, {
      kind: "bypass",
      choice: "c",
      item_id: "abc1234",
      flagged_items: ["abc1234", "def5678"],
    })) as { ok?: boolean; resolved_kind?: string; flagged_count?: number };
    assert(result.ok === true, `Step 4: tool should succeed, got ${JSON.stringify(result)}`);
    assert(
      result.resolved_kind === "bypass_deferred",
      `Step 4: resolved_kind should be bypass_deferred, got ${result.resolved_kind}`,
    );
    assert(result.flagged_count === 2, `Step 4: flagged_count should be 2, got ${result.flagged_count}`);
    const persisted = readDeferState(repo, "bypass");
    assert(persisted !== null, "Step 4: defer file must be written");
    if (persisted === null) return;
    assert(
      persisted.flagged_shas.length === 2,
      "Step 4: defer file should snapshot all flagged SHAs",
    );
    console.log("  ✓ Step 4 — resolve_attention bypass/c writes defer file");
  }

  // ── Step 5 — choice=a/b clears the defer file ───────────────────
  {
    const repo = mkRepo();
    const ctx = mkCtx(repo);
    const tool = allTools.find((t) => t.name === "cairn_resolve_attention");
    assert(tool !== undefined, "Step 5: cairn_resolve_attention missing");
    if (tool === undefined) return;
    // Pre-write a defer file.
    writeDeferState(repo, "review", { flagged_task_ids: ["task-old"] });
    assert(
      existsSync(deferStatePath(repo, "review")),
      "Step 5: review defer file should exist before resolve",
    );
    const result = (await tool.handler(ctx, {
      kind: "review",
      choice: "a",
      item_id: "task-new",
    })) as { ok?: boolean; resolved_kind?: string };
    assert(result.ok === true, `Step 5: tool should succeed, got ${JSON.stringify(result)}`);
    assert(
      result.resolved_kind === "review_now",
      `Step 5: resolved_kind should be review_now, got ${result.resolved_kind}`,
    );
    assert(
      !existsSync(deferStatePath(repo, "review")),
      "Step 5: choice=a should clear the defer file",
    );
    console.log("  ✓ Step 5 — choice=a clears prior defer");
  }

  // ── Step 6 — bypass and review defers are independent ───────────
  {
    const repo = mkRepo();
    writeDeferState(repo, "bypass", { flagged_shas: ["abc"] });
    writeDeferState(repo, "review", { flagged_task_ids: ["t1"] });
    assert(existsSync(deferStatePath(repo, "bypass")), "Step 6: bypass file");
    assert(existsSync(deferStatePath(repo, "review")), "Step 6: review file");
    const ctx = mkCtx(repo);
    const tool = allTools.find((t) => t.name === "cairn_resolve_attention");
    assert(tool !== undefined, "Step 6: cairn_resolve_attention missing");
    if (tool === undefined) return;
    // Resolving bypass should not touch review.
    await tool.handler(ctx, {
      kind: "bypass",
      choice: "b",
      item_id: "abc",
    });
    assert(
      !existsSync(deferStatePath(repo, "bypass")),
      "Step 6: bypass should be cleared",
    );
    assert(
      existsSync(deferStatePath(repo, "review")),
      "Step 6: review should remain untouched",
    );
    console.log("  ✓ Step 6 — bypass and review defers are independent");
  }

  console.log("smoke-stop-debounce — pass");
}

(async () => {
  try {
    await runSmoke();
  } finally {
    cleanup();
  }
})();
