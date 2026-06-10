/**
 * Ghost state backup (ghost-mode design).
 *
 * Ghost state lives out-of-repo at `<stateHome>/<repo-id>/`, so it never rides
 * the client repo's history — which means it has no version control at all
 * unless Cairn gives it some. The decided design: the state dir is its OWN git
 * repo (unrelated to the client repo), auto-committed on the Stop hook (fires
 * every turn). The operator adds a private per-client remote and pushes →
 * off-machine backup + full history/rollback of the decision memory.
 *
 * The seeded `.gitignore` already sits at the state-dir root in ghost (the
 * `.cairn/.gitignore` denylist, redirected out-of-repo by the seed), so the
 * backup repo tracks exactly the durable ground state (decisions, invariants,
 * config, scope-index, brand, canonical-map) and skips churn (sessions, runs,
 * events, locks, caches, init-state). No separate ignore list to maintain.
 *
 * Local commit only — the Stop hook is the hot turn-end path, so a network
 * push never runs here; the operator pushes on their own cadence. Strictly
 * `isGhost`-gated: a committed repo's `.cairn/` is inside the client tree and
 * versioned by the operator's normal git flow — a nested backup repo there
 * would be a footprint bug.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { cairnHome, isGhost } from "@isaacriehm/cairn-state";
import { logger } from "../logger.js";

const log = logger("ghost-backup");

// Inline commit identity — never persisted to the repo's config, never the
// operator's real name/email (no operator-private strings, and no dependency on
// a global git identity being present).
const COMMIT_IDENTITY = [
  "-c",
  "user.name=Cairn",
  "-c",
  "user.email=cairn@localhost",
];

export interface GhostBackupResult {
  /** A new snapshot commit was created this call. */
  committed: boolean;
  /** The state dir was `git init`-ed this call (first backup). */
  initialized: boolean;
  /** Why nothing was committed (when `committed` is false). */
  reason?: string;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
}

/**
 * Commit the ghost state dir's durable ground state. `git init`s the dir on
 * first call. Skips cleanly when nothing tracked-worthy changed (no empty
 * commits). Best-effort: every failure is swallowed + logged so a backup
 * problem never blocks the end of a turn. No-op outside ghost.
 */
export function ghostBackupCommit(repoRoot: string): GhostBackupResult {
  if (!isGhost(repoRoot)) {
    return { committed: false, initialized: false, reason: "not-ghost" };
  }
  const dir = cairnHome(repoRoot);
  if (!existsSync(dir)) {
    return { committed: false, initialized: false, reason: "no-state-dir" };
  }

  let initialized = false;
  try {
    if (!existsSync(join(dir, ".git"))) {
      git(dir, ["init", "-q"]);
      initialized = true;
    }
    git(dir, ["add", "-A"]);
    // After staging, an empty index diff means nothing durable changed (the
    // `.gitignore` filtered the churn) — skip rather than fail on an empty
    // commit.
    const staged = git(dir, ["status", "--porcelain"]).trim();
    if (staged.length === 0) {
      return { committed: false, initialized, reason: "clean" };
    }
    const ts = new Date().toISOString();
    git(dir, [...COMMIT_IDENTITY, "commit", "-q", "-m", `cairn ghost snapshot ${ts}`]);
    return { committed: true, initialized };
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "ghost backup commit failed",
    );
    return { committed: false, initialized, reason: "git-error" };
  }
}
