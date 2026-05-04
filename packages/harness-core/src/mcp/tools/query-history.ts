/**
 * harness_query_history — the only sanctioned read path into .archive/.
 *
 * Walks .archive/ matching path_hint + date window, runs a Tier-1 (Haiku)
 * summarizer over the matched files, returns structured per-claim
 * records with source citations and supersedes-tags. The agent never
 * sees raw stale content — only the summary.
 *
 * Per MCP_SURFACE.md §"harness_query_history". Implementation lives in
 * src/mcp/history/.
 */

import type { McpContext } from "../context.js";
import { mcpError } from "../errors.js";
import {
  isQuotaKind,
  ClaudeError,
  classifyClaudeError,
} from "../../claude/index.js";
import { runQueryHistory } from "../history/summarizer.js";
import { queryHistoryInput } from "../schemas.js";
import type { ToolDef } from "./types.js";

interface Input {
  scope: string;
  path_hint?: string;
  since?: string;
  until?: string;
}

async function handler(ctx: McpContext, input: Input): Promise<unknown> {
  try {
    const args: Parameters<typeof runQueryHistory>[0] = {
      repoRoot: ctx.repoRoot,
      scope: input.scope,
    };
    if (input.path_hint !== undefined) args.pathHint = input.path_hint;
    if (input.since !== undefined) args.since = input.since;
    if (input.until !== undefined) args.until = input.until;
    return await runQueryHistory(args);
  } catch (err) {
    if (err instanceof ClaudeError) {
      if (isQuotaKind(err.kind)) {
        return mcpError(
          "DAEMON_UNAVAILABLE",
          `history summarizer quota / rate-limit issue: ${err.message}`,
          { kind: err.kind, exit_code: err.exitCode ?? null },
        );
      }
      return mcpError(
        "OPERATION_TIMEOUT",
        `history summarizer call failed: ${err.message}`,
        { kind: err.kind, exit_code: err.exitCode ?? null },
      );
    }
    const kind = classifyClaudeError({
      message: err instanceof Error ? err.message : String(err),
      exitCode: null,
      stderr: "",
    });
    return mcpError(
      "OPERATION_TIMEOUT",
      `history summarizer threw: ${err instanceof Error ? err.message : String(err)}`,
      { kind },
    );
  }
}

export const queryHistoryTool: ToolDef<Input> = {
  name: "harness_query_history",
  description:
    "Returns summarized historical claims from .archive/ via Tier-1 LLM. Walks the archive by path_hint + since/until, summarizes per-claim with source citations and supersedes-tags. Raw archive content never enters agent context — only the structured summary does. The only sanctioned path into .archive/.",
  inputSchema: queryHistoryInput,
  handler,
};
