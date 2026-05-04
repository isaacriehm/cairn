/**
 * Phase 7b — deterministic source-comment walker.
 *
 * Walks every source file in the repo (via `git ls-files` when available, else
 * a manual recursive walk respecting a hardcoded ignore list) and extracts
 * essay-style comment blocks per language. Detection is deterministic — no
 * LLM. The output feeds the Haiku batch classifier (`classify.ts`).
 *
 * "Essay-style" heuristic per spec §15:
 *   - block comment > 3 lines, OR
 *   - block comment > 200 chars, OR
 *   - JSDoc with > 30 words of prose (after stripping @tags + symbols).
 *
 * License headers are detected separately and exported with `kind: "license"`
 * — the classifier passes them through; the strip-replace stage leaves them
 * in source untouched.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { extname, join, relative } from "node:path";

const SOURCE_EXTENSIONS = new Set<string>([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".rs",
  ".go",
  ".java",
  ".kt",
  ".kts",
  ".swift",
  ".scala",
  ".c",
  ".cc",
  ".cpp",
  ".cxx",
  ".h",
  ".hpp",
  ".cs",
  ".rb",
  ".sh",
  ".bash",
  ".zsh",
  ".php",
  ".lua",
  ".dart",
]);

const SKIP_DIRS = new Set<string>([
  ".git",
  "node_modules",
  "dist",
  "build",
  "target",
  "out",
  "__pycache__",
  "vendor",
  ".venv",
  ".direnv",
  ".cache",
  "coverage",
  ".next",
  ".turbo",
  ".nuxt",
  ".svelte-kit",
  ".astro",
  ".parcel-cache",
  ".vercel",
  ".netlify",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".tox",
  ".gradle",
  ".idea",
  ".vscode",
  ".harness",
  ".archive",
]);

/** Lower bound: only consider blocks above one of these. */
const MIN_LINES = 4;
const MIN_CHARS = 200;
const MIN_JSDOC_WORDS = 30;

export type CommentLang =
  | "js"
  | "py"
  | "rs"
  | "go"
  | "java"
  | "c"
  | "cs"
  | "rb"
  | "sh"
  | "php"
  | "lua"
  | "dart"
  | "kt"
  | "swift"
  | "scala"
  | "unknown";

export type CommentKind =
  | "block"
  | "jsdoc"
  | "line-cluster"
  | "license";

export interface CommentBlock {
  /** Stable per-walk id: `<rel-path>:<startLine>-<endLine>` */
  id: string;
  /** Repo-relative POSIX path. */
  file: string;
  lang: CommentLang;
  kind: CommentKind;
  /** 1-based, inclusive. */
  startLine: number;
  /** 1-based, inclusive. */
  endLine: number;
  /** Raw text including comment markers. */
  raw: string;
  /** Stripped prose — markers + leading `*` removed, used for word count. */
  prose: string;
  lineCount: number;
  charCount: number;
  wordCount: number;
  /** Index where `raw` starts in the file (UTF-8 bytes ≈ chars for source). */
  startOffset: number;
  /** Index immediately after `raw`. */
  endOffset: number;
}

export interface WalkOptions {
  repoRoot: string;
  /** Cap on files to read; default unlimited (full repo per spec). */
  fileCap?: number;
  /** When set, only walk these paths (repo-relative). Used by tests. */
  onlyFiles?: string[];
}

export interface WalkResult {
  files: string[];
  blocks: CommentBlock[];
  /** Per-language file count for telemetry. */
  fileCountByLang: Record<string, number>;
  /** Total raw chars scanned. */
  bytesScanned: number;
}

/* -------------------------------------------------------------------------- */
/* Public API                                                                 */
/* -------------------------------------------------------------------------- */

