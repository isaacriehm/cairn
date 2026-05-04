import type { McpContext } from "../context.js";
import { mcpError } from "../errors.js";
import { queryHistoryInput } from "../schemas.js";
import type { ToolDef } from "./types.js";

interface Input {
  scope: string;
  path_hint?: string;
  since?: string;
  until?: string;
}

/**
 * NOT IMPLEMENTED. Phase 4 baseline placeholder.
 *
 * Per MCP_SURFACE.md §"harness_query_history", the real implementation must:
 *   1. Walk .archive/** matching path_hint and date window.
 *   2. Run a Tier-1 LLM summarization over the matched files.
 *   3. Return per-claim records carrying source_path, source_lines, as_of,
 *      superseded_by, currently_canonical_pointer, and the summary_caveat.
 *
 * The LLM call requires the harness's frontend-adapter / model-registry
 * scaffolding, which lands in Phase 5+. Until then this tool returns a
 * structured NOT_IMPLEMENTED error envelope so callers don't accidentally
 * consume a malformed payload.
 *
 * Returning an error from this tool is safer than returning raw archive
 * content — the entire point of the surface is to keep raw stale content
 * out of agent context windows.
 */
async function handler(_ctx: McpContext, input: Input): Promise<unknown> {
  return mcpError(
    "NOT_IMPLEMENTED",
    "harness_query_history awaits Tier-1 LLM integration (Phase 5+). Until then, all archive reads are denied; callers must wait or use harness_decision_get / harness_canonical_for_topic for current-canonical-only access.",
    {
      requested_scope: input.scope,
      ...(input.path_hint !== undefined ? { requested_path_hint: input.path_hint } : {}),
    },
  );
}

export const queryHistoryTool: ToolDef<Input> = {
  name: "harness_query_history",
  description:
    "Summarized historical claims from .archive/ via Tier-1 LLM. Currently NOT_IMPLEMENTED — awaits Phase 5 model integration.",
  inputSchema: queryHistoryInput,
  handler,
};
