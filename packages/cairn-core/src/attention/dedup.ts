/**
 * Deterministic near-duplicate detection for DEC drafts.
 *
 * On a busy monorepo Phase 7b can emit several hundred DEC drafts; many
 * are the same idea expressed in multiple files (a shared utility
 * pattern documented identically across consumers, identical guard
 * clauses repeated by file boundary, etc.). Dragging the operator
 * through hundreds of per-draft triage prompts when a meaningful slice
 * of them are obvious duplicates is a UX failure.
 *
 * This module clusters drafts by token-Jaccard similarity (no LLM calls,
 * no network). Stopwords stripped, simple stem (drop trailing
 * `s` / `ed` / `ing`), tokens >= 3 chars only. Two thresholds:
 *   - `>= 0.5` → definite duplicates → merge-by-default in the skill
 *   - `0.4–0.5` → potential duplicates → flagged for review
 *
 * Output is deliberately a pure data structure — the skill renders. The
 * CLI subcommand wraps `findDuplicateClusters` for `--dry-run` previews.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { decisionsDir } from "../ground/paths.js";

/* -------------------------------------------------------------------------- */
/* Tokenization                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Stopwords. Hard-coded English set plus a handful of cairn-domain
 * terms that appear in nearly every draft and would otherwise dominate
 * Jaccard scores ("rationale", "decision").
 */
const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "of", "in", "on", "to", "for", "with",
  "by", "from", "is", "are", "was", "were", "be", "been", "being", "has",
  "have", "had", "do", "does", "did", "this", "that", "these", "those",
  "it", "its", "as", "at", "but", "if", "than", "so", "use", "used",
  "using", "via", "out", "off", "up", "our", "their", "one", "two",
  "when", "where", "what", "how", "why", "who", "which", "can", "should",
  "must", "will", "shall", "may", "not", "no", "any", "all", "some",
  "few", "more", "most", "only", "also",
]);

/** Default char window of body to fold into the token bag. */
const BODY_CHAR_WINDOW = 500;

function stem(w: string): string {
  if (w.length <= 4) return w;
  if (w.endsWith("ing")) return w.slice(0, -3);
  if (w.endsWith("ed")) return w.slice(0, -2);
  if (w.endsWith("s") && !w.endsWith("ss")) return w.slice(0, -1);
  return w;
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .map(stem)
      .filter((w) => w.length >= 3 && !STOPWORDS.has(w)),
  );
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter += 1;
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

/* -------------------------------------------------------------------------- */
/* Frontmatter parse (lightweight; no yaml dep)                               */
/* -------------------------------------------------------------------------- */

interface MinimalFrontmatter {
  id?: string;
  title?: string;
  sourceFile?: string;
  capture_source?: string;
  capture_confidence?: string;
}

