import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { logger } from "../logger.js";
import { topicIndexPath } from "./paths.js";
import { TopicIndex, type TopicIndexEntry } from "./schemas.js";

const log = logger("ground.topic-index");

/**
 * Topic-index is the ground-state file that maps content-fingerprint
 * slugs to the DECs they belong to. Phase 5b builds it before any
 * extractor runs so phases 6 / 7b / 7c can dedup-by-topic instead of
 * emitting one DEC per source. Layer A's PostToolUse hook reads it on
 * every Write to know whether a freshly typed prose block is the first
 * sighting of its content or a repeat of an existing topic.
 */

export function emptyTopicIndex(): TopicIndex {
  return { version: 1, generated: new Date().toISOString(), topics: {} };
}

export function readTopicIndex(repoRoot: string): TopicIndex {
  const path = topicIndexPath(repoRoot);
  if (!existsSync(path)) return emptyTopicIndex();
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = TopicIndex.safeParse(parseYaml(raw));
    if (!parsed.success) {
      log.warn({ path, error: parsed.error.message }, "topic-index invalid; treating as empty");
      return emptyTopicIndex();
    }
    return parsed.data;
  } catch (err) {
    log.warn({ path, err }, "topic-index read failed; treating as empty");
    return emptyTopicIndex();
  }
}

export function writeTopicIndex(repoRoot: string, index: TopicIndex): string {
  const path = topicIndexPath(repoRoot);
  mkdirSync(dirname(path), { recursive: true });
  const next: TopicIndex = { ...index, generated: new Date().toISOString() };
  writeFileSync(path, stringifyYaml(next), "utf8");
  log.debug({ path, topics: Object.keys(next.topics).length }, "wrote topic-index");
  return path;
}

/**
 * Insert or replace a topic entry. Returns the updated index.
 */
export function setTopic(index: TopicIndex, slug: string, entry: TopicIndexEntry): TopicIndex {
  return {
    ...index,
    topics: { ...index.topics, [slug]: entry },
  };
}

/**
 * Look up a topic by slug. Returns null if absent.
 */
export function getTopic(index: TopicIndex, slug: string): TopicIndexEntry | null {
  return index.topics[slug] ?? null;
}
