/**
 * Sensor types — honest-agent invariants stack.
 *
 * Each sensor reads a diff (+ decisions + project globs) and emits
 * `SensorFinding[]`. The sweep runner collects every sensor's `SensorResult`,
 * aggregates `ok`, and builds a remediation prompt from any hard findings.
 */

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

/**
 * Language tag used to filter Layer A patterns + AST assertions. OPEN string
 * equal to a `languages.ts` profile id — the registry is the single source,
 * so a new language is filterable just by living in the table. Common values:
 * typescript, javascript, python, ruby, go, rust, sql.
 */
export type SensorLanguage = string;

/** One pattern entry from .cairn/config/stub-patterns.yaml. */
export interface StubPattern {
  id: string;
  languages: (SensorLanguage | "all")[];
  description: string;
  regex: string;
  severity: "hard" | "soft";
  /**
   * File-path globs to EXCLUDE from this pattern. Per-project
   * operator escape hatch for legitimate idioms that match the regex
   * syntactically but are semantically correct in the matched context.
   * Globs are POSIX-style, evaluated against the diff entry's path.
   */
  skip_globs?: string[];
  /**
   * Optional inner regex applied to the OUTER match's text. Finding is
   * only emitted when this regex matches at least once inside the
   * block the outer regex captured. Lets a coarse outer pattern
   * (e.g. "3+ consecutive `//` lines") gate on an inner signal
   * (e.g. "at least one of those lines contains a code-syntax marker
   * like `;`, `=>`, `const`, `function`"). Without this, the outer
   * regex matches every doc preamble / license header / annotation
   * block and floods the audit with non-actionable noise.
   * Regex is multiline-mode; matched against the substring captured
   * by the outer regex, not the full file.
   */
  must_contain?: string;
}

export interface StubCatalog {
  version: number;
  patterns: StubPattern[];
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
