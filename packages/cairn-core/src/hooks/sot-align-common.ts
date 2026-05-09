/**
 * Shared SoT-alignment helpers used by both Layer A (PostToolUse hook,
 * `hooks/post-tool-use/sot-align.ts`) and Layer B (git pre-commit
 * hook, `hooks/pre-commit/sot-align-precommit.ts`). The Tier 1
 * deterministic match (Jaccard ≥ 0.85, 3-shingle ≥ 0.6, length ratio
 * 0.5–2.0) and the Jaccard top-K candidate pre-filter live here so
 * both layers compare against the same calibrated thresholds.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { jaccard, tokenize } from "../text/jaccard.js";
import {
  decisionsDir,
  invariantsDir,
  type CommentBlock,
  type SotCacheEntry,
} from "@isaacriehm/cairn-state";
import { walkSourceComments } from "../init/source-comments/walker.js";

/* -------------------------------------------------------------------------- */
/* Tunables — shared between Layer A and Layer B                              */
/* -------------------------------------------------------------------------- */

// Tier 1 deterministic floors — internal to `tier1PickWithBody`.
const TIER1_JACCARD_FLOOR = 0.85;
const TIER1_SHINGLE_FLOOR = 0.6;
const TIER1_LENGTH_RATIO_MIN = 0.5;
const TIER1_LENGTH_RATIO_MAX = 2.0;

// Jaccard pre-filter floors — exposed because Layer A and Layer B
// both pass them into `topKCandidates`.
export const TIER2_JACCARD_FLOOR = 0.3;
export const TOP_K_CANDIDATES = 5;

/* -------------------------------------------------------------------------- */
/* File-type guard                                                            */
/* -------------------------------------------------------------------------- */

export function isMarkdownPath(filePath: string): boolean {
  return filePath.endsWith(".md") || filePath.endsWith(".mdx");
}

/* -------------------------------------------------------------------------- */
/* Block extraction — wraps phase 7b's walker                                 */
/* -------------------------------------------------------------------------- */

/**
 * Extract prose blocks from the given file. License headers are
 * filtered out — they are operator-supplied legal text and never the
 * subject of a decision/invariant cite.
 */
export function extractBlocks(repoRoot: string, filePath: string): CommentBlock[] {
  const walk = walkSourceComments({
    repoRoot,
    onlyFiles: [filePath],
  });
  return walk.blocks.filter((b) => b.kind !== "license");
}

/* -------------------------------------------------------------------------- */
/* Jaccard pre-filter                                                         */
/* -------------------------------------------------------------------------- */

export interface Candidate {
  id: string;
  similarity: number;
  body_hash: string;
  sot_path: string;
}

export function topKCandidates(
  blockTokens: Set<string>,
  entries: SotCacheEntry[],
  threshold: number,
  topK: number,
): Candidate[] {
  const scored: Candidate[] = [];
  for (const e of entries) {
    const candidateTokens = new Set(e.tokens);
    const score = jaccard(blockTokens, candidateTokens);
    if (score < threshold) continue;
    scored.push({
      id: e.dec_id,
      similarity: score,
      body_hash: e.body_hash,
      sot_path: e.sot_path,
    });
  }
  scored.sort((a, b) => b.similarity - a.similarity);
  return scored.slice(0, topK);
}

/* -------------------------------------------------------------------------- */
/* Tier 1 deterministic match                                                 */
/* -------------------------------------------------------------------------- */

function shingleSet(text: string, n: number): Set<string> {
  const cleaned = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const tokens = cleaned.split(" ").filter((w) => w.length > 0);
  if (tokens.length < n) return new Set([cleaned]);
  const out = new Set<string>();
  for (let i = 0; i <= tokens.length - n; i += 1) {
    out.add(tokens.slice(i, i + n).join(" "));
  }
  return out;
}

function shingleOverlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0;
  for (const s of a) if (b.has(s)) inter += 1;
  // Symmetric Jaccard — `min(|a|,|b|)` would let a short fragment of a
  // long DEC pass Tier 1 even though the bodies aren't really verbatim
  // duplicates. The length-ratio bound (0.5-2.0) constrains this, but
  // Jaccard makes the threshold mean the same thing in both directions.
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

function lengthRatio(a: string, b: string): number {
  if (b.length === 0) return Number.POSITIVE_INFINITY;
  return a.length / b.length;
}

/**
 * Walk the top-K candidates and return the first one whose body
 * passes all Tier 1 floors against the block prose. Returns null when
 * no candidate qualifies. Reads the candidate body from the live
 * ledger via `readEntityBody`.
 */
export function tier1PickWithBody(
  repoRoot: string,
  block: CommentBlock,
  candidates: Candidate[],
): Candidate | null {
  if (candidates.length === 0) return null;
  const blockShingles = shingleSet(block.prose, 3);
  for (const cand of candidates) {
    if (cand.similarity < TIER1_JACCARD_FLOOR) continue;
    const candBody = readEntityBody(repoRoot, cand.id);
    if (candBody === null) continue;
    const overlap = shingleOverlap(blockShingles, shingleSet(candBody, 3));
    if (overlap < TIER1_SHINGLE_FLOOR) continue;
    const ratio = lengthRatio(block.prose, candBody);
    if (ratio < TIER1_LENGTH_RATIO_MIN || ratio > TIER1_LENGTH_RATIO_MAX) continue;
    return cand;
  }
  return null;
}

/* -------------------------------------------------------------------------- */
/* Ledger body reader                                                         */
/* -------------------------------------------------------------------------- */

/**
 * Read the body (post-frontmatter) of a DEC/INV by id. Returns null
 * when the entity file is missing or unreadable. Strips the leading
 * `---\n…\n---\n?` frontmatter block when present.
 */
export function readEntityBody(repoRoot: string, id: string): string | null {
  if (repoRoot.length === 0) return null;
  const dir = id.startsWith("INV-") ? invariantsDir(repoRoot) : decisionsDir(repoRoot);
  const abs = join(dir, `${id}.md`);
  if (!existsSync(abs)) return null;
  let raw: string;
  try {
    raw = readFileSync(abs, "utf8");
  } catch {
    return null;
  }
  const m = raw.match(/^---\n[\s\S]*?\n---\n?/);
  return m === null ? raw.trim() : raw.slice(m[0].length).trim();
}
