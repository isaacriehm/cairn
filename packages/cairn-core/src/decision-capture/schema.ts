/**
 * JSON Schema enforced by `claude --json-schema` for the decision-extractor
 * output. Mirrors `DecisionExtractorOutput` exactly.
 *
 * Assertion kinds match the production set in `src/ground/schemas.ts`. The
 * extractor's `parameters` is a free-form object; the harness materializes
 * the assertion into the draft as-is and lets sensors validate at evaluation
 * time. Rejecting at extract time would block the operator's intent over
 * a malformed parameter the agent might still get right on the next pass.
 */
export const DECISION_EXTRACTOR_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    subject: { type: "string", minLength: 1 },
    summary: { type: "string", minLength: 1 },
    scope_globs: {
      type: "array",
      items: { type: "string" },
    },
    supersedes: {
      anyOf: [
        { type: "string", pattern: "^DEC-\\d{4,}$" },
        { type: "null" },
      ],
    },
    candidate_assertions: {
      type: "array",
      maxItems: 3,
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          kind: {
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
          description: { type: "string", minLength: 1 },
          parameters: {
            type: "object",
            additionalProperties: true,
          },
        },
        required: ["kind", "description"],
      },
    },
    confidence_signal: { enum: ["high", "medium", "low"] },
    not_a_decision: { type: "boolean" },
  },
  required: [
    "subject",
    "summary",
    "scope_globs",
    "candidate_assertions",
    "confidence_signal",
    "not_a_decision",
  ],
} as const;
