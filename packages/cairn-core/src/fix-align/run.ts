/**
 * Layer C — `cairn fix align` (plan §4.4).
 *
 * Operator-explicit full-repo Haiku-judge sweep over every prose
 * block × every accepted DEC. Reuses the Layer A `alignFile` machinery
 * per file with elevated caps so a single sweep can fully judge each
 * file rather than deferring to staleness.
 *
 * Two phases:
 *
 *   1. Pre-flight (deterministic, free) — walk every staged source
 *      file, extract prose blocks, compute Tier 1 candidate counts +
 *      Haiku call estimate. Produces a cost preview the operator can
 *      eyeball before approving the spend.
 *
 *   2. Apply (calls Haiku) — invoke `alignFile` per file. Aggregate
 *      tier counts, pending, deferred, descriptive, Haiku spend.
 *
 * `--dry-run` exits after pre-flight. `--max-cost` aborts apply when
 * the estimate exceeds the budget. `--no-creation` short-circuits the
 * Tier 3 creation judge so a sweep only consolidates duplicates
 * without proposing fresh DECs.
 */

import { readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  matchAnyGlob,
  readSotCache,
  type SotCacheEntry,
} from "@isaacriehm/cairn-state";
import { alignFile, type AlignFileArgs, type AlignFileResult } from "../hooks/post-tool-use/index.js";
import {
  TIER2_JACCARD_FLOOR,
  TOP_K_CANDIDATES,
  extractBlocks,
  isMarkdownPath,
  topKCandidates,
} from "../hooks/sot-align-common.js";
import { logger } from "../logger.js";
import { tokenize } from "../text/jaccard.js";

const log = logger("fix-align");

/* -------------------------------------------------------------------------- */
/* Tunables                                                                   */
/* -------------------------------------------------------------------------- */

const SWEEP_PASS1_CAP = 200;
const SWEEP_PASS2_CAP = 50;
const PASS2_FRACTION_ESTIMATE = 0.1; // ~10% of Pass-1 ambiguous → Pass-2
const TOKENS_PER_PASS1_CALL = 600; // empirical: Haiku dedup P1 ~600 tokens in/out
const TOKENS_PER_PASS2_CALL = 1_200;
const TOKENS_PER_CREATION_CALL = 800;
const DEFAULT_MAX_COST_TOKENS = 500_000;
const MIN_BLOCK_PROSE_LEN = 80;
const MIN_BLOCK_TOKEN_COUNT = 10;

const DEFAULT_EXCLUDES: readonly string[] = [
  ".cairn/**",
  "node_modules/**",
  "dist/**",
  "build/**",
  ".git/**",
  ".vscode/**",
  ".idea/**",
];

/* -------------------------------------------------------------------------- */
/* Public surface                                                             */
/* -------------------------------------------------------------------------- */

export interface FixAlignArgs {
  repoRoot: string;
  /** Dry-run: pre-flight only, no Haiku, no source writes. */
  dryRun?: boolean;
  /**
   * Token budget. Apply phase aborts before invoking Haiku when the
   * pre-flight estimate exceeds this. Default 500k tokens.
   */
  maxCost?: number;
  /** Glob includes — empty = include everything. */
  include?: readonly string[];
  /**
   * Glob excludes appended on top of the built-in defaults
   * (`.cairn/**`, `node_modules/**`, etc.).
   */
  exclude?: readonly string[];
  /** Skip Tier 3 creation judge — duplicate consolidation only. */
  skipCreation?: boolean;
  /** Override per-file Pass-1 cap (default 200). */
  pass1Cap?: number;
  /** Override per-file Pass-2 cap (default 50). */
  pass2Cap?: number;
  /** Mock judges (smoke fixtures). Forwarded to alignFile. */
  mocks?: Pick<
    AlignFileArgs,
    | "mockDedupJudgePass1"
    | "mockDedupJudgePass2"
    | "mockDeltaExtract"
    | "mockDeltaClassify"
    | "mockCreationJudgePass1"
    | "mockCreationJudgePass2"
  >;
}

export interface PreflightResult {
  /** Source files scanned (post-glob, post-markdown filter). */
  filesScanned: number;
  /** Total prose blocks discovered. */
  blocksConsidered: number;
  /** Blocks below the prose-length / token-count floors. Skipped in apply. */
  shortBlocks: number;
  /** Blocks where Tier 1 Jaccard found at least one candidate. */
  blocksWithTier1Candidates: number;
  /** Blocks with NO Jaccard candidate — Tier 3 creation territory. */
  blocksWithoutCandidates: number;
  /** Estimated Pass-1 calls (one per first-survivor candidate per block, capped). */
  estimatedPass1Calls: number;
  /** Estimated Pass-2 calls (10% of Pass-1, plus Tier 3 escalations). */
  estimatedPass2Calls: number;
  /** Estimated Tier 3 creation calls (when skipCreation=false). */
  estimatedCreationCalls: number;
  /** Token estimate combining all three call buckets. */
  estimatedTokens: number;
}

