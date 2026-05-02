/**
 * JSON Schema enforced by `claude --json-schema` for the tightener output.
 * Mirrors `TightenerOutput` exactly. Keep in sync.
 */
export const TIGHTENER_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    ambiguities: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          question: { type: "string" },
          candidate_resolutions: {
            type: "array",
            items: { type: "string" },
          },
        },
        required: ["id", "question", "candidate_resolutions"],
      },
    },
    conflicts: { type: "array", items: { type: "string" } },
    missing_acceptance: { type: "array", items: { type: "string" } },
    scope_concerns: { type: "array", items: { type: "string" } },
    existing_stub_overlap: { type: "array", items: { type: "string" } },
    spec_quality_score: { type: "integer", minimum: 0, maximum: 10 },
    ready_to_execute: { type: "boolean" },
    tightened_spec_proposal: { type: "string" },
  },
  required: [
    "ambiguities",
    "conflicts",
    "missing_acceptance",
    "scope_concerns",
    "existing_stub_overlap",
    "spec_quality_score",
    "ready_to_execute",
    "tightened_spec_proposal",
  ],
} as const;
