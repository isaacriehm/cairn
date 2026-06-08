/**
 * Sweep + batch entry points for GC.
 *
 * `runGcSweep` composes all twelve passes against a repo root and returns the
 * aggregated `GcSweepResult` (findings + commit proposals). Callers decide
 * whether to apply.
 *
 * `runGcBatch` is the apply-side counterpart. Given a sweep result, it
 * (1) optionally re-classifies each proposal against project globs; (2)
 * applies proposals whose class is in `applyClasses`; (3) when more than one
 * proposal lands in the same batch AND `canary` is true, runs
 * `verifyBatchCanary` against the post-batch state; (4) on canary fail,
 * rolls back to the pre-batch SHA and returns the batch as `rolled_back`.
 */

import { simpleGit } from "simple-git";
import { logger } from "../logger.js";
import { selectProfile } from "../profiles/index.js";
import type { Profile } from "../profiles/types.js";
import type { ProjectGlobs, SensorLanguage } from "../sensors/types.js";
import { applyCommit } from "./apply.js";
import { runGcCanary, type GcCanaryResult } from "./canary.js";
import { runCitationIntegrity } from "./citation-integrity.js";
import { classifyAutoMerge } from "./classify.js";
import { runCompletionIntegrity } from "./completion-integrity.js";
import { runDocClaimsVsRuntime } from "./doc-claims.js";
import { runDocGardening } from "./doc-gardening.js";
import { runDocSourceDrift } from "./doc-source-drift.js";
import { runEntityOrphan } from "./entity-orphan.js";
import { runFrontmatterFreshness } from "./frontmatter.js";
import { runGeneratorDrift } from "./generator-drift.js";
import { runQualityUpdate } from "./quality-update.js";
import { runScopeCoverage } from "./scope-coverage.js";
import { runStubCatalogHits } from "./stub-hits.js";
import { runAttestedCommitsGc } from "./attested-commits.js";
import type {
  GcAutoMergeClass,
  GcCommitProposal,
  GcFinding,
  GcPassId,
  GcSweepResult,
  GcBatchResult,
} from "./types.js";

const log = logger("gc.sweep");

export interface RunGcSweepOptions {
  repoRoot: string;
  /** Override stack profile. Defaults to `selectProfile(repoRoot)`. */
  profile?: Profile;
  /** Project-extension globs (high_stakes_globs etc). */
  projectGlobs?: ProjectGlobs;
  /** Languages active for stub-catalog scan. Default ["typescript"]. */
  languages?: readonly SensorLanguage[];
  /** Frontmatter-pass options. */
  frontmatter?: {
    warnDays?: number;
    blockDays?: number;
    /** Inject for tests. */
    now?: Date;
    /**
     * Phase 12 v1 surfaces stale frontmatter only. Setting this to true also
     * proposes a verified-at bump as a safe-class commit; the smoke uses
     * this to exercise the auto-merge end-to-end.
     */
    forceRefresh?: boolean;
  };
  /** Quality-grades pass options. */
  qualityRecentRunCount?: number;
}

