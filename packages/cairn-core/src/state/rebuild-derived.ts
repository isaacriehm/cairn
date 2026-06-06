/**
 * `rebuildDerived` — reconstruct the gitignored derived ground-state
 * indexes from the committed source of truth (DEC/INV `.md` frontmatter
 * + bodies + source tree).
 *
 * As of v0.15.0 the derived ground files are gitignored to kill multi-dev
 * merge conflicts (every clone used to regenerate and commit divergent
 * copies). They no longer ship in git, so every clone must be able to
 * regenerate them locally. This routine is the single rebuild entry
 * point, wired into:
 *   - `cairn join`     — a fresh teammate clone has no derived files yet.
 *   - SessionStart     — refresh on every session open (cheap).
 *
 * (CI needs no rebuild: sensors read the committed DEC/INV `.md` directly,
 * not the derived indexes.)
 *
 * Haiku-free and deterministic from committed sources. Covers the
 * load-bearing set:
 *   - decisions/invariants ledgers (context injection)
 *   - scope-index               (cairn_in_scope)
 *   - manifest                  (inventory)
 *   - sot-bindings              (lens + sensors + align resolve §DEC → path)
 *   - sot-cache                 (Layer A Jaccard pre-filter)
 *
 * `topic-index.yaml` + `anchor-map.yaml` are discovery-time artifacts
 * (init builds them with a Haiku dedup walk). We don't re-run discovery,
 * but we DO reconstruct them Haiku-free on a COLD clone: the accepted
 * `sot_kind: path` DEC/INV already encode resolved topics, so we walk
 * the source prose blocks (`walkProseBlocks`, deterministic) and
 * content-hash-rematch each entity's `sot_content_hash` to its current
 * location → `anchor-map[slug]` + `topic-index[slug].dec_id`. This only
 * runs when the files are absent (fresh clone / post-untrack); when
 * present they are left to the incremental sot-align hook (no repeat of
 * the full walk on every SessionStart). `file-candidates-map` is a pure
 * function of the resulting `topic-index`.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  DecisionFrontmatter,
  InvariantFrontmatter,
  anchorMapPath,
  bindDec,
  bodyContentHash,
  decisionsDir,
  emptyAnchorMap,
  emptySotBindings,
  emptySotCache,
  emptyTopicIndex,
  invariantsDir,
  parseFrontmatter,
  readTopicIndex,
  rescanScopeIndex,
  setAnchor,
  setSotCacheEntry,
  setTopic,
  topicIndexPath,
  writeAnchorMap,
  writeDecisionsLedger,
  writeFileCandidatesMap,
  writeInvariantsLedger,
  writeManifest,
  writeSotBindings,
  writeSotCache,
  writeTopicIndex,
  type AnchorMapEntry,
  type SotBindings,
  type SotCache,
  type SotCacheEntry,
  type TopicIndexEntry,
} from "@isaacriehm/cairn-state";
import { walkProseBlocks } from "../init/topic-index/walk.js";
import { tokenize } from "../text/jaccard.js";
import { logger } from "../logger.js";

/** A `sot_kind: path` entity to relocate during a cold topic/anchor rebuild. */
interface PathEntity {
  id: string;
  sotContentHash: string;
}

const log = logger("rebuild-derived");

export interface RebuildDerivedResult {
  decisions: number;
  invariants: number;
  bindings: number;
  cacheEntries: number;
  /** `sot_kind: path` entities relocated into topic-index/anchor-map on a cold rebuild. */
  topicAnchorRebuilt: number;
}

/** Read every `.md` in a ground entity dir (skipping `_`-prefixed). */
function listEntityFiles(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir)
      .filter((n) => n.endsWith(".md") && !n.startsWith("_"))
      .sort();
  } catch {
    return [];
  }
}

