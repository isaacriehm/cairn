/**
 * Phase 7b orchestrator (v0.5.0 SoT model) — walker → classifier →
 * topic-index lookup → emit-or-cite → strip-replace.
 *
 * Plan §5.3 algorithm:
 *   1. Walk source files for prose-bearing comments (existing logic).
 *   2. Classify via Haiku, kind only — `rationale` / `constraint` /
 *      `citation` / `license` / `other`. No paraphrased title, no rewritten
 *      invariant body, no canonical-topic suggestion.
 *   3. Build a content-fingerprint slug for every rationale + constraint
 *      block. Look it up in the existing topic-index:
 *        a. **Cite-existing** — slug already owned by a docs/CLAUDE.md/
 *           AGENTS.md/rule entry that has been emitted. Strip-replace
 *           inserts `// §DEC-<existing>` (or `§INV-<existing>`) at the
 *           comment's offset. No new ground-state file is written.
 *        b. **Novel** — slug not in the topic-index, or owned by an
 *           un-emitted entry. Add the block to the topic-index as a
 *           new source-comment SoT entry; emit a verbatim DEC/INV via
 *           `emitFromTopicIndex` with `sot_kind: "ledger"`. After emit,
 *           strip-replace inserts `§DEC-<new>` / `§INV-<new>`.
 *   4. Auto-promote — every newly-emitted entity ships with
 *      `status: accepted` (no `_inbox/` draft queue). Plan §1's pivot:
 *      the inbox-as-blocker was the bug; verbatim bodies + auto-promote
 *      remove the manual review step.
 *   5. License + citation + other classifications → no-op (no DEC, no
 *      strip-replace). License blocks stay verbatim in source.
 *
 * Output side-effects (all relative to repoRoot):
 *   - `.cairn/ground/decisions/<DEC-id>.md`        (one per novel rationale)
 *   - `.cairn/ground/invariants/<INV-id>.md`       (one per novel constraint)
 *   - `.cairn/ground/topic-index.yaml`             (extended with source-comment SoT entries)
 *   - `.cairn/ground/anchor-map.yaml`              (one anchor per novel slug)
 *   - `.cairn/ground/sot-bindings.yaml`            (forward+reverse for new ids)
 *   - `.cairn/ground/sot-cache.yaml`               (token cache for Layer A)
 *   - `.cairn/ground/scope-index.yaml`             (file → ids that landed in source)
 *   - `.cairn/baseline/source-comments-<ISO>.yaml` (full audit — every block + verdict)
 *   - source files                                 (stripped & cited per replacement)
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import {
  writeDecisionsLedger,
  writeInvariantsLedger,
} from "../../ground/ledgers.js";
import {
  bodyContentHash,
  deriveLedgerDecId,
  deriveLedgerInvId,
  emptyAnchorMap,
  emptySotBindings,
  emptySotCache,
  emptyTopicIndex,
  readAnchorMap,
  readSotBindings,
  readSotCache,
  readTopicIndex,
  setAnchor,
  setSotCacheEntry,
  setTopic,
  topicSlug,
  writeAnchorMap,
  writeSotBindings,
  writeSotCache,
  writeTopicIndex,
  type AnchorMap,
  type SotBindings,
  type SotCache,
  type TopicIndex,
  type TopicIndexEntry,
} from "../../ground/index.js";
import {
  coerceDecisionIds,
  coerceInvariantIds,
  readScopeIndex,
  writeScopeIndex,
  type ScopeIndex,
  type ScopeIndexEntry,
} from "../../ground/scope-index.js";
import { logger } from "../../logger.js";
import type { ProjectGlobs } from "../../sensors/types.js";
import { emitFromTopicIndex, type EmitClassification } from "../sot-emit.js";
import {
  applyStripReplace,
  formatBareCitation,
  type ReplaceItem,
} from "./strip-replace.js";
import { classifyBlocks } from "./classify.js";
import type {
  ClassifyArgs,
  CommentClassification,
  CommentClassKind,
} from "./classify.js";
import { walkSourceComments } from "./walker.js";
import type { CommentBlock, WalkOptions, WalkResult } from "./walker.js";

const log = logger("init.source-comments.ingest");
const CAPTURE_SOURCE = "init-source-comments";

/**
 * Phase 7b regex pre-filter (PHASE_6_REDESIGN §4.3).
 *
 * Essay-class block comments only fall through to the Haiku batch
 * classifier when their prose matches imperative documentation
 * conventions. Code uses rigid conventions, so this regex is safe in a
 * way it would not be on arbitrary natural-language prose.
 *
 * Accepted false-negative: passive-voice invariants like
 *   "Token expiry is enforced via …"
 * miss the regex and remain topic-index candidates only. The operator
 * (or any AI agent reading the file) can promote them later via
 * `cairn_propose_decision` from the candidate surface introduced in PR 2.
 */
