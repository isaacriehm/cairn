/**
 * Invariant id allocator. Per L13.2:
 *   - Monotonic, never reused.
 *   - Format: V<NNNN>, zero-padded to four digits.
 *   - Even superseded invariants keep their id; allocation only ever
 *     advances forward.
 */

import { existsSync, readdirSync } from "node:fs";
import { invariantsDir } from "../ground/paths.js";

const FILENAME_RE = /^V(\d{4,})\.md$/;

/**
 * Scan `<repoRoot>/.harness/ground/invariants/V*.md` and return the next
 * free id formatted as `V<NNNN>`. The scan is liberal — any V-prefixed
 * markdown counts toward the high-water mark, including ones marked
 * superseded.
 */
export function allocateInvariantId(repoRoot: string): string {
  const dir = invariantsDir(repoRoot);
  let max = 0;
  if (existsSync(dir)) {
    let entries: string[];
    try {
      entries = readdirSync(dir, { encoding: "utf8" });
    } catch {
      entries = [];
    }
    for (const name of entries) {
      const match = name.match(FILENAME_RE);
      if (!match) continue;
      const n = Number.parseInt(match[1] ?? "0", 10);
      if (Number.isFinite(n) && n > max) max = n;
    }
  }
  const next = max + 1;
  return `V${next.toString().padStart(4, "0")}`;
}
