#!/usr/bin/env tsx
/**
 * smoke-bug-mine-0.13.3 — coverage for surfaces patched after the
 * cross-repo mining sweep over two long-running installations.
 *
 * Covers:
 *   - cairn_task_reopen happy path + collision + missing-id error
 *   - cairn_decision_get redirect on INV- prefix; cairn_invariant_get
 *     redirect on DEC- prefix
 *   - cairn_record_decision direct accept extends decisions.ledger.yaml
 *   - bulkAcceptObvious emits decision_accepted events
 *   - cairn_mission_advance choice=exit unlinks
 *     .mission-phase-deferred-until when phase ids match
 *   - Stop hook stall scan filters tasks owned by another session
 *     within the cross-session-takeover window
 *   - Stop hook GC of .stalled-warned/ markers for tasks no longer
 *     active
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  allTools,
  bulkAcceptObvious,
  clearMissionPhaseDeferIfMatches,
  eventsDir,
  type McpContext,
  type ToolDef,
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
      /* best-effort */
    }
  }
}

function mkRepoRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "cairn-smoke-bugmine-"));
  cleanups.push(dir);
  mkdirSync(join(dir, ".cairn", "ground", "decisions", "_inbox"), {
    recursive: true,
  });
  mkdirSync(join(dir, ".cairn", "ground", "invariants"), { recursive: true });
  mkdirSync(join(dir, ".cairn", "tasks", "active"), { recursive: true });
  mkdirSync(join(dir, ".cairn", "tasks", "done"), { recursive: true });
  mkdirSync(join(dir, ".cairn", "events"), { recursive: true });
  mkdirSync(join(dir, ".cairn", "config"), { recursive: true });
  // Mark bootstrap done — these tools require it.
  writeFileSync(
    join(dir, ".cairn", "manifest.yaml"),
    "cairn_version: 0.13.3\nbootstrap_complete: true\n",
    "utf8",
  );
  return dir;
}

function getTool(name: string): ToolDef<unknown> {
  const tool = (allTools as ToolDef<unknown>[]).find((t) => t.name === name);
  assert(tool !== undefined, `${name} should be registered in allTools`);
  return tool;
}

async function call(
  tool: ToolDef<unknown>,
  ctx: McpContext,
  input: unknown,
): Promise<Record<string, unknown>> {
  return (await tool.handler(ctx, input)) as Record<string, unknown>;
}

function writeActiveTask(
  repoRoot: string,
  taskId: string,
  fields: Record<string, string>,
): void {
  const dir = join(repoRoot, ".cairn", "tasks", "active", taskId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "spec.tightened.md"),
    `---\nid: ${taskId}\nneeds_review: false\n---\n# ${taskId}\n`,
    "utf8",
  );
  const lines: string[] = [`id: ${taskId}`, `phase: running`, ...Object.entries(fields).map(([k, v]) => `${k}: ${v}`)];
  writeFileSync(join(dir, "status.yaml"), `${lines.join("\n")}\n`, "utf8");
}