const PHASE_7B_DECISION_REGEX =
  /(MUST|MUST NOT|SHALL|NEVER|ALWAYS|REQUIRED|FORBIDDEN|INVARIANT|@invariant|@rule|@decision|@cairn:decision|@cairn:rule)/i;

/** Marker override — always emits regardless of regex match. */
const PHASE_7B_MARKER_REGEX = /@cairn:(decision|rule)/i;

type BlockDisposition =
  | { kind: "license" }
  | { kind: "marker"; markerKind: "decision" | "rule" }
  | { kind: "classify" }
  | { kind: "candidate-only" };

function dispositionForBlock(block: CommentBlock): BlockDisposition {
  if (block.kind === "license") return { kind: "license" };
  // Markers (`@cairn:decision` / `@cairn:rule`) live on JSDoc-tag lines that
  // the walker strips from `block.prose`. Match the raw text so the override
  // works in JSDoc as naturally as in plain block comments.
  const m = block.raw.match(PHASE_7B_MARKER_REGEX);
  if (m !== null) {
    const kw = (m[1] ?? "").toLowerCase();
    return { kind: "marker", markerKind: kw === "rule" ? "rule" : "decision" };
  }
  if (PHASE_7B_DECISION_REGEX.test(block.prose)) {
    return { kind: "classify" };
  }
  return { kind: "candidate-only" };
}

export interface IngestSourceCommentsArgs {
  repoRoot: string;
  /** Forwarded to walker — typically left undefined for full-repo walks. */
  walkOptions?: Partial<WalkOptions>;
  /** Forwarded to classifier (for tests / mock runs). */
  mockClassify?: ClassifyArgs["mockClassify"];
  /** Optional progress hook for batch-level updates. */
  onBatchProgress?: ClassifyArgs["onBatchProgress"];
  /** When true, no DEC drafts / proposals / citations are written. */
  dryRun?: boolean;
  /** When set, override `Date.now()` for deterministic test outputs. */
  nowIso?: string;
  /**
   * Project globs from `.cairn/config.yaml`. Carried through for
   * compatibility with the parallel-678 caller; phase 7b under v0.5.0
   * doesn't gate behavior on these (every novel rationale/constraint
   * auto-promotes without scoring).
   */
  globs?: ProjectGlobs;
  /** Pilot module path (workflow.md `pilot_module`). Same compat note. */
  pilotModule?: string;
  /**
   * Caller-supplied DEC id Set — kept for symmetry with phases 6 / 7c.
   * Plan §3.2.1 derives content-addressed ids; collisions across phases
   * are vanishingly unlikely so the Set is informational.
   */
  existingDecIds?: Set<string>;
  /** Caller-supplied INV id Set. Same compat note. */
  existingInvIds?: Set<string>;
}

interface IngestEmittedRecord {
  id: string;
  path: string;
  sourceFile: string;
  slug: string;
  status: "accepted";
}

interface IngestCiteRecord {
  /** Pre-existing DEC/INV id the source comment was bound to. */
  id: string;
  /** Source file the cite landed in. */
  sourceFile: string;
  /** 1-indexed inclusive line range of the original source comment. */
  lineRange: [number, number];
  /** Slug that resolved the topic-index lookup. */
  slug: string;
}

interface IngestSkipRecord {
  blockId: string;
  reason: string;
}

interface StripOutcomePersisted {
  file: string;
  applied: number;
  skipped: { blockId: string; reason: string }[];
  fileSkipReason: string | null;
}

