/**
 * UAT (Layer U) — Phase 11.
 *
 * UAT is multi-probe, not Playwright-only. The UAT-runner agent reads the
 * spec + acceptance criteria + diff and routes EACH acceptance criterion to
 * the cheapest probe that can verify it:
 *
 *   http         — bare fetch; "POST /foo returns 200", JSON shape match
 *   cli          — child_process; "command exits 0 with output X"
 *   ui           — playwright (lazy-loaded); "user clicks button → toast"
 *   sql          — pg/mysql client (deferred); "row in table X"
 *   integration  — docker compose (deferred); "service A talks to service B"
 *
 * Per UAT_PIPELINE.md §0–§4. The bundle + evidence-file gate is
 * probe-agnostic — same SHA256 manifest regardless of probe kind.
 */

import type { ClaudeTier } from "../claude/index.js";

// ──────────────────────────────────────────────────────────────────────────
// Probe types — discriminated by `kind`.
// ──────────────────────────────────────────────────────────────────────────

export type ProbeKind = "http" | "cli" | "ui" | "sql" | "integration";

export interface HttpExpectation {
  /** Exact status code that must be returned. */
  status?: number;
  /** Status code must be one of these. */
  status_in?: number[];
  /** Each substring must appear in the response body. */
  body_contains?: string[];
  /** Body must match this ECMAScript regex. */
  body_matches_regex?: string;
  /** JSON-path → expected JSON-stringifiable equality checks. Path is
   *  dot/bracket-style: `data.users[0].id`. */
  json_path_equals?: { path: string; value: unknown }[];
  /** Response must include this header (case-insensitive). */
  header_present?: string[];
}

export interface HttpProbe {
  kind: "http";
  id: string;
  description: string;
  request: {
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    url: string;
    headers?: Record<string, string>;
    body?: string;
  };
  expect: HttpExpectation;
  /** Hard timeout in ms. Default 30_000. */
  timeout_ms?: number;
}

export interface CliExpectation {
  exit_code?: number;
  stdout_contains?: string[];
  stdout_matches_regex?: string;
  stderr_empty?: boolean;
  stderr_contains?: string[];
}

export interface CliProbe {
  kind: "cli";
  id: string;
  description: string;
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  expect: CliExpectation;
  timeout_ms?: number;
}

export interface UiStep {
  action: "goto" | "click" | "fill" | "screenshot" | "wait_for_selector" | "wait_for_text";
  selector?: string;
  value?: string;
  path?: string;
  text?: string;
  timeout_ms?: number;
}

export interface UiExpectation {
  text_present?: string[];
  selector_visible?: string[];
}

export interface UiProbe {
  kind: "ui";
  id: string;
  description: string;
  url: string;
  steps: UiStep[];
  expect: UiExpectation;
  timeout_ms?: number;
}

export interface SqlProbe {
  kind: "sql";
  id: string;
  description: string;
  /** Connection key — looked up in project config; never literal credentials. */
  connection: string;
  query: string;
  expect: {
    rowcount?: number;
    rowcount_min?: number;
    rowcount_max?: number;
    first_row_includes?: Record<string, unknown>;
  };
}

export interface IntegrationProbe {
  kind: "integration";
  id: string;
  description: string;
  compose_file: string;
  service: string;
  ready_check:
    | { kind: "http"; url: string; status?: number; timeout_ms?: number }
    | { kind: "cli"; command: string; args: string[]; timeout_ms?: number };
  test: HttpProbe | CliProbe;
}

export type UatProbe = HttpProbe | CliProbe | UiProbe | SqlProbe | IntegrationProbe;

// ──────────────────────────────────────────────────────────────────────────
// Acceptance check + runner I/O.
// ──────────────────────────────────────────────────────────────────────────

export interface UatAcceptanceCheck {
  /** Stable id per acceptance criterion. */
  id: string;
  /** Verbatim acceptance criterion text the operator/spec specified. */
  text: string;
  /** Probe selected by the UAT-runner to verify this AC. */
  probe: UatProbe;
  /** Hint for cross-tenant fixture inclusion (high-stakes only, per L43). */
  is_high_stakes_required?: boolean;
}

export interface UatRunnerInput {
  /** Tightened spec body the implementer was given. */
  tightened_spec: string;
  /** Acceptance criteria the spec demands. */
  acceptance_criteria: string[];
  /** Files changed in this run (paths only — content is not needed for AC selection). */
  changed_files: { path: string; status: string }[];
  /** Project-level UAT hints — e.g. base URL, seed-DB command, auth token env var. */
  hints: {
    /** Base URL for http probes when the AC doesn't specify a full URL. */
    base_url?: string;
    /** CLI prefix (e.g. `pnpm --filter core`). */
    cli_prefix?: string;
    /** Project workdir for cli probes. */
    cli_cwd?: string;
    /** Whether ui probes are available (operator opted into playwright at adoption). */
    ui_available?: boolean;
    /** Whether sql probes are available. */
    sql_available?: boolean;
    /** Whether integration probes (docker compose) are available. */
    integration_available?: boolean;
  };
  /** True when the diff touches high-stakes globs — agent must add a cross-tenant fixture (Codex audit Q1 / L43). */
  is_high_stakes: boolean;
  /** Tier — Tier 2 default. */
  tier: ClaudeTier;
  /** Per-call timeout. Default 300_000 ms. */
  timeout_ms?: number;
}

