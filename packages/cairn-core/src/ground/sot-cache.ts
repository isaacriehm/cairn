import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { logger } from "../logger.js";
import { sotCachePath } from "./paths.js";
import { SotCache, type SotCacheEntry } from "./schemas.js";

const log = logger("ground.sot-cache");

/**
 * Sot-cache holds pre-tokenized DEC body content for the Layer A Jaccard
 * pre-filter. Rebuilt at SessionStart, incremental on PostToolUse Write
 * events that touch a DEC body or sot-path file. Mtime-keyed so a stale
 * entry is detected without re-tokenizing every body on every Write.
 */

export function emptySotCache(): SotCache {
  return { version: 1, generated: new Date().toISOString(), entries: {} };
}

export function readSotCache(repoRoot: string): SotCache {
  const path = sotCachePath(repoRoot);
  if (!existsSync(path)) return emptySotCache();
  try {
    const raw = readFileSync(path, "utf8");
    const parsed = SotCache.safeParse(parseYaml(raw));
    if (!parsed.success) {
      log.warn({ path, error: parsed.error.message }, "sot-cache invalid; treating as empty");
      return emptySotCache();
    }
    return parsed.data;
  } catch (err) {
    log.warn({ path, err }, "sot-cache read failed; treating as empty");
    return emptySotCache();
  }
}

export function writeSotCache(repoRoot: string, cache: SotCache): string {
  const path = sotCachePath(repoRoot);
  mkdirSync(dirname(path), { recursive: true });
  const next: SotCache = { ...cache, generated: new Date().toISOString() };
  writeFileSync(path, stringifyYaml(next), "utf8");
  log.debug({ path, entries: Object.keys(next.entries).length }, "wrote sot-cache");
  return path;
}

export function setEntry(cache: SotCache, decId: string, entry: SotCacheEntry): SotCache {
  return { ...cache, entries: { ...cache.entries, [decId]: entry } };
}

export function getEntry(cache: SotCache, decId: string): SotCacheEntry | null {
  return cache.entries[decId] ?? null;
}

export function deleteEntry(cache: SotCache, decId: string): SotCache {
  if (cache.entries[decId] === undefined) return cache;
  const entries = { ...cache.entries };
  delete entries[decId];
  return { ...cache, entries };
}

/**
 * Iterate all entries. Layer A's pre-filter pass calls this on each
 * Write to compute Jaccard against every cached DEC body.
 */
export function entries(cache: SotCache): SotCacheEntry[] {
  return Object.values(cache.entries);
}
