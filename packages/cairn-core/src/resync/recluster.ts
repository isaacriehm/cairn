/**
 * `cairn resync --recluster` — the LLM half of re-discovery (Stage 3b).
 *
 * The deterministic config-resync (`runResync`) re-points moved entities and
 * patches `config.yaml`, but it can't notice that the project's *prose* has
 * grown a new concept or that two now-separate docs describe the same topic.
 * That re-clustering is what init's Phase 7 does with a Haiku judge; this verb
 * re-runs exactly that pass over the grown tree.
 *
 * Why it's a distinct, opt-in verb (not folded into `runResync` or a sensor):
 *   - It spends Haiku. The judge fires for every fresh semantic-similarity
 *     collision, so it's quota-gated — never auto-run, never on a hook.
 *   - The on-disk judge cache makes it *incremental for free* (Q3): unchanged
 *     prose pairs hit the cache (no quota burn); only genuinely-new prose
 *     produces fresh judge calls. `judgeFresh` is the real cost of a re-run.
 *
 * Safety (Q23): the maps are gitignored, per-clone derived state — overwriting
 * them is not a committed mutation and raises no multi-dev conflict (Q22). Even
 * so, apply archives the pre-resync `topic-index.yaml` + `anchor-map.yaml` to
 * `.cairn/ground/.archive/` first (a bad re-cluster is recoverable), and
 * `--dry-run` (the default) resolves + reports without overwriting anything.
 *
 * The judge is injected (`opts.judge`) so the gate smoke drives a deterministic
 * mock — same runner seam Phase 7 already exposes — and burns zero quota.
 */

import { anchorMapPath, readTopicIndex, topicIndexPath } from "@isaacriehm/cairn-state";
import { buildTopicIndex } from "../init/topic-index/index.js";
import type { ProseBlock, SemanticJudge } from "../init/topic-index/resolve.js";
import { archiveFile } from "./archive.js";

export interface ResyncReclusterOptions {
  repoRoot: string;
  /** Preview only — resolve + report but DON'T overwrite the maps. Default true (safe). */
  dryRun?: boolean;
  /** Judge seam — smokes inject a deterministic mock to avoid Haiku. */
  judge?: SemanticJudge;
  /** Walker seam — smokes inject canned blocks instead of walking the tree. */
  blocks?: ProseBlock[];
  /** Hard cap on judge calls (passed through to the resolver). */
  maxJudgeCalls?: number;
  /** Injected ISO for archive filenames (determinism in tests). */
  nowIso?: string;
}

export interface ResyncReclusterResult {
  dryRun: boolean;
  applied: boolean;
  /** Distinct topic count before / after the re-cluster. */
  topicsBefore: number;
  topicsAfter: number;
  /** Prose blocks walked. */
  blockCount: number;
  /** Total judge calls dispatched (fresh + cached). */
  judgeCalls: number;
  /** Fresh `claude --print` judge calls — the real quota cost of this run. */
  judgeFresh: number;
  /** Judge calls served from the on-disk cache (no quota burn). */
  judgeCached: number;
  /** Judge calls that threw. */
  judgeErrors: number;
  /** Repo-relative paths of the archived pre-resync maps (apply only). */
  archivedMaps: string[];
}

export async function runResyncRecluster(
  opts: ResyncReclusterOptions,
): Promise<ResyncReclusterResult> {
  const dryRun = opts.dryRun !== false; // default true (safe)
  const topicsBefore = Object.keys(readTopicIndex(opts.repoRoot).topics).length;

  // On apply, snapshot the live maps before the rebuild overwrites them.
  const archivedMaps: string[] = [];
  if (!dryRun) {
    const nowIso = opts.nowIso ?? new Date().toISOString();
    for (const [abs, base] of [
      [topicIndexPath(opts.repoRoot), "topic-index.yaml"],
      [anchorMapPath(opts.repoRoot), "anchor-map.yaml"],
    ] as const) {
      const archived = archiveFile(abs, opts.repoRoot, base, nowIso);
      if (archived !== null) archivedMaps.push(archived);
    }
  }

  const result = await buildTopicIndex({
    repoRoot: opts.repoRoot,
    write: !dryRun,
    emitProgress: false,
    ...(opts.judge !== undefined ? { judge: opts.judge } : {}),
    ...(opts.blocks !== undefined ? { blocks: opts.blocks } : {}),
    ...(opts.maxJudgeCalls !== undefined ? { maxJudgeCalls: opts.maxJudgeCalls } : {}),
  });

  return {
    dryRun,
    applied: !dryRun,
    topicsBefore,
    topicsAfter: Object.keys(result.topicIndex.topics).length,
    blockCount: result.blockCount,
    judgeCalls: result.judgeCalls,
    judgeFresh: result.judgeFresh,
    judgeCached: result.judgeCached,
    judgeErrors: result.judgeErrors,
    archivedMaps,
  };
}
