/**
 * Stack profile — extension surface for project-specific generators, sensors,
 * and adoption-time defaults. Per L47 (Codex audit Q8).
 *
 * The harness package code is project-agnostic. All references to specific
 * stacks (NestJS, Drizzle, Rails, etc.) live inside profile implementations,
 * NEVER in core code paths. The profile registry is consulted at adoption
 * time and at runtime via id-based lookup.
 */

export interface ProfileSensorRef {
  /** Stable id used in sensor results. */
  id: string;
  /** What the sensor checks. */
  description: string;
  /** Globs that trigger this sensor. */
  watch?: string[];
  /** Severity if this sensor fails. */
  severity?: "hard" | "soft";
}

export interface ProfileExtractorContext {
  /** The repo root the daemon is operating against (mirror path). */
  repoRoot: string;
}

export interface ProfileExtractor {
  /** Stable id used in logs + manifest entries. */
  id: string;
  /** Output path relative to repoRoot — usually under .harness/ground/. */
  outputRelPath: string;
  /** Watch globs that trigger this extractor (relative to repoRoot). */
  watch: string[];
  /** Run extractor; returns content to write, or null to skip writing. */
  run(ctx: ProfileExtractorContext): Promise<string | null>;
}

export interface Profile {
  /** Stable id — typescript-next-nest, python-fastapi, rails, go, rust, unknown. */
  id: string;
  name: string;
  /** Returns true if this profile applies to the given repo. */
  detect(repoRoot: string): boolean;
  sensors: ProfileSensorRef[];
  extractors: ProfileExtractor[];
  /** Suggested off-limits paths on adoption. */
  offLimitsDefaults: string[];
  /** Suggested high-stakes globs on adoption. */
  highStakesDefaults: string[];
  /** Suggested start command for the project (e.g., `pnpm dev`). */
  startCommand?: string;
}
