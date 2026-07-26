/**
 * Merge-write ground-state indexes after init phases that emit DECs/INVs.
 *
 * Re-reads each file right before write so concurrent phase tools (6/7b/7c/9/10)
 * don't clobber each other's partial updates.
 */

import {
  emptyAnchorMap,
  emptySotBindings,
  emptySotCache,
  emptyTopicIndex,
  readAnchorMap,
  readSotBindings,
  readSotCache,
  readTopicIndex,
  setSotCacheEntry,
  writeAnchorMap,
  writeSotBindings,
  writeSotCache,
  writeTopicIndex,
  type AnchorMap,
  type SotBindings,
  type SotCache,
  type TopicIndex,
} from "@isaacriehm/cairn-state";

export interface PersistGroundStateArgs {
  repoRoot: string;
  topicIndex: TopicIndex;
  anchorMap: AnchorMap;
  bindings: SotBindings;
  cache: SotCache;
}

export function persistGroundState(args: PersistGroundStateArgs): void {
  const { repoRoot } = args;
  const freshTopic = readTopicIndex(repoRoot);
  const baseTopic = Object.keys(freshTopic.topics).length > 0 ? freshTopic : emptyTopicIndex();
  for (const [slug, entry] of Object.entries(args.topicIndex.topics)) {
    baseTopic.topics[slug] = entry;
  }
  baseTopic.generated = new Date().toISOString();
  writeTopicIndex(repoRoot, baseTopic);

  const freshAnchor = readAnchorMap(repoRoot);
  const baseAnchor = Object.keys(freshAnchor.anchors).length > 0 ? freshAnchor : emptyAnchorMap();
  for (const [slug, anchor] of Object.entries(args.anchorMap.anchors)) {
    baseAnchor.anchors[slug] = anchor;
  }
  baseAnchor.generated = new Date().toISOString();
  writeAnchorMap(repoRoot, baseAnchor);

  const freshBindings = readSotBindings(repoRoot);
  const baseBindings =
    Object.keys(freshBindings.forward).length > 0 ? freshBindings : emptySotBindings();
  for (const [decId, sotPath] of Object.entries(args.bindings.forward)) {
    baseBindings.forward[decId] = sotPath;
  }
  for (const [sotPath, decIds] of Object.entries(args.bindings.reverse)) {
    const seen = new Set(baseBindings.reverse[sotPath] ?? []);
    for (const id of decIds) seen.add(id);
    baseBindings.reverse[sotPath] = Array.from(seen);
  }
  baseBindings.generated = new Date().toISOString();
  writeSotBindings(repoRoot, baseBindings);

  const freshCache = readSotCache(repoRoot);
  let baseCache = Object.keys(freshCache.entries).length > 0 ? freshCache : emptySotCache();
  for (const [decId, entry] of Object.entries(args.cache.entries)) {
    baseCache = setSotCacheEntry(baseCache, decId, entry);
  }
  baseCache.generated = new Date().toISOString();
  writeSotCache(repoRoot, baseCache);
}
