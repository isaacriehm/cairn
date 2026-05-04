/**
 * JSON Schema enforced by `claude --json-schema` for the assertion-refiner
 * proposer output.
 *
 * For each input candidate the proposer returns one `RefinementProposal`.
 * The shape here is intentionally loose on `strict_assertion` — the
 * production `DecisionAssertion` zod (see `src/ground/schemas.ts`) is the
 * source of truth and re-validates at apply time. Forcing the discriminated
 * union into JSON Schema and the proposer's prompt would burn tokens
 * without buying additional safety, since malformed shapes auto-demote.
 *
 * The proposer's per-kind contract is encoded in the system prompt
 * (`refinement-prompt.ts`), not here.
 */
export const REFINEMENT_PROPOSER_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    proposals: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          candidate_id: { type: "string", minLength: 1 },
          candidate_kind: {
            enum: [
              "schema_must_contain",
              "text_must_match",
              "text_must_not_match",
              "index_must_exist",
              "ast_pattern",
              "file_must_not_be_modified",
              "query_must_filter_by",
              "route_must_have_guard",
              "event_must_emit",
              "service_method_must_call",
              "human_review_hint",
            ],
          },
          status: { enum: ["lift", "demote", "skip"] },
          confidence_signal: { enum: ["high", "medium", "low"] },
          strict_assertion: {
            type: "object",
            additionalProperties: true,
          },
          rationale: { type: "string", minLength: 1 },
        },
        required: [
          "candidate_id",
          "candidate_kind",
          "status",
          "confidence_signal",
          "rationale",
        ],
      },
    },
  },
  required: ["proposals"],
} as const;
