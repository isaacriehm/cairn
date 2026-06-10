/**
 * Shared `.cairn/.gitignore` remediation — used by `cairn fix gitignore` AND
 * the `0002-backfill-gitignore` migration.
 *
 * Cairn added gitignored derived/per-clone state across several releases
 * (v0.11.3 tasks/missions, v0.15.0 derived ground indexes, v0.18.0 component
 * index). A repo adopted before an entry landed both (a) lacks the ignore line
 * and (b) may have COMMITTED the derived state, which then churns on every
 * clone. Remediation = bring `.cairn/.gitignore` current (merge — never clobber
 * operator lines) and `git rm --cached` any now-ignored, already-tracked paths.
 * Idempotent: a second run adds nothing and untracks nothing.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { cairnDir, writeFileSafe } from "@isaacriehm/cairn-state";
import { templatesRoot } from "../init/seed.js";

export interface GitignoreRemediation {
  /** True when there is anything to backfill (missing lines or tracked state). */
  changed: boolean;
  /** Template ignore lines absent from the current file. */
  addedEntries: string[];
  /** Repo-relative paths that are (or would be) `git rm --cached`'d. */
  untracked: string[];
}

/** Non-comment, non-blank trimmed lines. */
function entryLines(text: string): string[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith("#"));
}

/** Of the template entries, the tracked-in-git file paths under them. */
function trackedUnder(repoRoot: string, entries: string[]): string[] {
  if (entries.length === 0) return [];
  const targets = entries.map((e) => join(".cairn", e));
  try {
    const out = execFileSync("git", ["ls-files", "-z", "--", ...targets], {
      cwd: repoRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return out.split("\0").filter((p) => p.length > 0);
  } catch {
    return [];
  }
}

/**
 * Bring `.cairn/.gitignore` current with the bundled template and (apply mode)
 * untrack any now-ignored committed state. `apply: false` is a pure read used
 * by the migration's `detect()`.
 */
export function remediateGitignore(
  repoRoot: string,
  opts: { apply: boolean },
): GitignoreRemediation {
  const result: GitignoreRemediation = { changed: false, addedEntries: [], untracked: [] };

  const templatePath = join(templatesRoot(), ".cairn", ".gitignore");
  const gitignorePath = cairnDir(repoRoot, ".gitignore");
  if (!existsSync(templatePath) || !existsSync(gitignorePath)) return result;

  const template = readFileSync(templatePath, "utf8");
  const current = readFileSync(gitignorePath, "utf8");
  const have = new Set(entryLines(current));
  const templateEntries = entryLines(template);

  result.addedEntries = templateEntries.filter((e) => !have.has(e));
  result.untracked = trackedUnder(repoRoot, templateEntries);
  result.changed = result.addedEntries.length > 0 || result.untracked.length > 0;

  if (!opts.apply || !result.changed) return result;

  if (result.addedEntries.length > 0) {
    const sep = current.endsWith("\n") ? "" : "\n";
    const block =
      `${sep}\n# --- backfilled by cairn migrate (0002-backfill-gitignore) ---\n` +
      `${result.addedEntries.join("\n")}\n`;
    writeFileSafe(gitignorePath, current + block);
  }

  if (result.untracked.length > 0) {
    // Untrack so the committed derived state drops out of the index. The
    // working-tree copy stays (rebuildDerived rewrites it); only the tracking
    // is removed. Best-effort — a git failure leaves the file ignored anyway.
    const targets = result.untracked.slice();
    try {
      execFileSync(
        "git",
        ["rm", "--cached", "-r", "--ignore-unmatch", "--", ...targets],
        { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "ignore", "ignore"] },
      );
    } catch {
      /* best-effort */
    }
  }

  return result;
}
