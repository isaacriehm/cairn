import { join } from "node:path";

/**
 * Convert a path to POSIX format (using forward slashes).
 */
export function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

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
  // Retired DEC/INV bodies — historical only, reachable via cairn_query_history.
  // Excluded from the canonical zone so archived entities stop loading into
  // agent context, search, and the drift sensors.
  ".cairn/ground/.archive/**",
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

/**
 * `.cairn/ground/.archive/` — the retirement graveyard. DEC/INV entities
 * that orphaned (source gone / zero live cites) or were manually retired
 * are moved here. Outside the active ledger and the canonical zone; only
 * `cairn_query_history` reads it.
 */
export function archiveDir(repoRoot: string): string {
  return join(groundDir(repoRoot), ".archive");
}

export function archiveDecisionsDir(repoRoot: string): string {
  return join(archiveDir(repoRoot), "decisions");
}

export function archiveInvariantsDir(repoRoot: string): string {
  return join(archiveDir(repoRoot), "invariants");
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

export function rejectedYamlPath(repoRoot: string): string {
  return join(groundDir(repoRoot), "_rejected.yaml");
}

export function fileCandidatesMapPath(repoRoot: string): string {
  return join(groundDir(repoRoot), "file-candidates-map.yaml");
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

export function alignmentPendingDir(repoRoot: string): string {
  return join(groundDir(repoRoot), "alignment-pending");
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

/**
 * Layer A live-hook deferred-block log. PostToolUse Write/Edit appends
 * one rich record per block when the per-Write Haiku cap is exceeded
 * or Pass-2-still-ambiguous fires. Drained by SessionStart Drain at SessionStart.
 */
export function layerADeferredLogPath(repoRoot: string): string {
  return join(stalenessDir(repoRoot), "layer-a-deferred.jsonl");
}

/**
 * Layer B pre-commit-drift rich log. Git pre-commit hook appends one
 * record per prose block discovered in staged content. Drained by
 * SessionStart Drain at SessionStart.
 */
export function preCommitDeferredLogPath(repoRoot: string): string {
  return join(stalenessDir(repoRoot), "pre-commit-deferred.jsonl");
}

export function runsTerminalDir(repoRoot: string): string {
  return join(repoRoot, ".cairn", "runs", "terminal");
}

/* -------------------------------------------------------------------------- */
/* Missions — committed roadmap + per-clone runtime state                    */
/* -------------------------------------------------------------------------- */

/** `.cairn/ground/missions/` — committed roadmap surface. */
export function missionsGroundRoot(repoRoot: string): string {
  return join(groundDir(repoRoot), "missions");
}

/** `.cairn/ground/missions/_done/` — archived roadmaps. */
export function missionsGroundDoneRoot(repoRoot: string): string {
  return join(missionsGroundRoot(repoRoot), "_done");
}

/** `.cairn/ground/missions/<id>/` for the live roadmap. */
export function missionGroundDir(repoRoot: string, missionId: string): string {
  return join(missionsGroundRoot(repoRoot), missionId);
}

/** `.cairn/ground/missions/<id>/roadmap.md`. */
export function missionRoadmapPath(repoRoot: string, missionId: string): string {
  return join(missionGroundDir(repoRoot, missionId), "roadmap.md");
}

/** `.cairn/missions/` — per-clone runtime state root. */
export function missionsRuntimeRoot(repoRoot: string): string {
  return join(repoRoot, ".cairn", "missions");
}

/** `.cairn/missions/_done/` — archived per-clone state. */
export function missionsRuntimeDoneRoot(repoRoot: string): string {
  return join(missionsRuntimeRoot(repoRoot), "_done");
}

/** `.cairn/missions/<id>/`. */
export function missionRuntimeDir(repoRoot: string, missionId: string): string {
  return join(missionsRuntimeRoot(repoRoot), missionId);
}

export function missionStatePath(repoRoot: string, missionId: string): string {
  return join(missionRuntimeDir(repoRoot, missionId), "state.json");
}

export function missionSpecPath(repoRoot: string, missionId: string): string {
  return join(missionRuntimeDir(repoRoot, missionId), "spec.md");
}

export function missionJournalPath(repoRoot: string, missionId: string): string {
  return join(missionRuntimeDir(repoRoot, missionId), "journal.jsonl");
}
