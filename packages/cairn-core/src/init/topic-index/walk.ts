/**
 * Phase 7 — cross-source prose-block walker.
 *
 * Discovers every prose block across the narrative-bearing source kinds
 * the SoT model recognizes. Doc discovery is layout-agnostic: any
 * `.md` file outside the rule-owned set + skip dirs counts as a doc.
 * That covers `docs/`, `documentation/`, `official_docs/`,
 * `architecture/`, `notes/`, root-level READMEs, custom-named folders
 * — anything an operator might use without cairn dictating naming.
 *
 *   - any reachable `.md` (excluding rule paths + skip dirs)
 *                                            kind = "doc",         paragraph-granularity
 *   - CLAUDE.md                              kind = "claudemd",    H2/H3-section-granularity
 *   - AGENTS.md                              kind = "agentsmd",    H2/H3-section-granularity
 *   - .claude/rules/*.md                     kind = "rule",        H2/H3-section-granularity
 *
 * Source comments (kind = "source-comment") are reached through the
 * existing phase 9 walker and folded into the topic-index lazily by
 * phase 9 itself; phase 7 builds the doc / rules slice up front.
 *
 * The Haiku classifier in phase 8 filters non-binding doc paragraphs
 * (release notes, tutorials, raw API references) by returning
 * kind=other, so being permissive here doesn't pollute the ledger.
 */

import { type Dirent, existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { parse as parseYaml } from "yaml";
import { bodyContentHash, normalizeBlock, topicSlug } from "@isaacriehm/cairn-state";

export type ProseBlockKind = "doc" | "claudemd" | "agentsmd" | "rule" | "source-comment";

/**
 * Operator-supplied marker that promotes a block straight to phase 8
 * Stage 4 emit (no Haiku judgement). Two surfaces:
 *
 *   1. File-level frontmatter:
 *        ---
 *        cairn:
 *          kind: decision   # or: rule
 *        ---
 *      Every block in the file inherits the kind. Use for ADRs,
 *      rulebooks, formal invariant lists.
 *
 *   2. Block-level HTML comment within 3 lines after the heading:
 *        ## Some heading
 *
 *        <!-- cairn:decision -->
 *        Body text here…
 *      The 3-line lookahead handles blank lines + author-style spacing
 *      between heading and marker.
 *
 *  Block-level wins over file-level when both are present (operator
 *  flagged a single section to override a coarser file-level kind).
 */
export type MarkerKind = "decision" | "rule";

const MARKER_LOOKAHEAD_LINES = 3;
const BLOCK_MARKER_DECISION = /<!--\s*cairn:decision\s*-->/;
const BLOCK_MARKER_RULE = /<!--\s*cairn:rule\s*-->/;

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
  /**
   * Operator-flagged marker — `"decision"` / `"rule"` when frontmatter
   * `cairn.kind` is set or a `<!-- cairn:decision -->` /
   * `<!-- cairn:rule -->` comment sits within
   * {@link MARKER_LOOKAHEAD_LINES} of the heading. Phase 8 Stage 3
   * emits these directly to `_inbox/` without Haiku.
   */
  marker_kind?: MarkerKind;
}

const MIN_BLOCK_CHARS = 80;
const MIN_UNIQUE_TOKENS = 10;
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".cairn",
  // `.claude` is Claude Code's config + agent-worktree dir. Contents
  // (worktrees/, skills/, commands/, hooks/, agents/) are tooling state,
  // not operator docs. Walked separately by `walkRulesDir` for the
  // `.claude/rules/` subtree only — everything else here would create
  // pathological N² semantic-dedup pairs (agent worktrees mirror real
  // docs char-for-char, blowing up phase 7).
  ".claude",
  "dist",
  "build",
  "out",
  ".next",
  ".turbo",
  ".cache",
  "coverage",
  ".pnpm-store",
  ".yarn",
  "vendor",
  "target",
  ".gradle",
  ".idea",
  ".vscode",
]);

/** Files owned by phase 10 (rules merge); excluded from the doc walk. */
const RULE_OWNED_FILES = new Set(["CLAUDE.md", "AGENTS.md"]);

/** Directory paths owned by phase 10 (relative to repo root). */
const RULE_OWNED_DIRS = [".claude/rules"];

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
/* Any reachable *.md (excluding rule-owned paths) → kind="doc"               */
/*                                                                            */
/* Layout-agnostic: walks the repo root and yields every markdown file        */
/* that isn't claimed by phase 10 (CLAUDE.md / AGENTS.md / .claude/rules/*)   */
/* and isn't inside a skip dir. Operator's chosen layout — `docs/`,           */
/* `documentation/`, `notes/`, custom-named folder, root-level READMEs —      */
/* all flow through this single discovery without configuration.              */
/* -------------------------------------------------------------------------- */

