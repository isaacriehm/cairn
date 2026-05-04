/**
 * Decision id allocator. DEC-NNNN, monotonic, never reused.
 *
 * Scans `.harness/ground/decisions/` for accepted decisions AND
 * `.harness/ground/decisions/_inbox/` for outstanding drafts. Either counts
 * toward the high-water mark — a draft that's pending operator confirmation
 * still owns its id; rejecting a draft does NOT recycle the id.
 *
 * Single source of truth for DEC-id allocation. The MCP `record_decision`
 * tool calls these helpers; do NOT re-implement the scan elsewhere.
 */

import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { decisionsDir } from "../ground/paths.js";

const FILENAME_RE = /^DEC-(\d{4,})(?:\.draft|\.rejected)?\.md$/;

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
