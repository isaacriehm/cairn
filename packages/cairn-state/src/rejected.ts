/**
 * `.cairn/ground/_rejected.yaml` — slug-keyed ledger of topic-index
 * entries the operator (or AI curator) has marked as not-a-decision.
 *
 * Phase 6 / `cairn ingest` skip any slug present here. The PR 2
 * `cairn_propose_decision` MCP tool refuses rejected slugs with
 * `{ ok: false, reason: "rejected" }`. Phase 5b's GC pass at the end
 * of `buildTopicIndex` drops any entry whose slug is no longer in the
 * freshly-built topic-index — so rotating docs / deleted markdown
 * files don't accumulate dead rejection records.
 *
 * Dedup: first writer wins the `reason`; subsequent writes for the
 * same slug only refresh `rejected_at`.
 */

import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { writeFileSafe } from "./fs.js";
import { getLogger } from "./logger.js";
import { rejectedYamlPath } from "./paths.js";
import { RejectedYaml, type RejectedEntry } from "./schemas.js";

const log = getLogger();

export function emptyRejectedYaml(): RejectedYaml {
  return { version: 1, generated: new Date().toISOString(), rejected: [] };
}

/**
 * Read `_rejected.yaml` and return a slug-keyed Map for O(1) lookups.
 * Missing file → empty Map. Malformed file → empty Map + warn (the
 * sensor surface treats this as a deliberate clean slate rather than
 * an error so the operator can recover by deleting the file).
 */
export function readRejectedYaml(repoRoot: string): Map<string, RejectedEntry> {
  const path = rejectedYamlPath(repoRoot);
  if (!existsSync(path)) return new Map();
  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(path, "utf8"));
  } catch (err) {
    log.warn({ path, err }, "_rejected.yaml read failed; treating as empty");
    return new Map();
  }
  const result = RejectedYaml.safeParse(parsed);
  if (!result.success) {
    log.warn(
      { path, error: result.error.message },
      "_rejected.yaml invalid; treating as empty",
    );
    return new Map();
  }
  const out = new Map<string, RejectedEntry>();
  for (const entry of result.data.rejected) out.set(entry.slug, entry);
  return out;
}

/**
 * Persist a slug-keyed Map to `_rejected.yaml`. Rebuilds `generated`.
 * Sorted by slug for stable diffs.
 */
export function writeRejectedYaml(
  repoRoot: string,
  rejected: Map<string, RejectedEntry>,
): string {
  const path = rejectedYamlPath(repoRoot);
  const sortedSlugs = [...rejected.keys()].sort();
  const next: RejectedYaml = {
    version: 1,
    generated: new Date().toISOString(),
    rejected: sortedSlugs.map((s) => rejected.get(s)!),
  };
  writeFileSafe(path, stringifyYaml(next));
  log.debug({ path, count: next.rejected.length }, "wrote _rejected.yaml");
  return path;
}

/**
 * Append (or refresh) a rejection record. Dedup by slug — first writer
 * wins the `reason` string; subsequent writes update `rejected_at`
 * only. Returns the merged Map without persisting; callers handle the
 * write so concurrent paths can batch under a single lock.
 */
export function appendRejected(
  current: Map<string, RejectedEntry>,
  entry: RejectedEntry,
): Map<string, RejectedEntry> {
  const next = new Map(current);
  const existing = next.get(entry.slug);
  if (existing === undefined) {
    next.set(entry.slug, entry);
  } else {
    next.set(entry.slug, { ...existing, rejected_at: entry.rejected_at });
  }
  return next;
}

/**
 * Garbage-collect rejection records whose slug is no longer present in
 * the freshly-built topic-index. Phase 5b runs this at the end of
 * `buildTopicIndex` so the index-builder owns rejection lifecycle —
 * keeps the sensor surface clean as docs rotate.
 */
export function gcRejectedYaml(
  rejected: Map<string, RejectedEntry>,
  liveSlugs: Set<string>,
): Map<string, RejectedEntry> {
  const next = new Map<string, RejectedEntry>();
  for (const [slug, entry] of rejected.entries()) {
    if (liveSlugs.has(slug)) next.set(slug, entry);
  }
  return next;
}