function walkDocs(repoRoot: string): ProseBlock[] {
  const out: ProseBlock[] = [];
  const ruleOwnedAbs = new Set(RULE_OWNED_DIRS.map((d) => join(repoRoot, d)));

  const stack: string[] = [repoRoot];
  while (stack.length > 0) {
    const dir = stack.pop();
    if (dir === undefined) break;
    if (ruleOwnedAbs.has(dir)) continue;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true, encoding: "utf8" });
    } catch {
      continue;
    }
    for (const ent of entries) {
      if (SKIP_DIRS.has(ent.name)) continue;
      const abs = join(dir, ent.name);
      if (ent.isDirectory()) {
        if (ruleOwnedAbs.has(abs)) continue;
        stack.push(abs);
        continue;
      }
      if (!ent.isFile() || !ent.name.endsWith(".md")) continue;
      const rel = relative(repoRoot, abs);
      if (RULE_OWNED_FILES.has(rel)) continue;
      out.push(...extractParagraphs(rel, abs, "doc"));
    }
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

function readBodyAndFrontmatter(file: string): {
  body: string;
  offsetLines: number;
  /** File-level marker stamped on every block when frontmatter `cairn.kind` is set. */
  fileMarker: MarkerKind | undefined;
} {
  const raw = readFileSync(file, "utf8");
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (m === null) return { body: raw, offsetLines: 0, fileMarker: undefined };
  const offset = (m[0].match(/\n/g) ?? []).length;
  const frontmatterText = m[1] ?? "";
  return {
    body: raw.slice(m[0].length),
    offsetLines: offset,
    fileMarker: extractFileMarker(frontmatterText),
  };
}

function extractFileMarker(frontmatterText: string): MarkerKind | undefined {
  if (frontmatterText.length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = parseYaml(frontmatterText);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const cairn = (parsed as Record<string, unknown>)["cairn"];
  if (typeof cairn !== "object" || cairn === null) return undefined;
  const kind = (cairn as Record<string, unknown>)["kind"];
  if (kind === "decision" || kind === "rule") return kind;
  return undefined;
}

/**
 * Scan the first `MARKER_LOOKAHEAD_LINES` lines of `bodyLines` for an
 * inline `<!-- cairn:decision -->` / `<!-- cairn:rule -->` comment.
 * Returns the marker kind, or `undefined` if none found. The
 * lookahead handles authors who put a blank line between heading and
 * marker (or extend the marker into a multi-line HTML comment block).
 */
function scanBlockMarker(bodyLines: string[]): MarkerKind | undefined {
  const window = bodyLines.slice(0, MARKER_LOOKAHEAD_LINES).join("\n");
  if (BLOCK_MARKER_DECISION.test(window)) return "decision";
  if (BLOCK_MARKER_RULE.test(window)) return "rule";
  return undefined;
}

function extractParagraphs(rel: string, file: string, kind: ProseBlockKind): ProseBlock[] {
  const { body, offsetLines, fileMarker } = readBodyAndFrontmatter(file);
  const lines = body.split(/\r?\n/);
  const out: ProseBlock[] = [];
  let bufStart: number | null = null;
  let buf: string[] = [];

  const flush = (endLineZero: number): void => {
    if (bufStart === null || buf.length === 0) return;
    const startLine = bufStart + offsetLines + 1;
    const endLine = endLineZero + offsetLines + 1;
    const text = buf.join("\n").trim();
    const localBuf = [...buf];
    bufStart = null;
    buf = [];
    if (text.length === 0) return;
    if (!isMeaningfulBlock(text)) return;
    const titleSource = text.split("\n")[0] ?? text;
    const title = titleSource.replace(/^#+\s*/, "").trim().slice(0, 120) || "(untitled)";
    const slug = topicSlug(text);
    // Block-level marker takes precedence: scan within the first
    // MARKER_LOOKAHEAD_LINES of the buffer (heading line + body) for
    // the HTML-comment marker. Falls back to the file-level
    // frontmatter marker when no block marker is found.
    const marker = scanBlockMarker(localBuf) ?? fileMarker;
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
    if (marker !== undefined) block.marker_kind = marker;
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
  const { body, offsetLines, fileMarker } = readBodyAndFrontmatter(file);
  const lines = body.split(/\r?\n/);
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
    const localBuf = [...sectionBuf];
    sectionStart = null;
    sectionTitle = "";
    sectionAnchor = undefined;
    sectionBuf = [];
    if (bodyText.length === 0) return;
    if (!isMeaningfulBlock(bodyText)) return;
    const slug = topicSlug(bodyText);
    // Block-level marker scans the first lines AFTER the heading —
    // sectionBuf holds the post-heading lines only. Fallback to
    // file-level frontmatter marker.
    const marker = scanBlockMarker(localBuf) ?? fileMarker;
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
    if (marker !== undefined) block.marker_kind = marker;
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
