/**
 * Shared pre-resync archive helper. Every resync mutation (config edits,
 * source-rematch frontmatter rewrites, topic-index re-cluster) snapshots the
 * file it is about to overwrite into `.cairn/ground/.archive/` first, so the
 * operator can recover the prior state (Q23). Recoverable, never hard-deleted.
 */

import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { archiveDir } from "@isaacriehm/cairn-state";

/**
 * Copy a repo file to `.cairn/ground/.archive/<base>.pre-resync.<ts>.bak`.
 * Returns the repo-relative path of the backup, or null when the source is
 * absent (fresh repo — nothing to back up) or the copy fails.
 */
export function archiveFile(
  srcAbs: string,
  repoRoot: string,
  base: string,
  nowIso: string,
): string | null {
  if (!existsSync(srcAbs)) return null;
  const dir = archiveDir(repoRoot);
  mkdirSync(dir, { recursive: true });
  const name = `${base}.pre-resync.${nowIso.replace(/[:.]/g, "-")}.bak`;
  try {
    copyFileSync(srcAbs, join(dir, name));
  } catch {
    return null;
  }
  return join(".cairn", "ground", ".archive", name);
}