export function walkSourceComments(opts: WalkOptions): WalkResult {
  const repoRoot = opts.repoRoot;
  const files = opts.onlyFiles ?? listSourceFiles(repoRoot, opts.fileCap);
  const blocks: CommentBlock[] = [];
  const fileCountByLang: Record<string, number> = {};
  let bytesScanned = 0;

  for (const rel of files) {
    const lang = detectLang(rel);
    if (lang === "unknown") continue;
    fileCountByLang[lang] = (fileCountByLang[lang] ?? 0) + 1;
    const abs = join(repoRoot, rel);
    let body: string;
    try {
      body = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    bytesScanned += body.length;
    const fileBlocks = extractFileBlocks(rel, lang, body);
    for (const b of fileBlocks) blocks.push(b);
  }

  return { files, blocks, fileCountByLang, bytesScanned };
}

/* -------------------------------------------------------------------------- */
/* File discovery                                                             */
/* -------------------------------------------------------------------------- */

function listSourceFiles(repoRoot: string, fileCap?: number): string[] {
  const fromGit = listFromGit(repoRoot);
  const list = fromGit ?? listFromFs(repoRoot);
  const filtered = list.filter((p) => SOURCE_EXTENSIONS.has(extname(p).toLowerCase()));
  if (fileCap !== undefined && filtered.length > fileCap) {
    return filtered.slice(0, fileCap);
  }
  return filtered;
}

function listFromGit(repoRoot: string): string[] | null {
  try {
    const out = execFileSync(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      {
        cwd: repoRoot,
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
      },
    );
    const parts = out.split("\0").filter((s) => s.length > 0);
    return parts.filter((p) => !pathInSkipDir(p));
  } catch {
    return null;
  }
}

function listFromFs(repoRoot: string): string[] {
  const out: string[] = [];
  walkFs(repoRoot, repoRoot, out);
  return out;
}

function walkFs(repoRoot: string, dir: string, out: string[]): void {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true, encoding: "utf8" });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name.startsWith(".") && SKIP_DIRS.has(e.name)) continue;
    if (SKIP_DIRS.has(e.name)) continue;
    const abs = join(dir, e.name);
    if (e.isDirectory()) {
      walkFs(repoRoot, abs, out);
      continue;
    }
    if (!e.isFile()) continue;
    out.push(toPosix(relative(repoRoot, abs)));
  }
}

function pathInSkipDir(rel: string): boolean {
  const segs = rel.split(/[\\/]/);
  for (const s of segs) if (SKIP_DIRS.has(s)) return true;
  return false;
}

function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

/* -------------------------------------------------------------------------- */
/* Lang detection                                                             */
/* -------------------------------------------------------------------------- */

export function detectLang(file: string): CommentLang {
  const ext = extname(file).toLowerCase();
  switch (ext) {
    case ".ts":
    case ".tsx":
    case ".js":
    case ".jsx":
    case ".mjs":
    case ".cjs":
      return "js";
    case ".py":
      return "py";
    case ".rs":
      return "rs";
    case ".go":
      return "go";
    case ".java":
      return "java";
    case ".kt":
    case ".kts":
      return "kt";
    case ".swift":
      return "swift";
    case ".scala":
      return "scala";
    case ".c":
    case ".cc":
    case ".cpp":
    case ".cxx":
    case ".h":
    case ".hpp":
      return "c";
    case ".cs":
      return "cs";
    case ".rb":
      return "rb";
    case ".sh":
    case ".bash":
    case ".zsh":
      return "sh";
    case ".php":
      return "php";
    case ".lua":
      return "lua";
    case ".dart":
      return "dart";
    default:
      return "unknown";
  }
}

/* -------------------------------------------------------------------------- */
/* Per-file extraction                                                        */
/* -------------------------------------------------------------------------- */

function extractFileBlocks(
  file: string,
  lang: CommentLang,
  body: string,
): CommentBlock[] {
  switch (lang) {
    case "js":
    case "java":
    case "c":
    case "cs":
    case "kt":
    case "swift":
    case "scala":
    case "php":
    case "dart":
      return extractCStyle(file, lang, body);
    case "rs":
      return extractRust(file, body);
    case "go":
      return extractGo(file, body);
    case "py":
      return extractPython(file, body);
    case "rb":
      return extractRuby(file, body);
    case "sh":
    case "lua":
      return extractHashCluster(file, lang, body);
    default:
      return [];
  }
}

