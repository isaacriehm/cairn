/**
 * GC pass 1 — frontmatter freshness.
 *
 * Walks the canonical zone via `walkCanonical`, parses each markdown's
 * provenance frontmatter, and surfaces docs whose `verified-at` exceeds the
 * configured warn (30d) / block (60d) thresholds.
 *
 * Phase 12 v1 surfaces only — it does NOT auto-bump verified-at, because a
 * timestamp bump without re-verification is a lie. Future revisions may add
 * an opt-in "refresh-and-bump" proposal for safe-class docs whose content
 * sha hasn't changed since the last verified-at, but that's out of v1 scope.
 *
 * Exception: when `forceRefresh: true` is passed (smoke / dev only), the pass
 * proposes a frontmatter-only verified-at bump as a safe-class commit. The
 * smoke uses this path to exercise the auto-merge end-to-end.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { evaluateFreshness, parseFrontmatter } from "../ground/frontmatter.js";
import { walkCanonical } from "../ground/walk.js";
import type { GcCommitProposal, GcFinding } from "./types.js";

const PASS_ID = "frontmatter-freshness" as const;

export interface FrontmatterFreshnessOptions {
  repoRoot: string;
  warnDays?: number;
  blockDays?: number;
  /** Default = new Date(); injected for tests. */
  now?: Date;
  /**
   * When true, produce a frontmatter-only safe-class commit proposal that
   * bumps verified-at to `now` for every stale doc. Off by default — see
   * module header. Smoke uses this.
   */
  forceRefresh?: boolean;
}

export interface FrontmatterFreshnessResult {
  findings: GcFinding[];
  proposals: GcCommitProposal[];
}

export function runFrontmatterFreshness(
  opts: FrontmatterFreshnessOptions,
): FrontmatterFreshnessResult {
  const warnDays = opts.warnDays ?? 30;
  const blockDays = opts.blockDays ?? 60;
  const now = opts.now ?? new Date();
  const findings: GcFinding[] = [];
  const refreshes: { path: string; content: string }[] = [];

  const files = walkCanonical(opts.repoRoot);
  for (const rel of files) {
    if (!rel.endsWith(".md")) continue;
    const abs = resolve(opts.repoRoot, rel);
    const source = readFileSync(abs, "utf8");
    const parsed = parseFrontmatter(source);
    if (!parsed.frontmatter) continue;
    const verdict = evaluateFreshness(parsed.frontmatter, warnDays, blockDays, now);
    if (verdict.status === "fresh" || verdict.status === "unknown") continue;

    findings.push({
      pass: PASS_ID,
      kind: "frontmatter_stale",
      path: rel,
      detail:
        verdict.status === "block"
          ? `verified-at is ${verdict.ageDays}d old (>=${blockDays}d block threshold) — re-verify before relying`
          : `verified-at is ${verdict.ageDays}d old (>=${warnDays}d warn threshold)`,
      severity: verdict.status === "block" ? "block" : "warn",
      ...(verdict.ageDays !== null ? { age_days: verdict.ageDays } : {}),
    });

    if (opts.forceRefresh) {
      const refreshed = bumpVerifiedAt(source, parsed.raw, now);
      refreshes.push({ path: rel, content: refreshed });
    }
  }

  const proposals: GcCommitProposal[] = [];
  if (refreshes.length > 0) {
    const patch: Record<string, string> = {};
    for (const r of refreshes) patch[r.path] = r.content;
    const paths = refreshes.map((r) => r.path).sort();
    proposals.push({
      pass: PASS_ID,
      class: "safe",
      paths,
      patch,
      commit_message: composeCommitMessage(paths.length, now),
      findings: findings.filter((f) => paths.includes(f.path)),
    });
  }

  return { findings, proposals };
}

/**
 * Rewrite the frontmatter block with verified-at bumped to `now`. Preserves
 * key order by replacing only the `verified-at:` line (or inserting it
 * directly after `generated:` when missing).
 */
function bumpVerifiedAt(source: string, rawBlock: string, now: Date): string {
  const iso = now.toISOString();
  // Frontmatter is fenced by `---` lines at the top of the file; replace the
  // first `verified-at:` line in the fence region. If none, insert it after
  // `generated:` if present, else at the end of the fence block.
  const fenceEndIdx = source.indexOf("\n---", 3);
  if (fenceEndIdx === -1) return source;
  const fenceText = source.slice(0, fenceEndIdx);
  const restText = source.slice(fenceEndIdx);

  const verifiedAtRe = /^verified-at:.*$/m;
  if (verifiedAtRe.test(fenceText)) {
    return fenceText.replace(verifiedAtRe, `verified-at: ${iso}`) + restText;
  }
  // Insert after generated: line if present.
  const generatedRe = /^(generated:.*)$/m;
  if (generatedRe.test(fenceText)) {
    return fenceText.replace(generatedRe, `$1\nverified-at: ${iso}`) + restText;
  }
  // Fallback: append before fence close.
  // rawBlock parsing is unused beyond detection; keep stringifyYaml import for
  // future "rewrite the whole block" mode.
  void stringifyYaml;
  void rawBlock;
  return fenceText + `\nverified-at: ${iso}` + restText;
}

function composeCommitMessage(count: number, now: Date): string {
  const ymd = now.toISOString().slice(0, 10);
  const subject = `chore(gc): refresh frontmatter verified-at on ${count} doc${count === 1 ? "" : "s"} (${ymd})`;
  const body =
    "GC frontmatter-freshness pass — content unchanged; bumping verified-at to today.\n" +
    "Auto-applied as safe-class per L16 (PRIMER §12.2).\n";
  return `${subject}\n\n${body}`;
}
