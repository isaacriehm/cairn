#!/usr/bin/env tsx
/**
 * smoke-init-mcp-tools — verify the v0.7.2 init tools are registered
 * with correct names + handlers and dispatch to the right phase.
 *
 * Two umbrella tools drive the pipeline:
 *   1. `cairn_init_resume` → { status, nextPhase, repoRoot }
 *   2. `cairn_init_run({ phase, state?, answer? })` → { status, ... }
 *
 * The cairn-adopt skill calls these by name; a typo in the registered
 * name would manifest as a runtime "tool not found" deep inside a
 * session, so we lock the surface in a smoke.
 */

import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  PHASE_IDS,
  allTools,
  freshPhaseState,
  phaseStateAbsPath,
  type McpContext,
  type PhaseId,
  type PhaseState,
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
  const dir = mkdtempSync(join(tmpdir(), "cairn-smoke-init-mcp-tools-"));
  cleanups.push(dir);
  execSync("git init -q", { cwd: dir });
  execSync('git config user.email smoke@example.com', { cwd: dir });
  execSync('git config user.name "smoke"', { cwd: dir });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "mcp-tools-smoke", version: "0.0.0" }),
  );
  return dir;
}

function mkCtx(repoRoot: string): McpContext {
  return {
    repoRoot,
    sessionId: null,
    runId: null,
  } as McpContext;
}

function findTool(name: string): { handler: (ctx: McpContext, input: unknown) => Promise<unknown>; description: string } {
  const tool = allTools.find((t) => t.name === name);
  assert(tool !== undefined, `tool ${name} missing from allTools`);
  return tool!;
}