/* C-style: /* … *\/, /** … *\/ (JSDoc), and clusters of // (3+ lines). */
function extractCStyle(file: string, lang: CommentLang, body: string): CommentBlock[] {
  const blocks: CommentBlock[] = [];
  const lineStarts = computeLineStarts(body);
  const len = body.length;
  let i = 0;
  while (i < len) {
    if (body[i] === "/" && body[i + 1] === "*") {
      const isJsDoc = body[i + 2] === "*" && body[i + 3] !== "/";
      const end = body.indexOf("*/", i + 2);
      if (end === -1) break;
      const startOffset = i;
      const endOffset = end + 2;
      const raw = body.slice(startOffset, endOffset);
      const startLine = offsetToLine(lineStarts, startOffset);
      const endLine = offsetToLine(lineStarts, endOffset - 1);
      const block = makeBlock({
        file,
        lang,
        kind: isJsDoc ? "jsdoc" : "block",
        raw,
        startLine,
        endLine,
        startOffset,
        endOffset,
        prose: stripCStyleProse(raw, isJsDoc),
      });
      const license = isLicense(block);
      if (license) block.kind = "license";
      if (passesHeuristic(block)) blocks.push(block);
      i = endOffset;
      continue;
    }
    if (body[i] === "/" && body[i + 1] === "/" && !inString(body, i)) {
      const cluster = readLineCluster(body, lineStarts, i, "//");
      if (cluster !== null) {
        const block = makeBlock({
          file,
          lang,
          kind: "line-cluster",
          raw: cluster.raw,
          startLine: cluster.startLine,
          endLine: cluster.endLine,
          startOffset: cluster.startOffset,
          endOffset: cluster.endOffset,
          prose: stripLineClusterProse(cluster.raw, "//"),
        });
        if (isLicense(block)) block.kind = "license";
        if (passesHeuristic(block)) blocks.push(block);
        i = cluster.endOffset;
        continue;
      }
    }
    if (body[i] === '"' || body[i] === "'" || body[i] === "`") {
      i = skipString(body, i);
      continue;
    }
    i += 1;
  }
  return blocks;
}

function extractGo(file: string, body: string): CommentBlock[] {
  return extractCStyle(file, "go", body);
}

function extractRust(file: string, body: string): CommentBlock[] {
  // Rust: ///, //!, /** */, /*! */ are doc-style. Treat /// + //! clusters as JSDoc-equiv.
  const blocks: CommentBlock[] = [];
  const lineStarts = computeLineStarts(body);
  const len = body.length;
  let i = 0;
  while (i < len) {
    if (body[i] === "/" && body[i + 1] === "*") {
      const end = body.indexOf("*/", i + 2);
      if (end === -1) break;
      const startOffset = i;
      const endOffset = end + 2;
      const raw = body.slice(startOffset, endOffset);
      const startLine = offsetToLine(lineStarts, startOffset);
      const endLine = offsetToLine(lineStarts, endOffset - 1);
      const isDoc = body[i + 2] === "*" || body[i + 2] === "!";
      const block = makeBlock({
        file,
        lang: "rs",
        kind: isDoc ? "jsdoc" : "block",
        raw,
        startLine,
        endLine,
        startOffset,
        endOffset,
        prose: stripCStyleProse(raw, isDoc),
      });
      if (isLicense(block)) block.kind = "license";
      if (passesHeuristic(block)) blocks.push(block);
      i = endOffset;
      continue;
    }
    if (body[i] === "/" && body[i + 1] === "/" && !inString(body, i)) {
      // Detect /// or //! prefix for doc-cluster
      const isDoc = body[i + 2] === "/" || body[i + 2] === "!";
      const marker = isDoc ? (body[i + 2] === "/" ? "///" : "//!") : "//";
      const cluster = readLineCluster(body, lineStarts, i, marker);
      if (cluster !== null) {
        const block = makeBlock({
          file,
          lang: "rs",
          kind: isDoc ? "jsdoc" : "line-cluster",
          raw: cluster.raw,
          startLine: cluster.startLine,
          endLine: cluster.endLine,
          startOffset: cluster.startOffset,
          endOffset: cluster.endOffset,
          prose: stripLineClusterProse(cluster.raw, marker),
        });
        if (isLicense(block)) block.kind = "license";
        if (passesHeuristic(block)) blocks.push(block);
        i = cluster.endOffset;
        continue;
      }
    }
    if (body[i] === '"') {
      i = skipString(body, i);
      continue;
    }
    i += 1;
  }
  return blocks;
}