export interface FixAlignResult {
  preflight: PreflightResult;
  /** Aggregated alignFile results. Populated only on apply (not dry-run). */
  apply: AggregateAlignResult | null;
  /**
   * True when apply was aborted because the estimate exceeded
   * `maxCost`. The preflight is still populated.
   */
  abortedOverBudget: boolean;
  /** Repo-relative paths the sweep visited. */
  filesVisited: string[];
}

export interface AggregateAlignResult {
  filesAligned: number;
  blocksConsidered: number;
  tier1Aligned: number;
  tier2Aligned: number;
  decsCreated: number;
  invsCreated: number;
  augmentsDecs: number;
  augmentsInvs: number;
  pending: number;
  deferredToStaleness: number;
  descriptive: number;
  skipped: number;
  haikuPass1Calls: number;
  haikuPass2Calls: number;
  haikuCalls: number;
}

/* -------------------------------------------------------------------------- */
/* Run                                                                        */
/* -------------------------------------------------------------------------- */

export async function runFixAlign(args: FixAlignArgs): Promise<FixAlignResult> {
  const { repoRoot } = args;
  const include = args.include ?? [];
  const exclude = [...DEFAULT_EXCLUDES, ...(args.exclude ?? [])];
  const maxCost = args.maxCost ?? DEFAULT_MAX_COST_TOKENS;
  const skipCreation = args.skipCreation === true;
  const pass1Cap = args.pass1Cap ?? SWEEP_PASS1_CAP;
  const pass2Cap = args.pass2Cap ?? SWEEP_PASS2_CAP;

  const filesVisited = listSourceFiles({ repoRoot, include, exclude });

  const cache = readSotCache(repoRoot);
  const cacheEntries = Object.values(cache.entries)
    .filter((e): e is SotCacheEntry => e !== undefined && e.tokens.length > 0);

  const preflight = computePreflight({
    repoRoot,
    files: filesVisited,
    cacheEntries,
    skipCreation,
    pass1Cap,
  });

  const result: FixAlignResult = {
    preflight,
    apply: null,
    abortedOverBudget: false,
    filesVisited,
  };

  if (args.dryRun === true) return result;

  if (preflight.estimatedTokens > maxCost) {
    log.warn(
      { estimated: preflight.estimatedTokens, maxCost },
      "fix-align estimate exceeds maxCost; aborting before Haiku spend",
    );
    result.abortedOverBudget = true;
    return result;
  }

  const aggregate: AggregateAlignResult = {
    filesAligned: 0,
    blocksConsidered: 0,
    tier1Aligned: 0,
    tier2Aligned: 0,
    decsCreated: 0,
    invsCreated: 0,
    augmentsDecs: 0,
    augmentsInvs: 0,
    pending: 0,
    deferredToStaleness: 0,
    descriptive: 0,
    skipped: 0,
    haikuPass1Calls: 0,
    haikuPass2Calls: 0,
    haikuCalls: 0,
  };

  for (const file of filesVisited) {
    const alignArgs: AlignFileArgs = {
      repoRoot,
      filePath: file,
      sessionId: null,
      pass1Cap,
      pass2Cap,
      skipCreation,
    };
    if (args.mocks?.mockDedupJudgePass1 !== undefined)
      alignArgs.mockDedupJudgePass1 = args.mocks.mockDedupJudgePass1;
    if (args.mocks?.mockDedupJudgePass2 !== undefined)
      alignArgs.mockDedupJudgePass2 = args.mocks.mockDedupJudgePass2;
    if (args.mocks?.mockDeltaExtract !== undefined)
      alignArgs.mockDeltaExtract = args.mocks.mockDeltaExtract;
    if (args.mocks?.mockDeltaClassify !== undefined)
      alignArgs.mockDeltaClassify = args.mocks.mockDeltaClassify;
    if (args.mocks?.mockCreationJudgePass1 !== undefined)
      alignArgs.mockCreationJudgePass1 = args.mocks.mockCreationJudgePass1;
    if (args.mocks?.mockCreationJudgePass2 !== undefined)
      alignArgs.mockCreationJudgePass2 = args.mocks.mockCreationJudgePass2;

    let fileResult: AlignFileResult;
    try {
      fileResult = await alignFile(alignArgs);
    } catch (err) {
      log.warn({ file, err: String(err) }, "alignFile threw; continuing sweep");
      continue;
    }
    aggregate.filesAligned += 1;
    aggregate.blocksConsidered += fileResult.blocksConsidered;
    aggregate.tier1Aligned += fileResult.tier1Aligned;
    aggregate.tier2Aligned += fileResult.tier2Aligned;
    aggregate.decsCreated += fileResult.decsCreated;
    aggregate.invsCreated += fileResult.invsCreated;
    aggregate.augmentsDecs += fileResult.augmentsDecs;
    aggregate.augmentsInvs += fileResult.augmentsInvs;
    aggregate.pending += fileResult.pending;
    aggregate.deferredToStaleness += fileResult.deferredToStaleness;
    aggregate.descriptive += fileResult.descriptive;
    aggregate.skipped += fileResult.skipped;
    aggregate.haikuPass1Calls += fileResult.haikuPass1Calls;
    aggregate.haikuPass2Calls += fileResult.haikuPass2Calls;
    aggregate.haikuCalls += fileResult.haikuCalls;
  }

  result.apply = aggregate;
  return result;
}