export interface IngestSourceCommentsResult {
  walk: WalkResult;
  classifications: CommentClassification[];
  /** Verbatim DEC files written under `.cairn/ground/decisions/`. */
  decsWritten: IngestEmittedRecord[];
  /** Verbatim INV files written under `.cairn/ground/invariants/`. */
  invsWritten: IngestEmittedRecord[];
  /**
   * Source comments that resolved to an already-emitted DEC/INV via the
   * topic-index lookup. Strip-replace still fires for these — the source
   * file gets the existing `§DEC-<hash>` / `§INV-<hash>` token.
   */
  citesEmitted: IngestCiteRecord[];
  /** Blocks the ingest stage skipped (license, citation, other, errors). */
  skipped: IngestSkipRecord[];
  stripFilesModified: number;
  stripItemsApplied: number;
  stripItemsSkipped: number;
  stripOutcomes: StripOutcomePersisted[];
  stripError: string | null;
  auditPath: string;
  auditRelPath: string;
  inputTokens: number;
  outputTokens: number;
  batchesRun: number;
  batchesFailed: number;
  /** Distribution by classifier kind (rationale / constraint / etc.). */
  kindCounts: Record<CommentClassKind, number>;
}

/* -------------------------------------------------------------------------- */
/* Public                                                                     */
/* -------------------------------------------------------------------------- */

