import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import { ProvenanceFrontmatter, type ProvenanceFrontmatter as ProvenanceType } from "./schemas.js";

export interface ParsedDocument {
  frontmatter: ProvenanceType | null;
  body: string;
  /** Raw YAML block before parsing (empty if no frontmatter present). */
  raw: string;
  /** Number of lines the frontmatter (incl. fences) occupies. */
  fenceLineCount: number;
}

const FENCE_RE = /^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/;

/**
 * Extract frontmatter from `source` and return it as an unvalidated
 * `Record<string, unknown>` alongside the remaining body. Returns
 * `{ fm: {}, body: source }` on any parse failure or absent frontmatter.
 *
 * Use this instead of an inline `.match(/^---…/)` when callers need
 * arbitrary field access without a Zod schema.
 */
export function parseFrontmatterRecord(source: string): {
  fm: Record<string, unknown>;
  body: string;
} {
  const match = source.match(FENCE_RE);
  if (match === null || match.index !== 0) {
    return { fm: {}, body: source };
  }
  const raw = match[1] ?? "";
  const body = source.slice(match[0].length);
  if (raw.trim().length === 0) return { fm: {}, body };
  try {
    const parsed = parseYaml(raw);
    if (typeof parsed === "object" && parsed !== null) {
      return { fm: parsed as Record<string, unknown>, body };
    }
  } catch {
    /* ignore — malformed YAML */
  }
  return { fm: {}, body };
}

export function parseFrontmatter(source: string): ParsedDocument {
  const match = source.match(FENCE_RE);
  if (!match || match.index !== 0) {
    return { frontmatter: null, body: source, raw: "", fenceLineCount: 0 };
  }
  const raw = match[1] ?? "";
  const fence = match[0];
  const body = source.slice(fence.length);
  const fenceLineCount = fence.split(/\r?\n/).length - 1;

  if (raw.trim().length === 0) {
    return { frontmatter: null, body, raw, fenceLineCount };
  }

  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch {
    return { frontmatter: null, body, raw, fenceLineCount };
  }
  const result = ProvenanceFrontmatter.safeParse(parsed);
  return {
    frontmatter: result.success ? result.data : null,
    body,
    raw,
    fenceLineCount,
  };
}

export function readFrontmatter(absPath: string): ParsedDocument {
  const source = readFileSync(absPath, "utf8");
  return parseFrontmatter(source);
}

export interface FreshnessVerdict {
  /** ISO timestamp from frontmatter, or null if missing/unparseable. */
  verifiedAt: string | null;
  /** Days since verifiedAt; null if verifiedAt is missing. */
  ageDays: number | null;
  /** "fresh" | "warn" | "block" | "unknown" — matches FILESYSTEM_LAYOUT §3. */
  status: "fresh" | "warn" | "block" | "unknown";
}

export function evaluateFreshness(
  fm: ProvenanceType | null,
  warnDays = 30,
  blockDays = 60,
  now: Date = new Date(),
): FreshnessVerdict {
  if (!fm || !fm["verified-at"]) {
    return { verifiedAt: null, ageDays: null, status: "unknown" };
  }
  const ts = Date.parse(fm["verified-at"]);
  if (Number.isNaN(ts)) {
    return { verifiedAt: fm["verified-at"], ageDays: null, status: "unknown" };
  }
  const ageMs = now.getTime() - ts;
  const ageDays = Math.floor(ageMs / 86_400_000);
  const status = ageDays >= blockDays ? "block" : ageDays >= warnDays ? "warn" : "fresh";
  return { verifiedAt: fm["verified-at"], ageDays, status };
}
