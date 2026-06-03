/**
 * Entity retirement — apply half of the orphan subsystem.
 *
 * Runs the `entity-orphan` pass, then archives the SAFE subset
 * (provably orphaned: doc source gone, or zero live §cites + source_file
 * gone) via `archiveEntity`. Ambiguous orphans are never auto-retired —
 * they surface for operator/agent triage through cairn-attention.
 *
 * The apply is wrapped in the same canary/rollback envelope the GC batch
 * uses: after the archive commit lands, `runGcCanary` rebuilds the
 * manifest and sanity-checks ground state; on failure the whole batch is
 * `git reset --hard` back to the pre-batch SHA. Archiving never
 * hard-deletes, so even a rolled-back run leaves no dangling references.
 *
 * `apply: false` (the default) is surface-only — it returns what *would*
 * be retired without mutating anything. The Stop-hook autotrigger and
 * `cairn gc retire --apply` opt into the mutating path.
 */

import { simpleGit } from "simple-git";
import { archiveEntity, recordDriftEvent } from "@isaacriehm/cairn-state";
import { logger } from "../logger.js";
import { runGcCanary } from "./canary.js";
import { runEntityOrphan, type OrphanCandidate } from "./entity-orphan.js";
import type { GcFinding } from "./types.js";

const log = logger("gc.retire");

export interface EntityRetireOptions {
  repoRoot: string;
  /** When false (default) the run is surface-only — no archive, no commit. */
  apply?: boolean;
  /** Re-run the canary after the archive commit lands. Default true. */
  canary?: boolean;
  /** Override the commit author (smoke convenience). */
  author?: { name: string; email: string };
  /** Inject "now" for the grace window (tests). */
  now?: Date;
}

export interface RetiredEntity {
  id: string;
  kind: "DEC" | "INV";
  archivedPath: string;
  reason: string;
}

export interface EntityRetireResult {
  /** All orphan findings (safe + ambiguous) for the sweep surface. */
  findings: GcFinding[];
  /** Entities archived this run (empty when apply=false or rolled back). */
  retired: RetiredEntity[];
  /** Safe orphans not retired — surface-only mode, archive failure, or rollback. */
  surfaced: OrphanCandidate[];
  /** Ambiguous orphans — always surfaced, never auto-retired. */
  ambiguous: OrphanCandidate[];
  pre_sha: string | null;
  post_sha: string | null;
  commit_sha: string | null;
  canary_ok: boolean;
  canary_failures: string[];
  rolled_back: boolean;
}

function commitSubject(retired: RetiredEntity[]): string {
  const decs = retired.filter((r) => r.kind === "DEC").length;
  const invs = retired.filter((r) => r.kind === "INV").length;
  const parts: string[] = [];
  if (decs > 0) parts.push(`${decs} DEC`);
  if (invs > 0) parts.push(`${invs} INV`);
  return `chore(gc): retire ${parts.join(" + ")} orphaned ${retired.length === 1 ? "entity" : "entities"}`;
}

function commitMessage(retired: RetiredEntity[]): string {
  const body = retired
    .map((r) => `- ${r.id}: ${r.reason} → ${r.archivedPath}`)
    .join("\n");
  return `${commitSubject(retired)}\n\nArchived by the entity-orphan GC pass:\n${body}\n`;
}

