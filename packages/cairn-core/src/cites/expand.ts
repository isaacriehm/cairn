/**
 * Inline cite expander — the inverse of sot-align's strip-replace.
 *
 * sot-align replaces a prose block with a bare `// §DEC-<hash>` /
 * `// §INV-<hash>` citation. This expands such a citation back into the
 * entity's body, rendered as a plain comment in the file's own comment
 * style. Two uses:
 *
 *   1. Uninstall — un-cite a repo so removing `.cairn/` leaves the source
 *      self-documenting, with no dangling `§DEC-/§INV-` references.
 *   2. General "expand cites" tooling.
 *
 * Only a PURE cite line — one whose entire content (after the comment
 * leader) is citation tokens — is expanded. A citation that shares a line
 * with code is left untouched (counted as `inlineSkipped`); a citation
 * whose entity is missing on disk is left as-is (`danglingSkipped`).
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readScopeIndex } from "@isaacriehm/cairn-state";
import { readEntityBody } from "../hooks/sot-align-common.js";

const CITE_RE = /§(DEC|INV)-([0-9a-f]{7,})/g;
/** A line that, with all cite tokens removed, is only indent + comment leader. */
const PURE_CITE_LEADER_RE = /^(\s*)(\/\/+|#+|;+|--+|\*)?\s*$/;

export interface ExpandResult {
  text: string;
  /** Citations replaced with their entity body. */
  expanded: number;
  /** Citation ids with no entity on disk — left in place. */
  danglingSkipped: number;
  /** Citations sharing a line with code — left in place. */
  inlineSkipped: number;
}

/**
 * Pure transform: expand every pure-cite line in `text`. `resolve` returns
 * an entity body (post-frontmatter) by id, or null when it doesn't exist.
 */
export function expandCitesInText(
  text: string,
  resolve: (id: string) => string | null,
): ExpandResult {
  let expanded = 0;
  let danglingSkipped = 0;
  let inlineSkipped = 0;

  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const out: string[] = [];

  for (const line of lines) {
    const cites = [...line.matchAll(CITE_RE)];
    if (cites.length === 0) {
      out.push(line);
      continue;
    }

    const stripped = line.replace(CITE_RE, "").replace(/\s+$/, "");
    const leaderMatch = stripped.match(PURE_CITE_LEADER_RE);
    if (leaderMatch === null) {
      // Citation shares the line with code — don't touch it.
      inlineSkipped += cites.length;
      out.push(line);
      continue;
    }

    const indent = leaderMatch[1] ?? "";
    const leader = leaderMatch[2] ?? "//";

    const replacement: string[] = [];
    let expandedAny = false;
    cites.forEach((m, idx) => {
      const id = `${m[1]}-${m[2]}`;
      const body = resolve(id);
      if (body === null) {
        danglingSkipped += 1;
        replacement.push(`${indent}${leader} §${id}`); // keep dangling cite verbatim
        return;
      }
      if (expandedAny) replacement.push(`${indent}${leader}`); // separator between bodies
      for (const bl of body.split(/\r?\n/)) {
        replacement.push(bl.length > 0 ? `${indent}${leader} ${bl}` : `${indent}${leader}`);
      }
      expanded += 1;
      expandedAny = true;
      void idx;
    });

    out.push(...replacement);
  }

  return { text: out.join(eol), expanded, danglingSkipped, inlineSkipped };
}

export interface ExpandCitesFileOptions {
  repoRoot: string;
  /** Repo-relative path. */
  filePath: string;
  /** When true, compute the result but don't write. */
  dryRun?: boolean;
}

export interface ExpandCitesFileResult extends ExpandResult {
  filePath: string;
  changed: boolean;
}

/**
 * Expand every pure-cite line in one source file, resolving ids against the
 * live `.cairn/ground/{decisions,invariants}/` store. Writes in place unless
 * `dryRun`.
 */
export function expandCitesInFile(
  opts: ExpandCitesFileOptions,
): ExpandCitesFileResult {
  const abs = join(opts.repoRoot, opts.filePath);
  const empty: ExpandCitesFileResult = {
    filePath: opts.filePath,
    text: "",
    expanded: 0,
    danglingSkipped: 0,
    inlineSkipped: 0,
    changed: false,
  };
  if (!existsSync(abs)) return empty;

  let source: string;
  try {
    source = readFileSync(abs, "utf8");
  } catch {
    return empty;
  }

  const result = expandCitesInText(source, (id) =>
    readEntityBody(opts.repoRoot, id),
  );
  const changed = result.text !== source;
  if (changed && opts.dryRun !== true) {
    writeFileSync(abs, result.text, "utf8");
  }
  return { ...result, filePath: opts.filePath, changed };
}

export interface ExpandCitesRepoOptions {
  repoRoot: string;
  /**
   * Explicit repo-relative files to expand. When omitted, the cited-file
   * set is taken from the scope-index (every file with a bound DEC/INV).
   */
  files?: string[];
  dryRun?: boolean;
}

export interface ExpandCitesRepoResult {
  files: ExpandCitesFileResult[];
  filesChanged: number;
  expanded: number;
  danglingSkipped: number;
  inlineSkipped: number;
}

/**
 * Expand cites across many files. Defaults to the scope-index's cited-file
 * set; pass `files` to target a subset (or when the scope-index is absent).
 */
export function expandCitesInRepo(
  opts: ExpandCitesRepoOptions,
): ExpandCitesRepoResult {
  let targets = opts.files;
  if (targets === undefined) {
    const idx = readScopeIndex(opts.repoRoot);
    targets = idx === null ? [] : Object.keys(idx.files);
  }

  const out: ExpandCitesRepoResult = {
    files: [],
    filesChanged: 0,
    expanded: 0,
    danglingSkipped: 0,
    inlineSkipped: 0,
  };
  for (const filePath of targets) {
    const r = expandCitesInFile({
      repoRoot: opts.repoRoot,
      filePath,
      ...(opts.dryRun !== undefined ? { dryRun: opts.dryRun } : {}),
    });
    if (r.expanded === 0 && r.danglingSkipped === 0 && r.inlineSkipped === 0) {
      continue; // no cites in this file
    }
    out.files.push(r);
    if (r.changed) out.filesChanged += 1;
    out.expanded += r.expanded;
    out.danglingSkipped += r.danglingSkipped;
    out.inlineSkipped += r.inlineSkipped;
  }
  return out;
}
