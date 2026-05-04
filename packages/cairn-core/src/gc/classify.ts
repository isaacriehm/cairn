/**
 * Auto-merge classification per PRIMER §12.2.
 *
 * Given a set of repo-relative paths a commit will touch, return one of:
 *   safe        — formatting, doc regen, frontmatter refresh, generated content,
 *                 archive moves, stub-catalog additions, .harness/ground/* writes
 *   code        — touches *.ts / *.tsx / *.js outside generator-managed files
 *   high-stakes — any path matches projectGlobs.high_stakes_globs
 *
 * The classifier is deliberately conservative: when in doubt, escalate. A
 * single high-stakes hit dominates the result. A single code hit dominates
 * over safe.
 */

import { matchAnyGlob } from "../ground/glob.js";
import type { ProjectGlobs } from "../sensors/types.js";
import type { GcAutoMergeClass } from "./types.js";

/** Patterns the classifier always treats as safe regardless of file type. */
const SAFE_PATH_PREFIXES = [
  ".harness/ground/",
  ".harness/staleness/",
  ".harness/runs/terminal/",
  ".archive/",
];

/** Doc / config / generated extensions. Not safe by themselves; combined with
 *  off-source-tree location they are. */
const DOC_LIKE_EXTS = [".md", ".yaml", ".yml", ".json", ".txt"];

/** Source-code extensions that escalate to code-class. */
const CODE_EXTS = [
  ".ts",
  ".tsx",
  ".cts",
  ".mts",
  ".js",
  ".jsx",
  ".cjs",
  ".mjs",
  ".py",
  ".rb",
  ".go",
  ".rs",
];

export interface ClassifyArgs {
  paths: readonly string[];
  projectGlobs?: ProjectGlobs;
  /**
   * Globs of paths the harness considers generator-managed — touching these
   * stays safe-class even when the extension is .ts. Default: empty.
   */
  generatorManagedGlobs?: readonly string[];
}

export function classifyAutoMerge(args: ClassifyArgs): GcAutoMergeClass {
  const highStakes = args.projectGlobs?.high_stakes_globs ?? [];
  const generated = args.generatorManagedGlobs ?? args.projectGlobs?.generator_source_globs ?? [];

  let cls: GcAutoMergeClass = "safe";
  for (const path of args.paths) {
    if (highStakes.length > 0 && matchAnyGlob(path, highStakes)) {
      return "high-stakes";
    }
    if (cls === "code") continue; // already escalated; only high-stakes upgrade further
    if (isSafePath(path, generated)) continue;
    if (isCodePath(path)) {
      cls = "code";
      continue;
    }
    // Unknown extension under the canonical zone — keep as safe; .archive
    // moves or yaml writes etc.
  }
  return cls;
}

function isSafePath(path: string, generatorManagedGlobs: readonly string[]): boolean {
  for (const prefix of SAFE_PATH_PREFIXES) {
    if (path.startsWith(prefix)) return true;
  }
  if (generatorManagedGlobs.length > 0 && matchAnyGlob(path, generatorManagedGlobs)) {
    return true;
  }
  // Documentation files are safe.
  if (path.startsWith("docs/")) return true;
  if (path === "AGENTS.md" || path === "CLAUDE.md" || path === "README.md") return true;
  // Frontmatter / config under .harness/config/* is safe (the GC pass that
  // writes there is doing config maintenance, not source change).
  if (path.startsWith(".harness/config/") || path.startsWith(".claude/")) return true;
  // Generic doc-extension files outside the source tree fall here.
  for (const ext of DOC_LIKE_EXTS) {
    if (path.endsWith(ext)) return true;
  }
  return false;
}

function isCodePath(path: string): boolean {
  const lower = path.toLowerCase();
  return CODE_EXTS.some((e) => lower.endsWith(e));
}
