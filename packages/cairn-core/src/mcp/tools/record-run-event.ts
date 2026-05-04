import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { McpContext } from "../context.js";
import { requireBootstrap } from "../bootstrap-guard.js";
import { mcpError } from "../errors.js";
import { recordRunEventInput } from "../schemas.js";
import type { ToolDef } from "./types.js";

interface Input {
  run_id: string;
  event: { kind: string; payload?: unknown };
}

async function handler(ctx: McpContext, input: Input): Promise<unknown> {
  const block = requireBootstrap(ctx.repoRoot);
  if (block !== null) return block;
  const runDir = join(ctx.repoRoot, ".harness", "runs", "active", input.run_id);
  if (!existsSync(runDir)) {
    return mcpError("RUN_NOT_FOUND", `No active run dir at ${runDir}`);
  }
  const path = join(runDir, "events.jsonl");
  // Server-fills ts. Seq is omitted in this naive implementation; the orchestrator
  // re-numbers in the post-run pass when it materializes the canonical event log.
  const row = {
    ts: new Date().toISOString(),
    kind: input.event.kind,
    ...(input.event.payload !== undefined ? { payload: input.event.payload } : {}),
  };
  mkdirSync(runDir, { recursive: true });
  appendFileSync(path, `${JSON.stringify(row)}\n`, "utf8");
  return { ok: true, run_id: input.run_id, kind: input.event.kind };
}

export const recordRunEventTool: ToolDef<Input> = {
  name: "harness_record_run_event",
  description:
    "Append a structured event to .harness/runs/active/<run_id>/events.jsonl. Server fills `ts`; sequence is renumbered in post-run materialization.",
  inputSchema: recordRunEventInput,
  handler,
};
