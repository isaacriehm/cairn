/**
 * Curator pipeline — regex pre-filter (Phase 9a-walker).
 *
 * Drops corpus records that the curator subagents would only classify
 * as noise:
 *   - test files / fixtures / snapshots
 *   - generated / build / vendor / migrations
 *   - .planning/archive/
 *   - JSX block comments (lots of UI annotation noise)
 *   - license / SPDX headers
 *   - JSDoc with only @param/@returns/@see/@throws and < 30 words prose
 *   - TODO-only or banner-only comments
 *
 * Mapper.off_limits_globs is also applied (so the operator's own
 * exclusion list filters the corpus too).
 *
 * Plus a pure-function `stripJsdocTags` that strips `@domain`,
 * `@orgScope`, `@softDelete`, `@see`, `@param`, `@returns`, `@throws`
 * scaffolding lines from prose so they don't leak into reducer
 * output. Validators downstream re-check `jsdoc-tag-leak`; this is
 * the defense-in-depth at the walker level.
 *
 * Drop targets (from curator plan):
 *   60–80% of the raw corpus is expected to drop here.
 */

const TEST_FILE_RE =
  /(?:^|\/)(?:[^/]+\.(?:spec|test)\.(?:[tj]sx?|mjs|cjs)|__tests__\/|e2e\/|fixtures\/|snapshots?\/|__snapshots__\/)/;
const GENERATED_DIR_RE =
  /(?:^|\/)(?:migrations|dist|build|generated|vendor|node_modules)\//;
const ARCHIVE_DIR_RE = /(?:^|\/)\.planning\/archive\//;
const TODO_BANNER_RE = /^\s*(?:TODO|FIXME|XXX|HACK|NOTE)\b/;
const PURE_BANNER_RE = /^[\s\W_]+$/;
const SPDX_LICENSE_RE = /\b(?:SPDX-License-Identifier|All rights reserved|Licensed under)\b/i;
const COPYRIGHT_RE = /\bcopyright\b/i;
const JSDOC_TAG_LINE_RE =
  /^\s*@(?:domain|orgScope|softDelete|see|param|returns?|throws?|example|deprecated|since|version|author|module|namespace|alias|constant|type|typedef|callback|exports|category|memberof|inheritdoc|override|fileoverview|api|public|private|protected|internal|readonly|abstract|static|access|todo|fires|listens|hideconstructor)\b.*$/gm;

export type DropReason =
  | "test-file"
  | "generated-dir"
  | "archive-dir"
  | "off-limits-glob"
  | "jsx-block-comment"
  | "license-header"
  | "jsdoc-tag-only"
  | "todo-or-banner-only"
  | "below-minimum-prose";

const MIN_WORDS_AFTER_TAG_STRIP = 12;

export interface PrefilterArgs {
  /** Repo-relative path the block came from. */
  file: string;
  /**
   * Source-kind tag — `comment` records get the JSX + JSDoc-tag-only
   * filters; `doc` and `rule` records skip those (paragraph + section
   * shapes are different).
   */
  source_kind: "comment" | "doc" | "rule";
  /** Cleaned prose (after the language-specific marker stripper). */
  prose: string;
  /** Raw block (carries surrounding context for the JSX detector). */
  raw?: string;
  /** Mapper off-limits globs to honor. Glob matching is prefix/contains-friendly. */
  offLimitsGlobs?: string[];
}

export interface PrefilterResult {
  drop: boolean;
  reason?: DropReason;
  /** Prose with JSDoc scaffolding tags stripped. Caller writes this to corpus.jsonl. */
  cleanedProse: string;
}