function extractPython(file: string, body: string): CommentBlock[] {
  const blocks: CommentBlock[] = [];
  const lineStarts = computeLineStarts(body);
  const len = body.length;
  let i = 0;
  while (i < len) {
    // Triple-quoted strings used as docstrings. We treat any """…""" or '''…'''
    // anywhere as a candidate. Real Python docstrings only count when at module
    // start or right after `def`/`class`, but for adoption purposes we capture
    // every triple-string to maximize prose surface; the classifier filters.
    if (
      (body[i] === '"' && body[i + 1] === '"' && body[i + 2] === '"') ||
      (body[i] === "'" && body[i + 1] === "'" && body[i + 2] === "'")
    ) {
      const quote = body.slice(i, i + 3);
      const end = body.indexOf(quote, i + 3);
      if (end === -1) break;
      const startOffset = i;
      const endOffset = end + 3;
      const raw = body.slice(startOffset, endOffset);
      const startLine = offsetToLine(lineStarts, startOffset);
      const endLine = offsetToLine(lineStarts, endOffset - 1);
      const block = makeBlock({
        file,
        lang: "py",
        kind: "block",
        raw,
        startLine,
        endLine,
        startOffset,
        endOffset,
        prose: stripPyDocstringProse(raw),
      });
      if (isLicense(block)) block.kind = "license";
      if (passesHeuristic(block)) blocks.push(block);
      i = endOffset;
      continue;
    }
    if (body[i] === "#") {
      const cluster = readLineCluster(body, lineStarts, i, "#");
      if (cluster !== null) {
        const block = makeBlock({
          file,
          lang: "py",
          kind: "line-cluster",
          raw: cluster.raw,
          startLine: cluster.startLine,
          endLine: cluster.endLine,
          startOffset: cluster.startOffset,
          endOffset: cluster.endOffset,
          prose: stripLineClusterProse(cluster.raw, "#"),
        });
        if (isLicense(block)) block.kind = "license";
        if (passesHeuristic(block)) blocks.push(block);
        i = cluster.endOffset;
        continue;
      }
    }
    i += 1;
  }
  return blocks;
}

function extractRuby(file: string, body: string): CommentBlock[] {
  const blocks: CommentBlock[] = [];
  const lineStarts = computeLineStarts(body);
  const len = body.length;
  let i = 0;
  while (i < len) {
    // =begin … =end heredoc-style block at line start
    if (atLineStart(body, i) && body.startsWith("=begin", i)) {
      const end = body.indexOf("\n=end", i);
      if (end === -1) break;
      const closeNl = body.indexOf("\n", end + 5);
      const endOffset = closeNl === -1 ? body.length : closeNl;
      const startOffset = i;
      const raw = body.slice(startOffset, endOffset);
      const startLine = offsetToLine(lineStarts, startOffset);
      const endLine = offsetToLine(lineStarts, endOffset - 1);
      const block = makeBlock({
        file,
        lang: "rb",
        kind: "block",
        raw,
        startLine,
        endLine,
        startOffset,
        endOffset,
        prose: raw.replace(/^=begin.*$|^=end.*$/gm, "").trim(),
      });
      if (isLicense(block)) block.kind = "license";
      if (passesHeuristic(block)) blocks.push(block);
      i = endOffset;
      continue;
    }
    if (body[i] === "#") {
      const cluster = readLineCluster(body, lineStarts, i, "#");
      if (cluster !== null) {
        const block = makeBlock({
          file,
          lang: "rb",
          kind: "line-cluster",
          raw: cluster.raw,
          startLine: cluster.startLine,
          endLine: cluster.endLine,
          startOffset: cluster.startOffset,
          endOffset: cluster.endOffset,
          prose: stripLineClusterProse(cluster.raw, "#"),
        });
        if (isLicense(block)) block.kind = "license";
        if (passesHeuristic(block)) blocks.push(block);
        i = cluster.endOffset;
        continue;
      }
    }
    i += 1;
  }
  return blocks;
}

