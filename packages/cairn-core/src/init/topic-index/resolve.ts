/**
 * Phase 5b — topic resolver.
 *
 * Given the prose blocks discovered by `walk.ts`, build the
 * TopicIndex (`{slug: entry}`) and AnchorMap (`{slug: location}`)
 * that phases 6 / 7b / 7c will consult before emitting any DEC.
 *
 * Two collision modes are reconciled here:
 *
 *   1. Verbatim collision — multiple sources share the same content
 *      fingerprint slug. The highest-priority source becomes the SoT;
 *      every other location is recorded as a candidate. The candidate
 *      list is what phases 6/7b/7c use to decide where to emit a
 *      §DEC-<hash> cite instead of a fresh DEC.
 *
 *   2. Semantic-similarity collision — different slugs, but Jaccard
 *      similarity ≥ 0.6 across kinds. A Haiku judge decides whether
 *      they describe the *same* topic. If yes, both slugs collapse
 *      into one entry; if no, they remain distinct.
 *
 * Priority order (operator-confirmed, plan §5.1):
 *
 *     docs/* > CLAUDE.md > AGENTS.md > .claude/rules/* > source-comments
 *
 * The judge call is parameterized so the smoke can mock it without
 * hitting the API.
 */

import type { AnchorMap, AnchorMapEntry, TopicIndex, TopicIndexEntry } from "../../ground/schemas.js";
import {
  emptyAnchorMap,
  emptyTopicIndex,
  setAnchor,
  setTopic,
} from "../../ground/index.js";
import { jaccard, tokenize } from "../../text/jaccard.js";
import type { ProseBlock, ProseBlockKind } from "./walk.js";

export type SemanticVerdict = "same" | "different";

export type SemanticJudge = (args: { a: ProseBlock; b: ProseBlock }) => Promise<SemanticVerdict>;

export interface ResolveOptions {
  judge: SemanticJudge;
  /** Min Jaccard similarity to call the judge (plan §5.1: 0.6). */
  similarityThreshold?: number;
  /** Hard cap on judge calls — guard against pathological cross-source collisions. */
  maxJudgeCalls?: number;
}

export interface ResolveResult {
  topicIndex: TopicIndex;
  anchorMap: AnchorMap;
  verbatimCollisions: number;
  semanticCollisions: number;
  judgeCalls: number;
  unresolvedAmbiguous: number;
}

const PRIORITY: Record<ProseBlockKind, number> = {
  doc: 0,
  claudemd: 1,
  agentsmd: 2,
  rule: 3,
  "source-comment": 4,
};

/* -------------------------------------------------------------------------- */
/* Public entry point                                                         */
/* -------------------------------------------------------------------------- */

