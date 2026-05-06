/**
 * Decision + invariant id allocators. Monotonic, never reused.
 *
 * Decisions: scan `.cairn/ground/decisions/` for accepted decisions AND
 * `.cairn/ground/decisions/_inbox/` for outstanding drafts. Either counts
 * toward the high-water mark — a draft that's pending operator confirmation
 * still owns its id; rejecting a draft does NOT recycle the id.
 *
 * Invariants: scan `.cairn/ground/invariants/INV-<NNNN>.md`. Phase 7b writes
 * invariants directly to ground state (no `_inbox/` flow — they auto-promote
 * from the constraint classifier; operator edits / supersedes after the
 * fact).
 *
 * Single source of truth for id allocation. The MCP write tools and the
 * init pipeline call these helpers; do NOT re-implement the scan elsewhere.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { decisionsDir, invariantsDir } from "../ground/paths.js";

const FILENAME_RE = /^DEC-(\d{4,})(?:\.draft|\.rejected)?\.md$/;
// Invariant filename: `INV-<NNNN>.md` — matches the schema id
// regex /^INV-\d{4,}$/ at packages/cairn-core/src/ground/schemas.ts.
const INVARIANT_FILENAME_RE = /^INV-(\d{4,})\.md$/;

/**
 * Scan both the canonical decisions dir and the `_inbox/` for
 * DEC-NNNN-prefixed files; return the set of ids found.
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
      ids.add(`DEC-${match[1].padStart(4, "0")}`);
    }
  }
  return ids;
}

/**
 * Return the next free `DEC-<NNNN>` id, optionally factoring in a
 * caller-supplied set (e.g. ids the MCP tool just validated against).
 */
export function allocateDecisionId(
  repoRoot: string,
  existing?: Set<string>,
): string {
  const ids = existing ?? scanExistingDecisionIds(repoRoot);
  let max = 0;
  for (const id of ids) {
    const m = id.match(/^DEC-(\d+)$/);
    if (!m?.[1]) continue;
    const n = Number.parseInt(m[1], 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return `DEC-${(max + 1).toString().padStart(4, "0")}`;
}

/**
 * Scan `.cairn/ground/invariants/` for INV-<NNNN>-prefixed files; return the
 * set of ids found.
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
    ids.add(`INV-${match[1].padStart(4, "0")}`);
  }
  return ids;
}

/**
 * Return the next free `INV-<NNNN>` id — matches the schema regex
 * at packages/cairn-core/src/ground/schemas.ts. Optionally factor in
 * a caller-supplied set so a batch of allocations doesn't collide on
 * disk before any are written.
 */
export function allocateInvariantId(
  repoRoot: string,
  existing?: Set<string>,
): string {
  const ids = existing ?? scanExistingInvariantIds(repoRoot);
  let max = 0;
  for (const id of ids) {
    const m = id.match(/^INV-(\d+)$/);
    if (!m?.[1]) continue;
    const n = Number.parseInt(m[1], 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return `INV-${(max + 1).toString().padStart(4, "0")}`;
}
