/**
 * Phase 5b — cross-source prose-block walker.
 *
 * Discovers every prose block across the narrative-bearing source kinds
 * the SoT model recognizes. Doc discovery is layout-agnostic: any
 * `.md` file outside the rule-owned set (`CLAUDE.md`, `AGENTS.md`,
 * `.claude/rules/**`) is treated as `kind="doc"`.
 *
 * Each discovered block is assigned a stable slug (via `# Heading`)
 * and a content hash.
 */

import { type Dirent, existsSync, readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { parse as parseYaml } from "yaml";
import { bodyContentHash, normalizeBlock, topicSlug } from "@isaacriehm/cairn-state";
import { z } from "zod";

const CairnConfigSchema = z.object({
  cairn: z.object({
    kind: z.enum(["decision", "rule"]).optional(),
  }).optional(),
}).passthrough();

export type ProseBlockKind = "doc" | "claudemd" | "agentsmd" | "rule" | "source-comment";

/**
 * Operator-supplied marker that promotes a block straight to phase 6
 * Stage 4 emit (no Haiku judgement). Two surfaces:
 *   1. YAML frontmatter: `cairn: { kind: "decision" | "rule" }`
 *   2. Inline comment: `<!-- cairn:decision -->` or `<!-- cairn:rule -->`
 */
export type MarkerKind = "decision" | "rule";

export interface ProseBlock {
  kind: ProseBlockKind;
  /** Repo-relative path (POSIX). */
  file: string;
  /** 1-based [start, end] in `file`. */
  line_range: [number, number];
  /** Slug derived from the block's first `# Heading`. */
  slug: string;
  /** Verbatim block content (including the heading). */
  body: string;
  /** Content hash for verbatim dedup. */
  content_hash: string;
  /** Optional anchor from a source comment (`@anchor foo`). */
  anchor?: string;
  /** Operator-supplied marker (if any). */
  marker_kind?: MarkerKind;
}

const SKIP_DIRS = new Set([
  ".git",
  ".cairn",
  "node_modules",
  "dist",
  "build",
  "target",
  "out",
  ".next",
  ".turbo",
  ".cache",
  "coverage",
]);

const MARKER_LOOKAHEAD_LINES = 3;
const MARKER_TEXT = "cairn:";

/**
 * Walk the repo and extract all prose blocks.
 */
export function walkProseBlocks(repoRoot: string): ProseBlock[] {
  const ruleOwned = discoverRuleSources(repoRoot);
  const ruleOwnedAbs = new Set(ruleOwned.map((s) => s.absPath));

  const out: ProseBlock[] = [];

  // 1. CLAUDE.md / AGENTS.md
  for (const s of ruleOwned.filter((s) => s.kind !== "rule")) {
    out.push(...extractSections(repoRoot, s.absPath, s.kind as ProseBlockKind));
  }

  // 2. .claude/rules/*.md
  for (const s of ruleOwned.filter((s) => s.kind === "rule")) {
    out.push(...extractSections(repoRoot, s.absPath, "rule"));
  }

  // 3. Layout-agnostic doc discovery (recursive walk)
  out.push(...walkDocs(repoRoot, ruleOwnedAbs));

  return out;
}

function walkDocs(repoRoot: string, ruleOwnedAbs: Set<string>): ProseBlock[] {
  const out: ProseBlock[] = [];
  const stack = [repoRoot];

  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
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
      if (ruleOwnedAbs.has(abs)) continue;

      out.push(...extractSections(repoRoot, abs, "doc"));
    }
  }
  return out;
}

/**
 * Split a markdown file into sections by its H1/H2 headers.
 * Each section is a `ProseBlock`.
 */
function extractSections(
  repoRoot: string,
  absPath: string,
  kind: ProseBlockKind,
): ProseBlock[] {
  let raw: string;
  try {
    raw = readFileSync(absPath, "utf8");
  } catch {
    return [];
  }

  const rel = relative(repoRoot, absPath).replace(/\\/g, "/");
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
  const frontmatter = fmMatch ? fmMatch[1] : "";
  const body = fmMatch ? raw.slice(fmMatch[0].length) : raw;
  const fileMarker = extractFileMarker(frontmatter ?? "");

  const lines = body.split("\n");
  const sections: { startLine: number; lines: string[] }[] = [];
  let current: (typeof sections)[0] | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (/^#+\s/.test(line)) {
      if (current) sections.push(current);
      current = { startLine: i + 1, lines: [line] };
    } else if (current) {
      current.lines.push(line);
    }
  }
  if (current) sections.push(current);

  const blocks: ProseBlock[] = [];
  for (const s of sections) {
    const blockBody = s.lines.join("\n");
    const slug = headingToAnchor(s.lines[0]!);
    if (slug === null) continue;

    const marker = extractInlineMarker(s.lines) || fileMarker;

    blocks.push({
      kind,
      file: rel,
      line_range: [s.startLine, s.startLine + s.lines.length - 1],
      slug,
      body: blockBody,
      content_hash: bodyContentHash(normalizeBlock(blockBody)),
      ...(marker ? { marker_kind: marker } : {}),
    });
  }

  return blocks;
}

function extractFileMarker(frontmatterText: string): MarkerKind | undefined {
  if (frontmatterText.length === 0) return undefined;
  try {
    const parsed: unknown = parseYaml(frontmatterText);
    const result = CairnConfigSchema.safeParse(parsed);
    if (result.success && result.data.cairn?.kind !== undefined) {
      return result.data.cairn.kind;
    }
  } catch {
    /* ignore */
  }
  return undefined;
}

function extractInlineMarker(lines: string[]): MarkerKind | undefined {
  const head = lines.slice(0, MARKER_LOOKAHEAD_LINES).join("\n");
  if (!head.includes(MARKER_TEXT)) return undefined;

  if (/<!--\s*cairn:decision\s*-->/i.test(head)) return "decision";
  if (/<!--\s*cairn:rule\s*-->/i.test(head)) return "rule";
  return undefined;
}

function discoverRuleSources(repoRoot: string): { absPath: string; path: string; kind: string }[] {
  const out: { absPath: string; path: string; kind: string }[] = [];
  const tryAdd = (rel: string, kind: string): void => {
    const abs = join(repoRoot, rel);
    if (existsSync(abs)) out.push({ absPath: abs, path: rel, kind });
  };

  tryAdd("CLAUDE.md", "claudemd");
  tryAdd("AGENTS.md", "agentsmd");

  const rulesDir = join(repoRoot, ".claude", "rules");
  if (existsSync(rulesDir)) {
    try {
      const entries = readdirSync(rulesDir, { withFileTypes: true });
      for (const e of entries) {
        if (e.isFile() && e.name.endsWith(".md")) {
          out.push({
            absPath: join(rulesDir, e.name),
            path: `.claude/rules/${e.name}`,
            kind: "rule",
          });
        }
      }
    } catch {
      /* ignore */
    }
  }

  return out;
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
