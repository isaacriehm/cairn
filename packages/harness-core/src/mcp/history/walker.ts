/**
 * Archive walker — collects matching files from .archive/ for the
 * Tier-1 history summarizer.
 *
 * The walker reads file content but does NOT return it to the agent.
 * The MCP server feeds content to a Tier-1 LLM; the LLM emits
 * structured claims; only the structured claims reach the agent's
 * context. This is the load-bearing two-zone enforcement: raw stale
 * content never crosses the historical/canonical boundary.
 */

import { type Dirent, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { matchAnyGlob } from "../../ground/glob.js";

export interface ArchiveFile {
  /** Absolute path. */
  absPath: string;
  /** Repo-relative POSIX path. */
  relPath: string;
  /**
   * Inferred archive date — from the path bucket
   * `.archive/YYYY-MM-DD/...` if present, else file mtime ISO.
   */
  archiveDate: string;
  /** Inferred bucket label — the segment immediately under .archive/. */
  bucket: string;
  /** UTF-8 content, truncated by `maxBytesPerFile`. */
  content: string;
  /** Size of original content in bytes (pre-truncation). */
  bytesOriginal: number;
  /** True iff `content` was truncated. */
  truncated: boolean;
}

export interface WalkArchiveResult {
  files: ArchiveFile[];
  /** True iff at least one match was skipped because totalBytes cap was reached. */
  capHit: boolean;
  totalBytes: number;
  /** Buckets discovered under .archive/ (top-level dirs). */
  bucketsScanned: string[];
}

export interface WalkArchiveOptions {
  repoRoot: string;
  /** Optional repo-relative glob (e.g. ".archive/2026-05-pre-harness/**"). */
  pathHint?: string;
  /** ISO 8601 lower bound (inclusive). Compared to archiveDate. */
  since?: string;
  /** ISO 8601 upper bound (inclusive). Compared to archiveDate. */
  until?: string;
  /** Per-file content cap. Default 32 KB. */
  maxBytesPerFile?: number;
  /** Total content cap across all files. Default 200 KB. */
  maxBytesTotal?: number;
  /** Hard cap on number of files returned. Default 40. */
  maxFiles?: number;
}

const DEFAULT_MAX_BYTES_PER_FILE = 32 * 1024;
const DEFAULT_MAX_BYTES_TOTAL = 200 * 1024;
const DEFAULT_MAX_FILES = 40;

const CONTENT_EXTENSIONS = new Set([
  ".md",
  ".markdown",
  ".yaml",
  ".yml",
  ".json",
  ".txt",
  ".sql",
]);

const BUCKET_DATE_RE = /^(\d{4}-\d{2}-\d{2})/;

/**
 * Walks `<repoRoot>/.archive/` collecting matching files. Returns content
 * inline so the summarizer can build a prompt without re-reading.
 */
export function walkArchive(opts: WalkArchiveOptions): WalkArchiveResult {
  const archiveRoot = join(opts.repoRoot, ".archive");
  const maxBytesPerFile = opts.maxBytesPerFile ?? DEFAULT_MAX_BYTES_PER_FILE;
  const maxBytesTotal = opts.maxBytesTotal ?? DEFAULT_MAX_BYTES_TOTAL;
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;

  const files: ArchiveFile[] = [];
  const bucketsScanned: string[] = [];
  let totalBytes = 0;
  let capHit = false;

  let topEntries: Dirent[];
  try {
    topEntries = readdirSync(archiveRoot, { withFileTypes: true, encoding: "utf8" });
  } catch {
    return { files: [], capHit: false, totalBytes: 0, bucketsScanned: [] };
  }

  for (const top of topEntries) {
    if (!top.isDirectory()) continue;
    bucketsScanned.push(top.name);
  }
  bucketsScanned.sort();

  // BFS so the closest-to-root files come first when caps trigger.
  const stack: { absDir: string; bucket: string }[] = bucketsScanned.map((b) => ({
    absDir: join(archiveRoot, b),
    bucket: b,
  }));

  while (stack.length > 0 && files.length < maxFiles) {
    const cur = stack.pop();
    if (cur === undefined) break;
    let entries: Dirent[];
    try {
      entries = readdirSync(cur.absDir, { withFileTypes: true, encoding: "utf8" });
    } catch {
      continue;
    }
    for (const e of entries) {
      const abs = join(cur.absDir, e.name);
      if (e.isDirectory()) {
        stack.push({ absDir: abs, bucket: cur.bucket });
        continue;
      }
      if (!e.isFile()) continue;
      if (!hasContentExtension(e.name)) continue;
      const rel = relative(opts.repoRoot, abs).replace(/\\/g, "/");

      if (opts.pathHint && opts.pathHint.length > 0) {
        if (!matchAnyGlob(rel, [opts.pathHint])) continue;
      }

      const archiveDate = inferArchiveDate(cur.bucket, abs);
      if (!withinDateWindow(archiveDate, opts.since, opts.until)) continue;

      let buf: Buffer;
      try {
        buf = readFileSync(abs);
      } catch {
        continue;
      }
      const bytesOriginal = buf.byteLength;
      if (totalBytes + Math.min(bytesOriginal, maxBytesPerFile) > maxBytesTotal) {
        capHit = true;
        continue;
      }
      const truncated = bytesOriginal > maxBytesPerFile;
      const content = truncated
        ? buf.subarray(0, maxBytesPerFile).toString("utf8") + "\n…[truncated]"
        : buf.toString("utf8");
      totalBytes += truncated ? maxBytesPerFile : bytesOriginal;
      files.push({
        absPath: abs,
        relPath: rel,
        archiveDate,
        bucket: cur.bucket,
        content,
        bytesOriginal,
        truncated,
      });
      if (files.length >= maxFiles) {
        capHit = true;
        break;
      }
    }
  }

  files.sort((a, b) => a.relPath.localeCompare(b.relPath));
  return { files, capHit, totalBytes, bucketsScanned };
}

function hasContentExtension(name: string): boolean {
  const dot = name.lastIndexOf(".");
  if (dot === -1) return false;
  const ext = name.slice(dot).toLowerCase();
  return CONTENT_EXTENSIONS.has(ext);
}

function inferArchiveDate(bucket: string, absPath: string): string {
  const match = BUCKET_DATE_RE.exec(basename(bucket));
  if (match?.[1]) return `${match[1]}T00:00:00Z`;
  try {
    return new Date(statSync(absPath).mtimeMs).toISOString();
  } catch {
    return new Date(0).toISOString();
  }
}

function withinDateWindow(date: string, since?: string, until?: string): boolean {
  const t = Date.parse(date);
  if (Number.isNaN(t)) return true;
  if (since !== undefined) {
    const s = Date.parse(since);
    if (!Number.isNaN(s) && t < s) return false;
  }
  if (until !== undefined) {
    const u = Date.parse(until);
    if (!Number.isNaN(u) && t > u) return false;
  }
  return true;
}