function parseMinimalFrontmatter(raw: string): {
  fm: MinimalFrontmatter;
  body: string;
} {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (m === null || m[1] === undefined || m[2] === undefined) {
    return { fm: {}, body: raw };
  }
  const fm: MinimalFrontmatter = {};
  for (const line of m[1].split("\n")) {
    const lm = line.match(/^(\w[\w-]*):\s*(.*)$/);
    if (lm === null || lm[1] === undefined || lm[2] === undefined) continue;
    const key = lm[1];
    const val = lm[2].trim().replace(/^["']|["']$/g, "");
    if (key === "id" || key === "title" || key === "sourceFile" || key === "capture_source" || key === "capture_confidence") {
      fm[key] = val;
    }
  }
  return { fm, body: m[2] };
}

/* -------------------------------------------------------------------------- */
/* Public types                                                               */
/* -------------------------------------------------------------------------- */

export interface DraftRef {
  /** DEC id (e.g. `DEC-a3f7b2c`). */
  id: string;
  /** Repo-relative path to the draft file in `_inbox/`. */
  path: string;
  /** Frontmatter title or fallback synthesized from filename. */
  title: string;
  /** Source file the draft was extracted from (frontmatter `sourceFile`). */
  sourceFile: string;
  /** capture_source frontmatter, e.g. `init-source-comments`. */
  source: string;
  /** capture_confidence frontmatter; null when unscored. */
  confidence: string | null;
}

export interface DuplicateCluster {
  /** Tier: `definite` (Jaccard >= 0.5) or `potential` (0.4..0.5). */
  tier: "definite" | "potential";
  /** Average pairwise Jaccard within the cluster. */
  averageSimilarity: number;
  /** Cluster members; first-listed is a stable suggested survivor (oldest mtime, then lex id). */
  drafts: DraftRef[];
}

export interface DedupResult {
  /** Total drafts scanned (everything in `_inbox/` ending `.draft.md`). */
  draftsScanned: number;
  /** All clusters at Jaccard >= 0.4. Ordered: definite first, then potential, both by size desc. */
  clusters: DuplicateCluster[];
  /** Count of drafts inside a cluster. */
  draftsInClusters: number;
  /** Reducible = sum over clusters of (members - 1). */
  reducible: number;
  /** Threshold floor used for clustering (0.4 by default). */
  thresholdFloor: number;
  /** Definite-tier threshold (0.5 by default). */
  thresholdDefinite: number;
}

/* -------------------------------------------------------------------------- */
/* Core: cluster the inbox                                                    */
/* -------------------------------------------------------------------------- */

interface InternalDoc extends DraftRef {
  tokens: Set<string>;
  mtimeMs: number;
}

/** Default tier thresholds — see module-level docstring. */
export const DEFAULT_THRESHOLD_DEFINITE = 0.5;
export const DEFAULT_THRESHOLD_FLOOR = 0.4;

/**
 * Scan `.cairn/ground/decisions/_inbox/` for `.draft.md` files and
 * return Jaccard-clustered duplicates at the two-tier thresholds. Pure
 * deterministic — same input, same output.
 */
export function findDuplicateClusters(args: {
  repoRoot: string;
  thresholdFloor?: number;
  thresholdDefinite?: number;
}): DedupResult {
  const thresholdFloor = args.thresholdFloor ?? DEFAULT_THRESHOLD_FLOOR;
  const thresholdDefinite = args.thresholdDefinite ?? DEFAULT_THRESHOLD_DEFINITE;
  const inbox = join(decisionsDir(args.repoRoot), "_inbox");
  if (!existsSync(inbox)) {
    return {
      draftsScanned: 0,
      clusters: [],
      draftsInClusters: 0,
      reducible: 0,
      thresholdFloor,
      thresholdDefinite,
    };
  }
  const files = readdirSync(inbox, { encoding: "utf8" }).filter((f) =>
    f.endsWith(".draft.md"),
  );
  const docs: InternalDoc[] = [];
  for (const f of files) {
    const abs = join(inbox, f);
    let raw: string;
    let mtimeMs: number;
    try {
      raw = readFileSync(abs, "utf8");
      mtimeMs = statSync(abs).mtimeMs;
    } catch {
      continue;
    }
    const { fm, body } = parseMinimalFrontmatter(raw);
    const id = fm.id ?? f.replace(/\.draft\.md$/, "");
    const title = fm.title ?? id;
    const text = `${title} ${body.slice(0, BODY_CHAR_WINDOW)}`;
    docs.push({
      id,
      path: `.cairn/ground/decisions/_inbox/${f}`,
      title,
      sourceFile: fm.sourceFile ?? "",
      source: fm.capture_source ?? "",
      confidence: fm.capture_confidence ?? null,
      tokens: tokenize(text),
      mtimeMs,
    });
  }
  const n = docs.length;
  if (n === 0) {
    return {
      draftsScanned: 0,
      clusters: [],
      draftsInClusters: 0,
      reducible: 0,
      thresholdFloor,
      thresholdDefinite,
    };
  }

  // Union-find for cluster merging at the floor threshold; track per-edge
  // similarities so we can compute the cluster average + tier.
  const parent: number[] = Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => {
    let cur = x;
    while (parent[cur] !== cur) {
      parent[cur] = parent[parent[cur] ?? cur] ?? cur;
      cur = parent[cur] ?? cur;
    }
    return cur;
  };
  const unite = (a: number, b: number): void => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };
  const edgeSims: { a: number; b: number; sim: number }[] = [];
  for (let i = 0; i < n; i++) {
    const di = docs[i];
    if (di === undefined) continue;
    for (let j = i + 1; j < n; j++) {
      const dj = docs[j];
      if (dj === undefined) continue;
      const sim = jaccard(di.tokens, dj.tokens);
      if (sim >= thresholdFloor) {
        edgeSims.push({ a: i, b: j, sim });
        unite(i, j);
      }
    }
  }

  const groupIndex = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const r = find(i);
    let bucket = groupIndex.get(r);
    if (bucket === undefined) {
      bucket = [];
      groupIndex.set(r, bucket);
    }
    bucket.push(i);
  }

  const clusters: DuplicateCluster[] = [];
  let draftsInClusters = 0;
  let reducible = 0;
  for (const idxs of groupIndex.values()) {
    if (idxs.length < 2) continue;
    // Average similarity = mean of edges within the cluster (over all
    // pairs, not just MST edges) for a stable tier signal.
    let total = 0;
    let count = 0;
    const set = new Set(idxs);
    for (const e of edgeSims) {
      if (set.has(e.a) && set.has(e.b)) {
        total += e.sim;
        count += 1;
      }
    }
    const avg = count === 0 ? 0 : total / count;
    const tier: "definite" | "potential" =
      avg >= thresholdDefinite ? "definite" : "potential";
    // Stable survivor pick: oldest mtime first (so the earliest-captured
    // draft becomes the canonical one), then lex id as a deterministic
    // tiebreaker. Content-addressed ids lex-sort to a random order, so
    // mtime is the meaningful signal under hash-based ids.
    const ordered = idxs
      .map((i) => docs[i])
      .filter((d): d is InternalDoc => d !== undefined);
    ordered.sort((a, b) => {
      if (a.mtimeMs !== b.mtimeMs) return a.mtimeMs - b.mtimeMs;
      return a.id.localeCompare(b.id);
    });
    clusters.push({
      tier,
      averageSimilarity: Number(avg.toFixed(3)),
      drafts: ordered.map(({ tokens: _omit, ...rest }) => rest),
    });
    draftsInClusters += idxs.length;
    reducible += idxs.length - 1;
  }
  // Definite tier first, both ordered by size desc, then avg sim desc.
  clusters.sort((a, b) => {
    if (a.tier !== b.tier) return a.tier === "definite" ? -1 : 1;
    if (a.drafts.length !== b.drafts.length) return b.drafts.length - a.drafts.length;
    return b.averageSimilarity - a.averageSimilarity;
  });

  return {
    draftsScanned: n,
    clusters,
    draftsInClusters,
    reducible,
    thresholdFloor,
    thresholdDefinite,
  };
}

