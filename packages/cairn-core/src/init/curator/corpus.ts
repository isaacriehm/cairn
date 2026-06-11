/**
 * Curator pipeline — corpus.jsonl + shards.json IO (Phase 9a-walker).
 *
 * After the regex pre-filter (`regex-prefilter.ts`) drops ~60-80% of
 * raw blocks, this module:
 *   1. Writes one `CorpusRecord` per surviving block to
 *      `.cairn/init/curator/corpus.jsonl`
 *   2. Packs records into shards capped at MAX_INPUT_TOKENS_PER_SHARD
 *      input tokens, grouped by `module` (or by file group for
 *      docs/rules), and writes the plan to `shards.json`
 *
 * Modules exceeding the cap split by submodule/directory hierarchy.
 * Never random shard — the curator-map subagent benefits from
 * intra-module locality (one Sonnet call sees all the auth-module
 * essay comments at once).
 *
 * Token estimate: ~4 chars/token for English prose. The walker hands
 * us already-cleaned prose, so this matches the input the subagent
 * actually receives within ~10%.
 */

import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cairnDir } from "@isaacriehm/cairn-state";

/** Repo-relative display paths. State home resolution goes through `cairnDir`. */
export const CORPUS_DIR = join(".cairn", "init", "curator");
export const CORPUS_JSONL_PATH = join(CORPUS_DIR, "corpus.jsonl");
export const SHARDS_JSON_PATH = join(CORPUS_DIR, "shards.json");
/** Per-shard corpus slices live here — written by `writeShardCorpora`. */
export const SHARD_CORPUS_DIR = join(CORPUS_DIR, "shards");

/** Under-cairn segments (no `.cairn` prefix) for `cairnDir` resolution. */
const CURATOR_SEGS = ["init", "curator"] as const;

/** Cap per shard. 80k headroom in 200k Sonnet for system prompt + tools. */
export const MAX_INPUT_TOKENS_PER_SHARD = 120_000;

/** Average chars-per-token estimate for English prose. */
const CHARS_PER_TOKEN = 4;

export type SourceKind = "comment" | "doc" | "rule";

export interface CorpusRecord {
  comment_id: string;
  source_kind: SourceKind;
  /** Repo-relative POSIX path. */
  file: string;
  /** Logical module (top-level dir / package / 'docs' / 'rules'). */
  module: string;
  /** Detected language for `comment` records; "md" for doc / rule. */
  lang: string;
  /** Already prefilter-cleaned + JSDoc-tag-stripped prose. */
  prose_clean: string;
  /** Best-effort enclosing symbol when known (line-cluster comments above a fn). */
  enclosing_symbol?: string;
  /** Top imports near the block — heuristic narrative context for the LLM. */
  nearby_imports?: string[];
  /** Module flags carried over from mapper key_modules ("high_stakes", "route_handler", …). */
  module_flags?: string[];
  /** 1-based line range when meaningful (source comments + rule sections). */
  line_range?: [number, number];
}

export interface CorpusWriteResult {
  /** Repo-relative path actually written. */
  corpus_path: string;
  /** Repo-relative path of the shards plan. */
  shards_path: string;
  records_total: number;
  records_by_kind: { comment: number; doc: number; rule: number };
}

export function writeCorpus(
  repoRoot: string,
  records: CorpusRecord[],
): CorpusWriteResult {
  const corpusAbs = cairnDir(repoRoot, ...CURATOR_SEGS, "corpus.jsonl");
  mkdirSync(dirname(corpusAbs), { recursive: true });
  const tmp = `${corpusAbs}.tmp`;
  const lines = records.map((r) => JSON.stringify(r)).join("\n");
  writeFileSync(tmp, lines.length === 0 ? "" : `${lines}\n`, "utf8");
  renameSync(tmp, corpusAbs);

  const counts = { comment: 0, doc: 0, rule: 0 };
  for (const r of records) counts[r.source_kind] += 1;

  return {
    corpus_path: CORPUS_JSONL_PATH,
    shards_path: SHARDS_JSON_PATH,
    records_total: records.length,
    records_by_kind: counts,
  };
}