export function rebuildDerived(repoRoot: string): RebuildDerivedResult {
  // 1. Deterministic ledgers + scope-index + manifest. These already had
  //    writers; SessionStart used to call the ledgers + scope rescan
  //    directly — now centralized here so join gets the same path.
  writeDecisionsLedger({ repoRoot });
  writeInvariantsLedger({ repoRoot });
  rescanScopeIndex(repoRoot);

  // 2. sot-bindings + sot-cache, reconstructed from committed DEC/INV
  //    frontmatter (sot_path) + bodies (tokens). The forward binding is
  //    one entity → its sot_path; sot-cache holds the tokenized body for
  //    the Layer A Jaccard pre-filter.
  let bindings: SotBindings = emptySotBindings();
  let cache: SotCache = emptySotCache();
  const pathEntities: PathEntity[] = [];
  let decisions = 0;
  let invariants = 0;

  const decDir = decisionsDir(repoRoot);
  for (const name of listEntityFiles(decDir)) {
    const abs = join(decDir, name);
    const parsed = parseFrontmatter(readFileSync(abs, "utf8"));
    const fm = DecisionFrontmatter.safeParse(parsed.frontmatter);
    if (!fm.success) continue;
    if (fm.data.status !== "accepted") continue;
    if (fm.data.superseded_by) continue;
    const entry = makeCacheEntry(fm.data.id, fm.data.sot_path, parsed.body, abs);
    bindings = bindDec(bindings, fm.data.id, fm.data.sot_path);
    cache = setSotCacheEntry(cache, fm.data.id, entry);
    if (fm.data.sot_kind === "path") {
      pathEntities.push({ id: fm.data.id, sotContentHash: fm.data.sot_content_hash });
    }
    decisions += 1;
  }

  const invDir = invariantsDir(repoRoot);
  for (const name of listEntityFiles(invDir)) {
    const abs = join(invDir, name);
    const parsed = parseFrontmatter(readFileSync(abs, "utf8"));
    const fm = InvariantFrontmatter.safeParse(parsed.frontmatter);
    if (!fm.success) continue;
    if ((fm.data.status ?? "active") !== "active") continue;
    const entry = makeCacheEntry(fm.data.id, fm.data.sot_path, parsed.body, abs);
    bindings = bindDec(bindings, fm.data.id, fm.data.sot_path);
    cache = setSotCacheEntry(cache, fm.data.id, entry);
    if (fm.data.sot_kind === "path") {
      pathEntities.push({ id: fm.data.id, sotContentHash: fm.data.sot_content_hash });
    }
    invariants += 1;
  }

  writeSotBindings(repoRoot, bindings);
  writeSotCache(repoRoot, cache);

  // 3. Manifest (inventory over the freshly-written ground files).
  writeManifest({ repoRoot });

  // 4. Cold-start only: reconstruct topic-index + anchor-map for
  //    `sot_kind: path` entities by content-hash rematch. Skip when both
  //    files already exist — the sot-align hook maintains them warm, and
  //    a full prose walk on every SessionStart would be wasteful.
  let topicAnchorRebuilt = 0;
  const topicMissing = !existsSync(topicIndexPath(repoRoot));
  const anchorMissing = !existsSync(anchorMapPath(repoRoot));
  if ((topicMissing || anchorMissing) && pathEntities.length > 0) {
    topicAnchorRebuilt = rebuildTopicAndAnchor(repoRoot, pathEntities);
  }

  // 5. file-candidates-map is a pure function of topic-index.
  writeFileCandidatesMap(repoRoot, readTopicIndex(repoRoot));

  const bindingCount = Object.keys(bindings.forward).length;
  const cacheCount = Object.keys(cache.entries).length;
  log.debug(
    {
      repoRoot,
      decisions,
      invariants,
      bindings: bindingCount,
      cache: cacheCount,
      topicAnchorRebuilt,
    },
    "rebuilt derived ground state",
  );

  return {
    decisions,
    invariants,
    bindings: bindingCount,
    cacheEntries: cacheCount,
    topicAnchorRebuilt,
  };
}

/**
 * Cold rebuild of `topic-index` + `anchor-map` for `sot_kind: path`
 * entities. Walks the source prose blocks once, indexes them by content
 * hash, and relocates each entity's `sot_content_hash` to its current
 * block (slug, file, line range, anchor). Haiku-free — discovery already
 * happened; this just re-resolves known topics. Entities whose SoT block
 * isn't found (content drifted, or it lives in a source-comment the doc
 * walker doesn't cover) are skipped and left to the incremental hook.
 * Returns the number of entities relocated.
 */
function rebuildTopicAndAnchor(repoRoot: string, entities: PathEntity[]): number {
  let blocksByHash: Map<string, ReturnType<typeof walkProseBlocks>[number]>;
  try {
    const blocks = walkProseBlocks(repoRoot);
    blocksByHash = new Map();
    for (const b of blocks) {
      if (!blocksByHash.has(b.content_hash)) blocksByHash.set(b.content_hash, b);
    }
  } catch {
    return 0; // walk failed (non-repo / IO) — leave maps to the hook
  }

  let topic = emptyTopicIndex();
  let anchors = emptyAnchorMap();
  let relocated = 0;
  const now = new Date().toISOString();

  for (const e of entities) {
    const b = blocksByHash.get(e.sotContentHash);
    if (b === undefined) continue;
    const topicEntry: TopicIndexEntry = {
      slug: b.slug,
      dec_id: e.id,
      sot_source: b.file,
      candidates: [
        {
          file: b.file,
          kind: b.kind,
          line_range: b.line_range,
          ...(b.anchor !== undefined ? { anchor: b.anchor } : {}),
        },
      ],
      created_at: now,
      content_hash: b.content_hash,
    };
    topic = setTopic(topic, b.slug, topicEntry);

    const anchorEntry: AnchorMapEntry = {
      file: b.file,
      content_hash: b.content_hash,
      line_range: b.line_range,
      kind: b.kind,
      ...(b.anchor !== undefined ? { current_anchor: b.anchor } : {}),
    };
    anchors = setAnchor(anchors, b.slug, anchorEntry);
    relocated += 1;
  }

  writeTopicIndex(repoRoot, topic);
  writeAnchorMap(repoRoot, anchors);
  return relocated;
}

function makeCacheEntry(
  id: string,
  sotPath: string,
  body: string,
  abs: string,
): SotCacheEntry {
  let mtimeMs = 0;
  try {
    mtimeMs = statSync(abs).mtimeMs;
  } catch {
    /* best-effort — mtime is a local incremental-staleness hint only */
  }
  return {
    dec_id: id,
    sot_path: sotPath,
    body_hash: bodyContentHash(body),
    tokens: Array.from(tokenize(body, { codeAware: true })),
    shingles: [],
    mtime_ms: mtimeMs,
  };
}