function extractHashCluster(file: string, lang: CommentLang, body: string): CommentBlock[] {
  const blocks: CommentBlock[] = [];
  const lineStarts = computeLineStarts(body);
  const len = body.length;
  let i = 0;
  while (i < len) {
    if (body[i] === "#" && (i === 0 || body[i - 1] === "\n")) {
      // shebang line — skip if first line and starts with #!
      if (i === 0 && body[i + 1] === "!") {
        const nl = body.indexOf("\n", i);
        if (nl === -1) break;
        i = nl + 1;
        continue;
      }
      const cluster = readLineCluster(body, lineStarts, i, "#");
      if (cluster !== null) {
        const block = makeBlock({
          file,
          lang,
          kind: "line-cluster",
          raw: cluster.raw,
          startLine: cluster.startLine,
          endLine: cluster.endLine,
          startOffset: cluster.startOffset,
          endOffset: cluster.endOffset,
          prose: stripLineClusterProse(cluster.raw, "#"),
        });
        if (isLicense(block)) block.kind = "license";
        if (passesHeuristic(block)) blocks.push(block);
        i = cluster.endOffset;
        continue;
      }
    }
    i += 1;
  }
  return blocks;
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

interface MakeBlockArgs {
  file: string;
  lang: CommentLang;
  kind: CommentKind;
  raw: string;
  startLine: number;
  endLine: number;
  startOffset: number;
  endOffset: number;
  prose: string;
}

function makeBlock(a: MakeBlockArgs): CommentBlock {
  const lineCount = a.endLine - a.startLine + 1;
  const charCount = a.raw.length;
  const wordCount = countWords(a.prose);
  return {
    id: `${a.file}:${a.startLine}-${a.endLine}`,
    file: a.file,
    lang: a.lang,
    kind: a.kind,
    startLine: a.startLine,
    endLine: a.endLine,
    raw: a.raw,
    prose: a.prose,
    lineCount,
    charCount,
    wordCount,
    startOffset: a.startOffset,
    endOffset: a.endOffset,
  };
}

function passesHeuristic(b: CommentBlock): boolean {
  if (b.kind === "license") return true; // capture, just don't strip
  if (b.kind === "jsdoc") {
    if (b.wordCount > MIN_JSDOC_WORDS) return true;
    return b.lineCount >= MIN_LINES || b.charCount > MIN_CHARS;
  }
  return b.lineCount >= MIN_LINES || b.charCount > MIN_CHARS;
}

function isLicense(b: CommentBlock): boolean {
  // Only check the first 1000 chars for typical license markers.
  const head = b.raw.slice(0, 1000);
  return (
    /\bcopyright\b/i.test(head) ||
    /\bSPDX-License-Identifier\b/.test(head) ||
    /\bAll rights reserved\b/i.test(head) ||
    /\bLicensed under\b/i.test(head)
  );
}

function stripCStyleProse(raw: string, isJsDoc: boolean): string {
  // Strip /* */ and leading * per line; if JSDoc, drop @tag blocks.
  let s = raw.replace(/^\/\*+!?/, "").replace(/\*+\/$/, "");
  s = s
    .split("\n")
    .map((line) => line.replace(/^\s*\*+\s?/, ""))
    .join("\n");
  if (isJsDoc) {
    // drop @tag lines (e.g. @param, @returns, @throws, @example)
    s = s
      .split("\n")
      .filter((line) => !/^\s*@\w+/.test(line))
      .join("\n");
  }
  return s.trim();
}

function stripLineClusterProse(raw: string, marker: string): string {
  // marker: //, ///, //!, #
  const escaped = marker.replace(/[/]/g, "\\/");
  const re = new RegExp(`^\\s*${escaped}\\s?`, "gm");
  return raw.replace(re, "").trim();
}

function stripPyDocstringProse(raw: string): string {
  // strip leading + trailing triple quotes
  let s = raw;
  const q = s.slice(0, 3);
  if (q === '"""' || q === "'''") s = s.slice(3);
  if (s.endsWith('"""') || s.endsWith("'''")) s = s.slice(0, -3);
  return s.trim();
}

function countWords(prose: string): number {
  const stripped = prose.replace(/[^\p{L}\p{N}\s]/gu, " ");
  const tokens = stripped.split(/\s+/).filter((t) => t.length > 0);
  return tokens.length;
}

function computeLineStarts(body: string): number[] {
  const starts: number[] = [0];
  for (let i = 0; i < body.length; i++) {
    if (body[i] === "\n") starts.push(i + 1);
  }
  return starts;
}

function offsetToLine(starts: number[], offset: number): number {
  // binary search
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >>> 1;
    const v = starts[mid];
    if (v !== undefined && v <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

function atLineStart(body: string, i: number): boolean {
  return i === 0 || body[i - 1] === "\n";
}

interface ClusterRead {
  raw: string;
  startLine: number;
  endLine: number;
  startOffset: number;
  endOffset: number;
}

/**
 * Read a contiguous cluster of single-line comments starting at `i` (which
 * must point to the marker). Returns null if the cluster is < MIN_LINES and
 * the total chars is ≤ MIN_CHARS — the caller's heuristic also re-checks, but
 * this fast-rejects short clusters cheaply.
 */
function readLineCluster(
  body: string,
  lineStarts: number[],
  i: number,
  marker: string,
): ClusterRead | null {
  // Verify we're at a line start.
  if (!atLineStart(body, i)) {
    // Allow leading whitespace before marker (indented comments).
    let j = i;
    while (j > 0 && (body[j - 1] === " " || body[j - 1] === "\t")) j -= 1;
    if (j === 0 || body[j - 1] === "\n") {
      i = j;
    } else {
      return null;
    }
  }
  const startLine = offsetToLine(lineStarts, i);
  const startOffset = i;
  let cursor = i;
  let lineCount = 0;
  while (cursor < body.length) {
    // Skip leading whitespace
    let lineStart = cursor;
    while (
      lineStart < body.length &&
      (body[lineStart] === " " || body[lineStart] === "\t")
    ) {
      lineStart += 1;
    }
    if (!body.startsWith(marker, lineStart)) break;
    // Reject /// when we're scanning //, and vice-versa: marker must match exactly
    // and not be a prefix of a longer one (handled by callers picking the right marker).
    const nextChar = body[lineStart + marker.length];
    if (marker === "//" && (nextChar === "/" || nextChar === "!")) break;
    const nl = body.indexOf("\n", lineStart);
    cursor = nl === -1 ? body.length : nl + 1;
    lineCount += 1;
    if (cursor >= body.length) break;
  }
  if (lineCount < 2) return null; // cluster is at least 2 lines
  const endOffset = cursor === 0 ? 0 : (body[cursor - 1] === "\n" ? cursor - 1 : cursor);
  const raw = body.slice(startOffset, endOffset);
  const endLine = offsetToLine(lineStarts, endOffset === startOffset ? startOffset : endOffset - 1);
  return { raw, startLine, endLine, startOffset, endOffset };
}

/**
 * Crude string-context check — true when offset i is inside a "..." or '...'
 * literal on the current line. Good enough for the C-style scanner; misses
 * multi-line backtick template strings, which are rare for real "//" tokens.
 */
function inString(body: string, i: number): boolean {
  // walk back to start of line
  let j = i;
  while (j > 0 && body[j - 1] !== "\n") j -= 1;
  let s = false;
  let q: string | null = null;
  while (j < i) {
    const ch = body[j];
    if (q !== null) {
      if (ch === "\\") {
        j += 2;
        continue;
      }
      if (ch === q) {
        q = null;
        s = false;
      }
    } else if (ch === '"' || ch === "'" || ch === "`") {
      q = ch;
      s = true;
    }
    j += 1;
  }
  return s;
}

function skipString(body: string, i: number): number {
  const q = body[i];
  if (q === undefined) return i + 1;
  let j = i + 1;
  while (j < body.length) {
    if (body[j] === "\\") {
      j += 2;
      continue;
    }
    if (body[j] === q) return j + 1;
    j += 1;
  }
  return body.length;
}

/* -------------------------------------------------------------------------- */
/* Re-exports for convenience                                                 */
/* -------------------------------------------------------------------------- */

export const HEURISTIC = {
  MIN_LINES,
  MIN_CHARS,
  MIN_JSDOC_WORDS,
};

export function _existsForTest(p: string): boolean {
  return existsSync(p);
}

void statSync; // keep imports stable across edits