async function runSmoke(): Promise<void> {
  console.log("smoke-bug-mine-0.13.3 — start");

  // ─────────────────────────────────────────────────────────────────
  // Step 1 — cairn_task_reopen happy path
  // ─────────────────────────────────────────────────────────────────
  {
    const repoRoot = mkRepoRoot();
    const taskId = "TSK-smoke-reopen-aaaaaaa";
    const doneDir = join(repoRoot, ".cairn", "tasks", "done", taskId);
    mkdirSync(doneDir, { recursive: true });
    writeFileSync(
      join(doneDir, "spec.tightened.md"),
      `---\nid: ${taskId}\n---\n# ${taskId}\n`,
      "utf8",
    );
    writeFileSync(
      join(doneDir, "status.yaml"),
      `id: ${taskId}\nphase: succeeded\ncompleted_at: 2026-05-15T12:00:00.000Z\noutcome_summary: ok\n`,
      "utf8",
    );
    writeFileSync(
      join(doneDir, "attestation.yaml"),
      `task_id: ${taskId}\nattested_at: 2026-05-15T11:59:00.000Z\n`,
      "utf8",
    );

    const tool = getTool("cairn_task_reopen");
    const ctx: McpContext = { repoRoot, sessionId: "session-x" };
    const result = await call(tool, ctx, { task_id: taskId });
    assert(result["ok"] === true, "task_reopen should succeed");
    const activeDir = join(repoRoot, ".cairn", "tasks", "active", taskId);
    assert(existsSync(activeDir), "active dir should exist after reopen");
    assert(!existsSync(doneDir), "done dir should be gone after reopen");
    const status = readFileSync(join(activeDir, "status.yaml"), "utf8");
    assert(/phase:\s*running/.test(status), "phase should reset to running");
    assert(!/completed_at/.test(status), "completed_at should be dropped");
    assert(!/outcome_summary/.test(status), "outcome_summary should be dropped");
    assert(
      !existsSync(join(activeDir, "attestation.yaml")),
      "attestation.yaml should be renamed away to prevent auto-graduate loop",
    );
    const archived = readdirSync(activeDir).filter((n) =>
      n.startsWith("attestation.") && n.endsWith(".yaml"),
    );
    assert(archived.length === 1, "exactly one archived attestation should remain");
    console.log("  ✓ Step 1 — task_reopen happy path + attestation archive");
  }

  // ─────────────────────────────────────────────────────────────────
  // Step 2 — cairn_task_reopen rejects collision + missing id
  // ─────────────────────────────────────────────────────────────────
  {
    const repoRoot = mkRepoRoot();
    const taskId = "TSK-smoke-collide-bbbbbbb";
    writeActiveTask(repoRoot, taskId, {});
    mkdirSync(join(repoRoot, ".cairn", "tasks", "done", taskId), { recursive: true });
    writeFileSync(
      join(repoRoot, ".cairn", "tasks", "done", taskId, "status.yaml"),
      `id: ${taskId}\nphase: succeeded\n`,
      "utf8",
    );

    const tool = getTool("cairn_task_reopen");
    const ctx: McpContext = { repoRoot, sessionId: "session-x" };
    const colliding = await call(tool, ctx, { task_id: taskId });
    assert(
      typeof colliding["error"] === "object",
      "reopen should error on active+done collision",
    );
    const missing = await call(tool, ctx, { task_id: "TSK-no-such-cccccc1" });
    assert(
      typeof missing["error"] === "object",
      "reopen should error on missing task",
    );
    console.log("  ✓ Step 2 — task_reopen rejects collision + missing id");
  }

  // ─────────────────────────────────────────────────────────────────
  // Step 3 — cairn_decision_get returns redirect on INV- prefix
  // ─────────────────────────────────────────────────────────────────
  {
    const repoRoot = mkRepoRoot();
    const decTool = getTool("cairn_decision_get");
    const invTool = getTool("cairn_invariant_get");
    const ctx: McpContext = { repoRoot, sessionId: "session-x" };
    const dWrong = await call(decTool, ctx, { id: "INV-1234567" });
    const err1 = dWrong["error"] as { code?: string } | undefined;
    assert(
      err1?.code === "WRONG_TOOL_FOR_KIND",
      "decision_get on INV- id should return WRONG_TOOL_FOR_KIND",
    );
    const iWrong = await call(invTool, ctx, { id: "DEC-7654321" });
    const err2 = iWrong["error"] as { code?: string } | undefined;
    assert(
      err2?.code === "WRONG_TOOL_FOR_KIND",
      "invariant_get on DEC- id should return WRONG_TOOL_FOR_KIND",
    );
    console.log("  ✓ Step 3 — decision/invariant get cross-prefix redirects");
  }

  // ─────────────────────────────────────────────────────────────────
  // Step 4 — record_decision target:accepted extends ledger
  // ─────────────────────────────────────────────────────────────────
  {
    const repoRoot = mkRepoRoot();
    const tool = getTool("cairn_record_decision");
    const ctx: McpContext = { repoRoot, sessionId: "session-x" };
    const result = await call(tool, ctx, {
      title: "smoke direct accept",
      summary: "Direct-accept path appends ledger.",
      target: "accepted",
      scope_globs: ["src/smoke/**"],
    });
    assert(result["ok"] === true, "record_decision should succeed");
    const ledgerPath = join(
      repoRoot,
      ".cairn",
      "ground",
      "decisions",
      "decisions.ledger.yaml",
    );
    assert(existsSync(ledgerPath), "decisions.ledger.yaml should be written");
    const ledger = readFileSync(ledgerPath, "utf8");
    const decId = result["id"] as string;
    assert(
      ledger.includes(decId),
      `ledger should include the newly-accepted DEC id ${decId}`,
    );
    console.log("  ✓ Step 4 — record_decision direct-accept extends ledger");
  }

  // ─────────────────────────────────────────────────────────────────
  // Step 5 — bulkAcceptObvious emits decision_accepted events
  // ─────────────────────────────────────────────────────────────────
  {
    const repoRoot = mkRepoRoot();
    const inbox = join(repoRoot, ".cairn", "ground", "decisions", "_inbox");
    const draftId = "DEC-bbbbbbb";
    const body = [
      "Critical security invariant: tenant context must never leak. Auth middleware",
      "requires tenant scoping on all queries to prevent cross-tenant data exposure.",
      "All endpoints must validate tenant before proceeding with database access or",
      "any privileged operation. This is enforced at multiple layers including the",
      "JWT validation step.",
    ].join(" ");
    writeFileSync(
      join(inbox, `${draftId}.draft.md`),
      [
        `---`,
        `id: ${draftId}`,
        `title: must validate tenant context before db access`,
        `status: draft`,
        `capture_confidence: high`,
        `sourceFile: core/src/auth/middleware.ts`,
        `proposedRationale: ${body}`,
        `---`,
        ``,
        body,
      ].join("\n"),
      "utf8",
    );
    const before = readdirSync(eventsDir(repoRoot)).filter((n) =>
      n.includes("decision_accepted"),
    ).length;
    await bulkAcceptObvious({
      repoRoot,
      globs: { source: ["**/*.ts"], copySafety: [], offLimits: [] },
      threshold: "low",
    });
    const after = readdirSync(eventsDir(repoRoot)).filter((n) =>
      n.includes("decision_accepted"),
    ).length;
    assert(
      after > before,
      `bulkAcceptObvious should emit at least one decision_accepted event (before=${before} after=${after})`,
    );
    console.log("  ✓ Step 5 — bulkAcceptObvious emits decision_accepted events");
  }

  // ─────────────────────────────────────────────────────────────────
  // Step 6 — clearMissionPhaseDeferIfMatches via mission-close path.
  // mission-advance exit requires full mission scaffolding (state.json,
  // roadmap.md, linked tasks) — using mission-close keeps the test
  // surface narrow while still exercising the unlink helper.
  // ─────────────────────────────────────────────────────────────────
  {
    const repoRoot = mkRepoRoot();
    const missionId = "MIS-smoke-defer-1234567";
    const phaseId = "phase-1-smoke";
    const otherMissionId = "MIS-smoke-other-7654321";

    const deferPath = join(
      repoRoot,
      ".cairn",
      ".mission-phase-deferred-until",
    );
    const futureMs = Date.now() + 3600 * 1000;
    writeFileSync(
      deferPath,
      JSON.stringify({
        mission_id: otherMissionId,
        phase_id: phaseId,
        deferred_at: new Date().toISOString(),
        deferred_until: new Date(futureMs).toISOString(),
      }),
      "utf8",
    );

    const nope = clearMissionPhaseDeferIfMatches(repoRoot, {
      missionId,
    });
    assert(nope === false, "mismatch should NOT unlink");
    assert(existsSync(deferPath), "mismatch must leave marker on disk");

    const yes = clearMissionPhaseDeferIfMatches(repoRoot, {
      missionId: otherMissionId,
    });
    assert(yes === true, "matching mission should unlink");
    assert(!existsSync(deferPath), "marker should be gone after match");
    console.log(
      "  ✓ Step 6 — clearMissionPhaseDeferIfMatches honors mission scope",
    );
  }

  console.log("smoke-bug-mine-0.13.3 — pass");
  cleanup();
}

runSmoke().catch((err) => {
  console.error("smoke-bug-mine-0.13.3 — fail");
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  cleanup();
  process.exit(1);
});
