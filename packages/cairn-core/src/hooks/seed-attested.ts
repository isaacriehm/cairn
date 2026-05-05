/**
 * Seed `.cairn/.attested-commits` with every commit reachable from
 * HEAD at the time of seeding. Bypass detection then grandfathers all
 * those SHAs as "already attested" — only future bypassed commits
 * surface as attention.
 *
 * Two callers:
 *   1. Phase 3b-seed (during `cairn init`) — seeds for the adopting
 *      clone the moment `.cairn/` lands, so the very next Stop hook
 *      tick doesn't false-positive every pre-adoption commit.
 *   2. `cairn join` (per-clone bootstrap) — `.attested-commits` is
 *      gitignored + per-clone, so each new clone needs its own seed
 *      on first bootstrap.
 *
 * Idempotent: if the file already exists with content, we leave it
 * alone (the post-commit hook owns ongoing appends).
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type SeedAttestedStatus = "ok" | "skipped" | "error";

export interface SeedAttestedResult {
  status: SeedAttestedStatus;
  detail: string;
  /** SHA count seeded — present only when status="ok". */
  count?: number;
}

export function seedAttestedCommits(
  repoRoot: string,
  dryRun = false,
): SeedAttestedResult {
  const path = join(repoRoot, ".cairn", ".attested-commits");
  if (existsSync(path)) {
    return {
      status: "skipped",
      detail: ".cairn/.attested-commits already exists — leaving as-is",
    };
  }
  if (!existsSync(join(repoRoot, ".git"))) {
    return {
      status: "skipped",
      detail: "no .git/ — bypass detection is git-only, nothing to seed",
    };
  }
  let shas: string[] = [];
  try {
    const out = execFileSync("git", ["log", "--format=%H"], {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
    shas = out.split("\n").filter((s) => s.length > 0);
  } catch {
    // git log fails on empty repos (no commits yet) and on edge cases
    // like detached/corrupted state. In all those cases the right
    // semantic is "nothing to seed" — never block adoption / bootstrap
    // on the absence of pre-existing history.
    return {
      status: "skipped",
      detail: "git log returned no commits — nothing to seed",
    };
  }
  if (shas.length === 0) {
    return {
      status: "skipped",
      detail: "git log returned no commits — nothing to seed",
    };
  }
  if (dryRun) {
    return {
      status: "ok",
      detail: `(dry-run) would seed ${shas.length} pre-existing SHA${shas.length === 1 ? "" : "s"}`,
      count: shas.length,
    };
  }
  try {
    mkdirSync(join(repoRoot, ".cairn"), { recursive: true });
    writeFileSync(path, `${shas.join("\n")}\n`, "utf8");
  } catch (err) {
    return {
      status: "error",
      detail: `write ${path} failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return {
    status: "ok",
    detail: `seeded ${shas.length} pre-existing SHA${shas.length === 1 ? "" : "s"} — bypass detection grandfathers them`,
    count: shas.length,
  };
}
