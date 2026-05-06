import { createHash } from "node:crypto";

/**
 * Content-fingerprint helpers shared by topic-index, anchor-map, sot-cache,
 * and the Layer A alignment hook.
 *
 * The content slug is sha256-derived from the normalized prose body so two
 * identical blocks (in any source) produce the same slug. Different content
 * → different slug, regardless of leading words. This avoids the "we use
 * postgres for X" vs "we use postgres for Y" collision that a leading-word
 * slugger would suffer.
 */

const NORMALIZE_PATTERNS: { pattern: RegExp; replacement: string }[] = [
  { pattern: /```[\s\S]*?```/g, replacement: " " },
  { pattern: /`[^`]+`/g, replacement: " " },
  { pattern: /\[([^\]]+)\]\([^)]*\)/g, replacement: "$1" },
  { pattern: /^#{1,6}\s+/gm, replacement: "" },
  { pattern: /^[\s>*\-+]+/gm, replacement: "" },
  { pattern: /\s+/g, replacement: " " },
];

/**
 * Normalize a prose block: strip markdown ornaments + collapse whitespace.
 * Output is the canonical form fed into both content-fingerprint slug
 * generation and content-hash calculation. Identical normalized output
 * → identical slug, even if the source markdown formatting differs.
 */
export function normalizeBlock(input: string): string {
  let s = input;
  for (const { pattern, replacement } of NORMALIZE_PATTERNS) {
    s = s.replace(pattern, replacement);
  }
  return s.trim().toLowerCase();
}

/**
 * Compute the 12-char content-fingerprint slug for a prose block. Uses
 * sha256 over the normalized body, hex-encoded, sliced to 12 chars.
 *
 * 12 chars → 48 bits, ~280 trillion buckets. Birthday collision becomes
 * meaningful around 16 million distinct topics; real repos are nowhere
 * close to that.
 */
export function topicSlug(input: string): string {
  const normalized = normalizeBlock(input);
  return createHash("sha256").update(normalized, "utf8").digest("hex").slice(0, 12);
}

/**
 * Compute the full sha256 hex of a prose body (no normalization). Used
 * for sot_content_hash drift detection — the hash must change when the
 * operator edits the source paragraph by even one character so the
 * doc-drift sensor can fire.
 */
export function bodyContentHash(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
}

/**
 * Derive a stable DEC id from canonical inputs. Plan §3.2.1: id =
 * "DEC-" + sha256(JSON.stringify({sot_path, title, capture_source})).slice(0, 7).
 *
 * Body is intentionally NOT in the hash input — doc-drift refresh
 * updates body but keeps the id stable so every §DEC-<hash> token in
 * source files survives the refresh.
 */
export function deriveDecId(input: {
  sot_path: string;
  title: string;
  capture_source: string;
}): string {
  const json = JSON.stringify({
    sot_path: input.sot_path,
    title: input.title,
    capture_source: input.capture_source,
  });
  return `DEC-${createHash("sha256").update(json, "utf8").digest("hex").slice(0, 7)}`;
}

export function deriveInvId(input: {
  sot_path: string;
  title: string;
  capture_source: string;
}): string {
  const json = JSON.stringify({
    sot_path: input.sot_path,
    title: input.title,
    capture_source: input.capture_source,
  });
  return `INV-${createHash("sha256").update(json, "utf8").digest("hex").slice(0, 7)}`;
}
