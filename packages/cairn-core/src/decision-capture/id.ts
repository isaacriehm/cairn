/**
 * Content-addressed id derivation for decisions and invariants.
 *
 * Decisions: `DEC-<hash>` where `<hash>` is the first 7 hex chars of
 *   sha256(canonicalized input). Stable across clones — two devs
 *   that capture the same source comment in the same file produce
 *   the same id, so concurrent adoption runs do not collide on merge.
 *
 * Invariants: same shape, `INV-<hash>`.
 *
 * On the rare hash collision against an existing on-disk id with
 * different content, the new id extends to 8 chars. Same fallback git
 * uses for short SHAs.
 *
 * Ids are never recycled — rejecting a draft renames the file to
 * `<id>.rejected.md` so the same hash never re-allocates to a
 * different decision.
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { decisionsDir, invariantsDir } from "../ground/paths.js";

/** Default short-hash length (matches git short-SHA convention). */
const HASH_LEN = 7;

/** DEC filename: `DEC-<hex>.md`, optionally `.draft` or `.rejected`. */
const FILENAME_RE = /^DEC-([0-9a-f]{7,})(?:\.draft|\.rejected)?\.md$/;
/** INV filename: `INV-<hex>.md`. Matches the schema id regex in `ground/schemas.ts`. */
const INVARIANT_FILENAME_RE = /^INV-([0-9a-f]{7,})\.md$/;

/* -------------------------------------------------------------------------- */
/* Content-hash inputs                                                        */
/* -------------------------------------------------------------------------- */

export interface DecisionIdInput {
  /** Title — required. Lowercased + trimmed in the hash input. */
  title: string;
  /** Free-text rationale or summary. */
  rationale?: string;
  /** Provenance source (e.g. `init-source-comments`, `init-rules-merge`, `user-record`). */
  capture_source?: string;
  /** Source file the decision was extracted from. */
  source_file?: string;
  /** Line / offset within the source file. */
  source_offset?: number;
  /** Original raw comment / section text. */
  raw?: string;
  /** Scope globs (sorted before hashing for stability). */
  scope_globs?: string[];
  /** Full body markdown (for manual `cairn_record_decision` calls). */
  body_markdown?: string;
  /**
   * Millisecond timestamp — only set for manual user-record paths
   * where there is no stable provenance. Source-comment / rules-merge
   * derived ids omit this so re-running the pipeline is idempotent.
   */
  timestamp_ms?: number;
}

export interface InvariantIdInput {
  /** Title — required. Lowercased + trimmed. */
  title: string;
  /** Source file the constraint was extracted from. */
  source_file?: string;
  /** Line / offset within the source file. */
  source_offset?: number;
  /** Original raw comment text. */
  raw?: string;
  /** Millisecond timestamp — manual writes only. */
  timestamp_ms?: number;
}

function canonicalDecision(input: DecisionIdInput): string {
  return JSON.stringify({
    title: input.title.trim().toLowerCase(),
    rationale: input.rationale ?? null,
    capture_source: input.capture_source ?? null,
    source_file: input.source_file ?? null,
    source_offset: input.source_offset ?? null,
    raw: input.raw ?? null,
    scope_globs:
      input.scope_globs !== undefined ? [...input.scope_globs].sort() : null,
    body_markdown: input.body_markdown ?? null,
    timestamp_ms: input.timestamp_ms ?? null,
  });
}

function canonicalInvariant(input: InvariantIdInput): string {
  return JSON.stringify({
    title: input.title.trim().toLowerCase(),
    source_file: input.source_file ?? null,
    source_offset: input.source_offset ?? null,
    raw: input.raw ?? null,
    timestamp_ms: input.timestamp_ms ?? null,
  });
}

/**
 * Compute a stable `DEC-<hash>` id from the canonical input. When
 * `existing` is supplied and the 7-char prefix collides with an id
 * already in that set whose content differs, the id extends to 8+
 * chars until unique.
 */
export function computeDecisionId(
  input: DecisionIdInput,
  existing?: Set<string>,
): string {
  const digest = createHash("sha256").update(canonicalDecision(input)).digest("hex");
  for (let len = HASH_LEN; len <= digest.length; len++) {
    const candidate = `DEC-${digest.slice(0, len)}`;
    if (existing === undefined || !existing.has(candidate)) return candidate;
  }
  throw new Error("computeDecisionId: hash exhaustion (impossible at sha256)");
}

/**
 * Compute a stable `INV-<hash>` id from the canonical input. Same
 * collision-extension behavior as `computeDecisionId`.
 */
export function computeInvariantId(
  input: InvariantIdInput,
  existing?: Set<string>,
): string {
  const digest = createHash("sha256").update(canonicalInvariant(input)).digest("hex");
  for (let len = HASH_LEN; len <= digest.length; len++) {
    const candidate = `INV-${digest.slice(0, len)}`;
    if (existing === undefined || !existing.has(candidate)) return candidate;
  }
  throw new Error("computeInvariantId: hash exhaustion (impossible at sha256)");
}

/* -------------------------------------------------------------------------- */
/* On-disk scans (used for collision check + auxiliary lookups)               */
/* -------------------------------------------------------------------------- */

/**
 * Scan both the canonical decisions dir and `_inbox/` for
 * `DEC-<hash>` filenames; return the set of ids found.
 */
export function scanExistingDecisionIds(repoRoot: string): Set<string> {
  const dir = decisionsDir(repoRoot);
  const inboxDir = join(dir, "_inbox");
  const ids = new Set<string>();
  for (const candidateDir of [dir, inboxDir]) {
    if (!existsSync(candidateDir)) continue;
    let entries: string[];
    try {
      entries = readdirSync(candidateDir, { encoding: "utf8" });
    } catch {
      continue;
    }
    for (const name of entries) {
      const match = name.match(FILENAME_RE);
      if (!match || !match[1]) continue;
      ids.add(`DEC-${match[1]}`);
    }
  }
  return ids;
}

/**
 * Scan `.cairn/ground/invariants/` for `INV-<hash>` filenames.
 */
export function scanExistingInvariantIds(repoRoot: string): Set<string> {
  const dir = invariantsDir(repoRoot);
  const ids = new Set<string>();
  if (!existsSync(dir)) return ids;
  let entries: string[];
  try {
    entries = readdirSync(dir, { encoding: "utf8" });
  } catch {
    return ids;
  }
  for (const name of entries) {
    const match = name.match(INVARIANT_FILENAME_RE);
    if (!match || !match[1]) continue;
    ids.add(`INV-${match[1]}`);
  }
  return ids;
}
