/**
 * Phase 7 — topic resolver.
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

import type { AnchorMap, AnchorMapEntry, TopicIndex, TopicIndexEntry } from "@isaacriehm/cairn-state";
import {
  emptyAnchorMap,
  emptyTopicIndex,
  setAnchor,
  setTopic,
} from "@isaacriehm/cairn-state";
import { ClaudeError, isQuotaKind } from "../../claude/error.js";
import { logger } from "../../logger.js";
import { jaccard, tokenize } from "../../text/jaccard.js";
import type { ProseBlock, ProseBlockKind } from "./walk.js";
export type { ProseBlock, ProseBlockKind };

const log = logger("init.topic-index.resolve");

/**
 * Bail the rest of phase 7 after this many consecutive judge failures of
 * ANY kind. Any sustained failure mode (timeout, overloaded, rate-limited
 * via wording the regex didn't catch, broken pipe, JSON parse glitch on
 * every call) means subsequent calls will almost certainly fail too;
 * continuing would burn `TIMEOUT_MS × pair-count` of wall-time AND mask
 * the true partial-completion as a successful phase output. Quota / auth
 * errors trip the breaker on the first occurrence.
 *
 * Crucially, a breaker trip caused by quota/auth — or by reaching this
 * consecutive-fail threshold — surfaces as a thrown error from
 * `resolveTopics`, not a degraded-but-successful result. Phase 7 wraps
 * that as `status: "error"` so the orchestrator stops instead of
 * advancing on a partial topic index.
 */
const CONSECUTIVE_FAIL_BAIL = 5;

export type SemanticVerdict = "same" | "different";

export type SemanticJudge = (args: { a: ProseBlock; b: ProseBlock }) => Promise<SemanticVerdict>;

export interface JudgeProgress {
  /** Judge calls dispatched so far (counts attempts, not just successes). */
  judgeCalls: number;
  /** Total candidate pairs above the similarity threshold. */
  totalPairs: number;
}

export interface ResolveOptions {
  judge: SemanticJudge;
  /** Min Jaccard similarity to call the judge (plan §5.1: 0.6). */
  similarityThreshold?: number;
  /** Hard cap on judge calls — guard against pathological cross-source collisions. */
  maxJudgeCalls?: number;
  /**
   * Max concurrent judge calls. Defaults to 5. Each call spawns a
   * `claude --print` subprocess; concurrency trades subprocess RAM for
   * wall-clock speedup. Operator's coding-plan quota is unchanged —
   * total Haiku spend is identical to sequential.
   */
  judgeConcurrency?: number;
  /**
   * Fired after each judge call resolves (success or failure). Used by
   * phase 7 to write `.cairn/init/progress.json` so the statusline can
   * render `phase 7-topic-index X/Y pairs` while the phase runs.
   */
  onProgress?: (snap: JudgeProgress) => void;
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

  // Pass 1 — collect every candidate pair (i,j) above threshold.
  // Pure CPU/memory work, no subprocess. Building the pair list up
  // front gives us an honest `totalPairs` for progress reporting and
  // lets pass 2 dispatch a flat worker pool instead of nested loops.
  type CandidatePair = { i: number; j: number; a: ProseBlock; b: ProseBlock };
  const pairs: CandidatePair[] = [];
  for (let i = 0; i < reps.length; i += 1) {
    for (let j = i + 1; j < reps.length; j += 1) {
      const a = reps[i]!;
      const b = reps[j]!;
      if (a.kind === b.kind && a.file === b.file) continue;
      const score = jaccard(repTokens[i]!, repTokens[j]!);
      if (score < similarityThreshold) continue;
      pairs.push({ i, j, a, b });
    }
  }
  const semanticCollisions = pairs.length;

  // Pass 2 — bounded-concurrency judge pool. Each worker drains the
  // shared `nextIdx` cursor and races a Haiku verdict per pair.
  const concurrency = Math.max(1, opts.judgeConcurrency ?? 5);
  let judgeCalls = 0;
  let unresolvedAmbiguous = 0;
  let consecutiveFails = 0;
  let judgeBroken = false;
  /**
   * First fatal error encountered. Set when:
   *   - quota/auth error (immediate trip — no point retrying), OR
   *   - the consecutive-fail threshold trips on any error kind.
   * Re-thrown after Promise.all so phase 7 surfaces as an error and
   * the orchestrator does NOT advance on a partial topic index.
   * Non-fatal soft failures (isolated parse glitch, single timeout)
   * still count toward `unresolvedAmbiguous` and let the phase finish.
   */
  let firstFatalErr: Error | null = null;
  let nextIdx = 0;
  const sameVerdicts: { i: number; j: number }[] = [];

