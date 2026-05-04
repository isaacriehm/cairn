/**
 * Daemon-driven checkpoint writer — emits a snapshot of the same handoff
 * block content to `.harness/tasks/active/<taskId>/checkpoint-<ISO>.md`.
 *
 * Spec: docs/CONTEXT_CONTINUITY_SPEC.md §2.2.
 *
 * Throws if the task directory is missing — daemons should fail loudly when
 * pointed at a stale taskId. Successful writes return the absolute path.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildHandoffBlock } from "./handoff-builder.js";

export async function writeCheckpoint(
  repoRoot: string,
  taskId: string,
  _runId: string,
): Promise<string> {
  const taskDir = join(repoRoot, ".harness", "tasks", "active", taskId);
  if (!existsSync(taskDir)) {
    throw new Error(`writeCheckpoint: task directory not found: ${taskDir}`);
  }

  const block = await buildHandoffBlock(repoRoot);
  const content = block === null ? "(no active run handoff to capture)\n" : block;

  // Ensure dir exists (defensive — `existsSync` above guarantees parent, but
  // mkdir recursive is cheap and safe).
  mkdirSync(taskDir, { recursive: true });

  const stamp = new Date().toISOString().replace(/:/g, "-");
  const filename = `checkpoint-${stamp}.md`;
  const abs = join(taskDir, filename);
  writeFileSync(abs, content, "utf8");
  return abs;
}
