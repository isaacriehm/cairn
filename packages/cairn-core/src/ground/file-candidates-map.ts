/**
 * `.cairn/ground/file-candidates-map.yaml` — per-file count of
 * topic-index entries with `dec_id IS NULL`.
 *
 * Built (and rebuilt) anywhere `topic-index.yaml` is written. The
 * read-enrich PostToolUse hook on `Read` consults this map per file
 * touched by the agent — `O(1)` lookup avoids re-walking the topic
 * index on every read. When an entry has its `dec_id` stamped
 * (phase 6 emit, PR 2 `cairn_propose_decision`), the index writer is
 * responsible for refreshing this file too — that's why the helper is
 * a pure pair of `(topicIndex) → FileCandidatesMap` plus a writer.
 */

import { existsSync, readFileSync } from "node:fs";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { writeFileSafe } from "../fs.js";
import { logger } from "../logger.js";
import { fileCandidatesMapPath } from "./paths.js";
import {
  FileCandidatesMap,
  type TopicIndex,
} from "./schemas.js";

const log = logger("ground.file-candidates-map");

export function emptyFileCandidatesMap(): FileCandidatesMap {
  return {
    version: 1,
    generated: new Date().toISOString(),
    file_candidates: {},
  };
}

/**
 * Compute the per-file candidate count by walking the topic-index.
 * Each entry without a `dec_id` contributes 1 to its `sot_source`
 * bucket. Files with zero unpromoted candidates are omitted from the
 * map (so `Map.has(file)` is the gate, not a zero-check).
 */
export function buildFileCandidatesMap(topicIndex: TopicIndex): FileCandidatesMap {
  const counts = new Map<string, number>();
  for (const entry of Object.values(topicIndex.topics)) {
    if (entry.dec_id !== undefined) continue;
    const cur = counts.get(entry.sot_source) ?? 0;
    counts.set(entry.sot_source, cur + 1);
  }
  const file_candidates: Record<string, number> = {};
  const sortedFiles = [...counts.keys()].sort();
  for (const f of sortedFiles) file_candidates[f] = counts.get(f)!;
  return {
    version: 1,
    generated: new Date().toISOString(),
    file_candidates,
  };
}

export function readFileCandidatesMap(repoRoot: string): FileCandidatesMap {
  const path = fileCandidatesMapPath(repoRoot);
  if (!existsSync(path)) return emptyFileCandidatesMap();
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = FileCandidatesMap.safeParse(parseYaml(raw));
    if (!parsed.success) {
      log.warn(
        { path, error: parsed.error.message },
        "file-candidates-map invalid; treating as empty",
      );
      return emptyFileCandidatesMap();
    }
    return parsed.data;
  } catch (err) {
    log.warn({ path, err }, "file-candidates-map read failed; treating as empty");
    return emptyFileCandidatesMap();
  }
}

export function writeFileCandidatesMap(
  repoRoot: string,
  topicIndex: TopicIndex,
): string {
  const path = fileCandidatesMapPath(repoRoot);
  const map = buildFileCandidatesMap(topicIndex);
  writeFileSafe(path, stringifyYaml(map));
  log.debug(
    { path, files: Object.keys(map.file_candidates).length },
    "wrote file-candidates-map",
  );
  return path;
}
