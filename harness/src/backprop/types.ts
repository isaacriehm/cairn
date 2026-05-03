/**
 * Backprop subagent (Phase 13).
 *
 * Per PRIMER §13 + INTEGRATION_PLAN §5 Phase 13: every code-class fix
 * produces a permanent §V invariant + a sensor (or named E2E case) that
 * enforces it going forward. Backprop runs as a second commit phase AFTER
 * sensors/reviewer/UAT all pass.
 *
 * Design constraints:
 *   - Tier 2 (Sonnet) by default per templates/.harness/config/workflow.md
 *     `backprop_author: 2`. Override via BackpropInput.tier.
 *   - Structured output via `--json-schema` — backprop returns a typed
 *     payload; the harness writes the invariant file + generates the
 *     sensor script mechanically. The agent does NOT touch the filesystem.
 *   - Invariant ids are monotonic, never reused (L13.2). The id allocator
 *     scans existing `.harness/ground/invariants/V*.md` and returns the
 *     next free integer.
 *   - Sensor script template is a regex sniff over the diff. The agent
 *     supplies the regex + a one-line failure message; the harness emits
 *     the boilerplate around it. Future: a Tier-2-authored bespoke sensor
 *     when the regex form is insufficient.
 */

import type { ClaudeTier } from "../claude/index.js";
import type { DiffEntry } from "../sensors/index.js";

/** Surface that enforces the invariant. */
export type EnforcementKind = "regex_sensor" | "named_e2e";

/**
 * The structured object the backprop subagent emits. Constrained by
 * `BACKPROP_OUTPUT_SCHEMA` to keep the surface narrow and machine-checkable.
 */
export interface BackpropOutput {
  /**
   * Short kebab-case slug used in the invariant filename + sensor filename.
   * Example: "no-jsonb-userid-filter". 30 char max.
   */
  slug: string;
  /** One-line invariant title. Imperative voice. */
  title: string;
  /** Markdown body of the invariant — what + why + how to enforce. */
  body_markdown: string;
  /** Names of decisions the invariant derives from, if any. */
  source_decision_ids?: string[];
  /** Original failure that motivated the fix (one paragraph). */
  introduced_for_bug: string;
  /** Mechanism that enforces the invariant going forward. */
  enforcement: {
    kind: EnforcementKind;
    /** When kind=regex_sensor: a JS-flavored regex pattern (string). */
    regex?: string;
    /** When kind=regex_sensor: which file globs to scan. Default `**\/*.ts`. */
    target_globs?: string[];
    /** When kind=regex_sensor: language hint for filtering. */
    language?: "typescript" | "javascript" | "python" | "ruby" | "go" | "rust" | "sql";
    /** When kind=regex_sensor: the failure message the sensor prints on a hit. */
    failure_message?: string;
    /** When kind=named_e2e: relative path of the generated test stub. */
    e2e_path?: string;
  };
}

export interface BackpropInput {
  /** The tightened spec body the implementer was given. */
  tightened_spec: string;
  /** Acceptance criteria the run satisfied. */
  acceptance_criteria: string[];
  /** Files touched by the fix run, with post-change content. */
  diff: DiffEntry[];
  /**
   * The failure that motivated this fix — the prior sensor finding,
   * reviewer hard gap, UAT rejection note, or human-supplied bug report.
   */
  failure_summary: string;
  /** Run id for cross-reference. Becomes `source_run` in the invariant frontmatter. */
  run_id: string;
  /** Decision ids whose scope this fix touches (for source_decision linkage). */
  in_scope_decision_ids: string[];
  /** Tier — default 2 (Sonnet) per workflow.md. */
  tier: ClaudeTier;
  /** Per-call timeout. Default 300_000 ms. */
  timeout_ms?: number;
}

/**
 * Result handed back to the orchestrator. The harness has already written
 * the invariant + sensor files into the mirror at this point; the caller
 * decides whether to commit.
 */
export interface BackpropResult {
  /** Allocated invariant id. */
  id: string;
  /** Path of the written invariant file (repo-relative). */
  invariant_path: string;
  /** Path of the written sensor / E2E (repo-relative). */
  sensor_path: string;
  /** Original agent output for telemetry. */
  output: BackpropOutput;
  tier: ClaudeTier;
  duration_ms: number;
  usage?: { input_tokens?: number; output_tokens?: number };
}