export interface Shard {
  /** Stable shard id (e.g. `module-0001` or `docs/architecture-0`). */
  shard_id: string;
  /** Module slug the shard belongs to. */
  module: string;
  /** comment_ids included in this shard. */
  comment_ids: string[];
  /** Estimated input tokens for the shard's prose. */
  estimated_input_tokens: number;
  /** Per-source-kind count (helps the subagent prompt know what to expect). */
  records_by_kind: { comment: number; doc: number; rule: number };
  /**
   * Basename of the ready-to-read per-shard corpus slice under
   * `<curator_dir>/shards/`. Set by `writeShardCorpora`. The curator-map
   * orchestration reads this file directly — it no longer slices the corpus
   * by hand. Resolve absolute as `join(curator_dir, "shards", shard_file)`
   * (works in committed AND ghost mode).
   */
  shard_file?: string;
}

export interface ShardPlan {
  /** Total shards across all modules. */
  shards: Shard[];
  /** Total input tokens summed across shards. */
  total_input_tokens_estimate: number;
  /** Cap honored by the packer (echoed for telemetry / future tuning). */
  cap_per_shard: number;
}

/**
 * Pack records into shards capped at `MAX_INPUT_TOKENS_PER_SHARD`.
 * Modules exceeding the cap split by file directory prefix; in the
 * worst case (one record over the cap by itself) the record gets its
 * own shard regardless. Records keep their original ordering within
 * each module — corpus locality matters for the curator subagent.
 */
export function packShards(records: CorpusRecord[]): ShardPlan {
  // 1. Group by module (preserve insertion order).
  const byModule = new Map<string, CorpusRecord[]>();
  for (const r of records) {
    const list = byModule.get(r.module) ?? [];
    list.push(r);
    byModule.set(r.module, list);
  }

  const shards: Shard[] = [];
  let total = 0;

  for (const [moduleSlug, moduleRecords] of byModule.entries()) {
    const moduleTokens = sumTokens(moduleRecords);
    if (moduleTokens <= MAX_INPUT_TOKENS_PER_SHARD) {
      const shard = makeShard(moduleSlug, shards.length, moduleRecords);
      shards.push(shard);
      total += shard.estimated_input_tokens;
      continue;
    }
    // Module overflows — split by top-level directory under the module.
    const splits = splitByDirectoryHierarchy(moduleRecords);
    for (const split of splits) {
      const splitTokens = sumTokens(split.records);
      if (splitTokens <= MAX_INPUT_TOKENS_PER_SHARD) {
        const shard = makeShard(`${moduleSlug}/${split.label}`, shards.length, split.records);
        shards.push(shard);
        total += shard.estimated_input_tokens;
        continue;
      }
      // Split is still too large — fall back to greedy bin-packing
      // by record (each record ≪ cap by construction; if a single
      // record > cap, it gets its own oversized shard).
      const bins = greedyBinPack(split.records);
      for (let i = 0; i < bins.length; i++) {
        const bin = bins[i];
        if (bin === undefined) continue;
        const shard = makeShard(`${moduleSlug}/${split.label}-bin${i}`, shards.length, bin);
        shards.push(shard);
        total += shard.estimated_input_tokens;
      }
    }
  }

  return {
    shards,
    total_input_tokens_estimate: total,
    cap_per_shard: MAX_INPUT_TOKENS_PER_SHARD,
  };
}

export function writeShards(
  repoRoot: string,
  plan: ShardPlan,
): string {
  const shardsAbs = cairnDir(repoRoot, ...CURATOR_SEGS, "shards.json");
  mkdirSync(dirname(shardsAbs), { recursive: true });
  const tmp = `${shardsAbs}.tmp`;
  writeFileSync(tmp, JSON.stringify(plan, null, 2), "utf8");
  renameSync(tmp, shardsAbs);
  return SHARDS_JSON_PATH;
}