export async function runSourceCommentsIngestion(
  args: IngestSourceCommentsArgs,
): Promise<IngestSourceCommentsResult> {
  const repoRoot = args.repoRoot;
  const nowIso = args.nowIso ?? new Date().toISOString();
  const tsSlug = nowIso.replace(/[:.]/g, "-").slice(0, 19);

  // ── 1. Walk ──────────────────────────────────────────────────────
  const walkOpts: WalkOptions = { repoRoot };
  if (args.walkOptions?.fileCap !== undefined) {
    walkOpts.fileCap = args.walkOptions.fileCap;
  }
  if (args.walkOptions?.onlyFiles !== undefined) {
    walkOpts.onlyFiles = args.walkOptions.onlyFiles;
  }
  const walk = walkSourceComments(walkOpts);

  // ── 2a. Phase 7b regex pre-filter ────────────────────────────────
  const dispositions: BlockDisposition[] = walk.blocks.map(dispositionForBlock);
  const classifyTargets: CommentBlock[] = [];
  const classifyTargetIndices: number[] = [];
  for (let i = 0; i < walk.blocks.length; i += 1) {
    if (dispositions[i]?.kind === "classify") {
      classifyTargets.push(walk.blocks[i]!);
      classifyTargetIndices.push(i);
    }
  }

  // ── 2b. Classify (kind only) — only blocks that passed the regex ─
  const classifyResult = await classifyBlocks({
    blocks: classifyTargets,
    repoRoot,
    ...(args.mockClassify !== undefined ? { mockClassify: args.mockClassify } : {}),
    ...(args.onBatchProgress !== undefined
      ? { onBatchProgress: args.onBatchProgress }
      : {}),
  });

  // Re-align classifications back to walk.blocks index space. Marker-override
  // blocks get a synthetic classification so the resolution loop emits them.
  // Candidate-only blocks (and license blocks) get a synthetic "other" so
  // the resolution loop branches into the candidate-registration path.
  const classifications: CommentClassification[] = new Array(walk.blocks.length);
  for (let i = 0; i < walk.blocks.length; i += 1) {
    const block = walk.blocks[i]!;
    classifications[i] = { blockId: block.id, kind: "other", failed: false };
  }
  for (let j = 0; j < classifyTargets.length; j += 1) {
    const blockIdx = classifyTargetIndices[j]!;
    const real = classifyResult.classifications[j];
    if (real !== undefined) classifications[blockIdx] = real;
  }
  for (let i = 0; i < walk.blocks.length; i += 1) {
    const block = walk.blocks[i]!;
    const d = dispositions[i]!;
    if (d.kind === "marker") {
      classifications[i] = {
        blockId: block.id,
        kind: d.markerKind === "rule" ? "constraint" : "rationale",
        failed: false,
      };
    } else if (d.kind === "license") {
      classifications[i] = { blockId: block.id, kind: "license", failed: false };
    }
    // candidate-only and classify dispositions retain their existing assignment.
  }

  const kindCounts: Record<CommentClassKind, number> = {
    rationale: 0,
    constraint: 0,
    citation: 0,
    license: 0,
    other: 0,
  };
  for (const c of classifications) {
    if (c === undefined) continue;
    kindCounts[c.kind] = (kindCounts[c.kind] ?? 0) + 1;
  }

  // ── 3. Topic-index lookup + extension ────────────────────────────
  let topicIndex: TopicIndex = readTopicIndex(repoRoot);
  if (Object.keys(topicIndex.topics).length === 0) topicIndex = emptyTopicIndex();
  let anchorMap: AnchorMap = readAnchorMap(repoRoot);
  if (Object.keys(anchorMap.anchors).length === 0) anchorMap = emptyAnchorMap();

  type Resolution =
    | { kind: "cite"; existingId: string; slug: string }
    | { kind: "emit"; slug: string; emitKind: "decision" | "constraint" };

  const resolutionByBlockId = new Map<string, Resolution>();
  const skipped: IngestSkipRecord[] = [];
  const emitKindBySlug = new Map<string, "decision" | "constraint">();

  for (let i = 0; i < walk.blocks.length; i += 1) {
    const block = walk.blocks[i];
    const cls = classifications[i];
    const disposition = dispositions[i];
    if (block === undefined || cls === undefined || disposition === undefined) continue;
    if (disposition.kind === "candidate-only") {
      // Phase 7b regex pre-filter: surface in topic-index as a candidate
      // (no dec_id) so AI agents reading the file can promote later via
      // cairn_propose_decision. No DEC emit, no strip-replace.
      const slug = topicSlug(block.prose);
      if (topicIndex.topics[slug] === undefined) {
        const lineRange: [number, number] = [block.startLine, block.endLine];
        topicIndex = setTopic(topicIndex, slug, {
          slug,
          sot_source: block.file,
          candidates: [
            { file: block.file, kind: "source-comment", line_range: lineRange },
          ],
          created_at: nowIso,
        });
        anchorMap = setAnchor(anchorMap, slug, {
          file: block.file,
          content_hash: bodyContentHash(block.prose),
          line_range: lineRange,
          kind: "source-comment",
        });
      }
      skipped.push({ blockId: block.id, reason: "phase-7b regex pre-filter: no imperative keyword" });
      continue;
    }
    if (cls.kind !== "rationale" && cls.kind !== "constraint") {
      skipped.push({ blockId: block.id, reason: `kind=${cls.kind}` });
      continue;
    }
    if (cls.failed) {
      skipped.push({
        blockId: block.id,
        reason: `classifier failed: ${cls.errorMessage ?? "unknown"}`,
      });
      continue;
    }
    const slug = topicSlug(block.prose);
    const existing = topicIndex.topics[slug];
    if (existing !== undefined && existing.dec_id !== undefined) {
      // Cite-existing — another source already owns this topic + emitted.
      resolutionByBlockId.set(block.id, {
        kind: "cite",
        existingId: existing.dec_id,
        slug,
      });
      continue;
    }
    const emitKind: "decision" | "constraint" =
      cls.kind === "constraint" ? "constraint" : "decision";
    if (existing !== undefined) {
      // Slug already in topic-index but not yet emitted (e.g. phase 5b
      // walked it as some other kind). Keep the existing entry, just
      // remember the emit kind so the classifier callback below maps
      // the entry to the right phase-7b verdict.
      emitKindBySlug.set(slug, emitKind);
      resolutionByBlockId.set(block.id, { kind: "emit", slug, emitKind });
      continue;
    }
    // Novel topic — register a fresh source-comment entry.
    const lineRange: [number, number] = [block.startLine, block.endLine];
    const newEntry: TopicIndexEntry = {
      slug,
      sot_source: block.file,
      candidates: [
        {
          file: block.file,
          kind: "source-comment",
          line_range: lineRange,
        },
      ],
      created_at: nowIso,
    };
    topicIndex = setTopic(topicIndex, slug, newEntry);
    anchorMap = setAnchor(anchorMap, slug, {
      file: block.file,
      content_hash: bodyContentHash(block.prose),
      line_range: lineRange,
      kind: "source-comment",
    });
    emitKindBySlug.set(slug, emitKind);
    resolutionByBlockId.set(block.id, { kind: "emit", slug, emitKind });
  }

  // ── 4. Emit (sot-emit, sot_kind=ledger) ──────────────────────────
  const emit = await emitFromTopicIndex({
    repoRoot,
    topicIndex,
    anchorMap,
    filter: (entry) =>
      entry.dec_id === undefined &&
      isSourceCommentEntry(entry) &&
      emitKindBySlug.has(entry.slug),
    classifier: async ({ entry }): Promise<EmitClassification> => {
      const k = emitKindBySlug.get(entry.slug);
      if (k === undefined) return { kind: "skip", title: "" };
      return { kind: k === "constraint" ? "constraint" : "decision", title: "" };
    },
    sot_kind: "ledger",
    capture_source: CAPTURE_SOURCE,
    idDeriver: ({ entry, kind }) => {
      const sot = entry.candidates.find((c) => c.file === entry.sot_source);
      const range = sot?.line_range;
      const offset = range !== undefined ? range[0] : 0;
      const inputs = {
        source_file: entry.sot_source,
        source_offset: offset,
        capture_source: CAPTURE_SOURCE,
      };
      return kind === "constraint"
        ? deriveLedgerInvId(inputs)
        : deriveLedgerDecId(inputs);
    },
  });

  topicIndex = emit.topicIndex;
  if (args.dryRun !== true) {
    persistGroundState({
      repoRoot,
      topicIndex,
      anchorMap,
      bindings: emit.bindings,
      cache: emit.cache,
    });
  }

  // ── 5. Build emit / cite records keyed by slug ──────────────────
  const decsWritten: IngestEmittedRecord[] = [];
  const invsWritten: IngestEmittedRecord[] = [];
  const emittedIdBySlug = new Map<string, string>();
  for (const rec of emit.emitted) {
    emittedIdBySlug.set(rec.slug, rec.id);
    const target: IngestEmittedRecord = {
      id: rec.id,
      path:
        rec.kind === "DEC"
          ? `.cairn/ground/decisions/${rec.id}.md`
          : `.cairn/ground/invariants/${rec.id}.md`,
      sourceFile: rec.source_file,
      slug: rec.slug,
      status: "accepted",
    };
    if (rec.kind === "DEC") decsWritten.push(target);
    else invsWritten.push(target);
  }
  for (const sk of emit.skipped) {
    skipped.push({ blockId: `slug:${sk.slug}`, reason: sk.reason });
  }

  // ── 6. Strip-replace ─────────────────────────────────────────────
  const citesEmitted: IngestCiteRecord[] = [];
  const stripItems: ReplaceItem[] = [];
  for (let i = 0; i < walk.blocks.length; i += 1) {
    const block = walk.blocks[i];
    if (block === undefined) continue;
    const resolution = resolutionByBlockId.get(block.id);
    if (resolution === undefined) continue;
    const targetId =
      resolution.kind === "cite"
        ? resolution.existingId
        : emittedIdBySlug.get(resolution.slug);
    if (targetId === undefined) {
      skipped.push({
        blockId: block.id,
        reason: `emit produced no id for slug ${resolution.slug}`,
      });
      continue;
    }
    if (resolution.kind === "cite") {
      citesEmitted.push({
        id: targetId,
        sourceFile: block.file,
        lineRange: [block.startLine, block.endLine],
        slug: resolution.slug,
      });
    }
    stripItems.push({
      blockId: block.id,
      file: block.file,
      startOffset: block.startOffset,
      endOffset: block.endOffset,
      replacement: formatBareCitation(block.lang, targetId),
      expectedRaw: block.raw,
    });
  }

  let stripFilesModified = 0;
  let stripItemsApplied = 0;
  let stripItemsSkipped = 0;
  let stripOutcomes: StripOutcomePersisted[] = [];
  let stripError: string | null = null;
  if (args.dryRun !== true && stripItems.length > 0) {
    log.info(
      {
        items: stripItems.length,
        files: [...new Set(stripItems.map((it) => it.file))],
      },
      "strip-replace: starting",
    );
    try {
      const dirtyDecisions: Record<string, "overwrite"> = {};
      for (const item of stripItems) dirtyDecisions[item.file] = "overwrite";
      const result = applyStripReplace({
        repoRoot,
        items: stripItems,
        dirtyDecisions,
      });
      stripFilesModified = result.filesModified;
      stripItemsApplied = result.itemsApplied;
      stripItemsSkipped = result.itemsSkipped;
      stripOutcomes = result.files.map((o) => ({
        file: o.file,
        applied: o.itemsApplied,
        skipped: o.itemsSkipped.map((s) => ({
          blockId: s.blockId,
          reason: s.reason,
        })),
        fileSkipReason: o.fileSkipReason ?? null,
      }));
      log.info(
        {
          filesModified: result.filesModified,
          itemsApplied: result.itemsApplied,
          itemsSkipped: result.itemsSkipped,
        },
        "strip-replace: complete",
      );
      try {
        updateScopeIndexFromStripItems(repoRoot, stripItems);
      } catch (err) {
        log.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "scope-index update from strip items failed",
        );
      }
    } catch (err) {
      stripError = err instanceof Error ? err.message : String(err);
      log.warn({ err: stripError }, "strip-replace failed");
    }
  } else if (stripItems.length === 0) {
    log.info("strip-replace: no items (no rationale/constraint blocks classified)");
  }

  // ── 7. Ledger rebuilds ───────────────────────────────────────────
  if (args.dryRun !== true) {
    if (invsWritten.length > 0) {
      try {
        writeInvariantsLedger({ repoRoot });
      } catch (err) {
        log.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "invariants ledger rebuild failed",
        );
      }
    }
    if (decsWritten.length > 0) {
      try {
        writeDecisionsLedger({ repoRoot });
      } catch (err) {
        log.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "decisions ledger rebuild failed",
        );
      }
    }
  }

  // ── 8. Audit yaml ───────────────────────────────────────────────
  const auditRelPath = `.cairn/baseline/source-comments-${tsSlug}.yaml`;
  const auditPath = join(repoRoot, auditRelPath);
  if (args.dryRun !== true) {
    writeYaml(auditPath, {
      run_at: nowIso,
      files_scanned: walk.files.length,
      files_available: walk.filesAvailable,
      ...(walk.truncatedAtFileCap ? { truncated_at_file_cap: true } : {}),
      blocks_detected: walk.blocks.length,
      bytes_scanned: walk.bytesScanned,
      file_count_by_lang: walk.fileCountByLang,
      kind_counts: kindCounts,
      batches_run: classifyResult.batchesRun,
      batches_failed: classifyResult.batchesFailed,
      input_tokens: classifyResult.inputTokens,
      output_tokens: classifyResult.outputTokens,
      decs_written: decsWritten.length,
      invs_written: invsWritten.length,
      cites_emitted: citesEmitted.length,
      blocks: walk.blocks.map((b, idx) => ({
        block_id: b.id,
        file: b.file,
        lang: b.lang,
        kind: b.kind,
        start_line: b.startLine,
        end_line: b.endLine,
        line_count: b.lineCount,
        char_count: b.charCount,
        word_count: b.wordCount,
        start_offset: b.startOffset,
        end_offset: b.endOffset,
        raw: b.raw,
        disposition: dispositions[idx]?.kind ?? null,
        classification: classifications[idx] ?? null,
        resolution: serializeResolution(resolutionByBlockId.get(b.id)),
      })),
    });
  }

  log.info(
    {
      files: walk.files.length,
      blocks: walk.blocks.length,
      kindCounts,
      decs: decsWritten.length,
      invs: invsWritten.length,
      cites: citesEmitted.length,
      stripApplied: stripItemsApplied,
      stripSkipped: stripItemsSkipped,
      inputTokens: classifyResult.inputTokens,
      outputTokens: classifyResult.outputTokens,
    },
    "source-comments ingestion complete",
  );

  return {
    walk,
    classifications,
    decsWritten,
    invsWritten,
    citesEmitted,
    skipped,
    stripFilesModified,
    stripItemsApplied,
    stripItemsSkipped,
    stripOutcomes,
    stripError,
    auditPath,
    auditRelPath,
    inputTokens: classifyResult.inputTokens,
    outputTokens: classifyResult.outputTokens,
    batchesRun: classifyResult.batchesRun,
    batchesFailed: classifyResult.batchesFailed,
    kindCounts,
  };
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function isSourceCommentEntry(entry: TopicIndexEntry): boolean {
  const sot = entry.candidates.find((c) => c.file === entry.sot_source);
  return sot?.kind === "source-comment";
}

