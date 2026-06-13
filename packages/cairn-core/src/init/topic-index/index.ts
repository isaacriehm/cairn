/**
 * Phase 7 — topic-index build orchestration.
 *
 * Public entry: `buildTopicIndex(args)` walks the repo, resolves
 * verbatim + semantic collisions, and writes the topic-index +
 * anchor-map ground files. Returns counts so the phase runner can
 * surface a one-line summary.
 *
 * The phase runner uses this; smokes call it directly with a mock
 * judge to avoid Haiku.
 */

import { logger } from "../../logger.js";
import {
  anchorMapPath,
  fileCandidatesMapPath,
  gcRejectedYaml,
  readRejectedYaml,
  topicIndexPath,
  writeAnchorMap,
  writeFileCandidatesMap,
  writeRejectedYaml,
  writeTopicIndex,
} from "@isaacriehm/cairn-state";
import { clearProgress, writeProgress } from "../progress.js";
import { makeHaikuJudge, type JudgeTally } from "./judge.js";
import { resolveTopics, type JudgeProgress, type ResolveResult, type SemanticJudge } from "./resolve.js";
import { walkProseBlocks, type ProseBlock } from "./walk.js";

const log = logger("init.topic-index");

export interface BuildTopicIndexArgs {
  repoRoot: string;
  /** Override the judge (smokes pass a deterministic mock). */
  judge?: SemanticJudge;
  /** Override the walker (smokes pass canned blocks). */
  blocks?: ProseBlock[];
  /** Min Jaccard similarity to invoke the judge. Defaults to plan §5.1 (0.6). */
  similarityThreshold?: number;
  /** Hard cap on judge calls. Defaults to 200. */
  maxJudgeCalls?: number;
  /** Max concurrent judge calls. Defaults to 5. */
  judgeConcurrency?: number;
  /**
   * When true (default), the resolver writes
   * `.cairn/init/progress.json` after each judge call so the
   * statusline can render `phase 7-topic-index X/Y pairs`. Smokes opt out.
   */
  emitProgress?: boolean;
  /**
   * When true (default), the freshly-resolved index + anchor-map +
   * file-candidates-map are written to disk and `_rejected.yaml` is
   * GC'd. When false the resolve runs (the Haiku judge still fires — it
   * IS the discovery), but no map is mutated: `cairn resync --recluster`
   * uses this to preview a re-cluster without overwriting the live maps.
   */
  write?: boolean;
}

export interface BuildTopicIndexResult extends ResolveResult {
  blockCount: number;
  topicIndexPath: string;
  anchorMapPath: string;
  /** Absolute path of `.cairn/ground/file-candidates-map.yaml`. */
  fileCandidatesMapPath: string;
  /** Per-file unpromoted-candidate count after this build. */
  fileCandidates: Record<string, number>;
  /** Slugs dropped from `_rejected.yaml` by the GC pass. */
  rejectedGcDropped: string[];
  /**
   * Cached vs fresh vs errored Haiku judge call breakdown. Only the
   * default `makeHaikuJudge` path increments these — smokes that
   * supply their own judge get all-zeros (correctly: no Haiku spend).
   */
  judgeCached: number;
  judgeFresh: number;
  judgeErrors: number;
}

