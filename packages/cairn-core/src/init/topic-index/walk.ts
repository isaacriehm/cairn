/**
 * Phase 5b — cross-source prose-block walker.
 *
 * Discovers every prose block across the four narrative-bearing source
 * kinds the SoT model recognizes:
 *
 *   - docs/*.md (excluding .archive)        kind = "doc",         paragraph-granularity
 *   - CLAUDE.md                              kind = "claudemd",    H2/H3-section-granularity
 *   - AGENTS.md                              kind = "agentsmd",    H2/H3-section-granularity
 *   - .claude/rules/*.md                     kind = "rule",        H2/H3-section-granularity
 *
 * Source comments (kind = "source-comment") are reached through the
 * existing phase 7b walker and folded into the topic-index lazily by
 * phase 7b itself; phase 5b builds the doc / rules slice up front.
 *
 * Block extraction is intentionally simple — markdown formatting is
 * normalized in `slug.ts::normalizeBlock` so the slug is stable across
 * indentation changes, list-marker churn, etc. Headings are kept on the
 * first line of each section so the resolver can lift `proposedTitle`
 * without an extra LLM call.
 */

import { type Dirent, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { bodyContentHash, normalizeBlock, topicSlug } from "../../ground/slug.js";

export type ProseBlockKind = "doc" | "claudemd" | "agentsmd" | "rule" | "source-comment";

export interface ProseBlock {
  /** Repo-relative source path (e.g. `docs/auth.md`). */
  file: string;
  kind: ProseBlockKind;
  /** Heading text or first sentence — the operator-facing label. */
  title: string;
  /** Stable anchor inside the source file (markdown heading slug). */
  anchor?: string;
  /** Inclusive line range [start, end] in the source file (1-indexed). */
  line_range: [number, number];
  /** Raw body, comment-marker / list-marker -stripped. Verbatim, NOT normalized. */
  body: string;
  /** sha256 of raw body — used by anchor-map drift detection. */
  content_hash: string;
  /** sha256(normalize(body)).slice(0,12) — content-fingerprint. */
  slug: string;
}

const MIN_BLOCK_CHARS = 80;
const MIN_UNIQUE_TOKENS = 10;
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".cairn",
  "dist",
  "build",
  "out",
  ".next",
  ".turbo",
  ".cache",
  "coverage",
  ".archive",
]);

/* -------------------------------------------------------------------------- */
/* Public entry point                                                         */
/* -------------------------------------------------------------------------- */

export function walkProseBlocks(repoRoot: string): ProseBlock[] {
  const blocks: ProseBlock[] = [];
  blocks.push(...walkDocs(repoRoot));
  blocks.push(...walkRoot(repoRoot, "CLAUDE.md", "claudemd"));
  blocks.push(...walkRoot(repoRoot, "AGENTS.md", "agentsmd"));
  blocks.push(...walkRulesDir(repoRoot));
  return blocks;
}

/* -------------------------------------------------------------------------- */
/* docs/*.md — paragraph granularity                                          */
/* -------------------------------------------------------------------------- */