function serializeResolution(
  resolution:
    | { kind: "cite"; existingId: string; slug: string }
    | { kind: "emit"; slug: string; emitKind: "decision" | "constraint" }
    | undefined,
): Record<string, unknown> | null {
  if (resolution === undefined) return null;
  if (resolution.kind === "cite") {
    return { kind: "cite", existing_id: resolution.existingId, slug: resolution.slug };
  }
  return { kind: "emit", slug: resolution.slug, emit_kind: resolution.emitKind };
}

interface PersistGroundStateArgs {
  repoRoot: string;
  topicIndex: TopicIndex;
  anchorMap: AnchorMap;
  bindings: SotBindings;
  cache: SotCache;
}

function persistGroundState(args: PersistGroundStateArgs): void {
  const { repoRoot } = args;
  // Re-read each file right before write so we merge with any other phase
  // that committed concurrently. parallel-678 still uses Promise.allSettled
  // across phases 6/7b/7c; sequential individual phase tools are race-free.
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

/**
 * After the strip-replace pass inserts cites into source files, fold those
 * IDs into `.cairn/ground/scope-index.yaml`. Phase 3 mapper that originally
 * seeded scope-index ran before any DECs/INVs existed, so its `decisions:
 * []` / `invariants: []` arrays for these files were correctly empty. Now
 * that the cite tokens are landed, the read-enricher's "in scope" headers
 * should reflect them.
 */
function updateScopeIndexFromStripItems(
  repoRoot: string,
  items: ReplaceItem[],
): void {
  if (items.length === 0) return;
  const decsByFile = new Map<string, Set<string>>();
  const invsByFile = new Map<string, Set<string>>();
  const decMatch = /§(DEC-[0-9a-f]{7,})/;
  const invMatch = /§(INV-[0-9a-f]{7,})/;
  for (const item of items) {
    const decM = item.replacement.match(decMatch);
    const invM = item.replacement.match(invMatch);
    if (decM !== null) {
      const id = decM[1];
      if (id !== undefined) {
        let set = decsByFile.get(item.file);
        if (set === undefined) {
          set = new Set<string>();
          decsByFile.set(item.file, set);
        }
        set.add(id);
      }
    }
    if (invM !== null) {
      const id = invM[1];
      if (id !== undefined) {
        let set = invsByFile.get(item.file);
        if (set === undefined) {
          set = new Set<string>();
          invsByFile.set(item.file, set);
        }
        set.add(id);
      }
    }
  }
  if (decsByFile.size === 0 && invsByFile.size === 0) return;

  const existing = readScopeIndex(repoRoot) ?? {
    generated: new Date().toISOString(),
    files: {},
  };
  const allFiles = new Set<string>([...decsByFile.keys(), ...invsByFile.keys()]);
  for (const file of allFiles) {
    const prior = existing.files[file];
    const mergedDecs = coerceDecisionIds([
      ...(prior?.decisions ?? []),
      ...(decsByFile.get(file) ?? []),
    ]);
    const mergedInvs = coerceInvariantIds([
      ...(prior?.invariants ?? []),
      ...(invsByFile.get(file) ?? []),
    ]);
    const next: ScopeIndexEntry = {
      decisions: mergedDecs,
      invariants: mergedInvs,
    };
    if (prior?.unscoped === true) next.unscoped = true;
    existing.files[file] = next;
  }
  const updated: ScopeIndex = {
    generated: new Date().toISOString(),
    files: existing.files,
  };
  writeScopeIndex(repoRoot, updated);
  log.info(
    {
      files: allFiles.size,
      decs: Array.from(decsByFile.values()).reduce((acc, s) => acc + s.size, 0),
      invs: Array.from(invsByFile.values()).reduce((acc, s) => acc + s.size, 0),
    },
    "scope-index updated with cite tokens from strip-replace",
  );
}

function writeYaml(path: string, payload: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, stringifyYaml(payload), "utf8");
}
