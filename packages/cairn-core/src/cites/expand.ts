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

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { archiveDecisionsDir, archiveInvariantsDir } from "@isaacriehm/cairn-state";
import { readEntityBody } from "../hooks/sot-align-common.js";

/** Resolve a cite id to the entity body that replaces it, or null to leave the cite verbatim. */
export type CiteResolver = (id: string) => string | null;

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
  /**
   * How a cite id resolves to a body. Defaults to the live
   * `.cairn/ground/{decisions,invariants}/` store. Override to expand from a
   * different source (e.g. the `.archive/` graveyard for stranded cites).
   */
  resolve?: CiteResolver;
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

  const resolve = opts.resolve ?? ((id: string) => readEntityBody(opts.repoRoot, id));
  const result = expandCitesInText(source, resolve);
  const changed = result.text !== source;
  if (changed && opts.dryRun !== true) {
    writeFileSync(abs, result.text, "utf8");
  }
  return { ...result, filePath: opts.filePath, changed };
}

/** Dirs the cited-file scan never descends into. */
const SCAN_SKIP_DIRS = new Set([
  ".git",
  ".cairn",
  "node_modules",
  "dist",
  "build",
  "out",
  "coverage",
  ".next",
  ".turbo",
  ".vercel",
]);
const CITE_SCAN_RE = /§(?:DEC|INV)-[0-9a-f]{7,}/;
const SCAN_SKIP_EXT = new Set([
  ".png", ".jpg", ".jpeg", ".gif", ".webp", ".ico", ".pdf", ".zip", ".gz",
  ".woff", ".woff2", ".ttf", ".eot", ".mp4", ".mov", ".wasm", ".lock", ".map",
]);
const SCAN_MAX_BYTES = 2_000_000;

/**
 * Walk the working tree for files that contain a `§DEC-/§INV-` token. The
 * source of truth for un-citing is the source itself, NOT the scope-index —
 * a stale/missing scope-index would silently leave dangling cites behind.
 */
