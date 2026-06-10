import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { appendTrace } from "../trace/index.js";
import type { McpContext } from "./context.js";
import { cairnDir } from "@isaacriehm/cairn-state";

/**
 * Writes one row per tool call to:
 *   - .cairn/runs/active/<runId>/mcp-calls.jsonl     when ctx.runId set
 *   - .cairn/staleness/mcp-calls.jsonl               otherwise
 *
 * Also mirrors a compact row into the unified `~/.cairn/trace/`
 * sink so `cairn trace` aggregates MCP calls alongside hook + claude
 * subprocess events.
 */
interface TelemetryRow {
  ts: string;
  tool: string;
  args: unknown;
  result_kind: "ok" | "error";
  result_size: number;
  duration_ms: number;
  /** First ~400 chars of the result text — populated for errors so trace shows the message body. */
  result_preview?: string;
}

export function recordCall(ctx: McpContext, row: TelemetryRow): void {
  const path =
    ctx.runId !== undefined
      ? cairnDir(ctx.repoRoot, "runs", "active", ctx.runId, "mcp-calls.jsonl")
      : cairnDir(ctx.repoRoot, "staleness", "mcp-calls.jsonl");
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  appendFileSync(path, `${JSON.stringify(row)}\n`, "utf8");

  appendTrace({
    ts: row.ts,
    source: "mcp",
    kind: row.tool,
    repo_root: ctx.repoRoot,
    session_id: null,
    duration_ms: row.duration_ms,
    ok: row.result_kind === "ok",
    payload: {
      args: row.args,
      result_size: row.result_size,
      ...(row.result_preview !== undefined ? { result_preview: row.result_preview } : {}),
      ...(ctx.runId !== undefined ? { run_id: ctx.runId } : {}),
    },
  });
}