export async function runEntityRetire(
  opts: EntityRetireOptions,
): Promise<EntityRetireResult> {
  const apply = opts.apply === true;
  const canaryEnabled = opts.canary ?? true;

  const orphanRun = runEntityOrphan({
    repoRoot: opts.repoRoot,
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  });
  const safe = orphanRun.orphans.filter((o) => o.classification === "safe");
  const ambiguous = orphanRun.orphans.filter((o) => o.classification === "ambiguous");

  // Ambiguous orphans are never auto-retired — surface them as drift events
  // so cairn-attention can offer a one-tap retire (or prompt a fix). Recorded
  // whether or not we apply, since this is the dedicated retirement entry
  // point invoked by the autonomous daily tick.
  const driftTs = (opts.now ?? new Date()).toISOString();
  for (const a of ambiguous) {
    try {
      recordDriftEvent(opts.repoRoot, {
        ts: driftTs,
        kind: "orphan_entity",
        path: a.entityPath,
        detail: `${a.id} orphaned (${a.reason}). Retire via cairn_retire_${a.kind === "INV" ? "invariant" : "decision"}, or restore a live §cite.`,
        severity: "soft",
        dec_id: a.id,
      });
    } catch {
      /* best-effort — drift log is advisory */
    }
  }

  const base: EntityRetireResult = {
    findings: orphanRun.findings,
    retired: [],
    surfaced: [...safe],
    ambiguous,
    pre_sha: null,
    post_sha: null,
    commit_sha: null,
    canary_ok: true,
    canary_failures: [],
    rolled_back: false,
  };

  if (!apply || safe.length === 0) {
    return base;
  }

  // Snapshot pre-batch SHA for rollback. Absent git (or a non-repo) still
  // archives — the state change is the point — it just skips commit/canary.
  const git = simpleGit({ baseDir: opts.repoRoot });
  let preSha: string | null = null;
  try {
    preSha = (await git.revparse(["HEAD"])).trim();
  } catch {
    preSha = null;
  }

  const retired: RetiredEntity[] = [];
  const failedToArchive: OrphanCandidate[] = [];
  for (const cand of safe) {
    const res = archiveEntity({
      repoRoot: opts.repoRoot,
      id: cand.id,
      reason: cand.reason,
      ...(opts.now !== undefined ? { now: opts.now } : {}),
    });
    if (res.ok) {
      retired.push({
        id: res.id,
        kind: res.kind,
        archivedPath: res.archivedPath,
        reason: cand.reason,
      });
    } else {
      failedToArchive.push(cand);
    }
  }

  if (retired.length === 0) {
    return { ...base, retired: [], surfaced: failedToArchive, pre_sha: preSha };
  }

  // Commit the archive move + ledger rebuild + cache prune as one chore(gc).
  let commitSha: string | null = null;
  if (preSha !== null) {
    try {
      if (opts.author !== undefined) {
        await git.addConfig("user.name", opts.author.name, false, "local");
        await git.addConfig("user.email", opts.author.email, false, "local");
      }
      await git.raw(["add", "-A", ".cairn/ground"]);
      await git.commit(commitMessage(retired));
      commitSha = (await git.revparse(["HEAD"])).trim();
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "entity-retire commit failed; archive applied to working tree only",
      );
    }
  }

  // Canary — rebuild manifest + sanity-check ground state. Rollback on fail.
  let canaryOk = true;
  let canaryFailures: string[] = [];
  let rolledBack = false;
  if (canaryEnabled && commitSha !== null && preSha !== null) {
    const canary = runGcCanary({ repoRoot: opts.repoRoot });
    canaryOk = canary.ok;
    canaryFailures = canary.failures;
    if (!canary.ok) {
      try {
        await git.reset(["--hard", preSha]);
        rolledBack = true;
        log.warn(
          { repo: opts.repoRoot, pre_sha: preSha, retired: retired.length, failures: canary.failures },
          "entity-retire rolled back — canary failed",
        );
      } catch (err) {
        log.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "entity-retire rollback failed",
        );
      }
    }
  }

  if (rolledBack) {
    return {
      ...base,
      retired: [],
      surfaced: [...safe],
      pre_sha: preSha,
      post_sha: preSha,
      commit_sha: null,
      canary_ok: false,
      canary_failures: canaryFailures,
      rolled_back: true,
    };
  }

  let postSha: string | null = commitSha;
  if (postSha === null && preSha !== null) {
    try {
      postSha = (await git.revparse(["HEAD"])).trim();
    } catch {
      postSha = preSha;
    }
  }

  log.info(
    { repo: opts.repoRoot, retired: retired.length, ambiguous: ambiguous.length, commit: commitSha },
    "entity-retire complete",
  );

  return {
    ...base,
    retired,
    surfaced: failedToArchive,
    pre_sha: preSha,
    post_sha: postSha,
    commit_sha: commitSha,
    canary_ok: canaryOk,
    canary_failures: canaryFailures,
    rolled_back: false,
  };
}
