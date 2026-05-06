import { join } from "node:path";

/**
 * Canonical-zone glob roots, relative to the adopted project's repo root.
 *
 * Per FILESYSTEM_LAYOUT.md §2.1. These paths are project-agnostic (every
 * cairn-adopted repo carries the same layout).
 */
export const CANONICAL_GLOBS = [
  "AGENTS.md",
  "CLAUDE.md",
  ".claude/agents/**/*.md",
  ".claude/skills/**/*.md",
  ".claude/rules/**/*.md",
  "docs/**/*.md",
  ".cairn/config/**/*",
  ".cairn/ground/**/*",
  ".cairn/tasks/active/**/*",
];

/** Paths excluded from canonical regardless of glob match. */
export const CANONICAL_EXCLUDES = [
  ".cairn/ground/decisions/_inbox/**",
  ".cairn/ground/manifest.yaml",
  ".cairn/ground/decisions/decisions.ledger.yaml",
  ".cairn/ground/invariants/invariants.ledger.yaml",
  ".cairn/ground/quality-grades.yaml",
];

export function groundDir(repoRoot: string): string {
  return join(repoRoot, ".cairn", "ground");
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

export function topicIndexPath(repoRoot: string): string {
  return join(groundDir(repoRoot), "topic-index.yaml");
}

export function sotBindingsPath(repoRoot: string): string {
  return join(groundDir(repoRoot), "sot-bindings.yaml");
}

export function sotCachePath(repoRoot: string): string {
  return join(groundDir(repoRoot), "sot-cache.yaml");
}

export function anchorMapPath(repoRoot: string): string {
  return join(groundDir(repoRoot), "anchor-map.yaml");
}

export function conflictsDir(repoRoot: string): string {
  return join(groundDir(repoRoot), "conflicts");
}

export function archivedConflictsDir(repoRoot: string): string {
  return join(conflictsDir(repoRoot), "_archived");
}

export function sotRenderedCacheDir(repoRoot: string): string {
  return join(repoRoot, ".cairn", "cache", "sot-rendered");
}

export function haikuCacheDir(repoRoot: string): string {
  return join(repoRoot, ".cairn", "cache", "haiku");
}

export function stalenessDir(repoRoot: string): string {
  return join(repoRoot, ".cairn", "staleness");
}

export function stalenessLogPath(repoRoot: string): string {
  return join(stalenessDir(repoRoot), "log.jsonl");
}

export function stalenessCurrentPath(repoRoot: string): string {
  return join(stalenessDir(repoRoot), "current.json");
}

export function runsTerminalDir(repoRoot: string): string {
  return join(repoRoot, ".cairn", "runs", "terminal");
}
