import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import type { McpContext } from "./context.js";

/**
 * Writes one row per tool call to:
 *   - .harness/runs/active/<runId>/mcp-calls.jsonl     when ctx.runId set
 *   - .harness/staleness/mcp-calls.jsonl               otherwise
 */
export interface TelemetryRow {
  ts: string;
  tool: string;
  args: unknown;
  result_kind: "ok" | "error";
  result_size: number;
  duration_ms: number;
}

export function recordCall(ctx: McpContext, row: TelemetryRow): void {
  const path =
    ctx.runId !== undefined
      ? join(ctx.repoRoot, ".harness", "runs", "active", ctx.runId, "mcp-calls.jsonl")
      : join(ctx.repoRoot, ".harness", "staleness", "mcp-calls.jsonl");
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  appendFileSync(path, `${JSON.stringify(row)}\n`, "utf8");
}
