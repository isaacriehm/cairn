/**
 * GC pass 4 — doc gardening.
 *
 * Walks every markdown in the canonical zone and surfaces:
 *   - broken-link findings: `[text](relative/path.md)` whose target doesn't exist
 *     under repoRoot. Absolute URLs (https://...) are skipped.
 *   - orphan-path findings: markdown files that are not referenced by any other
 *     markdown in the canonical zone. Orientation files (AGENTS.md, CLAUDE.md,
 *     README.md, RESUME_PROMPT.md) and explicitly-allowed roots are excluded.
 *
 * Phase 12 v1 surfaces only — moving orphans to `.archive/` per the original
 * spec needs operator confirmation (it's a non-trivial canonical-zone change).
 * The proposal type is set up so a future revision can attach an archive-move
 * commit when the operator opts in.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, posix, resolve } from "node:path";
import { walkCanonical } from "../ground/walk.js";
import type { GcFinding } from "./types.js";

const PASS_ID = "doc-gardening" as const;

const ORPHAN_ROOT_EXCLUDES = [
  "AGENTS.md",
  "CLAUDE.md",
  "README.md",
  "RESUME_PROMPT.md",
  ".harness/config/workflow.md",
  ".harness/config/sensors.yaml",
  ".harness/config/stub-patterns.yaml",
  ".harness/config/trust-policy.yaml",
];

export interface DocGardeningOptions {
  repoRoot: string;
  /**
   * Additional repo-relative paths to treat as orphan-allowed roots. Useful
   * for project-specific entry-point docs that nothing links to (e.g. wiki
   * landing pages).
   */
  orphanExcludes?: readonly string[];
}

export interface DocGardeningResult {
  findings: GcFinding[];
}

export function runDocGardening(opts: DocGardeningOptions): DocGardeningResult {
  const findings: GcFinding[] = [];
  const allFiles = walkCanonical(opts.repoRoot);
  const mdFiles = allFiles.filter((p) => p.endsWith(".md"));
  const referenced = new Set<string>();

  for (const rel of mdFiles) {
    const abs = resolve(opts.repoRoot, rel);
    let source: string;
    try {
      source = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    const links = extractMarkdownLinks(source);
    for (const link of links) {
      if (link.url.length === 0) continue;
      if (isExternalUrl(link.url)) continue;
      if (link.url.startsWith("#")) continue; // intra-page anchor
      const target = resolveLinkTarget(opts.repoRoot, rel, link.url);
      if (target === null) continue;
      if (!fileExists(opts.repoRoot, target)) {
        findings.push({
          pass: PASS_ID,
          kind: "broken_link",
          path: rel,
          detail: `${rel}:${link.line} → \`${link.url}\` (target ${target} missing)`,
          severity: "warn",
          line: link.line,
          matched_text: link.url,
        });
      } else if (target.endsWith(".md")) {
        referenced.add(target);
      }
    }
  }

  // Orphan detection — markdowns not referenced by any other markdown.
  const allowOrphan = new Set([
    ...ORPHAN_ROOT_EXCLUDES,
    ...(opts.orphanExcludes ?? []),
  ]);
  for (const rel of mdFiles) {
    if (allowOrphan.has(rel)) continue;
    if (!referenced.has(rel)) {
      findings.push({
        pass: PASS_ID,
        kind: "orphan_path",
        path: rel,
        detail: `${rel} is not referenced by any other markdown in the canonical zone — candidate for .archive/ move`,
        severity: "warn",
      });
    }
  }

  return { findings };
}

interface MarkdownLink {
  text: string;
  url: string;
  line: number;
}

function extractMarkdownLinks(source: string): MarkdownLink[] {
  // Match ](url) part of an inline link. Allow spaces inside text. Skip
  // images (preceded by `!`) and reference-style links.
  const out: MarkdownLink[] = [];
  // Build line-index map.
  const re = /(!?)\[([^\]\n]+)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const isImage = m[1] === "!";
    const text = m[2] ?? "";
    const url = m[3] ?? "";
    if (isImage) continue;
    out.push({ text, url, line: lineOf(source, m.index) });
  }
  return out;
}

function isExternalUrl(url: string): boolean {
  return /^[a-z]+:\/\//i.test(url) || url.startsWith("mailto:");
}

function resolveLinkTarget(
  repoRoot: string,
  fromRel: string,
  url: string,
): string | null {
  // Strip fragment.
  const hashIdx = url.indexOf("#");
  const cleanUrl = hashIdx === -1 ? url : url.slice(0, hashIdx);
  if (cleanUrl.length === 0) return null;
  // Absolute paths inside the repo (rare, but tolerated).
  if (cleanUrl.startsWith("/")) {
    return cleanUrl.replace(/^\/+/, "");
  }
  const fromDir = dirname(fromRel);
  const joined = posix.normalize(posix.join(fromDir, cleanUrl));
  if (joined.startsWith("..")) return null; // escapes repo root
  return joined;
}

function fileExists(repoRoot: string, rel: string): boolean {
  const abs = resolve(repoRoot, rel);
  if (!existsSync(abs)) return false;
  try {
    return statSync(abs).isFile() || statSync(abs).isDirectory();
  } catch {
    return false;
  }
}

function lineOf(text: string, charIndex: number): number {
  let line = 1;
  for (let i = 0; i < charIndex && i < text.length; i++) {
    if (text.charCodeAt(i) === 10 /* \n */) line += 1;
  }
  return line;
}
