/**
 * Lens staleness reader — `cairn attention undo` and Layer A's drift
 * sensors append to `.cairn/staleness/log.jsonl` whenever an entity
 * gets a new pending issue (orphan path, doc drift, pre-commit drift,
 * etc.). The decoration provider renders a `⚑` gutter glyph beside
 * any §DEC / §INV token whose id appears in the log.
 *
 * Lives in its own module (no `vscode` import) so the smoke harness
 * can exercise it directly.
 */

import { existsSync, readFileSync } from "node:fs";
import { cairnDir } from "@isaacriehm/cairn-state";

/**
 * Return the set of `dec_id` values referenced by any drift entry in the
 * staleness log. Resolves through `cairnDir`, so it reads the out-of-repo state
 * home in ghost (§3.7). Returns an empty set when the log is missing/unreadable.
 */
export function readPendingStalenessIds(repoRoot: string): Set<string> {
  const path = cairnDir(repoRoot, "staleness", "log.jsonl");
  if (!existsSync(path)) return new Set();
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return new Set();
  }
  const ids = new Set<string>();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (parsed && typeof parsed === "object" && typeof parsed.dec_id === "string") {
        ids.add(parsed.dec_id);
      }
    } catch {
      // Malformed line — skip silently; this is a read-only consumer.
    }
  }
  return ids;
}