function walkDocs(repoRoot: string): ProseBlock[] {
  const docsDir = join(repoRoot, "docs");
  if (!existsSync(docsDir)) return [];
  const out: ProseBlock[] = [];
  for (const file of listMarkdown(docsDir)) {
    const rel = relative(repoRoot, file);
    out.push(...extractParagraphs(rel, file, "doc"));
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* CLAUDE.md / AGENTS.md / rule files — H2/H3-section granularity             */
/* -------------------------------------------------------------------------- */

function walkRoot(repoRoot: string, name: string, kind: ProseBlockKind): ProseBlock[] {
  const file = join(repoRoot, name);
  if (!existsSync(file) || !statSync(file).isFile()) return [];
  return extractSections(name, file, kind);
}

function walkRulesDir(repoRoot: string): ProseBlock[] {
  const dir = join(repoRoot, ".claude", "rules");
  if (!existsSync(dir)) return [];
  const out: ProseBlock[] = [];
  for (const file of listMarkdown(dir)) {
    const rel = relative(repoRoot, file);
    out.push(...extractSections(rel, file, "rule"));
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Markdown extraction                                                        */
/* -------------------------------------------------------------------------- */

function listMarkdown(dir: string): string[] {
  const out: string[] = [];
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true, encoding: "utf8" });
  } catch {
    return [];
  }
  for (const ent of entries) {
    if (SKIP_DIRS.has(ent.name)) continue;
    const full = join(dir, ent.name);
    if (ent.isDirectory()) {
      out.push(...listMarkdown(full));
    } else if (ent.isFile() && ent.name.endsWith(".md")) {
      out.push(full);
    }
  }
  return out;
}

function readBodyAndFrontmatter(file: string): { body: string; offsetLines: number } {
  const raw = readFileSync(file, "utf8");
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (m === null) return { body: raw, offsetLines: 0 };
  const offset = (m[0].match(/\n/g) ?? []).length;
  return { body: raw.slice(m[0].length), offsetLines: offset };
}

function extractParagraphs(rel: string, file: string, kind: ProseBlockKind): ProseBlock[] {
  const { body, offsetLines } = readBodyAndFrontmatter(file);
  const lines = body.split("\n");
  const out: ProseBlock[] = [];
  let bufStart: number | null = null;
  let buf: string[] = [];

  const flush = (endLineZero: number): void => {
    if (bufStart === null || buf.length === 0) return;
    const startLine = bufStart + offsetLines + 1;
    const endLine = endLineZero + offsetLines + 1;
    const text = buf.join("\n").trim();
    bufStart = null;
    buf = [];
    if (text.length === 0) return;
    if (!isMeaningfulBlock(text)) return;
    const titleSource = text.split("\n")[0] ?? text;
    const title = titleSource.replace(/^#+\s*/, "").trim().slice(0, 120) || "(untitled)";
    const slug = topicSlug(text);
    const block: ProseBlock = {
      file: rel,
      kind,
      title,
      line_range: [startLine, endLine],
      body: text,
      content_hash: bodyContentHash(text),
      slug,
    };
    const anchor = headingToAnchor(titleSource);
    if (anchor !== null) block.anchor = anchor;
    out.push(block);
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    if (line.trim().length === 0) {
      flush(i - 1);
      continue;
    }
    if (bufStart === null) bufStart = i;
    buf.push(line);
  }
  flush(lines.length - 1);

  return out;
}

function extractSections(rel: string, file: string, kind: ProseBlockKind): ProseBlock[] {
  const { body, offsetLines } = readBodyAndFrontmatter(file);
  const lines = body.split("\n");
  const out: ProseBlock[] = [];

  let sectionStart: number | null = null;
  let sectionTitle = "";
  let sectionAnchor: string | undefined;
  let sectionBuf: string[] = [];

  const flush = (endLineZero: number): void => {
    if (sectionStart === null) return;
    const startLine = sectionStart + offsetLines + 1;
    const endLine = endLineZero + offsetLines + 1;
    const bodyText = sectionBuf.join("\n").trim();
    const titleSnap = sectionTitle;
    const anchorSnap = sectionAnchor;
    sectionStart = null;
    sectionTitle = "";
    sectionAnchor = undefined;
    sectionBuf = [];
    if (bodyText.length === 0) return;
    if (!isMeaningfulBlock(bodyText)) return;
    const slug = topicSlug(bodyText);
    const block: ProseBlock = {
      file: rel,
      kind,
      title: titleSnap || "(untitled section)",
      line_range: [startLine, endLine],
      body: bodyText,
      content_hash: bodyContentHash(bodyText),
      slug,
    };
    if (anchorSnap !== undefined) block.anchor = anchorSnap;
    out.push(block);
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? "";
    const headingMatch = line.match(/^(#{2,3})\s+(.+?)\s*$/);
    if (headingMatch !== null) {
      flush(i - 1);
      const titleText = headingMatch[2] ?? "";
      sectionStart = i;
      sectionTitle = titleText;
      const anchorComputed = headingToAnchor(line);
      if (anchorComputed !== null) sectionAnchor = anchorComputed;
      continue;
    }
    if (sectionStart !== null) sectionBuf.push(line);
  }
  flush(lines.length - 1);

  return out;
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function isMeaningfulBlock(text: string): boolean {
  if (text.length < MIN_BLOCK_CHARS) return false;
  const normalized = normalizeBlock(text);
  const tokens = new Set(
    normalized
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length >= 3),
  );
  return tokens.size >= MIN_UNIQUE_TOKENS;
}

function headingToAnchor(line: string): string | null {
  const m = line.match(/^#+\s+(.+?)\s*$/);
  if (m === null || m[1] === undefined) return null;
  const slug = m[1]
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
  return slug.length === 0 ? null : slug;
}
