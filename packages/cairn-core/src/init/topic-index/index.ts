/**
 * Phase 5b — topic-index build orchestration.
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
  gcRejectedYaml,
  readRejectedYaml,
  writeAnchorMap,
  writeFileCandidatesMap,
  writeRejectedYaml,
  writeTopicIndex,
} from "../../ground/index.js";
import { clearProgress, writeProgress } from "../progress.js";
import { makeHaikuJudge } from "./judge.js";
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
   * statusline can render `phase-5b X/Y pairs`. Smokes opt out.
   */
  emitProgress?: boolean;
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
}

export async function buildTopicIndex(
  args: BuildTopicIndexArgs,
): Promise<BuildTopicIndexResult> {
  const blocks = args.blocks ?? walkProseBlocks(args.repoRoot);
  const judge = args.judge ?? makeHaikuJudge({ repoRoot: args.repoRoot });

  log.debug({ blockCount: blocks.length }, "phase-5b walk complete");

  const emitProgress = args.emitProgress !== false;
  const startedAt = Date.now();
  const onProgress = emitProgress
    ? (snap: JudgeProgress): void => {
        writeProgress(args.repoRoot, {
          phase: "5b-topic-index",
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
  try {
    const result = await resolveTopics(blocks, resolveOpts);
    const topicIndexPath = writeTopicIndex(args.repoRoot, result.topicIndex);
    const anchorMapPath = writeAnchorMap(args.repoRoot, result.anchorMap);
    // Phase 5b extension:
    //   - Write `file-candidates-map.yaml` so the read-enrich hook can
    //     do O(1) per-file candidate-count lookups instead of scanning
    //     the whole topic-index per Read.
    //   - Run `_rejected.yaml` GC against the freshly-built slug set,
    //     dropping rejection records whose source has been deleted /
    //     renamed since the last build. Centralizing GC here keeps
    //     index maintenance owned by the index-builder.
    const fileCandidatesMapAbs = writeFileCandidatesMap(args.repoRoot, result.topicIndex);
    const fileCandidates = perFileCandidateCounts(result.topicIndex);
    const rejectedGcDropped = runRejectedGc(args.repoRoot, result.topicIndex);
    if (emitProgress) clearProgress(args.repoRoot);
    return finishResult({
      result,
      blocks,
      topicIndexPath,
      anchorMapPath,
      fileCandidatesMapPath: fileCandidatesMapAbs,
      fileCandidates,
      rejectedGcDropped,
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
}): BuildTopicIndexResult {
  const {
    result,
    blocks,
    topicIndexPath,
    anchorMapPath,
    fileCandidatesMapPath,
    fileCandidates,
    rejectedGcDropped,
  } = args;

  log.info(
    {
      blockCount: blocks.length,
      verbatim: result.verbatimCollisions,
      semantic: result.semanticCollisions,
      judgeCalls: result.judgeCalls,
      filesWithCandidates: Object.keys(fileCandidates).length,
      rejectedGcDropped: rejectedGcDropped.length,
    },
    "phase-5b topic-index built",
  );

  return {
    ...result,
    blockCount: blocks.length,
    topicIndexPath,
    anchorMapPath,
    fileCandidatesMapPath,
    fileCandidates,
    rejectedGcDropped,
  };
}

export { walkProseBlocks } from "./walk.js";
export type { ProseBlock, ProseBlockKind } from "./walk.js";
export { resolveTopics } from "./resolve.js";
export type { ResolveOptions, ResolveResult, SemanticJudge, SemanticVerdict } from "./resolve.js";
export { makeHaikuJudge } from "./judge.js";
export type { JudgeOptions } from "./judge.js";
