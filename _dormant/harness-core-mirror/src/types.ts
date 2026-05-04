/**
 * Project-name slug used as the directory key under
 * ~/.local/harness/{repos,state}/<name>/.
 *
 * Normalized by `normalizeProjectName` from package.json `name` (preferred)
 * or directory name. Lowercased; non-alphanumerics → underscores.
 */
export type ProjectName = string;

/**
 * Persisted at ~/.local/harness/state/<projectName>/mirror.json.
 *
 * Owned by the harness; the user's working tree at userTreePath is sacred —
 * harness reads it for dirty-overlap checks, never writes.
 */
export interface MirrorRecord {
  projectName: ProjectName;
  /** Absolute path to the user's primary working tree. Read-only for harness. */
  userTreePath: string;
  /** Origin URL discovered at adoption (or supplied). */
  originUrl: string;
  /** Default branch (resolved at adoption from origin/HEAD). */
  defaultBranch: string;
  /** Absolute path to the parallel mirror clone. */
  mirrorPath: string;
  /** ISO timestamp of last successful sync. */
  lastSyncedAt: string | null;
  /** SHA at HEAD after last sync. */
  lastSha: string | null;
  /** ISO timestamp the record was created. */
  createdAt: string;
}

export interface SyncResult {
  /** SHA pin captured immediately after fetch + reset. */
  sha: string;
  /** Branch the mirror is pinned to (default origin/<defaultBranch>). */
  branch: string;
  syncedAt: string;
}

export interface PushResult {
  /** SHA pushed to origin. */
  sha: string;
  branch: string;
  pushedAt: string;
  /** Stdout from git push, kept for the run event log. */
  raw: string;
}

export interface DirtyOverlapResult {
  /** Files with un-committed changes in the user's working tree. */
  dirtyFiles: string[];
  /** Subset of dirtyFiles that match any of the run's target globs. */
  overlappingFiles: string[];
  /** True iff overlappingFiles is non-empty. */
  overlap: boolean;
}

export interface CloneOptions {
  projectName: ProjectName;
  userTreePath: string;
  originUrl: string;
  defaultBranch?: string;
}

export interface SyncOptions {
  projectName: ProjectName;
  /** Override default branch for this sync (rare). */
  branch?: string;
}

export interface PushOptions {
  projectName: ProjectName;
  /** Branch to push; defaults to record.defaultBranch. */
  branch?: string;
  /** Set to true only when explicitly authorized; otherwise refuse force pushes. */
  force?: boolean;
}

export interface DirtyOverlapOptions {
  projectName: ProjectName;
  /** Globs from the dispatched run's tightened spec (target_path_globs). */
  targetGlobs: string[];
}
