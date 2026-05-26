#!/usr/bin/env tsx
/**
 * smoke-bug-mine-0.13.5 — verifies the Phase-2 self-attest flow.
 *
 * Spec: docs/bug-mine-r3/PHASES.md Phase 2.
 *
 * Sequence:
 *   1. Bootstrap a temp repo and call `cairn_task_create` (no needs_review
 *      field — the schema no longer accepts one).
 *   2. Assert the written spec frontmatter does NOT contain `needs_review`.
 *   3. Call `cairn_task_complete({outcome: "succeeded", summary})` with no
 *      attestation.yaml on disk and no subagent attestations.
 *   4. Assert the task directory moved to `.cairn/tasks/done/<task_id>/`,
 *      status.yaml has phase=succeeded + outcome_summary, and no
 *      attestation.yaml exists in the done dir.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  allTools,
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
  const dir = mkdtempSync(join(tmpdir(), "cairn-smoke-bugmine-0135-"));
  cleanups.push(dir);
  mkdirSync(join(dir, ".cairn", "ground", "decisions"), { recursive: true });
  mkdirSync(join(dir, ".cairn", "ground", "invariants"), { recursive: true });
  mkdirSync(join(dir, ".cairn", "tasks", "active"), { recursive: true });
  mkdirSync(join(dir, ".cairn", "tasks", "done"), { recursive: true });
  mkdirSync(join(dir, ".cairn", "events"), { recursive: true });
  mkdirSync(join(dir, ".cairn", "config"), { recursive: true });
  writeFileSync(
    join(dir, ".cairn", "manifest.yaml"),
    "cairn_version: 0.13.5\nbootstrap_complete: true\n",
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

async function runSmoke(): Promise<void> {
  console.log("smoke-bug-mine-0.13.5 — start");

  // Step 1 — task_create writes spec without needs_review
  const repoRoot = mkRepoRoot();
  const ctx: McpContext = { repoRoot, sessionId: "smoke-self-attest" };
  const createTool = getTool("cairn_task_create");
  const created = await call(createTool, ctx, {
    slug: "phase-2-self-attest",
    title: "Self-attest smoke",
    goal: "Verify task_create + task_complete close the loop with no reviewer.",
    mission_id: "",
  });
  assert(
    typeof created["task_id"] === "string",
    `Step 1 — task_create should return task_id; got ${JSON.stringify(created)}`,
  );
  const taskId = created["task_id"] as string;
  const activeDir = join(repoRoot, ".cairn", "tasks", "active", taskId);
  assert(existsSync(activeDir), `Step 1 — active dir not created at ${activeDir}`);
  const specBody = readFileSync(join(activeDir, "spec.tightened.md"), "utf8");
  assert(
    !/^needs_review\s*:/m.test(specBody),
    "Step 1 — spec frontmatter should NOT contain needs_review after Phase 2",
  );
  console.log("  ✓ Step 1 — task_create writes spec without needs_review");

  // Step 2 — task_create silently drops a legacy needs_review input
  //         (Zod strips unknown keys; the field is no longer wired).
  const createdLegacy = await call(createTool, ctx, {
    slug: "phase-2-legacy-input",
    title: "Legacy needs_review input",
    goal: "Phase 2 strips needs_review even when the caller still sends it.",
    needs_review: true,
    mission_id: "",
  });
  assert(
    typeof createdLegacy["task_id"] === "string",
    `Step 2 — task_create with legacy needs_review should still succeed; got ${JSON.stringify(createdLegacy)}`,
  );
  const legacyTaskId = createdLegacy["task_id"] as string;
  const legacySpec = readFileSync(
    join(repoRoot, ".cairn", "tasks", "active", legacyTaskId, "spec.tightened.md"),
    "utf8",
  );
  assert(
    !/^needs_review\s*:/m.test(legacySpec),
    "Step 2 — legacy needs_review input should be stripped from the spec",
  );
  console.log("  ✓ Step 2 — task_create strips legacy needs_review input");

  // Step 3 — task_complete with summary moves to done/ with no attestation
  const completeTool = getTool("cairn_task_complete");
  const completed = await call(completeTool, ctx, {
    task_id: taskId,
    outcome: "succeeded",
    summary:
      "Phase 2 self-attest happy path — Smoke writes its own narrative " +
      "summary; no subagent dispatch, no attestation.yaml on disk.",
  });
  assert(
    completed["ok"] === true,
    `Step 3 — task_complete should succeed; got ${JSON.stringify(completed)}`,
  );
  const doneDir = join(repoRoot, ".cairn", "tasks", "done", taskId);
  assert(existsSync(doneDir), `Step 3 — task dir not at ${doneDir}`);
  assert(
    !existsSync(activeDir),
    `Step 3 — active dir still present at ${activeDir}`,
  );
  assert(
    !existsSync(join(doneDir, "attestation.yaml")),
    "Step 3 — attestation.yaml should NOT exist on disk (summary IS the attestation)",
  );
  const statusBody = readFileSync(join(doneDir, "status.yaml"), "utf8");
  assert(
    /^phase:\s*succeeded/m.test(statusBody),
    `Step 3 — status.yaml phase should be succeeded; got ${statusBody}`,
  );
  assert(
    /outcome_summary:/m.test(statusBody),
    `Step 3 — status.yaml should carry outcome_summary; got ${statusBody}`,
  );
  console.log("  ✓ Step 3 — task_complete graduates without attestation.yaml");

  cleanup();
  console.log("smoke-bug-mine-0.13.5 — pass");
}

runSmoke().catch((err: unknown) => {
  console.error("smoke-bug-mine-0.13.5 — fail");
  console.error(err);
  cleanup();
  process.exit(1);
});
