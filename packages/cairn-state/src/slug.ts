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

/**
 * Ledger-DEC id derivation for source-comment captures (plan §5.3). The
 * generic `deriveDecId` keys on `(sot_path, title, capture_source)`, which
 * collapses for ledger entries because every source-comment DEC shares the
 * literal `sot_path: "ledger"`. Title alone is not unique — two essay
 * comments starting with the same line would collide. Source location is
 * stable post-strip-replace, so `(source_file, source_offset, capture_source)`
 * is the per-fact unique input.
 */
export function deriveLedgerDecId(input: {
  source_file: string;
  source_offset: number;
  capture_source: string;
}): string {
  const json = JSON.stringify({
    source_file: input.source_file,
    source_offset: input.source_offset,
    capture_source: input.capture_source,
  });
  return `DEC-${createHash("sha256").update(json, "utf8").digest("hex").slice(0, 7)}`;
}

export function deriveLedgerInvId(input: {
  source_file: string;
  source_offset: number;
  capture_source: string;
}): string {
  const json = JSON.stringify({
    source_file: input.source_file,
    source_offset: input.source_offset,
    capture_source: input.capture_source,
  });
  return `INV-${createHash("sha256").update(json, "utf8").digest("hex").slice(0, 7)}`;
}

/**
 * Convert an arbitrary title into a kebab-case slug suitable for a
 * mission id (`MIS-<slug>-<hash7>`). Lowercased ASCII; non-alnum
 * collapses to single hyphen; trims leading/trailing hyphens; capped
 * at 32 chars to keep mission ids inside the 40-char statusline budget
 * after the `MIS-` prefix + `-<hash7>` suffix.
 */
export function titleToSlug(title: string, maxLen = 32): string {
  const slug = title
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLen)
    .replace(/-+$/g, "");
  return slug.length > 0 ? slug : "mission";
}

/**
 * Derive a stable mission id from canonical inputs. Format:
 * `MIS-<slug>-<hash7>` mirroring TSK-/DEC-/INV- conventions.
 *
 * Hash inputs include `started_at` so re-running `mission start` on the
 * same spec doc minutes later produces a fresh id (no collision with
 * the prior mission's archived dirs).
 */
export function deriveMissionId(input: {
  title: string;
  spec_path: string;
  started_at: string;
}): string {
  const slug = titleToSlug(input.title);
  const json = JSON.stringify({
    title: input.title,
    spec_path: input.spec_path,
    started_at: input.started_at,
  });
  const hash = createHash("sha256").update(json, "utf8").digest("hex").slice(0, 7);
  return `MIS-${slug}-${hash}`;
}