export async function resolveTopics(
  blocks: ProseBlock[],
  opts: ResolveOptions,
): Promise<ResolveResult> {
  const similarityThreshold = opts.similarityThreshold ?? 0.6;
  const maxJudgeCalls = opts.maxJudgeCalls ?? 200;

  const buckets = bucketBySlug(blocks);
  const verbatimCollisions = countCollidingBuckets(buckets);

  const candidateGroups: ProseBlock[][] = Object.values(buckets);

  const tokenCache = new Map<string, Set<string>>();
  const tokenizeCached = (slug: string, body: string): Set<string> => {
    const hit = tokenCache.get(slug);
    if (hit !== undefined) return hit;
    const t = tokenize(body, { codeAware: true });
    tokenCache.set(slug, t);
    return t;
  };

  const reps: ProseBlock[] = candidateGroups.map((g) => pickSotByPriority(g));
  const repTokens = reps.map((r) => tokenizeCached(r.slug, r.body));

  const groupOf = new Map<string, number>();
  candidateGroups.forEach((group, idx) => {
    for (const block of group) groupOf.set(block.slug, idx);
  });

  const merge: Map<number, number> = new Map();
  const find = (i: number): number => {
    const parent = merge.get(i);
    if (parent === undefined || parent === i) return i;
    const root = find(parent);
    merge.set(i, root);
    return root;
  };
  const union = (i: number, j: number): void => {
    const ri = find(i);
    const rj = find(j);
    if (ri === rj) return;
    if (PRIORITY[reps[ri]!.kind] <= PRIORITY[reps[rj]!.kind]) {
      merge.set(rj, ri);
    } else {
      merge.set(ri, rj);
    }
  };

  let semanticCollisions = 0;
  let judgeCalls = 0;
  let unresolvedAmbiguous = 0;

  for (let i = 0; i < reps.length && judgeCalls < maxJudgeCalls; i += 1) {
    for (let j = i + 1; j < reps.length && judgeCalls < maxJudgeCalls; j += 1) {
      const a = reps[i]!;
      const b = reps[j]!;
      if (a.kind === b.kind && a.file === b.file) continue;
      const score = jaccard(repTokens[i]!, repTokens[j]!);
      if (score < similarityThreshold) continue;
      semanticCollisions += 1;
      let verdict: SemanticVerdict;
      try {
        verdict = await opts.judge({ a, b });
      } catch {
        unresolvedAmbiguous += 1;
        continue;
      }
      judgeCalls += 1;
      if (verdict === "same") union(i, j);
    }
  }

  let topicIndex: TopicIndex = emptyTopicIndex();
  let anchorMap: AnchorMap = emptyAnchorMap();
  const seenRoots = new Set<number>();

  for (let i = 0; i < reps.length; i += 1) {
    const root = find(i);
    if (seenRoots.has(root)) continue;
    seenRoots.add(root);

    const memberIdx: number[] = [];
    for (let k = 0; k < reps.length; k += 1) {
      if (find(k) === root) memberIdx.push(k);
    }
    const memberBlocks: ProseBlock[] = [];
    for (const idx of memberIdx) {
      memberBlocks.push(...candidateGroups[idx]!);
    }
    const sot = pickSotByPriority(memberBlocks);
    const slug = sot.slug;
    const entry: TopicIndexEntry = {
      slug,
      sot_source: sot.file,
      candidates: memberBlocks.map((b) => {
        const candidate: TopicIndexEntry["candidates"][number] = {
          file: b.file,
          kind: b.kind,
          line_range: b.line_range,
        };
        if (b.anchor !== undefined) candidate.anchor = b.anchor;
        return candidate;
      }),
      created_at: new Date().toISOString(),
    };
    topicIndex = setTopic(topicIndex, slug, entry);

    const sotAnchor: AnchorMapEntry = {
      file: sot.file,
      content_hash: sot.content_hash,
      line_range: sot.line_range,
      kind: sot.kind,
    };
    if (sot.anchor !== undefined) sotAnchor.current_anchor = sot.anchor;
    anchorMap = setAnchor(anchorMap, slug, sotAnchor);
  }

  return {
    topicIndex,
    anchorMap,
    verbatimCollisions,
    semanticCollisions,
    judgeCalls,
    unresolvedAmbiguous,
  };
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function bucketBySlug(blocks: ProseBlock[]): Record<string, ProseBlock[]> {
  const out: Record<string, ProseBlock[]> = {};
  for (const b of blocks) {
    const bucket = out[b.slug];
    if (bucket === undefined) {
      out[b.slug] = [b];
    } else {
      bucket.push(b);
    }
  }
  return out;
}

function countCollidingBuckets(buckets: Record<string, ProseBlock[]>): number {
  let n = 0;
  for (const arr of Object.values(buckets)) {
    if (arr.length > 1) n += 1;
  }
  return n;
}

function pickSotByPriority(blocks: ProseBlock[]): ProseBlock {
  const sorted = [...blocks].sort((x, y) => {
    const p = PRIORITY[x.kind] - PRIORITY[y.kind];
    if (p !== 0) return p;
    return x.file.localeCompare(y.file);
  });
  return sorted[0]!;
}
