/**
 * JSON Schema enforced by `claude --json-schema` for the UAT-runner output.
 * Mirrors `UatRunnerOutput` exactly. Keep in sync with types.ts.
 */

const HTTP_PROBE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    kind: { const: "http" },
    id: { type: "string" },
    description: { type: "string" },
    request: {
      type: "object",
      additionalProperties: false,
      properties: {
        method: { enum: ["GET", "POST", "PUT", "PATCH", "DELETE"] },
        url: { type: "string" },
        headers: {
          type: "object",
          additionalProperties: { type: "string" },
        },
        body: { type: "string" },
      },
      required: ["method", "url"],
    },
    expect: {
      type: "object",
      additionalProperties: false,
      properties: {
        status: { type: "integer" },
        status_in: { type: "array", items: { type: "integer" } },
        body_contains: { type: "array", items: { type: "string" } },
        body_matches_regex: { type: "string" },
        json_path_equals: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              path: { type: "string" },
              value: {},
            },
            required: ["path", "value"],
          },
        },
        header_present: { type: "array", items: { type: "string" } },
      },
    },
    timeout_ms: { type: "integer" },
  },
  required: ["kind", "id", "description", "request", "expect"],
} as const;

const CLI_PROBE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    kind: { const: "cli" },
    id: { type: "string" },
    description: { type: "string" },
    command: { type: "string" },
    args: { type: "array", items: { type: "string" } },
    cwd: { type: "string" },
    env: { type: "object", additionalProperties: { type: "string" } },
    expect: {
      type: "object",
      additionalProperties: false,
      properties: {
        exit_code: { type: "integer" },
        stdout_contains: { type: "array", items: { type: "string" } },
        stdout_matches_regex: { type: "string" },
        stderr_empty: { type: "boolean" },
        stderr_contains: { type: "array", items: { type: "string" } },
      },
    },
    timeout_ms: { type: "integer" },
  },
  required: ["kind", "id", "description", "command", "args", "expect"],
} as const;

const UI_PROBE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    kind: { const: "ui" },
    id: { type: "string" },
    description: { type: "string" },
    url: { type: "string" },
    steps: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          action: {
            enum: ["goto", "click", "fill", "screenshot", "wait_for_selector", "wait_for_text"],
          },
          selector: { type: "string" },
          value: { type: "string" },
          path: { type: "string" },
          text: { type: "string" },
          timeout_ms: { type: "integer" },
        },
        required: ["action"],
      },
    },
    expect: {
      type: "object",
      additionalProperties: false,
      properties: {
        text_present: { type: "array", items: { type: "string" } },
        selector_visible: { type: "array", items: { type: "string" } },
      },
    },
    timeout_ms: { type: "integer" },
  },
  required: ["kind", "id", "description", "url", "steps", "expect"],
} as const;

const SQL_PROBE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    kind: { const: "sql" },
    id: { type: "string" },
    description: { type: "string" },
    connection: { type: "string" },
    query: { type: "string" },
    expect: {
      type: "object",
      additionalProperties: false,
      properties: {
        rowcount: { type: "integer" },
        rowcount_min: { type: "integer" },
        rowcount_max: { type: "integer" },
        first_row_includes: { type: "object" },
      },
    },
  },
  required: ["kind", "id", "description", "connection", "query", "expect"],
} as const;

// Integration probes nest a sub-probe; we keep the schema lenient (test: object)
// because nested oneOf in JSON-Schema is heavy and the runtime parser will
// validate by `kind`.
const INTEGRATION_PROBE_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    kind: { const: "integration" },
    id: { type: "string" },
    description: { type: "string" },
    compose_file: { type: "string" },
    service: { type: "string" },
    ready_check: { type: "object" },
    test: { type: "object" },
  },
  required: ["kind", "id", "description", "compose_file", "service", "ready_check", "test"],
} as const;

const PROBE_SCHEMA = {
  oneOf: [
    HTTP_PROBE_SCHEMA,
    CLI_PROBE_SCHEMA,
    UI_PROBE_SCHEMA,
    SQL_PROBE_SCHEMA,
    INTEGRATION_PROBE_SCHEMA,
  ],
} as const;

export const UAT_RUNNER_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    acceptance_checks: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          id: { type: "string" },
          text: { type: "string" },
          probe: PROBE_SCHEMA,
          is_high_stakes_required: { type: "boolean" },
        },
        required: ["id", "text", "probe"],
      },
    },
    cold_start_smoke: { type: "boolean" },
    backend_only: { type: "boolean" },
    ungenerable_reason: { type: "string" },
  },
  required: ["acceptance_checks", "cold_start_smoke", "backend_only"],
} as const;