export async function buildTopicIndex(
  args: BuildTopicIndexArgs,
): Promise<BuildTopicIndexResult> {
  const blocks = args.blocks ?? walkProseBlocks(args.repoRoot);
  const tally: JudgeTally = { cached: 0, fresh: 0, errors: 0 };
  const judge =
    args.judge ?? makeHaikuJudge({ repoRoot: args.repoRoot, tally });

  log.debug({ blockCount: blocks.length }, "phase 7-topic-index walk complete");

  const emitProgress = args.emitProgress !== false;
  const startedAt = Date.now();
  const onProgress = emitProgress
    ? (snap: JudgeProgress): void => {
        writeProgress(args.repoRoot, {
          phase: "7-topic-index",
          batch: snap.judgeCalls,
          total: snap.totalPairs,
          startedAt,
        });
      }
    : undefined;

  const resolveOpts: {
    judge: SemanticJudge;
    similarityThreshold?: number;
    maxJudgeCalls?: number;
    judgeConcurrency?: number;
    onProgress?: (snap: JudgeProgress) => void;
  } = { judge };
  if (args.similarityThreshold !== undefined) resolveOpts.similarityThreshold = args.similarityThreshold;
  if (args.maxJudgeCalls !== undefined) resolveOpts.maxJudgeCalls = args.maxJudgeCalls;
  if (args.judgeConcurrency !== undefined) resolveOpts.judgeConcurrency = args.judgeConcurrency;
  if (onProgress !== undefined) resolveOpts.onProgress = onProgress;
  const write = args.write !== false;
  try {
    const result = await resolveTopics(blocks, resolveOpts);
    // Phase 7 extension (write mode):
    //   - Write `file-candidates-map.yaml` so the read-enrich hook can
    //     do O(1) per-file candidate-count lookups instead of scanning
    //     the whole topic-index per Read.
    //   - Run `_rejected.yaml` GC against the freshly-built slug set,
    //     dropping rejection records whose source has been deleted /
    //     renamed since the last build. Centralizing GC here keeps
    //     index maintenance owned by the index-builder.
    // Preview mode (write:false) resolves identically but mutates no map
    // — the resync re-cluster previews before overwriting the live index.
    const topicIndexAbs = write
      ? writeTopicIndex(args.repoRoot, result.topicIndex)
      : topicIndexPath(args.repoRoot);
    const anchorMapAbs = write
      ? writeAnchorMap(args.repoRoot, result.anchorMap)
      : anchorMapPath(args.repoRoot);
    const fileCandidatesMapAbs = write
      ? writeFileCandidatesMap(args.repoRoot, result.topicIndex)
      : fileCandidatesMapPath(args.repoRoot);
    const fileCandidates = perFileCandidateCounts(result.topicIndex);
    const rejectedGcDropped = write ? runRejectedGc(args.repoRoot, result.topicIndex) : [];
    if (emitProgress) clearProgress(args.repoRoot);
    return finishResult({
      result,
      blocks,
      topicIndexPath: topicIndexAbs,
      anchorMapPath: anchorMapAbs,
      fileCandidatesMapPath: fileCandidatesMapAbs,
      fileCandidates,
      rejectedGcDropped,
      tally,
    });
  } catch (err) {
    if (emitProgress) clearProgress(args.repoRoot);
    throw err;
  }
}

function perFileCandidateCounts(
  topicIndex: ResolveResult["topicIndex"],
): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of Object.values(topicIndex.topics)) {
    if (entry.dec_id !== undefined) continue;
    counts[entry.sot_source] = (counts[entry.sot_source] ?? 0) + 1;
  }
  return counts;
}

function runRejectedGc(
  repoRoot: string,
  topicIndex: ResolveResult["topicIndex"],
): string[] {
  const rejected = readRejectedYaml(repoRoot);
  if (rejected.size === 0) return [];
  const liveSlugs = new Set(Object.keys(topicIndex.topics));
  const cleaned = gcRejectedYaml(rejected, liveSlugs);
  const dropped: string[] = [];
  for (const slug of rejected.keys()) {
    if (!cleaned.has(slug)) dropped.push(slug);
  }
  if (dropped.length > 0 || cleaned.size !== rejected.size) {
    writeRejectedYaml(repoRoot, cleaned);
  }
  return dropped;
}

function finishResult(args: {
  result: ResolveResult;
  blocks: ProseBlock[];
  topicIndexPath: string;
  anchorMapPath: string;
  fileCandidatesMapPath: string;
  fileCandidates: Record<string, number>;
  rejectedGcDropped: string[];
  tally: JudgeTally;
}): BuildTopicIndexResult {
  const {
    result,
    blocks,
    topicIndexPath,
    anchorMapPath,
    fileCandidatesMapPath,
    fileCandidates,
    rejectedGcDropped,
    tally,
  } = args;

  log.info(
    {
      blockCount: blocks.length,
      verbatim: result.verbatimCollisions,
      semantic: result.semanticCollisions,
      judgeCalls: result.judgeCalls,
      judgeCached: tally.cached,
      judgeFresh: tally.fresh,
      judgeErrors: tally.errors,
      filesWithCandidates: Object.keys(fileCandidates).length,
      rejectedGcDropped: rejectedGcDropped.length,
    },
    "phase 7-topic-index built",
  );

  return {
    ...result,
    blockCount: blocks.length,
    topicIndexPath,
    anchorMapPath,
    fileCandidatesMapPath,
    fileCandidates,
    rejectedGcDropped,
    judgeCached: tally.cached,
    judgeFresh: tally.fresh,
    judgeErrors: tally.errors,
  };
}

export { walkProseBlocks } from "./walk.js";
export type { ProseBlock, ProseBlockKind } from "./walk.js";
export { resolveTopics } from "./resolve.js";
export type { ResolveOptions, ResolveResult, SemanticJudge, SemanticVerdict } from "./resolve.js";
export { makeHaikuJudge } from "./judge.js";
export type { JudgeOptions } from "./judge.js";