export interface UatRunnerOutput {
  /** One probe per acceptance criterion. */
  acceptance_checks: UatAcceptanceCheck[];
  /** True when the diff touches startup files; orchestrator inserts the smoke step before probes (UAT_PIPELINE §3.3). */
  cold_start_smoke: boolean;
  /** True when the change is backend-only (no UI surface) — informs adapter rendering. */
  backend_only: boolean;
  /** Set when the UAT-runner can't generate any check (e.g. no testable surface). */
  ungenerable_reason?: string;
}

// ──────────────────────────────────────────────────────────────────────────
// Probe execution result + bundle.
// ──────────────────────────────────────────────────────────────────────────

export interface ProbeRunResult {
  probe_id: string;
  probe_kind: ProbeKind;
  passed: boolean;
  /** Short evidence pointer — file path or inline snippet. */
  evidence: string;
  duration_ms: number;
  /** Inline diagnostic for the operator when passed=false. */
  failure_reason?: string;
  /** Artifact files produced (relative to the run's UAT directory). */
  artifacts?: string[];
  /** Whether the probe was skipped (probe kind not yet supported / not configured). */
  skipped_reason?: string;
}

export interface UatBundleArtifact {
  kind: "screenshot" | "transcript" | "video" | "log" | "summary" | "evidence" | "cross-tenant-fixture";
  path: string;
  caption?: string;
}

export interface UatSummary {
  run_id: string;
  task_id: string;
  goal_one_liner: string;
  diff_stats: { files_changed: number; lines_added: number; lines_removed: number };
  acceptance_results: {
    id: string;
    text: string;
    probe_kind: ProbeKind;
    status: "pass" | "fail" | "pending" | "skipped";
    evidence?: string;
    failure_reason?: string;
    is_high_stakes_required?: boolean;
  }[];
  cold_start_smoke?: { status: "pass" | "fail" | "skipped"; evidence?: string };
  artifacts: UatBundleArtifact[];
  sensors_passed: string[];
  reviewer_subagent_verdict: "pass" | "fail" | "skipped";
  operator_decision_required: boolean;
  operator_options: { id: string; label: string }[];
  /** All ACs pass + no skipped + cold-start ok if applicable. */
  all_passed: boolean;
}

export interface UatRunResult {
  /** Final summary object the bundle is built from. */
  summary: UatSummary;
  /** Per-probe execution results. */
  probe_results: ProbeRunResult[];
  /** Generated UAT-runner output (the source of truth for which probes ran). */
  runner_output: UatRunnerOutput;
  /** Evidence-file SHA256 manifest path (relative to repoRoot). */
  evidence_file_path: string;
  /** Aggregate ok = all_passed AND evidence file written + verifies. */
  ok: boolean;
  /** Operator's final decision; populated by the adapter approval step. */
  operator_decision?: "approve" | "reject" | "ask" | "abandoned";
  /** Operator-provided rejection details when decision = reject. */
  rejection?: UatRejection;
  duration_ms: number;
}

// ──────────────────────────────────────────────────────────────────────────
// Operator decision + rejection envelope.
// ──────────────────────────────────────────────────────────────────────────

export type UatDecision = "approve" | "reject" | "ask" | "abandoned" | "pending";

export interface UatRejection {
  /** A/B/C/D rejection category per UAT_PIPELINE §6. */
  category: "A" | "B" | "C" | "D";
  /** Free-text note from the operator (typed or transcribed from voice). */
  operator_note: string;
  /** Whisper transcript of voice rejection if applicable. */
  voice_transcript?: string;
  /** Screenshots the operator referenced in their note. */
  referenced_screenshots?: string[];
  rejected_at: string;
}

// ──────────────────────────────────────────────────────────────────────────
// Evidence file format — written under <uat_dir>/.uat-passed.
// ──────────────────────────────────────────────────────────────────────────

export interface EvidenceFileEntry {
  path: string;
  sha256: string;
}

export interface EvidenceFile {
  run_id: string;
  generated_at: string;
  bundle_sha256: string;
  files: EvidenceFileEntry[];
  /** When operator approval is recorded; gate requires approve. */
  operator_decision?: UatDecision;
}
