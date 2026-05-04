/**
 * JSON Schema enforced by `claude --json-schema` for the history
 * summarizer Tier-1 call.
 *
 * Per MCP_SURFACE.md §"harness_query_history": every claim MUST carry
 * source_path, source_lines, as_of, and a supersedes-tag (string DEC-id
 * or null). The harness post-resolves currently_canonical_pointer from
 * the decisions ledger after the LLM returns — keeps the LLM's
 * responsibilities tight (cite + summarize) and makes the canonical
 * cross-reference mechanical.
 */
export const HISTORY_SUMMARIZER_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    claims: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          claim: { type: "string", minLength: 1 },
          as_of: { type: "string", minLength: 1 },
          source_path: { type: "string", minLength: 1 },
          source_lines: { type: "string", minLength: 1 },
          superseded_by: {
            anyOf: [
              { type: "string", pattern: "^DEC-\\d{4,}$" },
              { type: "null" },
            ],
          },
        },
        required: ["claim", "as_of", "source_path", "source_lines"],
      },
    },
    summary_caveat: { type: "string" },
    no_relevant_history: { type: "boolean" },
  },
  required: ["claims"],
} as const;