/* -------------------------------------------------------------------------- */
/* File listing                                                               */
/* -------------------------------------------------------------------------- */

interface ListArgs {
  repoRoot: string;
  include: readonly string[];
  exclude: readonly string[];
}

function listSourceFiles(args: ListArgs): string[] {
  const out: string[] = [];
  walk(args.repoRoot, args.repoRoot, out, args);
  out.sort();
  return out;
}

function walk(
  repoRoot: string,
  dir: string,
  out: string[],
  args: ListArgs,
): void {
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (name.startsWith(".") && name !== ".cairn") {
      // Allow .cairn for the exclude check below; everything else
      // hidden gets skipped (avoids walking node_modules-equivalents).
      if (name === ".git" || name === ".vscode" || name === ".idea") continue;
    }
    const abs = join(dir, name);
    let s: ReturnType<typeof statSync>;
    try {
      s = statSync(abs);
    } catch {
      continue;
    }
    const rel = relative(repoRoot, abs).split("\\").join("/");
    if (s.isDirectory()) {
      if (matchAnyGlob(`${rel}/`, args.exclude) || matchAnyGlob(rel, args.exclude)) continue;
      walk(repoRoot, abs, out, args);
      continue;
    }
    if (!s.isFile()) continue;
    if (isMarkdownPath(rel)) continue;
    if (matchAnyGlob(rel, args.exclude)) continue;
    if (args.include.length > 0 && !matchAnyGlob(rel, args.include)) continue;
    out.push(rel);
  }
}

/* -------------------------------------------------------------------------- */
/* Pre-flight estimator                                                       */
/* -------------------------------------------------------------------------- */

interface PreflightArgs {
  repoRoot: string;
  files: readonly string[];
  cacheEntries: SotCacheEntry[];
  skipCreation: boolean;
  pass1Cap: number;
}

function computePreflight(args: PreflightArgs): PreflightResult {
  const out: PreflightResult = {
    filesScanned: args.files.length,
    blocksConsidered: 0,
    shortBlocks: 0,
    blocksWithTier1Candidates: 0,
    blocksWithoutCandidates: 0,
    estimatedPass1Calls: 0,
    estimatedPass2Calls: 0,
    estimatedCreationCalls: 0,
    estimatedTokens: 0,
  };

  for (const file of args.files) {
    let blocks;
    try {
      blocks = extractBlocks(args.repoRoot, file);
    } catch {
      continue;
    }
    for (const block of blocks) {
      out.blocksConsidered += 1;
      if (block.prose.length < MIN_BLOCK_PROSE_LEN) {
        out.shortBlocks += 1;
        continue;
      }
      const blockTokens = tokenize(block.prose, { codeAware: true });
      if (blockTokens.size < MIN_BLOCK_TOKEN_COUNT) {
        out.shortBlocks += 1;
        continue;
      }
      const candidates = topKCandidates(
        blockTokens,
        args.cacheEntries,
        TIER2_JACCARD_FLOOR,
        TOP_K_CANDIDATES,
      );
      if (candidates.length === 0) {
        out.blocksWithoutCandidates += 1;
        if (!args.skipCreation) {
          // Tier 3 creation: ~1 P1 call + ~5% P2 escalation.
          out.estimatedPass1Calls += 1;
          out.estimatedPass2Calls += 0.05;
          out.estimatedCreationCalls += 1;
        }
        continue;
      }
      out.blocksWithTier1Candidates += 1;
      // Tier 2 dedup: at most pass1Cap P1 calls per block, but
      // typically the first candidate matches → average ~1 P1 call.
      const expectedP1 = Math.min(candidates.length, Math.max(1, args.pass1Cap));
      const avgP1 = Math.min(expectedP1, 2); // empirical avg
      out.estimatedPass1Calls += avgP1;
      out.estimatedPass2Calls += avgP1 * PASS2_FRACTION_ESTIMATE;
    }
  }

  out.estimatedPass1Calls = Math.ceil(out.estimatedPass1Calls);
  out.estimatedPass2Calls = Math.ceil(out.estimatedPass2Calls);
  out.estimatedTokens =
    out.estimatedPass1Calls * TOKENS_PER_PASS1_CALL +
    out.estimatedPass2Calls * TOKENS_PER_PASS2_CALL +
    out.estimatedCreationCalls * TOKENS_PER_CREATION_CALL;

  return out;
}