export function findCitedFiles(repoRoot: string): string[] {
  const out: string[] = [];
  const walk = (absDir: string, relDir: string): void => {
    let entries;
    try {
      entries = readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const rel = relDir.length > 0 ? `${relDir}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (SCAN_SKIP_DIRS.has(e.name)) continue;
        walk(join(absDir, e.name), rel);
      } else if (e.isFile()) {
        const dot = e.name.lastIndexOf(".");
        if (dot !== -1 && SCAN_SKIP_EXT.has(e.name.slice(dot).toLowerCase())) continue;
        const abs = join(absDir, e.name);
        try {
          if (statSync(abs).size > SCAN_MAX_BYTES) continue;
          if (CITE_SCAN_RE.test(readFileSync(abs, "utf8"))) out.push(rel);
        } catch {
          /* unreadable — skip */
        }
      }
    }
  };
  walk(repoRoot, "");
  return out;
}

export interface ExpandCitesRepoOptions {
  repoRoot: string;
  /**
   * Explicit repo-relative files to expand. When omitted, the working tree
   * is scanned for every file carrying a `§DEC-/§INV-` token.
   */
  files?: string[];
  dryRun?: boolean;
  /** Resolver override (see {@link ExpandCitesFileOptions.resolve}). */
  resolve?: CiteResolver;
}

export interface ExpandCitesRepoResult {
  files: ExpandCitesFileResult[];
  filesChanged: number;
  expanded: number;
  danglingSkipped: number;
  inlineSkipped: number;
  /**
   * Archived-entity cite tokens removed from an INLINE line (one that shares
   * the line with code or prose, so it can't be expanded) where the token was
   * provably inside a comment / in a text file. Populated by
   * `repairArchivedCitesInRepo`; always 0 for plain `expandCitesInRepo`.
   */
  strippedInline: number;
  /**
   * Archived cite tokens left in place because they sit bare in code (not
   * after a comment leader) — stripping could alter a string/identifier, so
   * they're reported for manual review instead.
   */
  unsafeSkipped: number;
}

/**
 * Expand cites across many files. Defaults to the scope-index's cited-file
 * set; pass `files` to target a subset (or when the scope-index is absent).
 */
export function expandCitesInRepo(
  opts: ExpandCitesRepoOptions,
): ExpandCitesRepoResult {
  const targets = opts.files ?? findCitedFiles(opts.repoRoot);

  const out: ExpandCitesRepoResult = {
    files: [],
    filesChanged: 0,
    expanded: 0,
    danglingSkipped: 0,
    inlineSkipped: 0,
    strippedInline: 0,
    unsafeSkipped: 0,
  };
  for (const filePath of targets) {
    const r = expandCitesInFile({
      repoRoot: opts.repoRoot,
      filePath,
      ...(opts.dryRun !== undefined ? { dryRun: opts.dryRun } : {}),
      ...(opts.resolve !== undefined ? { resolve: opts.resolve } : {}),
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

/**
 * Read an entity body from the `.archive/` graveyard (post-frontmatter),
 * or null when no archived entity with this id exists. Mirrors
 * `readEntityBody` but targets the archive dirs.
 */
function readArchivedEntityBody(repoRoot: string, id: string): string | null {
  if (repoRoot.length === 0) return null;
  const dir = id.startsWith("INV-")
    ? archiveInvariantsDir(repoRoot)
    : archiveDecisionsDir(repoRoot);
  const abs = join(dir, `${id}.md`);
  if (!existsSync(abs)) return null;
  let raw: string;
  try {
    raw = readFileSync(abs, "utf8");
  } catch {
    return null;
  }
  const m = raw.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return m === null ? raw.trim() : raw.slice(m[0].length).trim();
}

/* -------------------------------------------------------------------------- */
/* Inline archived-cite token strip                                           */
/* -------------------------------------------------------------------------- */

/** Bare cite token (no comment leader), e.g. `§INV-a3f7b2c`. */
const CITE_TOKEN_RE = /§(?:DEC|INV)-[0-9a-f]{7,}/g;

/** Extensions whose whole content is prose — a token is always safe to strip. */
const TEXT_EXT = new Set([".md", ".mdx", ".markdown", ".txt", ".rst"]);
/** `#`-comment languages. */
const HASH_EXT = new Set([".py", ".rb", ".sh", ".bash", ".zsh", ".yaml", ".yml", ".toml", ".pl"]);
/** `--`-comment languages (also support `/* *​/`). */
const DASH_EXT = new Set([".sql", ".lua", ".hs", ".elm"]);
/** `;`-comment languages. */
const SEMI_EXT = new Set([".lisp", ".clj", ".cljs", ".el", ".scm", ".rkt"]);

/**
 * Is the cite token at `tokenStart` provably inside a comment on its line?
 * Conservative per language family — when unsure we return false so the token
 * is left for manual review rather than risk editing code / a string literal.
 */
function tokenInComment(line: string, tokenStart: number, ext: string): boolean {
  if (/^\s*\*/.test(line)) return true; // block-comment / JSDoc continuation line
  const before = line.slice(0, tokenStart);
  if (HASH_EXT.has(ext)) return before.includes("#");
  if (DASH_EXT.has(ext)) return before.includes("--") || before.includes("/*");
  if (SEMI_EXT.has(ext)) return before.includes(";");
  return before.includes("//") || before.includes("/*"); // c-like default
}

/** Trim a trailing line-comment left empty after a strip (`code; //` → `code;`). */
function trimEmptiedTrailingComment(line: string, ext: string): string {
  if (HASH_EXT.has(ext)) return line.replace(/\s*#+\s*$/, "");
  if (DASH_EXT.has(ext)) return line.replace(/\s*--+\s*$/, "");
  if (SEMI_EXT.has(ext)) return line.replace(/\s*;+\s*$/, "");
  if (TEXT_EXT.has(ext)) return line.replace(/\s+$/, "");
  return line.replace(/\s*\/\/+\s*$/, ""); // c-like trailing `//`
}

interface StripResult {
  text: string;
  /** Archived tokens removed from inline (non-pure-cite) lines. */
  stripped: number;
  /** Archived tokens left because they sit bare in code (manual review). */
  unsafeSkipped: number;
}

/**
 * Remove archived-entity cite tokens that sit on an INLINE line — one the
 * expander won't touch because it shares the line with code or prose. A token
 * is removed only when it's a text file or provably inside a comment; a token
 * bare in code is left and counted in `unsafeSkipped`. `isArchived` decides
 * which ids are in scope — active-entity cites are never stripped. Pure-cite
 * lines are skipped here (the expander already restored their prose).
 */
function stripArchivedInlineTokens(
  text: string,
  isArchived: (id: string) => boolean,
  ext: string,
): StripResult {
  const isText = TEXT_EXT.has(ext);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  let stripped = 0;
  let unsafeSkipped = 0;

  const out = lines.map((line) => {
    const matches = [...line.matchAll(CITE_TOKEN_RE)];
    if (matches.length === 0) return line;
    // Pure-cite lines belong to the expander — don't double-handle.
    const bare = line.replace(CITE_TOKEN_RE, "").replace(/\s+$/, "");
    if (PURE_CITE_LEADER_RE.test(bare)) return line;

    let result = "";
    let cursor = 0;
    let strippedHere = 0;
    for (const m of matches) {
      const start = m.index ?? 0;
      const end = start + m[0].length;
      const id = m[0].slice(1); // drop the leading §
      result += line.slice(cursor, start);
      const safe = isText || tokenInComment(line, start, ext);
      if (isArchived(id) && safe) {
        // Remove the token plus exactly ONE adjacent space so prose stays
        // readable: `a §TOK b` → `a b` (one space), `code; // §TOK` → `code; //`.
        const hasLead = result.endsWith(" ");
        const hasTrail = line[end] === " ";
        if (hasTrail) {
          cursor = end + 1; // swallow the trailing space (keep any leading)
        } else if (hasLead) {
          result = result.slice(0, -1); // no trailing space — drop the leading one
          cursor = end;
        } else {
          cursor = end;
        }
        stripped += 1;
        strippedHere += 1;
      } else {
        if (isArchived(id)) unsafeSkipped += 1;
        result += line.slice(start, end);
        cursor = end;
      }
    }
    result += line.slice(cursor);
    if (strippedHere > 0) result = trimEmptiedTrailingComment(result, ext);
    return result;
  });

  return { text: out.join(eol), stripped, unsafeSkipped };
}

function extOf(filePath: string): string {
  const dot = filePath.lastIndexOf(".");
  const slash = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));
  return dot > slash ? filePath.slice(dot).toLowerCase() : "";
}

/**
 * ONE repair pass over the cited-file set. Two transforms per file,
 * archived-scoped throughout (active and unknown cites are never touched):
 *
 *   1. expand — a PURE archived cite line is restored to the archived prose
 *      (self-documenting), via `expandCitesInText` + the `.archive/` resolver.
 *   2. strip  — an archived token on an INLINE line (shares the line with code
 *      or prose) can't be safely expanded, so the bare token is removed when
 *      it's a text file or provably inside a comment. A token bare in code is
 *      left and reported in `unsafeSkipped` for manual review.
 *
 * The public `repairArchivedCitesInRepo` loops this to convergence — the walk
 * (`findCitedFiles`) can transiently skip a subtree under concurrent fs
 * activity, and a partial pass would otherwise leave stragglers behind while
 * the migration reports success (and advances the version pin past retry).
 */
function repairArchivedCitesPass(
  opts: { repoRoot: string; files?: string[]; dryRun?: boolean },
): ExpandCitesRepoResult {
  const targets = opts.files ?? findCitedFiles(opts.repoRoot);
  const isArchived = (id: string): boolean =>
    readArchivedEntityBody(opts.repoRoot, id) !== null;

  const out: ExpandCitesRepoResult = {
    files: [],
    filesChanged: 0,
    expanded: 0,
    danglingSkipped: 0,
    inlineSkipped: 0,
    strippedInline: 0,
    unsafeSkipped: 0,
  };

  for (const filePath of targets) {
    const abs = join(opts.repoRoot, filePath);
    if (!existsSync(abs)) continue;
    let source: string;
    try {
      source = readFileSync(abs, "utf8");
    } catch {
      continue;
    }

    const expandResult = expandCitesInText(source, (id) =>
      readArchivedEntityBody(opts.repoRoot, id),
    );
    const stripResult = stripArchivedInlineTokens(
      expandResult.text,
      isArchived,
      extOf(filePath),
    );

    const finalText = stripResult.text;
    const changed = finalText !== source;
    if (
      expandResult.expanded === 0 &&
      stripResult.stripped === 0 &&
      expandResult.danglingSkipped === 0 &&
      stripResult.unsafeSkipped === 0
    ) {
      continue; // nothing archived-related in this file
    }

    if (changed && opts.dryRun !== true) {
      try {
        writeFileSync(abs, finalText, "utf8");
      } catch {
        /* best-effort — leave for a re-run */
      }
    }

    out.files.push({
      filePath,
      text: finalText,
      expanded: expandResult.expanded,
      danglingSkipped: expandResult.danglingSkipped,
      inlineSkipped: expandResult.inlineSkipped,
      changed,
    });
    if (changed) out.filesChanged += 1;
    out.expanded += expandResult.expanded;
    out.danglingSkipped += expandResult.danglingSkipped;
    out.inlineSkipped += expandResult.inlineSkipped;
    out.strippedInline += stripResult.stripped;
    out.unsafeSkipped += stripResult.unsafeSkipped;
  }

  return out;
}

/** Upper bound on repair passes — convergence is monotone, so this is a backstop. */
const MAX_REPAIR_PASSES = 8;

/**
 * Repair archived-entity cites repo-wide, looping {@link repairArchivedCitesPass}
 * until a pass does no work (expands nothing and strips nothing). `unsafeSkipped`
 * tokens (bare in code) are a stable residual — they never count as progress, so
 * the loop converges. A dry-run reports a single pass (enough for `detect()`:
 * any work pending → true). Returns aggregate counts; `files` is omitted
 * (per-file detail is per-pass and not meaningful across the loop).
 */
export function repairArchivedCitesInRepo(
  opts: { repoRoot: string; files?: string[]; dryRun?: boolean },
): ExpandCitesRepoResult {
  if (opts.dryRun === true) return repairArchivedCitesPass(opts);

  const changedFiles = new Set<string>();
  const out: ExpandCitesRepoResult = {
    files: [],
    filesChanged: 0,
    expanded: 0,
    danglingSkipped: 0,
    inlineSkipped: 0,
    strippedInline: 0,
    unsafeSkipped: 0,
  };

  for (let pass = 0; pass < MAX_REPAIR_PASSES; pass += 1) {
    const p = repairArchivedCitesPass(opts);
    out.expanded += p.expanded;
    out.strippedInline += p.strippedInline;
    for (const f of p.files) if (f.changed) changedFiles.add(f.filePath);
    // The latest pass's residual snapshot — what's left once work stops.
    out.danglingSkipped = p.danglingSkipped;
    out.inlineSkipped = p.inlineSkipped;
    out.unsafeSkipped = p.unsafeSkipped;
    if (p.expanded + p.strippedInline === 0) break; // converged
  }

  out.filesChanged = changedFiles.size;
  return out;
}
