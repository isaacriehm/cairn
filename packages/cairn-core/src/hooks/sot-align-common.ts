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
/* Essay-class shape detector — diff-aware sot-align short-circuit            */
/* -------------------------------------------------------------------------- */

/**
 * Detect whether a string contains an "essay-class" comment shape
 * — JSDoc block, JSDoc continuation line, 3+ consecutive `//` lines,
 * or a Python triple-quote docstring. Used by `executeSotAlign` to
 * skip the per-Edit/per-Write Haiku dedup pass when the diff doesn't
 * touch any prose. Most Edits are mechanical (var rename, type tweak,
 * single-line bugfix) and don't change essay-class blocks; running
 * `alignFile` against the whole file's blocks for those edits burns
 * 1-30s of Haiku latency for zero signal.
 *
 * Conservative — anchors on shape markers a single-line edit usually
 * preserves (the `*` prefix on JSDoc continuation lines is the most
 * common). Cases where the regex misses (e.g. modifying one line in
 * the MIDDLE of a `// 3+` block where new_string is just one bare
 * `// foo bar` line) are a known false-negative; Layer B's
 * pre-commit pass + `cairn fix align` catch the drift on commit
 * boundary.
 */
const ESSAY_CLASS_SHAPE_RE = new RegExp(
  [
    String.raw`/\*\*[\s\S]*?\*/`,           // JSDoc block — /** ... */
    String.raw`(?:^[ \t]*//[^\n]*\n){3,}`,  // 3+ consecutive // lines (TS/JS/Go/Rust)
    String.raw`^[ \t]*"""[\s\S]*?"""`,      // Python triple-quote docstring
    String.raw`^[ \t]*\*\s+\S`,             // JSDoc continuation line — *<space><non-space>
  ].join("|"),
  "m",
);

export function containsEssayClassShape(text: string): boolean {
  if (text.length === 0) return false;
  return ESSAY_CLASS_SHAPE_RE.test(text);
}

/* -------------------------------------------------------------------------- */
/* Ledger-worthy shape gate — shared by init Phase-7b and Layer A runtime     */
/* -------------------------------------------------------------------------- */

/**
 * Constraint signal — a modal/rule keyword or an explicit `@cairn:*` /
 * `@invariant` / `@rule` / `@decision` marker. Single source of truth for
 * "does this prose state an enforceable rule" — consumed by init's Phase-7b
 * gate (`init/source-comments/ingest.ts`) AND the Layer A runtime creation
 * gate (`hooks/post-tool-use/sot-align.ts`) so the two paths can't drift.
 * The keyword list is a superset of the original Phase-7b regex; word
 * boundaries keep `FORBIDDEN` from matching inside a longer token.
 * `ONLY` is deliberately excluded — it matches inside common descriptive
 * compounds (`read-only`, `append-only`, "only used for…") and carries
 * almost no real-rule signal on its own.
 */
const CONSTRAINT_KEYWORDS_RE =
  /\b(?:MUST(?:\s+NOT)?|SHALL(?:\s+NOT)?|NEVER|ALWAYS|REQUIRED|FORBIDDEN|CANNOT|INVARIANT)\b/i;
const LEDGER_MARKER_RE = /@(?:cairn:(?:decision|rule)|invariant|rule|decision)\b/i;

export function hasConstraintShape(text: string): boolean {
  if (text.length === 0) return false;
  return CONSTRAINT_KEYWORDS_RE.test(text) || LEDGER_MARKER_RE.test(text);
}

/**
 * Decision signal — an explicit decision verb (chose / selected / picked /
 * decided / adopted / preferred / went with) paired with a rationale or
 * rejected-alternative connector (because / over / instead of / rather than
 * / to avoid / outweighs). Both halves are required: "use X" alone is not a
 * decision, and "over the wire" alone is not either. Only the Layer A
 * runtime gate consumes this — init routes bare decision prose to the
 * candidate surface, not to auto-creation.
 */
const DECISION_VERB_RE =
  /\b(?:chose|chosen|choose|selected?|picked?|decided?|adopt(?:ed|s)?|prefer(?:red|s)?|standardiz(?:e|ed|es)|went\s+with|going\s+with)\b/i;
const RATIONALE_RE =
  /\b(?:because|since|over|instead\s+of|rather\s+than|to\s+avoid|so\s+that|in\s+order\s+to|due\s+to|outweighs?)\b/i;

export function hasDecisionShape(text: string): boolean {
  if (text.length === 0) return false;
  return DECISION_VERB_RE.test(text) && RATIONALE_RE.test(text);
}

/**
 * True when a block is dominated by separator / box-drawing glyphs — a
 * `─────` rule, a `=====` divider, a `*****` banner. These decorate code;
 * they never state a rule or a decision. Pre-0.22.7 the Layer A creation
 * judge over-labeled them `constraint` and minted box-drawing "invariants".
 * Threshold 0.6 keeps real prose (always <60% punctuation) clear.
 */
const SEPARATOR_GLYPHS_RE = /[─-╿=\-_*#~+.]/g;

export function isSeparatorBlock(prose: string): boolean {
  const compact = prose.replace(/\s+/g, "");
  if (compact.length === 0) return true;
  const glyphs = (compact.match(SEPARATOR_GLYPHS_RE) ?? []).length;
  return glyphs / compact.length >= 0.6;
}

/**
 * The Layer A creation pre-filter: a prose block is ledger-worthy only when
 * it is NOT a separator banner AND carries either a constraint or a decision
 * shape. Everything else — file/class/endpoint descriptions, behavior notes,
 * test-fixture comments, re-export banners — is structurally `descriptive`
 * and never reaches the (cost-bearing) Haiku creation judge. Pass both the
 * stripped `prose` and the raw comment text so an `@cairn:*` marker on a
 * JSDoc tag line (which the walker strips from `prose`) is still honored.
 */
export function isLedgerWorthyBlock(prose: string, raw: string): boolean {
  if (isSeparatorBlock(prose)) return false;
  return (
    hasConstraintShape(prose) ||
    hasConstraintShape(raw) ||
    hasDecisionShape(prose)
  );
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
  const m = raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return m === null ? raw.trim() : raw.slice(m[0].length).trim();
}
