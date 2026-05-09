/**
 * GC pass 11 — doc-source-drift.
 *
 * For every accepted DEC / INV with `sot_kind: path`, recompute the body
 * hash from the file at `sot_path` and compare against the frontmatter
 * `sot_content_hash`. The PostToolUse `sot-align` hook only fires when
 * Claude Code itself edits the file; this pass closes the loop for
 * external editor edits (VS Code, Cursor, raw shell) by checking the
 * snapshot every GC sweep.
 *
 * Section extraction by `#anchor` uses GitHub-style heading slugs so the
 * pass works without a populated AnchorMap. Missing file → finding;
 * unresolvable anchor → finding; hash mismatch → finding.
 *
 * V1 surfaces only — no auto-rewrite proposal. Once the cairn-attention
 * skill ingests the findings as A/B/C cases, the operator chooses
 * `[a] regenerate from runtime` (refresh body), `[b] code wrong`
 * (replace ground), or `[c] defer`.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  bodyContentHash,
  decisionsDir,
  invariantsDir,
  parseFrontmatterRecord,
} from "@isaacriehm/cairn-state";
import type { GcFinding } from "./types.js";

const PASS_ID = "doc-source-drift" as const;

export interface DocSourceDriftOptions {
  repoRoot: string;
}

export interface DocSourceDriftResult {
  findings: GcFinding[];
  /** Total path-kind entries scanned. Useful for tests. */
  scanned: number;
}

interface PathKindFrontmatter {
  id: string;
  sotPath: string;
  sotContentHash: string;
}

export function runDocSourceDrift(
  opts: DocSourceDriftOptions,
): DocSourceDriftResult {
  const findings: GcFinding[] = [];
  let scanned = 0;
  for (const groundPath of collectGroundFiles(opts.repoRoot)) {
    const abs = resolve(opts.repoRoot, groundPath);
    let raw: string;
    try {
      raw = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    const fm = extractPathKindFrontmatter(raw);
    if (fm === null) continue;
    scanned++;
    const finding = checkOne(opts.repoRoot, groundPath, fm);
    if (finding !== null) findings.push(finding);
  }
  return { findings, scanned };
}

function collectGroundFiles(repoRoot: string): string[] {
  const out: string[] = [];
  for (const dir of [decisionsDir(repoRoot), invariantsDir(repoRoot)]) {
    if (!existsSync(dir)) continue;
    for (const name of listLedgerMarkdown(dir)) {
      out.push(toRepoRel(repoRoot, dir, name));
    }
  }
  return out;
}

function listLedgerMarkdown(dir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((n) => n.endsWith(".md") && !n.startsWith("_"))
    .sort();
}

function toRepoRel(repoRoot: string, dir: string, name: string): string {
  const abs = resolve(dir, name);
  const root = resolve(repoRoot);
  return abs.startsWith(`${root}/`) ? abs.slice(root.length + 1) : abs;
}

function extractPathKindFrontmatter(raw: string): PathKindFrontmatter | null {
  const { fm } = parseFrontmatterRecord(raw);
  if (fm["sot_kind"] !== "path") return null;
  const id = typeof fm["id"] === "string" ? fm["id"] : "";
  const sotPath = typeof fm["sot_path"] === "string" ? fm["sot_path"] : "";
  const sotContentHash =
    typeof fm["sot_content_hash"] === "string" ? fm["sot_content_hash"] : "";
  if (id.length === 0 || sotPath.length === 0 || sotContentHash.length !== 64) {
    return null;
  }
  return { id, sotPath, sotContentHash };
}

function checkOne(
  repoRoot: string,
  groundPath: string,
  fm: PathKindFrontmatter,
): GcFinding | null {
  const [filePart, anchorPart] = splitSotPath(fm.sotPath);
  const fileAbs = resolve(repoRoot, filePart);
  if (!existsSync(fileAbs)) {
    return {
      pass: PASS_ID,
      kind: "sot_missing",
      path: groundPath,
      detail: `${groundPath} — sot_path \`${fm.sotPath}\` does not exist`,
      severity: "warn",
      matched_text: fm.sotPath,
    };
  }
  let source: string;
  try {
    source = readFileSync(fileAbs, "utf8");
  } catch {
    return {
      pass: PASS_ID,
      kind: "sot_missing",
      path: groundPath,
      detail: `${groundPath} — sot_path \`${fm.sotPath}\` unreadable`,
      severity: "warn",
      matched_text: fm.sotPath,
    };
  }

  let body: string;
  if (anchorPart === null) {
    body = source.trim();
  } else {
    const extracted = extractSectionByAnchor(source, anchorPart);
    if (extracted === null) {
      return {
        pass: PASS_ID,
        kind: "sot_anchor_missing",
        path: groundPath,
        detail: `${groundPath} — anchor \`#${anchorPart}\` not found in ${filePart}`,
        severity: "warn",
        matched_text: fm.sotPath,
      };
    }
    body = extracted;
  }

  const actual = bodyContentHash(body);
  if (actual === fm.sotContentHash) return null;
  return {
    pass: PASS_ID,
    kind: "doc_source_drift",
    path: groundPath,
    detail: `${groundPath} — body at ${fm.sotPath} drifted from snapshot (expected sha256 ${shortHash(fm.sotContentHash)}, actual ${shortHash(actual)})`,
    severity: "warn",
    matched_text: fm.sotPath,
  };
}

function splitSotPath(sotPath: string): [string, string | null] {
  const idx = sotPath.indexOf("#");
  if (idx === -1) return [sotPath, null];
  return [sotPath.slice(0, idx), sotPath.slice(idx + 1)];
}

function shortHash(hash: string): string {
  return hash.slice(0, 8);
}

const HEADING_RE = /^(#+)\s+(.*?)\s*$/;

export function slugifyHeading(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function extractSectionByAnchor(
  source: string,
  anchor: string,
): string | null {
  const lines = source.split("\n");
  let startLine = -1;
  let startDepth = 0;
  for (let i = 0; i < lines.length; i++) {
    const m = HEADING_RE.exec(lines[i] ?? "");
    if (m === null) continue;
    const depth = (m[1] ?? "").length;
    const text = m[2] ?? "";
    if (slugifyHeading(text) === anchor) {
      startLine = i;
      startDepth = depth;
      break;
    }
  }
  if (startLine === -1) return null;
  let endLine = lines.length;
  for (let i = startLine + 1; i < lines.length; i++) {
    const m = HEADING_RE.exec(lines[i] ?? "");
    if (m === null) continue;
    const depth = (m[1] ?? "").length;
    if (depth <= startDepth) {
      endLine = i;
      break;
    }
  }
  return lines.slice(startLine, endLine).join("\n").trim();
}
