/**
 * Sensor types — Phase 9 honest-agent invariants stack.
 *
 * Sensors run after the implementer agent finishes. Each sensor reads a
 * `SensorInput` (diff + attestation + decisions + project block) and emits
 * `SensorFinding[]`. The orchestrator collects every sensor's `SensorResult`,
 * builds a remediation prompt from any findings, and either passes the run
 * through or feeds the prompt back to the agent for retry.
 *
 * Per PRIMER §10. Per OpenAI's pattern: failure messages are remediation
 * prompts the agent consumes on retry.
 */

import type { DecisionFrontmatter } from "../ground/schemas.js";

/** A single file changed in this run. */
export interface DiffEntry {
  /** Repo-relative path. */
  path: string;
  status: "added" | "modified" | "deleted" | "renamed";
  /** Pre-change content. Undefined when status === "added". */
  beforeContent?: string;
  /** Post-change content. Undefined when status === "deleted". */
  afterContent?: string;
  /** Original path when status === "renamed". */
  fromPath?: string;
}

/** Languages used to filter Layer A patterns + AST assertions. */
export type SensorLanguage =
  | "typescript"
  | "javascript"
  | "python"
  | "ruby"
  | "go"
  | "rust"
  | "sql";

/** One pattern entry from .harness/config/stub-patterns.yaml. */
export interface StubPattern {
  id: string;
  languages: SensorLanguage[];
  description: string;
  regex: string;
  severity: "hard" | "soft";
}

export interface StubCatalog {
  version: number;
  patterns: StubPattern[];
}

/** YAML block the agent emits at end of turn. */
export interface AttestationDelivered {
  symbol: string;
  path?: string;
  behavior: "full" | "partial" | "scaffolded";
  sensors_passed?: string[];
}

export interface AttestationDeferred {
  symbol: string;
  reason: string;
}

export interface Attestation {
  delivered: AttestationDelivered[];
  deferred: AttestationDeferred[];
  known_limitations: string[];
  todos_introduced: number;
  stubs_introduced: number;
  files_touched: string[];
  /** Set when the agent could not proceed; runner reports it as soft finding. */
  blocked_by?: { reason: string; needed_from_operator?: string };
}

/**
 * Project-extension block resolved from workflow.md `<project>:` extension.
 * Sensors that trigger on `glob_keys` look up the matching key here.
 */
export interface ProjectGlobs {
  route_handler_globs?: string[];
  dto_globs?: string[];
  generator_source_globs?: string[];
  high_stakes_globs?: string[];
  /** Off-limits — file_must_not_be_modified assertions also enforce these. */
  off_limits?: string[];
  [key: string]: string[] | undefined;
}

export interface SensorInput {
  /** Absolute path to the mirror checkout. */
  mirrorPath: string;
  /** origin/main SHA pinned at workspace prep. */
  shaPin: string;
  /** Files changed in this run, content already loaded. */
  changedFiles: DiffEntry[];
  /** Parsed attestation; undefined if the agent emitted none (Layer B fails). */
  attestation: Attestation | undefined;
  /** Decisions accepted in scope of this diff. Already filtered. */
  decisionsInScope: DecisionFrontmatter[];
  /** Layer A catalog. */
  stubCatalog: StubCatalog;
  /** Stack profile language list — pattern filtering. */
  languages: SensorLanguage[];
  /** Project-extension globs. */
  projectGlobs: ProjectGlobs;
  /** Run id used in log lines. */
  runId: string;
}

export interface SensorFinding {
  /** id from sensors.yaml — e.g., "stub-pattern-catalog". */
  sensor_id: string;
  /** Layer A only — the pattern that matched. */
  pattern_id?: string;
  /** Decision-assertions only — the failing decision. */
  decision_id?: string;
  /** Decision-assertions only — the assertion that failed. */
  assertion_id?: string;
  /** Where the failure surfaced (repo-relative). */
  path?: string;
  /** Line number, 1-based. */
  line?: number;
  /** Verbatim text that caused the finding. */
  matched_text?: string;
  /** Human-readable, remediation-shaped one-liner. */
  message: string;
  severity: "hard" | "soft";
}

export interface SensorResult {
  sensor_id: string;
  ok: boolean;
  duration_ms: number;
  findings: SensorFinding[];
  /** Set when the sensor opted out (e.g. no diff hits its glob keys). */
  skipped?: { reason: string };
}

/** Aggregated outcome of a single sensor sweep. */
export interface SensorSweepResult {
  ok: boolean;
  hard_failures: number;
  soft_findings: number;
  results: SensorResult[];
  /** Remediation prompt body to feed back to the agent on retry. Empty when ok. */
  remediation_prompt: string;
  duration_ms: number;
}
