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
import { writeAnchorMap, writeTopicIndex } from "../../ground/index.js";
import { makeHaikuJudge } from "./judge.js";
import { resolveTopics, type ResolveResult, type SemanticJudge } from "./resolve.js";
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
}

export interface BuildTopicIndexResult extends ResolveResult {
  blockCount: number;
  topicIndexPath: string;
  anchorMapPath: string;
}

export async function buildTopicIndex(
  args: BuildTopicIndexArgs,
): Promise<BuildTopicIndexResult> {
  const blocks = args.blocks ?? walkProseBlocks(args.repoRoot);
  const judge = args.judge ?? makeHaikuJudge({ repoRoot: args.repoRoot });

  log.debug({ blockCount: blocks.length }, "phase-5b walk complete");

  const resolveOpts: { judge: SemanticJudge; similarityThreshold?: number; maxJudgeCalls?: number } = { judge };
  if (args.similarityThreshold !== undefined) resolveOpts.similarityThreshold = args.similarityThreshold;
  if (args.maxJudgeCalls !== undefined) resolveOpts.maxJudgeCalls = args.maxJudgeCalls;
  const result = await resolveTopics(blocks, resolveOpts);
  const topicIndexPath = writeTopicIndex(args.repoRoot, result.topicIndex);
  const anchorMapPath = writeAnchorMap(args.repoRoot, result.anchorMap);

  log.info(
    {
      blockCount: blocks.length,
      verbatim: result.verbatimCollisions,
      semantic: result.semanticCollisions,
      judgeCalls: result.judgeCalls,
    },
    "phase-5b topic-index built",
  );

  return {
    ...result,
    blockCount: blocks.length,
    topicIndexPath,
    anchorMapPath,
  };
}

export { walkProseBlocks } from "./walk.js";
export type { ProseBlock, ProseBlockKind } from "./walk.js";
export { resolveTopics } from "./resolve.js";
export type { ResolveOptions, ResolveResult, SemanticJudge, SemanticVerdict } from "./resolve.js";
export { makeHaikuJudge } from "./judge.js";
export type { JudgeOptions } from "./judge.js";
