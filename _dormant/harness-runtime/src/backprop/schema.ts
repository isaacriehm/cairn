/**
 * JSON Schema enforced by `claude --json-schema` for the backprop output.
 * Mirrors `BackpropOutput` exactly. Keep in sync with types.ts.
 */
export const BACKPROP_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    slug: {
      type: "string",
      pattern: "^[a-z0-9][a-z0-9-]{0,29}$",
    },
    title: { type: "string", minLength: 1 },
    body_markdown: { type: "string", minLength: 1 },
    source_decision_ids: {
      type: "array",
      items: { type: "string" },
    },
    introduced_for_bug: { type: "string", minLength: 1 },
    enforcement: {
      type: "object",
      additionalProperties: false,
      properties: {
        kind: { enum: ["regex_sensor", "named_e2e"] },
        regex: { type: "string" },
        target_globs: {
          type: "array",
          items: { type: "string" },
        },
        language: {
          enum: [
            "typescript",
            "javascript",
            "python",
            "ruby",
            "go",
            "rust",
            "sql",
          ],
        },
        failure_message: { type: "string" },
        e2e_path: { type: "string" },
      },
      required: ["kind"],
    },
  },
  required: [
    "slug",
    "title",
    "body_markdown",
    "introduced_for_bug",
    "enforcement",
  ],
} as const;