export function applyPrefilter(args: PrefilterArgs): PrefilterResult {
  const cleaned = stripJsdocTags(args.prose);

  if (TEST_FILE_RE.test(args.file)) {
    return { drop: true, reason: "test-file", cleanedProse: cleaned };
  }
  if (GENERATED_DIR_RE.test(args.file)) {
    return { drop: true, reason: "generated-dir", cleanedProse: cleaned };
  }
  if (ARCHIVE_DIR_RE.test(args.file)) {
    return { drop: true, reason: "archive-dir", cleanedProse: cleaned };
  }
  if (matchesAnyGlob(args.file, args.offLimitsGlobs)) {
    return { drop: true, reason: "off-limits-glob", cleanedProse: cleaned };
  }

  if (args.source_kind === "comment") {
    if (isJsxBlockComment(args.raw, args.file)) {
      return { drop: true, reason: "jsx-block-comment", cleanedProse: cleaned };
    }
    if (isLicenseHeader(args.raw ?? args.prose)) {
      return { drop: true, reason: "license-header", cleanedProse: cleaned };
    }
    if (isJsdocTagOnly(args.prose, cleaned)) {
      return { drop: true, reason: "jsdoc-tag-only", cleanedProse: cleaned };
    }
  }

  if (isTodoOrBannerOnly(cleaned)) {
    return { drop: true, reason: "todo-or-banner-only", cleanedProse: cleaned };
  }
  if (countWords(cleaned) < MIN_WORDS_AFTER_TAG_STRIP) {
    return { drop: true, reason: "below-minimum-prose", cleanedProse: cleaned };
  }

  return { drop: false, cleanedProse: cleaned };
}

/**
 * Strip JSDoc-style scaffolding tag lines from prose. Defensive layer
 * before the LLM ever sees them; validators downstream still check.
 */
export function stripJsdocTags(prose: string): string {
  return prose
    .replace(JSDOC_TAG_LINE_RE, "")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * JSX block comments live inside `{/* … *\/}` — they're UI annotations
 * and almost never carry decision-bearing prose. Detection: the file
 * is .tsx/.jsx and either the raw block starts with `{/` (the JSX
 * wrapper got captured) or the surrounding chars are JSX brackets.
 *
 * Conservative — when the source is not .tsx/.jsx we never flag this
 * reason, since `/* … *\/` in normal .ts is fine.
 */
function isJsxBlockComment(raw: string | undefined, file: string): boolean {
  if (!/\.(?:[tj])sx$/.test(file)) return false;
  if (raw === undefined) return false;
  const head = raw.trimStart().slice(0, 4);
  return head.startsWith("{/*");
}

function isLicenseHeader(raw: string): boolean {
  const head = raw.slice(0, 1500);
  return SPDX_LICENSE_RE.test(head) || COPYRIGHT_RE.test(head);
}

/**
 * Returns true when the JSDoc block carries scaffolding tags but
 * < MIN_WORDS_AFTER_TAG_STRIP words of real prose. Many JSDoc blocks
 * are pure `@param`/`@returns` lists with a one-line summary —
 * curator should drop those rather than dispatch a Sonnet call.
 */
function isJsdocTagOnly(originalProse: string, cleaned: string): boolean {
  const hadTag = JSDOC_TAG_LINE_RE.test(originalProse);
  if (!hadTag) return false;
  return countWords(cleaned) < MIN_WORDS_AFTER_TAG_STRIP;
}

function isTodoOrBannerOnly(cleaned: string): boolean {
  if (cleaned.length === 0) return true;
  const lines = cleaned
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
  if (lines.length === 0) return true;
  let nonTodo = 0;
  for (const line of lines) {
    if (TODO_BANNER_RE.test(line)) continue;
    if (PURE_BANNER_RE.test(line)) continue;
    nonTodo += 1;
  }
  return nonTodo === 0;
}

function countWords(prose: string): number {
  const stripped = prose.replace(/[^\p{L}\p{N}\s]/gu, " ");
  const tokens = stripped.split(/\s+/).filter((t) => t.length > 0);
  return tokens.length;
}

// Lightweight glob match — supports `*` and `**` segment wildcards,
// good enough for `off_limits_globs` patterns like `vendor` or `dist`
// at any depth. Not a full minimatch; the curator only needs
// prefix-style matching.
function matchesAnyGlob(file: string, globs?: string[]): boolean {
  if (globs === undefined || globs.length === 0) return false;
  for (const g of globs) {
    if (matchesGlob(file, g)) return true;
  }
  return false;
}

function matchesGlob(file: string, glob: string): boolean {
  const re = globToRegex(glob);
  return re.test(file);
}

function globToRegex(glob: string): RegExp {
  // Translate ** → `.*`, * → `[^/]*`, escape everything else.
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        out += ".*";
        i += 1;
      } else {
        out += "[^/]*";
      }
      continue;
    }
    if (ch === "?") {
      out += "[^/]";
      continue;
    }
    if (ch === undefined) continue;
    if (".+^$()[]{}|\\".includes(ch)) {
      out += `\\${ch}`;
    } else {
      out += ch;
    }
  }
  return new RegExp(`^${out}$`);
}
