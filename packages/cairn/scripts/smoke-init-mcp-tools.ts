#!/usr/bin/env tsx
/**
 * smoke-init-mcp-tools — verify the v0.2.0 init tools are registered
 * with correct names + handlers and dispatch to the right phase.
 *
 * The cairn-adopt skill drives the pipeline by calling these tools by
 * name; a typo in the registered name would manifest as a runtime
 * "tool not found" deep inside a session, so we lock the surface in
 * a smoke.
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

function expectedToolName(id: PhaseId): string {
  return `cairn_init_phase_${id.replace(/-/g, "_")}`;
}

async function runSmoke(): Promise<void> {
  console.log("smoke-init-mcp-tools — start");

  // ── Step 1 — all 11 phase tools + the resume tool registered ────
  {
    const names = new Set(allTools.map((t) => t.name));
    assert(
      names.has("cairn_init_resume"),
      `Step 1: cairn_init_resume must be registered`,
    );
    for (const id of PHASE_IDS) {
      const name = expectedToolName(id);
      assert(names.has(name), `Step 1: ${name} must be registered`);
    }
    console.log(`  ✓ Step 1 — ${PHASE_IDS.length + 1} init tools registered`);
  }

  // ── Step 2 — cairn_init_resume on empty repo → ready / 1-detect ─
  // v0.3.5: resume tool returns slim { status, nextPhase, repoRoot }
  // (no state echo — state lives on disk so MCP responses stay
  // under the spillover-to-file token cap on real monorepos).
  {
    const repo = mkRepo();
    const tool = allTools.find((t) => t.name === "cairn_init_resume");
    assert(tool !== undefined, "Step 2: resume tool missing");
    if (tool === undefined) return;
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

  // ── Step 3 — phase tool dispatches + persists state ─────────────
  // v0.3.5: phase tool response is slim { status, nextPhase } —
  // outputs land on disk, not in the echo. Smoke verifies the
  // on-disk state captures the phase output.
  {
    const repo = mkRepo();
    const ctx = mkCtx(repo);
    const tool = allTools.find((t) => t.name === "cairn_init_phase_1_detect");
    assert(tool !== undefined, "Step 3: phase tool missing");
    if (tool === undefined) return;
    const state = freshPhaseState(repo);
    const result = (await tool.handler(ctx, { state })) as {
      status: string;
      nextPhase?: string | null;
    };
    assert(result.status === "complete", `Step 3: phase 1-detect should complete, got ${result.status}`);
    assert(result.nextPhase === "2-walker", `Step 3: nextPhase should be 2-walker, got ${result.nextPhase}`);
    assert(
      !("state" in (result as Record<string, unknown>)),
      "Step 3: phase response must NOT echo full state (slim contract)",
    );
    // State file persisted.
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
    console.log("  ✓ Step 3 — phase tool dispatches + persists state");
  }

  // ── Step 3b — phase tool reads state from disk when state arg omitted ─
  // v0.3.5 contract: callers pass {} (or {answer}) — wrapper loads
  // state from .cairn/init-state.json. Smoke covers the disk-load path.
  {
    const repo = mkRepo();
    const ctx = mkCtx(repo);
    const detectTool = allTools.find(
      (t) => t.name === "cairn_init_phase_1_detect",
    );
    const walkerTool = allTools.find(
      (t) => t.name === "cairn_init_phase_2_walker",
    );
    assert(detectTool !== undefined, "Step 3b: 1-detect tool missing");
    assert(walkerTool !== undefined, "Step 3b: 2-walker tool missing");
    if (detectTool === undefined || walkerTool === undefined) return;
    // Run 1-detect with explicit state to seed disk; then call 2-walker
    // with no state arg and verify it picks up from .cairn/init-state.json.
    await detectTool.handler(ctx, { state: freshPhaseState(repo) });
    const result = (await walkerTool.handler(ctx, {})) as {
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
    console.log("  ✓ Step 3b — phase tool loads state from disk when arg omitted");
  }

  // ── Step 3c — phase tool with no disk state and no arg returns
  //              VALIDATION_FAILED rather than crashing.
  {
    const repo = mkRepo();
    const ctx = mkCtx(repo);
    const tool = allTools.find((t) => t.name === "cairn_init_phase_1_detect");
    assert(tool !== undefined, "Step 3c: tool missing");
    if (tool === undefined) return;
    const payload = (await tool.handler(ctx, {})) as {
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
  // v0.3.5 fix: prior versions persisted result.state unconditionally,
  // so an error response with input-state echo would overwrite a
  // 90KB mapper run with whatever shape the caller sent in. Verify
  // disk state is unchanged after an error response.
  {
    const repo = mkRepo();
    const ctx = mkCtx(repo);
    const detectTool = allTools.find(
      (t) => t.name === "cairn_init_phase_1_detect",
    );
    assert(detectTool !== undefined, "Step 3d: tool missing");
    if (detectTool === undefined) return;
    // Seed disk with valid 1-detect output.
    await detectTool.handler(ctx, { state: freshPhaseState(repo) });
    const before = readFileSync(phaseStateAbsPath(repo), "utf8");
    // Force an error: call 1-detect again with currentPhase="5-brand"
    // (mismatch).
    const bogus: PhaseState = {
      ...freshPhaseState(repo),
      currentPhase: "5-brand",
    };
    const errResult = (await detectTool.handler(ctx, { state: bogus })) as {
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
    const tool = allTools.find((t) => t.name === "cairn_init_phase_1_detect");
    assert(tool !== undefined, "Step 4: phase tool missing");
    if (tool === undefined) return;
    const state: PhaseState = {
      ...freshPhaseState(repo),
      currentPhase: "5-brand", // wrong
    };
    const payload = (await tool.handler(ctx, { state })) as {
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
    const tool = allTools.find((t) => t.name === "cairn_init_phase_1_detect");
    assert(tool !== undefined, "Step 5: phase tool missing");
    if (tool === undefined) return;
    const state = freshPhaseState(repoB); // different repo
    const payload = (await tool.handler(ctx, { state })) as {
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

  // ── Step 6 — tool descriptions reference operator-facing intent ─
  // Each phase tool's description must give the cairn-adopt skill
  // enough hint to surface a one-line status line. Lock the shape.
  {
    for (const id of PHASE_IDS) {
      const tool = allTools.find(
        (t) => t.name === `cairn_init_phase_${id.replace(/-/g, "_")}`,
      );
      assert(tool !== undefined, `Step 6: tool for ${id} missing`);
      if (tool === undefined) continue;
      assert(
        tool.description.includes(`Phase ${id}`),
        `Step 6: ${tool.name} description should mention "Phase ${id}", got ${tool.description.slice(0, 60)}`,
      );
      assert(
        tool.description.length > 40,
        `Step 6: ${tool.name} description too short`,
      );
    }
    console.log(`  ✓ Step 6 — phase tool descriptions cover all ${PHASE_IDS.length} phases`);
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
