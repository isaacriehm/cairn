/**
 * Decision id allocator. DEC-NNNN, monotonic, never reused.
 *
 * Scans `.harness/ground/decisions/` for accepted decisions AND
 * `.harness/ground/decisions/_inbox/` for outstanding drafts. Either counts
 * toward the high-water mark — a draft that's pending operator confirmation
 * still owns its id; rejecting a draft does NOT recycle the id.
 */

import { existsSync, readdirSync } from "node:fs";
import { decisionsDir } from "../ground/paths.js";
import { join } from "node:path";

const FILENAME_RE = /^DEC-(\d{4,})(?:\.draft|\.rejected)?\.md$/;

/**
 * Return the next free `DEC-<NNNN>` id. The scan is liberal — any DEC-prefixed
 * file (`.md` or `.draft.md`) counts toward the mark, including superseded
 * decisions and rejected drafts that the harness chose to leave on disk.
 */
export function allocateDecisionId(repoRoot: string): string {
  const dir = decisionsDir(repoRoot);
  const inboxDir = join(dir, "_inbox");
  let max = 0;
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
      if (!match) continue;
      const n = Number.parseInt(match[1] ?? "0", 10);
      if (Number.isFinite(n) && n > max) max = n;
    }
  }
  const next = max + 1;
  return `DEC-${next.toString().padStart(4, "0")}`;
}