async function runSmoke(): Promise<void> {
  console.log("smoke-init-mcp-tools — start");

  // ── Step 1 — both umbrella init tools registered ────────────────
  // v0.7.2 collapsed the per-phase tools into a single
  // `cairn_init_run({ phase })` dispatcher. Surface is two tools.
  {
    const names = new Set(allTools.map((t) => t.name));
    assert(
      names.has("cairn_init_resume"),
      "Step 1: cairn_init_resume must be registered",
    );
    assert(
      names.has("cairn_init_run"),
      "Step 1: cairn_init_run must be registered",
    );
    // Per-phase tools are gone — verify they aren't lingering.
    for (const id of PHASE_IDS) {
      const stale = `cairn_init_phase_${id.replace(/-/g, "_")}`;
      assert(
        !names.has(stale),
        `Step 1: legacy ${stale} must NOT be registered (collapsed into cairn_init_run in v0.7.2)`,
      );
    }
    assert(
      !names.has("cairn_init_phases_8_9_10_parallel"),
      "Step 1: legacy cairn_init_phases_8_9_10_parallel must NOT be registered (folded into cairn_init_run for phase 8 in v0.7.2)",
    );
    console.log("  ✓ Step 1 — cairn_init_resume + cairn_init_run registered, legacy per-phase tools removed");
  }

  // ── Step 2 — cairn_init_resume on empty repo → ready / 1-detect ─
  // Resume tool returns slim { status, nextPhase, repoRoot } —
  // no state echo (state lives on disk so MCP responses stay under
  // the spillover-to-file token cap on real monorepos).
  {
    const repo = mkRepo();
    const tool = findTool("cairn_init_resume");
    const result = (await tool.handler(mkCtx(repo), {})) as {
      status: string;
      nextPhase: string | null;
      repoRoot: string;
    };
    assert(result.status === "ready", `Step 2: status should be 'ready', got ${result.status}`);
    assert(result.nextPhase === "1-detect", `Step 2: nextPhase should be 1-detect, got ${result.nextPhase}`);
    assert(result.repoRoot === repo, `Step 2: repoRoot should match repo, got ${result.repoRoot}`);
    assert(
      !("state" in (result as Record<string, unknown>)),
      "Step 2: resume response must NOT echo full state (slim contract)",
    );
    console.log("  ✓ Step 2 — cairn_init_resume → ready / 1-detect");
  }

  // ── Step 3 — cairn_init_run dispatches + persists state ─────────
  // Phase tool response is slim { status, nextPhase } — outputs land
  // on disk, not in the echo. Smoke verifies the on-disk state
  // captures the phase output.
  {
    const repo = mkRepo();
    const ctx = mkCtx(repo);
    const tool = findTool("cairn_init_run");
    const state = freshPhaseState(repo);
    const result = (await tool.handler(ctx, { phase: "1-detect", state })) as {
      status: string;
      nextPhase?: string | null;
    };
    assert(result.status === "complete", `Step 3: phase 1-detect should complete, got ${result.status}`);
    assert(result.nextPhase === "2-walker", `Step 3: nextPhase should be 2-walker, got ${result.nextPhase}`);
    assert(
      !("state" in (result as Record<string, unknown>)),
      "Step 3: phase response must NOT echo full state (slim contract)",
    );
    assert(
      existsSync(phaseStateAbsPath(repo)),
      `Step 3: ${phaseStateAbsPath(repo)} should be written`,
    );
    const persisted = JSON.parse(
      readFileSync(phaseStateAbsPath(repo), "utf8"),
    ) as PhaseState;
    assert(
      persisted.outputs["1-detect"] !== undefined,
      "Step 3: persisted state missing 1-detect outputs",
    );
    console.log("  ✓ Step 3 — cairn_init_run dispatches + persists state");
  }

  // ── Step 3b — cairn_init_run reads state from disk when state arg omitted
  // Skill default: callers pass { phase, answer? } — wrapper loads
  // state from .cairn/init-state.json.
  {
    const repo = mkRepo();
    const ctx = mkCtx(repo);
    const tool = findTool("cairn_init_run");
    // Run 1-detect with explicit state to seed disk; then call 2-walker
    // with no state arg and verify it picks up from .cairn/init-state.json.
    await tool.handler(ctx, { phase: "1-detect", state: freshPhaseState(repo) });
    const result = (await tool.handler(ctx, { phase: "2-walker" })) as {
      status: string;
      nextPhase?: string | null;
    };
    assert(
      result.status === "complete",
      `Step 3b: 2-walker (disk-loaded state) should complete, got ${result.status}`,
    );
    assert(
      result.nextPhase === "3-mapper",
      `Step 3b: 2-walker nextPhase should be 3-mapper, got ${result.nextPhase}`,
    );
    const persisted = JSON.parse(
      readFileSync(phaseStateAbsPath(repo), "utf8"),
    ) as PhaseState;
    assert(
      persisted.outputs["2-walker"] !== undefined,
      "Step 3b: 2-walker output should be persisted after disk-load run",
    );
    console.log("  ✓ Step 3b — cairn_init_run loads state from disk when state arg omitted");
  }

  // ── Step 3c — cairn_init_run with no disk state and no state arg
  // returns VALIDATION_FAILED rather than crashing.
  {
    const repo = mkRepo();
    const ctx = mkCtx(repo);
    const tool = findTool("cairn_init_run");
    const payload = (await tool.handler(ctx, { phase: "1-detect" })) as {
      error?: { code: string; message: string };
    };
    assert(
      payload.error?.code === "VALIDATION_FAILED",
      `Step 3c: missing state should error VALIDATION_FAILED, got ${JSON.stringify(payload)}`,
    );
    assert(
      payload.error.message.includes("no init state") ||
        payload.error.message.includes("init-state.json"),
      `Step 3c: error should mention missing state file, got ${payload.error.message}`,
    );
    console.log("  ✓ Step 3c — missing state errors with VALIDATION_FAILED");
  }

  // ── Step 3d — error path does NOT clobber disk state.
  // Prior versions persisted result.state unconditionally, so an
  // error response with input-state echo would overwrite a 90KB
  // mapper run with whatever shape the caller sent in. Verify disk
  // state is unchanged after an error response.
  {
    const repo = mkRepo();
    const ctx = mkCtx(repo);
    const tool = findTool("cairn_init_run");
    // Seed disk with valid 1-detect output.
    await tool.handler(ctx, { phase: "1-detect", state: freshPhaseState(repo) });
    const before = readFileSync(phaseStateAbsPath(repo), "utf8");
    // Force an error: call 1-detect again with currentPhase="5-preflight"
    // (mismatch).
    const bogus: PhaseState = {
      ...freshPhaseState(repo),
      currentPhase: "5-preflight",
    };
    const errResult = (await tool.handler(ctx, { phase: "1-detect", state: bogus })) as {
      error?: { code: string };
    };
    assert(
      errResult.error?.code === "VALIDATION_FAILED",
      `Step 3d: expected VALIDATION_FAILED, got ${JSON.stringify(errResult)}`,
    );
    const after = readFileSync(phaseStateAbsPath(repo), "utf8");
    assert(
      before === after,
      "Step 3d: error path must not overwrite disk state",
    );
    console.log("  ✓ Step 3d — error path preserves disk state");
  }

  // ── Step 4 — wrong-phase state rejected with VALIDATION_FAILED ──
  {
    const repo = mkRepo();
    const ctx = mkCtx(repo);
    const tool = findTool("cairn_init_run");
    const state: PhaseState = {
      ...freshPhaseState(repo),
      currentPhase: "5-preflight", // wrong
    };
    const payload = (await tool.handler(ctx, { phase: "1-detect", state })) as {
      error?: { code: string; message: string };
    };
    assert(
      payload.error?.code === "VALIDATION_FAILED",
      `Step 4: expected VALIDATION_FAILED, got ${JSON.stringify(payload)}`,
    );
    assert(
      payload.error.message.includes("currentPhase") ||
        payload.error.message.includes("1-detect"),
      `Step 4: error message should mention currentPhase, got ${payload.error.message}`,
    );
    console.log("  ✓ Step 4 — wrong-phase state rejected");
  }

  // ── Step 5 — repoRoot mismatch rejected ─────────────────────────
  {
    const repoA = mkRepo();
    const repoB = mkRepo();
    const ctx = mkCtx(repoA);
    const tool = findTool("cairn_init_run");
    const state = freshPhaseState(repoB); // different repo
    const payload = (await tool.handler(ctx, { phase: "1-detect", state })) as {
      error?: { code: string; message: string };
    };
    assert(
      payload.error?.code === "VALIDATION_FAILED",
      `Step 5: expected VALIDATION_FAILED, got ${JSON.stringify(payload)}`,
    );
    assert(
      payload.error.message.includes("repoRoot"),
      `Step 5: error should mention repoRoot, got ${payload.error.message}`,
    );
    // Neither repo's state file should exist (mismatch errored early).
    assert(
      !existsSync(phaseStateAbsPath(repoA)),
      "Step 5: state should NOT have been written to ctx repo",
    );
    console.log("  ✓ Step 5 — repoRoot mismatch rejected");
  }

  // ── Step 6 — cairn_init_run description references the umbrella intent
  // The skill's prompt cites the tool description; lock the shape so
  // a refactor doesn't accidentally drop the phase-routing hint.
  {
    const tool = findTool("cairn_init_run");
    assert(
      tool.description.length > 60,
      `Step 6: cairn_init_run description too short, got ${tool.description.length} chars`,
    );
    for (const term of ["phase", "8-docs-ingest", "11-baseline"]) {
      assert(
        tool.description.toLowerCase().includes(term.toLowerCase()),
        `Step 6: cairn_init_run description should mention "${term}", got: ${tool.description}`,
      );
    }
    console.log("  ✓ Step 6 — cairn_init_run description covers phase routing + parallel fold");
  }

  console.log("smoke-init-mcp-tools — pass");
}

(async () => {
  try {
    await runSmoke();
  } finally {
    cleanup();
  }
})();