/** Map a shard_id (carries `/` and `#`) to a filesystem-safe `.jsonl` name. */
function shardFilename(shardId: string): string {
  return `${shardId.replace(/[^a-zA-Z0-9_.-]/g, "-")}.jsonl`;
}

/**
 * Write each shard's `CorpusRecord` lines to a ready-to-read slice at
 * `<curator_dir>/shards/<shard_file>` and stamp `shard.shard_file` on the
 * plan in place (so the subsequent `writeShards` persists the basename).
 *
 * This moves corpus slicing OFF the cairn-adopt skill, which previously
 * hand-rolled a per-shard filter in Bash on every adoption — fragile (one
 * run shipped the wrong corpus field name and had to retry) and slow. The
 * curator-map orchestration now points each subagent straight at the
 * pre-written shard file. Call BEFORE `writeShards` so the basenames land
 * in `shards.json`.
 */
export function writeShardCorpora(
  repoRoot: string,
  records: CorpusRecord[],
  plan: ShardPlan,
): void {
  const byId = new Map(records.map((r) => [r.comment_id, r]));
  const dirAbs = cairnDir(repoRoot, ...CURATOR_SEGS, "shards");
  mkdirSync(dirAbs, { recursive: true });
  for (const shard of plan.shards) {
    const recs = shard.comment_ids
      .map((id) => byId.get(id))
      .filter((r): r is CorpusRecord => r !== undefined);
    const body = recs.length === 0 ? "" : `${recs.map((r) => JSON.stringify(r)).join("\n")}\n`;
    const fname = shardFilename(shard.shard_id);
    const abs = join(dirAbs, fname);
    const tmp = `${abs}.tmp`;
    writeFileSync(tmp, body, "utf8");
    renameSync(tmp, abs);
    shard.shard_file = fname;
  }
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                  */
/* -------------------------------------------------------------------------- */

function makeShard(label: string, index: number, records: CorpusRecord[]): Shard {
  const counts = { comment: 0, doc: 0, rule: 0 };
  for (const r of records) counts[r.source_kind] += 1;
  return {
    shard_id: `${label}#${index.toString().padStart(4, "0")}`,
    module: label.split("/")[0] ?? label,
    comment_ids: records.map((r) => r.comment_id),
    estimated_input_tokens: sumTokens(records),
    records_by_kind: counts,
  };
}

function sumTokens(records: CorpusRecord[]): number {
  let sum = 0;
  for (const r of records) {
    sum += Math.ceil(r.prose_clean.length / CHARS_PER_TOKEN);
  }
  return sum;
}

interface DirectorySplit {
  label: string;
  records: CorpusRecord[];
}

function splitByDirectoryHierarchy(records: CorpusRecord[]): DirectorySplit[] {
  // Group by the SECOND directory segment (first segment is the
  // module slug we already split by). For records whose path has no
  // second segment, group under "(root)".
  const byDir = new Map<string, CorpusRecord[]>();
  for (const r of records) {
    const parts = r.file.split("/");
    const label = parts.length >= 2 ? `${parts[0]}/${parts[1]}` : parts[0] ?? "(root)";
    const list = byDir.get(label) ?? [];
    list.push(r);
    byDir.set(label, list);
  }
  return Array.from(byDir.entries()).map(([label, list]) => ({
    label: sanitizeShardLabel(label),
    records: list,
  }));
}

function sanitizeShardLabel(label: string): string {
  return label.replace(/[^a-zA-Z0-9_/-]/g, "_");
}

function greedyBinPack(records: CorpusRecord[]): CorpusRecord[][] {
  const bins: CorpusRecord[][] = [];
  let current: CorpusRecord[] = [];
  let currentTokens = 0;
  for (const r of records) {
    const tokens = Math.ceil(r.prose_clean.length / CHARS_PER_TOKEN);
    if (
      current.length > 0 &&
      currentTokens + tokens > MAX_INPUT_TOKENS_PER_SHARD
    ) {
      bins.push(current);
      current = [];
      currentTokens = 0;
    }
    current.push(r);
    currentTokens += tokens;
  }
  if (current.length > 0) bins.push(current);
  return bins;
}
