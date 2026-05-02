import { join } from "node:path";

/**
 * Canonical-zone glob roots, relative to the adopted project's repo root.
 *
 * Per FILESYSTEM_LAYOUT.md §2.1. These paths are project-agnostic (every
 * harness-adopted repo carries the same layout).
 */
export const CANONICAL_GLOBS = [
  "AGENTS.md",
  "CLAUDE.md",
  ".claude/settings.json",
  ".claude/agents/**/*.md",
  ".claude/skills/**/*.md",
  ".claude/rules/**/*.md",
  "docs/**/*.md",
  ".harness/config/**/*",
  ".harness/ground/**/*",
  ".harness/tasks/active/**/*",
];

/** Paths excluded from canonical regardless of glob match. */
export const CANONICAL_EXCLUDES = [
  ".harness/ground/decisions/_inbox/**",
  ".harness/ground/manifest.yaml",
  ".harness/ground/decisions/decisions.ledger.yaml",
  ".harness/ground/invariants/invariants.ledger.yaml",
  ".harness/ground/quality-grades.yaml",
];

export function groundDir(repoRoot: string): string {
  return join(repoRoot, ".harness", "ground");
}

export function manifestPath(repoRoot: string): string {
  return join(groundDir(repoRoot), "manifest.yaml");
}

export function decisionsDir(repoRoot: string): string {
  return join(groundDir(repoRoot), "decisions");
}

export function invariantsDir(repoRoot: string): string {
  return join(groundDir(repoRoot), "invariants");
}

export function decisionsLedgerPath(repoRoot: string): string {
  return join(decisionsDir(repoRoot), "decisions.ledger.yaml");
}

export function invariantsLedgerPath(repoRoot: string): string {
  return join(invariantsDir(repoRoot), "invariants.ledger.yaml");
}

export function qualityGradesPath(repoRoot: string): string {
  return join(groundDir(repoRoot), "quality-grades.yaml");
}

export function stalenessDir(repoRoot: string): string {
  return join(repoRoot, ".harness", "staleness");
}

export function stalenessLogPath(repoRoot: string): string {
  return join(stalenessDir(repoRoot), "log.jsonl");
}

export function stalenessCurrentPath(repoRoot: string): string {
  return join(stalenessDir(repoRoot), "current.json");
}

export function runsTerminalDir(repoRoot: string): string {
  return join(repoRoot, ".harness", "runs", "terminal");
}
