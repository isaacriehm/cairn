/**
 * JSON Schema enforced by `claude --json-schema` for the reviewer output.
 * Mirrors `ReviewerOutput` exactly. Keep in sync with types.ts.
 */
export const REVIEWER_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    verdict: { enum: ["pass", "fail"] },
    gaps: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          category: {
            enum: [
              "deferred_but_claimed_done",
              "missing_acceptance_criterion",
              "scope_leak",
              "query_scope_omission",
              "decision_contradiction",
              "unhandled_error",
              "fake_thoroughness",
              "documentation_drift",
              "security_concern",
              "other",
            ],
          },
          description: { type: "string" },
          path: { type: "string" },
          symbol: { type: "string" },
          severity: { enum: ["hard", "soft"] },
        },
        required: ["category", "description", "severity"],
      },
    },
    confidence_signal: { enum: ["high", "medium", "low"] },
    summary: { type: "string" },
  },
  required: ["verdict", "gaps", "confidence_signal", "summary"],
} as const;
