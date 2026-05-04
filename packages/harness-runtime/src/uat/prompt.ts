/**
 * UAT-runner prompts.
 *
 * The UAT-runner picks the cheapest probe that can verify each acceptance
 * criterion. Operator policy: do NOT spin up Chrome to test an API call;
 * do NOT run a CLI to verify a database row.
 */

import type { UatRunnerInput } from "./types.js";

export const UAT_RUNNER_SYSTEM_PROMPT = [
  "You are the UAT-RUNNER subagent in a developer harness.",
  "",
  "Your job: read the tightened spec + acceptance criteria + diff and emit one acceptance-check per criterion. Each check selects ONE probe — the cheapest one that can mechanically verify that criterion.",
  "",
  "**Probe ladder — pick the FIRST kind that fits:**",
  "  1. `http`        — for any AC that asserts behavior of a network endpoint (status code, response body, JSON shape, headers). Never use `ui` for this.",
  "  2. `cli`         — for any AC that asserts CLI/process behavior (exit code, stdout, stderr).",
  "  3. `sql`         — for any AC that asserts database state (row exists, rowcount, column value). REQUIRES `hints.sql_available = true`. If unavailable, try to verify the same property via `http` against the API surface, OR set `ungenerable_reason`.",
  "  4. `ui`          — ONLY for ACs that genuinely require a browser (rendered text, click → navigation, visual layout). REQUIRES `hints.ui_available = true`.",
  "  5. `integration` — for ACs that require multi-service orchestration (docker compose). REQUIRES `hints.integration_available = true`.",
  "",
  "Picking a heavier probe than necessary is a defect. If you find yourself reaching for `ui` because you 'want to be thorough,' stop and pick `http`.",
  "",
  "**Probe shape rules:**",
  "  - Every probe has a stable `id` (e.g. `AC1`) and a one-line `description`.",
  "  - http: include exact `status` (or `status_in`); add `body_contains` / `json_path_equals` when the AC asserts response shape. Use `hints.base_url` as URL prefix when the AC doesn't include a full URL.",
  "  - cli: split `command` and `args` so we don't shell-escape; use `hints.cli_cwd` as cwd; prepend `hints.cli_prefix` ONLY when the AC actually invokes the project's CLI (e.g. `pnpm` workspace prefix).",
  "  - ui: minimal `steps`. Always include a `screenshot` step at the start (baseline) and at every assertion checkpoint. Use `wait_for_selector` before `click` on async UI.",
  "",
  "**Cold-start smoke:**",
  "  Set `cold_start_smoke = true` when the diff touches startup files (entrypoints, migrations, env loaders, build configs, docker-compose). The orchestrator runs the project's start command before probes. Default false.",
  "",
  "**Backend-only:**",
  "  Set `backend_only = true` when ZERO acceptance checks use `ui`. Lets the adapter render with markdown tables instead of GIFs.",
  "",
  "**High-stakes (when `is_high_stakes = true` in the input):**",
  "  Per Codex audit Q1 / L43: at least one acceptance check MUST be a cross-tenant negative fixture — a request from user/org B against user/org A's resource that returns the spec's denial response (404 / 403 / scoped-empty). Mark it with `is_high_stakes_required = true`.",
  "",
  "**Ungenerable cases:**",
  "  If you genuinely cannot pick a probe for an AC (e.g. AC requires manual visual judgment, or asserts behavior with no probe surface available), set `ungenerable_reason` and emit an `acceptance_checks` array with whatever you CAN verify. The orchestrator will surface ungenerable-reason to the operator and fall back to manual UAT.",
  "",
  "Return ONLY the JSON object. No prose, no markdown wrapper.",
].join("\n");

export function buildUatRunnerUserPrompt(input: UatRunnerInput): string {
  const parts: string[] = [];

  parts.push("# Tightened spec");
  parts.push("");
  parts.push(input.tightened_spec.trim());

  if (input.acceptance_criteria.length > 0) {
    parts.push("");
    parts.push("# Acceptance criteria");
    parts.push("");
    for (const a of input.acceptance_criteria) parts.push(`- ${a}`);
  }

  if (input.changed_files.length > 0) {
    parts.push("");
    parts.push("# Files changed");
    parts.push("");
    for (const f of input.changed_files) parts.push(`- ${f.path} (${f.status})`);
  }

  parts.push("");
  parts.push("# Available probe surfaces (hints)");
  parts.push("");
  parts.push(`- http:        ${input.hints.base_url ? `available; base_url=${input.hints.base_url}` : "available; base_url unset (specify full URL in each probe)"}`);
  parts.push(`- cli:         available${input.hints.cli_cwd ? `; cwd=${input.hints.cli_cwd}` : ""}${input.hints.cli_prefix ? `; prefix=${input.hints.cli_prefix}` : ""}`);
  parts.push(`- ui:          ${input.hints.ui_available ? "available (playwright installed)" : "UNAVAILABLE — DO NOT emit ui probes"}`);
  parts.push(`- sql:         ${input.hints.sql_available ? "available" : "UNAVAILABLE — DO NOT emit sql probes"}`);
  parts.push(`- integration: ${input.hints.integration_available ? "available (docker compose)" : "UNAVAILABLE — DO NOT emit integration probes"}`);

  if (input.is_high_stakes) {
    parts.push("");
    parts.push("# High-stakes augmentation (per Codex audit Q1 / L43)");
    parts.push("");
    parts.push(
      "This diff touches paths classified as high-stakes. You MUST emit at least one acceptance check that is a cross-tenant negative fixture. Mark it `is_high_stakes_required = true`. Acceptable shapes:",
    );
    parts.push("");
    parts.push(
      "  - http: a request signed/authed as user/org B against user/org A's resource, expecting 404 / 403 / scoped-empty.",
    );
    parts.push(
      "  - sql:  an INSERT or SELECT that proves user/org A's data is invisible to user/org B's query.",
    );
    parts.push(
      "If neither probe surface can express it, set `ungenerable_reason` so the operator knows manual cross-tenant verification is needed.",
    );
  }

  parts.push("");
  parts.push("---");
  parts.push("");
  parts.push("Emit one acceptance check per AC, picking the cheapest probe that fits. Return ONLY the JSON object.");
  return parts.join("\n");
}
