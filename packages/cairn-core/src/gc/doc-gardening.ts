/**
 * GC pass 4 — doc gardening.
 *
 * Walks every markdown in the canonical zone and surfaces:
 *   - broken-link findings: `[text](relative/path.md)` whose target doesn't exist
 *     under repoRoot. Absolute URLs (https://...) are skipped.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, posix, resolve } from "node:path";
import { lineOf, walkCanonical } from "@isaacriehm/cairn-state";
import type { GcFinding } from "./types.js";

const PASS_ID = "doc-gardening" as const;

export interface DocGardeningOptions {
  repoRoot: string;
}

export interface DocGardeningResult {
  findings: GcFinding[];
}

export function runDocGardening(opts: DocGardeningOptions): DocGardeningResult {
  const findings: GcFinding[] = [];
  const allFiles = walkCanonical(opts.repoRoot);
  const mdFiles = allFiles.filter((p) => p.endsWith(".md"));

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
      }
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