  const worker = async (): Promise<void> => {
    for (;;) {
      if (judgeBroken) return;
      // Cap counts dispatched attempts, not successes — otherwise a
      // timeout storm could blow past it. The `judgeCalls += 1` claim
      // happens before `await`, so the cap is honored even with
      // concurrent workers (small over-shoot bounded by `concurrency`).
      if (judgeCalls >= maxJudgeCalls) return;
      const idx = nextIdx;
      nextIdx += 1;
      if (idx >= pairs.length) return;
      const pair = pairs[idx]!;
      judgeCalls += 1;
      try {
        const verdict = await opts.judge({ a: pair.a, b: pair.b });
        consecutiveFails = 0;
        if (verdict === "same") sameVerdicts.push({ i: pair.i, j: pair.j });
      } catch (err) {
        unresolvedAmbiguous += 1;
        consecutiveFails += 1;
        if (err instanceof ClaudeError) {
          if (err.kind === "auth" || isQuotaKind(err.kind)) {
            log.warn({ kind: err.kind }, "phase 7 judge bailed on quota/auth error");
            if (firstFatalErr === null) firstFatalErr = err;
            judgeBroken = true;
          }
        }
        if (!judgeBroken && consecutiveFails >= CONSECUTIVE_FAIL_BAIL) {
          log.warn(
            { consecutiveFails, errKind: err instanceof ClaudeError ? err.kind : "non-claude" },
            "phase 7 judge bailed after consecutive fails; surfacing as phase error",
          );
          if (firstFatalErr === null) {
            firstFatalErr = err instanceof Error ? err : new Error(String(err));
          }
          judgeBroken = true;
        }
      }
      if (opts.onProgress !== undefined) {
        opts.onProgress({ judgeCalls, totalPairs: pairs.length });
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => worker()));

  // Surface fatal failure to phase 7. Doing this before applying merges
  // / writing topicIndex prevents a partial topic-index from being
  // written to ground state when quota / auth / sustained failures
  // mean the resolver never got a clean run.
  if (firstFatalErr !== null) throw firstFatalErr;

  // Apply union-find merges from successful "same" verdicts. Done after
  // all workers finish so concurrent verdicts can't race the merge map.
  // Order doesn't affect the final equivalence classes — union is
  // commutative for this PRIORITY-tie-break scheme.
  for (const v of sameVerdicts) union(v.i, v.j);

  // Pairs that the breaker / cap skipped never got a verdict — preserve
  // the old contract by counting them as unresolved.
  const skipped = Math.max(0, pairs.length - judgeCalls);
  unresolvedAmbiguous += skipped;

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
    // Marker resolution: SoT wins, but if the SoT has no marker we
    // surface any candidate's marker so an operator's opt-in inside
    // a lower-priority source isn't lost just because docs/* won the
    // tie-break. "decision" beats "rule" when both kinds appear in
    // the same equivalence class — phase 8 only acts on this for
    // `kind="decision"|"rule"` so the choice doesn't matter for
    // emit semantics, but it keeps the field deterministic.
    const entryMarker = resolveMarker(sot, memberBlocks);
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
      content_hash: sot.content_hash,
    };
    if (entryMarker !== undefined) entry.marker_kind = entryMarker;
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

function resolveMarker(
  sot: ProseBlock,
  members: ProseBlock[],
): ProseBlock["marker_kind"] | undefined {
  if (sot.marker_kind !== undefined) return sot.marker_kind;
  // Prefer "decision" if any candidate flags it; otherwise "rule".
  let sawRule = false;
  for (const b of members) {
    if (b.marker_kind === "decision") return "decision";
    if (b.marker_kind === "rule") sawRule = true;
  }
  return sawRule ? "rule" : undefined;
}
