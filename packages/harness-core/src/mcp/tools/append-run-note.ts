/**
 * `harness_append_run_note` — append a phase-tagged note to a task's notes.md.
 *
 * The handoff builder (CONTEXT_CONTINUITY_SPEC §2.2) reads notes.md when it
 * resumes an in-flight run, so notes survive context compaction by virtue of
 * being committed to disk. The MCP write surface is append-only and gated
 * by the path allowlist — see `mcp/path-allowlist.ts`.
 *
 * Spec: docs/CONTEXT_CONTINUITY_SPEC.md §2.3.
 */

import { appendFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import type { McpContext } from "../context.js";
import { mcpError } from "../errors.js";
import { isAppendAllowed, relPosix, safeJoin } from "../path-allowlist.js";
import { appendRunNoteInput } from "../schemas.js";
import type { ToolDef } from "./types.js";

interface Input {
  run_id: string;
  phase: string;
  note: string;
}

const RUN_ID_RE = /^[A-Za-z0-9_-]+$/;

async function handler(ctx: McpContext, input: Input): Promise<unknown> {
  if (!RUN_ID_RE.test(input.run_id) || input.run_id.length > 80) {
    return mcpError(
      "VALIDATION_FAILED",
      `run_id must match path-safe pattern [A-Za-z0-9_-] (≤80 chars)`,
    );
  }

  const rel = `.harness/tasks/active/${input.run_id}/notes.md`;
  const abs = safeJoin(ctx.repoRoot, rel);
  if (typeof abs !== "string") return abs; // error envelope

  const relCanon = relPosix(ctx.repoRoot, abs);
  if (!isAppendAllowed(relCanon)) {
    return mcpError(
      "PATH_NOT_ALLOWED",
      `Append-write is not allowed for "${relCanon}".`,
    );
  }

  const taskDir = join(ctx.repoRoot, ".harness", "tasks", "active", input.run_id);
  if (!existsSync(taskDir)) {
    return mcpError(
      "RUN_NOT_FOUND",
      `No active task dir at .harness/tasks/active/${input.run_id}/`,
    );
  }

  const entry = `\n## ${new Date().toISOString()} [${input.phase}]\n${input.note}\n`;
  appendFileSync(abs, entry, "utf8");
  return {
    ok: true,
    path: relCanon,
    bytes_written: Buffer.byteLength(entry, "utf8"),
  };
}

export const appendRunNoteTool: ToolDef<Input> = {
  name: "harness_append_run_note",
  description:
    "Append a phase-tagged note to .harness/tasks/active/<run_id>/notes.md. The handoff builder reads notes.md so notes survive across sessions / context compaction. The run_id field must match the active task dir id (path-safe chars only).",
  inputSchema: appendRunNoteInput,
  handler,
};