export async function runGcSweep(opts: RunGcSweepOptions): Promise<GcSweepResult> {
  const startedAt = Date.now();
  const profile = opts.profile ?? selectProfile(opts.repoRoot);
  const findings: GcFinding[] = [];
  const proposals: GcCommitProposal[] = [];
  const passDurations: Record<GcPassId, number> = {
    "frontmatter-freshness": 0,
    "generator-drift": 0,
    "stub-catalog-hits": 0,
    "doc-gardening": 0,
    "quality-grades": 0,
    "scope-coverage": 0,
    "completion-integrity": 0,
    "citation-integrity": 0,
    "attested-commits-pruning": 0,
    "doc-claims-vs-runtime": 0,
    "doc-source-drift": 0,
    "entity-orphan": 0,
  };

  // 1. Frontmatter freshness.
  {
    const t0 = Date.now();
    const r = runFrontmatterFreshness({
      repoRoot: opts.repoRoot,
      ...(opts.frontmatter?.warnDays !== undefined ? { warnDays: opts.frontmatter.warnDays } : {}),
      ...(opts.frontmatter?.blockDays !== undefined ? { blockDays: opts.frontmatter.blockDays } : {}),
      ...(opts.frontmatter?.now !== undefined ? { now: opts.frontmatter.now } : {}),
      ...(opts.frontmatter?.forceRefresh !== undefined ? { forceRefresh: opts.frontmatter.forceRefresh } : {}),
    });
    findings.push(...r.findings);
    proposals.push(...r.proposals);
    passDurations["frontmatter-freshness"] = Date.now() - t0;
  }

  // 2. Generator drift.
  {
    const t0 = Date.now();
    const r = await runGeneratorDrift({ repoRoot: opts.repoRoot, profile });
    findings.push(...r.findings);
    proposals.push(...r.proposals);
    passDurations["generator-drift"] = Date.now() - t0;
  }

  // 3. Stub catalog hits.
  {
    const t0 = Date.now();
    const r = await runStubCatalogHits({
      repoRoot: opts.repoRoot,
      ...(opts.languages !== undefined ? { languages: opts.languages } : {}),
    });
    findings.push(...r.findings);
    passDurations["stub-catalog-hits"] = Date.now() - t0;
  }

  // 4. Doc gardening.
  {
    const t0 = Date.now();
    const r = runDocGardening({ repoRoot: opts.repoRoot });
    findings.push(...r.findings);
    passDurations["doc-gardening"] = Date.now() - t0;
  }

  // 5. Quality grades.
  {
    const t0 = Date.now();
    const r = await runQualityUpdate({
      repoRoot: opts.repoRoot,
      ...(opts.qualityRecentRunCount !== undefined ? { recentRunCount: opts.qualityRecentRunCount } : {}),
    });
    findings.push(...r.findings);
    proposals.push(...r.proposals);
    passDurations["quality-grades"] = Date.now() - t0;
  }

  // 6. Completion integrity.
  {
    const t0 = Date.now();
    const r = await runCompletionIntegrity({ repoRoot: opts.repoRoot });
    findings.push(...r.findings);
    passDurations["completion-integrity"] = Date.now() - t0;
  }

  // 7. Scope coverage.
  {
    const t0 = Date.now();
    const r = runScopeCoverage({ repoRoot: opts.repoRoot });
    findings.push(...r.findings);
    passDurations["scope-coverage"] = Date.now() - t0;
  }

  // 8. Citation integrity.
  {
    const t0 = Date.now();
    const r = await runCitationIntegrity({ repoRoot: opts.repoRoot });
    findings.push(...r.findings);
    passDurations["citation-integrity"] = Date.now() - t0;
  }

  // 9. Attested commits pruning.
  {
    const t0 = Date.now();
    const r = runAttestedCommitsGc({ repoRoot: opts.repoRoot });
    findings.push(...r.findings);
    passDurations["attested-commits-pruning"] = Date.now() - t0;
  }

  // 10. Doc-claims vs runtime drift.
  {
    const t0 = Date.now();
    const r = runDocClaimsVsRuntime({ repoRoot: opts.repoRoot });
    findings.push(...r.findings);
    passDurations["doc-claims-vs-runtime"] = Date.now() - t0;
  }

  // 11. Doc-source drift — body of sot_kind=path DECs/INVs vs ground hash.
  {
    const t0 = Date.now();
    const r = runDocSourceDrift({ repoRoot: opts.repoRoot });
    findings.push(...r.findings);
    passDurations["doc-source-drift"] = Date.now() - t0;
  }

  // 12. Entity-orphan — ledger → code; surface DEC/INV that no longer have
  // a live home. Findings only; the safe subset is retired by the
  // `cairn gc retire` apply path, not auto-merged as a Gc proposal.
  {
    const t0 = Date.now();
    const r = runEntityOrphan({ repoRoot: opts.repoRoot });
    findings.push(...r.findings);
    passDurations["entity-orphan"] = Date.now() - t0;
  }

  // Re-classify proposals against project globs (passes set defaults; this
  // ensures high-stakes hits dominate when a stale-frontmatter doc happens to
  // live under a high-stakes glob).
  for (const p of proposals) {
    p.class = classifyAutoMerge({
      paths: p.paths,
      ...(opts.projectGlobs !== undefined ? { projectGlobs: opts.projectGlobs } : {}),
    });
  }

  const result: GcSweepResult = {
    generated: new Date().toISOString(),
    findings,
    proposals,
    pass_durations: passDurations,
    duration_ms: Date.now() - startedAt,
  };

  log.info(
    {
      repo: opts.repoRoot,
      profile: profile.id,
      findings: findings.length,
      proposals: proposals.length,
      duration_ms: result.duration_ms,
    },
    "gc sweep complete",
  );
  return result;
}

export interface RunGcBatchOptions extends RunGcSweepOptions {
  /** Auto-merge classes that are allowed to apply. Default ["safe"]. */
  applyClasses?: readonly GcAutoMergeClass[];
  /** Re-run the canary after the batch lands. Default true. */
  canary?: boolean;
  /** Override the commit author. */
  author?: { name: string; email: string };
}

export async function runGcBatch(opts: RunGcBatchOptions): Promise<GcBatchResult> {
  const applyClasses: readonly GcAutoMergeClass[] = opts.applyClasses ?? ["safe"];
  const canaryEnabled = opts.canary ?? true;

  const sweep = await runGcSweep(opts);

  const git = simpleGit({ baseDir: opts.repoRoot });
  const preBatchSha = (await git.revparse(["HEAD"])).trim();

  const toApply: GcCommitProposal[] = [];
  const surfaced: GcCommitProposal[] = [];
  for (const p of sweep.proposals) {
    if (applyClasses.includes(p.class)) {
      toApply.push(p);
    } else {
      surfaced.push(p);
    }
  }

  const applied: GcBatchResult["applied"] = [];
  for (const p of toApply) {
    const r = await applyCommit({
      repoRoot: opts.repoRoot,
      proposal: p,
      ...(opts.author !== undefined ? { author: opts.author } : {}),
    });
    applied.push({
      pass: p.pass,
      class: p.class,
      commit_sha: r.commit_sha,
      commit_message: p.commit_message,
      paths: p.paths,
    });
  }

  let canaryResult: GcCanaryResult | undefined;
  let rolledBack = false;
  if (canaryEnabled && applied.length >= 2) {
    canaryResult = await runGcCanary({ repoRoot: opts.repoRoot });
    if (!canaryResult.ok) {

      // Roll back to pre-batch SHA — undoes every commit applied in this
      // batch atomically.
      await git.reset(["--hard", preBatchSha]);
      rolledBack = true;
      log.warn(
        {
          repo: opts.repoRoot,
          pre_batch_sha: preBatchSha,
          applied_count: applied.length,
          failures: canaryResult.failures,
        },
        "gc batch rolled back — canary failed",
      );
    }
  }

  const postBatchSha = rolledBack
    ? preBatchSha
    : (await git.revparse(["HEAD"])).trim();

  return {
    applied: rolledBack ? [] : applied,
    surfaced: rolledBack ? [...surfaced, ...toApply] : surfaced,
    pre_batch_sha: preBatchSha,
    post_batch_sha: postBatchSha,
    canary_ok: canaryResult ? canaryResult.ok : true,
    canary_failures: canaryResult?.failures ?? [],
    rolled_back: rolledBack,
  };
}
