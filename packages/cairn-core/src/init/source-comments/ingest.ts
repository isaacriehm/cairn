/**
 * Phase 7b orchestrator — walker → classifier → persist.
 *
 * Output:
 *   - DEC drafts (one per "rationale" classification with non-empty title)
 *     written to `.cairn/ground/decisions/_inbox/<id>.draft.md`
 *   - Invariant files (one per "constraint" classification with non-empty
 *     suggestedInvariant) written directly to
 *     `.cairn/ground/invariants/INV-<NNNN>.md` with `status: active`. Auto-
 *     promote — the operator can edit / supersede via cairn-attention or
 *     direct edit. Invariants don't go through an `_inbox/` review queue
 *     because the classifier emits hard rules, not policy decisions.
 *   - Canonical-map citations appended to
 *     `.cairn/baseline/canonical-citations-<ISO>.yaml`
 *   - Full audit (every block + classification) at
 *     `.cairn/baseline/source-comments-<ISO>.yaml` — consumed by the
 *     strip-replace stage so it doesn't have to re-walk.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import {
  computeDecisionId,
  computeInvariantId,
  scanExistingDecisionIds,
  scanExistingInvariantIds,
} from "../../decision-capture/id.js";
import { writeInvariantsLedger } from "../../ground/ledgers.js";
import { decisionsDir, invariantsDir } from "../../ground/paths.js";
import {
  coerceInvariantIds,
  readScopeIndex,
  writeScopeIndex,
  type ScopeIndex,
  type ScopeIndexEntry,
} from "../../ground/scope-index.js";
import { logger } from "../../logger.js";
import {
  scoreDecDraft,
  scoreInvariant,
  type DraftConfidence,
} from "../../attention/scoring.js";
import type { ProjectGlobs } from "../../sensors/types.js";
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
   * Project globs from `.cairn/config.yaml` (or the mapper output). When
   * provided, every DEC draft + invariant gets `capture_confidence` scored
   * and stamped at write time so `cairn attention bulk-accept` becomes an
   * O(1) file move instead of re-scoring every draft on disk.
   */
  globs?: ProjectGlobs;
  /** Pilot module path (workflow.md `pilot_module`) for scoring bias. */
  pilotModule?: string;
  /**
   * Caller-supplied DEC id Set, threaded by the parallel orchestrator
   * across phases 6 / 7b / 7c so concurrent allocations don't collide.
   */
  existingDecIds?: Set<string>;
  /**
   * Caller-supplied INV id Set. Only 7b allocates invariant ids today,
   * but the optional arg matches the DEC pattern for symmetry and lets
   * future phases share the allocator.
   */
  existingInvIds?: Set<string>;
}

export interface IngestSourceCommentsResult {
  walk: WalkResult;
  classifications: CommentClassification[];
  decDraftsWritten: { id: string; path: string; sourceFile: string }[];
  /**
   * INV-<NNNN>.md files written directly to `.cairn/ground/invariants/`
   * with `status: active`. The cairn-adopt summary surfaces the count.
   */
  invariantsWritten: { id: string; path: string; sourceFile: string }[];
  /** Files where the source comment was successfully replaced with `// §INV-NNNN`. */
  invariantStripFilesModified: number;
  /** Number of strip items that landed (one per invariant comment). */
  invariantStripItemsApplied: number;
  /** Number of strip items that skipped (range-mismatch, dirty, missing, etc.). */
  invariantStripItemsSkipped: number;
  /** Per-file strip outcomes — debug surface for "wrote ground state but not source". */
  invariantStripOutcomes: {
    file: string;
    applied: number;
    skipped: { blockId: string; reason: string }[];
    fileSkipReason: string | null;
  }[];
  /** Set when applyStripReplace threw — null on the happy path. */
  invariantStripError: string | null;
  /**
   * Count of "constraint" classifications regardless of whether they
   * produced a non-empty suggestedInvariant. Always equals
   * invariantsWritten.length when no proposals had empty bodies.
   */
  invariantProposalsAdded: number;
  canonicalCitationsAdded: number;
  auditPath: string;
  auditRelPath: string;
  invariantProposalsPath: string | null;
  canonicalCitationsPath: string | null;
  inputTokens: number;
  outputTokens: number;
  batchesRun: number;
  batchesFailed: number;
  /** Distribution by classifier kind. */
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

  const walkOpts: WalkOptions = { repoRoot };
  if (args.walkOptions?.fileCap !== undefined) {
    walkOpts.fileCap = args.walkOptions.fileCap;
  }
  if (args.walkOptions?.onlyFiles !== undefined) {
    walkOpts.onlyFiles = args.walkOptions.onlyFiles;
  }
  const walk = walkSourceComments(walkOpts);

  const classifyResult = await classifyBlocks({
    blocks: walk.blocks,
    repoRoot,
    ...(args.mockClassify !== undefined ? { mockClassify: args.mockClassify } : {}),
    ...(args.onBatchProgress !== undefined
      ? { onBatchProgress: args.onBatchProgress }
      : {}),
  });

  const kindCounts: Record<CommentClassKind, number> = {
    rationale: 0,
    constraint: 0,
    citation: 0,
    license: 0,
    other: 0,
  };
  for (const c of classifyResult.classifications) {
    if (c === undefined) continue;
    kindCounts[c.kind] = (kindCounts[c.kind] ?? 0) + 1;
  }

  const decDraftsWritten: { id: string; path: string; sourceFile: string }[] = [];
  const invariantsWritten: { id: string; path: string; sourceFile: string }[] = [];
  const invariantProposals: InvariantProposal[] = [];
  const canonicalCitations: CanonicalCitation[] = [];
  // Strip-replace items collected during the classification loop —
  // applied in one batch at the end so a single dirty-check round
  // covers all files. Each item points at the original constraint
  // comment block; replacement is `// §INV-NNNN`.
  const invariantStripItems: ReplaceItem[] = [];

  const existingIds = args.existingDecIds ?? scanExistingDecisionIds(repoRoot);
  const existingInvariantIds =
    args.existingInvIds ?? scanExistingInvariantIds(repoRoot);

  for (let i = 0; i < walk.blocks.length; i++) {
    const block = walk.blocks[i];
    const cls = classifyResult.classifications[i];
    if (block === undefined || cls === undefined) continue;

    if (cls.kind === "rationale" && cls.suggestedDecDraft.length > 0) {
      const id = computeDecisionId(
        {
          title: cls.suggestedDecDraft,
          rationale: block.prose,
          capture_source: "init-source-comments",
          source_file: block.file,
          source_offset: block.startLine,
          raw: block.raw,
        },
        existingIds,
      );
      existingIds.add(id);
      const confidence: DraftConfidence | undefined =
        args.globs !== undefined
          ? scoreDecDraft({
              sourceFile: block.file,
              prose: block.prose,
              title: cls.suggestedDecDraft,
              rawComment: block.raw,
              globs: args.globs,
              ...(args.pilotModule !== undefined ? { pilotModule: args.pilotModule } : {}),
            })
          : undefined;
      if (args.dryRun !== true) {
        const written = writeDecDraft({
          repoRoot,
          id,
          block,
          classification: cls,
          generatedAt: nowIso,
          ...(confidence !== undefined ? { confidence } : {}),
        });
        decDraftsWritten.push({
          id,
          path: written.relPath,
          sourceFile: block.file,
        });
      } else {
        decDraftsWritten.push({
          id,
          path: `.cairn/ground/decisions/_inbox/${id}.draft.md`,
          sourceFile: block.file,
        });
      }
    }

    if (cls.kind === "constraint" && cls.suggestedInvariant.length > 0) {
      invariantProposals.push({
        block_id: block.id,
        source_file: block.file,
        start_line: block.startLine,
        end_line: block.endLine,
        proposed: cls.suggestedInvariant,
        canonical_topic: cls.suggestedCanonicalTopic,
      });
      const invId = computeInvariantId(
        {
          title: cls.suggestedInvariant,
          source_file: block.file,
          source_offset: block.startLine,
          raw: block.raw,
        },
        existingInvariantIds,
      );
      existingInvariantIds.add(invId);
      const invConfidence: DraftConfidence | undefined =
        args.globs !== undefined
          ? scoreInvariant({
              sourceFile: block.file,
              prose: cls.suggestedInvariant,
              title: cls.suggestedInvariant.split("\n")[0] ?? "",
              rawComment: block.raw,
              globs: args.globs,
              ...(args.pilotModule !== undefined ? { pilotModule: args.pilotModule } : {}),
            })
          : undefined;
      if (args.dryRun !== true) {
        const written = writeInvariantFile({
          repoRoot,
          id: invId,
          block,
          classification: cls,
          generatedAt: nowIso,
          ...(invConfidence !== undefined ? { confidence: invConfidence } : {}),
        });
        invariantsWritten.push({
          id: invId,
          path: written.relPath,
          sourceFile: block.file,
        });
      } else {
        invariantsWritten.push({
          id: invId,
          path: `.cairn/ground/invariants/${invId}.md`,
          sourceFile: block.file,
        });
      }
      // Stage strip-replace for the source comment so the file ends
      // up carrying `// §INV-NNNN` (or `# §INV-NNNN` in hash-comment
      // languages) instead of the original essay block. Run after
      // the loop so all items go through one applyStripReplace pass.
      invariantStripItems.push({
        blockId: block.id,
        file: block.file,
        startOffset: block.startOffset,
        endOffset: block.endOffset,
        replacement: formatBareCitation(block.lang, invId),
        expectedRaw: block.raw,
      });
    }

    if (cls.kind === "citation" && cls.suggestedCanonicalTopic.length > 0) {
      canonicalCitations.push({
        block_id: block.id,
        source_file: block.file,
        start_line: block.startLine,
        end_line: block.endLine,
        topic: cls.suggestedCanonicalTopic,
        excerpt: block.prose.slice(0, 240),
      });
    }
  }

  const auditRelPath = `.cairn/baseline/source-comments-${tsSlug}.yaml`;
  const auditPath = join(repoRoot, auditRelPath);
  let invariantProposalsPath: string | null = null;
  let canonicalCitationsPath: string | null = null;

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
        classification: classifyResult.classifications[idx] ?? null,
      })),
    });
    if (invariantProposals.length > 0) {
      const rel = `.cairn/baseline/invariant-proposals-${tsSlug}.yaml`;
      invariantProposalsPath = join(repoRoot, rel);
      writeYaml(invariantProposalsPath, {
        run_at: nowIso,
        proposals: invariantProposals,
      });
    }
    if (canonicalCitations.length > 0) {
      const rel = `.cairn/baseline/canonical-citations-${tsSlug}.yaml`;
      canonicalCitationsPath = join(repoRoot, rel);
      writeYaml(canonicalCitationsPath, {
        run_at: nowIso,
        citations: canonicalCitations,
      });
    }
  }

  log.info(
    {
      files: walk.files.length,
      blocks: walk.blocks.length,
      kindCounts,
      decDrafts: decDraftsWritten.length,
      invariantProposals: invariantProposals.length,
      canonicalCitations: canonicalCitations.length,
      inputTokens: classifyResult.inputTokens,
      outputTokens: classifyResult.outputTokens,
    },
    "source-comments ingestion complete",
  );

  // Rebuild the invariants ledger after writing new INV-<NNNN>.md files so
  // that §INV-NNNN tokens are resolvable before the strip-replace stage writes
  // bare citations into source. Lens + MCP read tools resolve through the
  // ledger, not by re-walking the dir.
  if (args.dryRun !== true && invariantsWritten.length > 0) {
    try {
      writeInvariantsLedger({ repoRoot });
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "invariants ledger rebuild failed",
      );
    }
  }

  // Strip the original constraint comment from each source file and
  // replace with a bare `// §INV-NNNN` cite. Adoption assumes a clean
  // working tree (init phase 1's preflight); pass `overwrite` for
  // every file so dirty-skip doesn't bite us — the operator
  // consented to source mutation when they consented to adoption.
  let invariantStripFilesModified = 0;
  let invariantStripItemsApplied = 0;
  let invariantStripItemsSkipped = 0;
  let invariantStripOutcomes: {
    file: string;
    applied: number;
    skipped: { blockId: string; reason: string }[];
    fileSkipReason: string | null;
  }[] = [];
  let invariantStripError: string | null = null;
  if (args.dryRun !== true && invariantStripItems.length > 0) {
    log.info(
      {
        items: invariantStripItems.length,
        files: [...new Set(invariantStripItems.map((it) => it.file))],
      },
      "invariant strip-replace: starting",
    );
    try {
      const dirtyDecisions: Record<string, "overwrite"> = {};
      for (const item of invariantStripItems) dirtyDecisions[item.file] = "overwrite";
      const result = applyStripReplace({
        repoRoot,
        items: invariantStripItems,
        dirtyDecisions,
      });
      invariantStripFilesModified = result.filesModified;
      invariantStripItemsApplied = result.itemsApplied;
      invariantStripItemsSkipped = result.itemsSkipped;
      invariantStripOutcomes = result.files.map((o) => ({
        file: o.file,
        applied: o.itemsApplied,
        skipped: o.itemsSkipped.map((s) => ({ blockId: s.blockId, reason: s.reason })),
        fileSkipReason: o.fileSkipReason ?? null,
      }));
      log.info(
        {
          filesModified: result.filesModified,
          itemsApplied: result.itemsApplied,
          itemsSkipped: result.itemsSkipped,
          outcomes: invariantStripOutcomes,
        },
        "invariant strip-replace: complete",
      );
      // Now that we know which §INV-NNNN landed in which file, populate
      // the scope-index for those files. Phase 3 mapper ran before any
      // invariants existed, so its scope_index entries for these files
      // had empty `invariants: []` arrays. Without this update the
      // read-enricher legend's "Invariants in scope" header stays blank
      // even though the source carries the cite tokens.
      try {
        updateScopeIndexFromStripItems(repoRoot, invariantStripItems);
      } catch (err) {
        log.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "scope-index update from strip items failed",
        );
      }
    } catch (err) {
      invariantStripError = err instanceof Error ? err.message : String(err);
      log.warn(
        { err: invariantStripError },
        "invariant strip-replace failed",
      );
    }
  } else if (invariantStripItems.length === 0) {
    log.info("invariant strip-replace: no items (no constraint blocks classified)");
  }

  return {
    walk,
    classifications: classifyResult.classifications,
    decDraftsWritten,
    invariantsWritten,
    invariantStripFilesModified,
    invariantStripItemsApplied,
    invariantStripItemsSkipped,
    invariantStripOutcomes,
    invariantStripError,
    invariantProposalsAdded: invariantProposals.length,
    canonicalCitationsAdded: canonicalCitations.length,
    auditPath,
    auditRelPath,
    invariantProposalsPath,
    canonicalCitationsPath,
    inputTokens: classifyResult.inputTokens,
    outputTokens: classifyResult.outputTokens,
    batchesRun: classifyResult.batchesRun,
    batchesFailed: classifyResult.batchesFailed,
    kindCounts,
  };
}

/* -------------------------------------------------------------------------- */
/* Scope-index post-population                                                */
/* -------------------------------------------------------------------------- */

/**
 * After the strip-replace pass inserts `// §INV-NNNN` cites into source
 * files, fold those IDs into `.cairn/ground/scope-index.yaml`. The Phase
 * 3 mapper that originally seeded scope-index ran before any invariants
 * existed, so its `invariants: []` arrays for these files were correctly
 * empty. Now that the cite tokens are landed, the read-enricher's
 * "Invariants in scope" header should reflect them.
 *
 * Each file's existing invariants array gets unioned with the new IDs,
 * de-duplicated, and re-coerced (defense-in-depth). Files absent from
 * the scope-index get a fresh entry. Decisions arrays are left
 * untouched — DEC strips happen at accept-time via cairn-attention,
 * not in this Phase 7b bulk pass.
 */
function updateScopeIndexFromStripItems(
  repoRoot: string,
  items: ReplaceItem[],
): void {
  if (items.length === 0) return;
  const idsByFile = new Map<string, Set<string>>();
  const idMatch = /§(INV-[0-9a-f]{7,})/;
  for (const item of items) {
    const m = item.replacement.match(idMatch);
    if (m === null) continue;
    const id = m[1];
    if (id === undefined) continue;
    let set = idsByFile.get(item.file);
    if (set === undefined) {
      set = new Set<string>();
      idsByFile.set(item.file, set);
    }
    set.add(id);
  }
  if (idsByFile.size === 0) return;

  const existing = readScopeIndex(repoRoot) ?? {
    generated: new Date().toISOString(),
    files: {},
  };
  for (const [file, ids] of idsByFile) {
    const prior = existing.files[file];
    const merged = coerceInvariantIds([
      ...(prior?.invariants ?? []),
      ...ids,
    ]);
    const next: ScopeIndexEntry = {
      decisions: prior?.decisions ?? [],
      invariants: merged,
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
    { files: idsByFile.size },
    "scope-index updated with §INV cite tokens from strip-replace",
  );
}

/* -------------------------------------------------------------------------- */
/* Persisters                                                                 */
/* -------------------------------------------------------------------------- */

interface InvariantProposal {
  block_id: string;
  source_file: string;
  start_line: number;
  end_line: number;
  proposed: string;
  canonical_topic: string;
}

interface CanonicalCitation {
  block_id: string;
  source_file: string;
  start_line: number;
  end_line: number;
  topic: string;
  excerpt: string;
}

interface WriteDecDraftArgs {
  repoRoot: string;
  id: string;
  block: CommentBlock;
  classification: CommentClassification;
  generatedAt: string;
  /** Pre-computed write-time confidence; defaults to "medium" when absent. */
  confidence?: DraftConfidence;
}

function writeDecDraft(args: WriteDecDraftArgs): { absPath: string; relPath: string } {
  const dir = decisionsDir(args.repoRoot);
  const inboxDir = join(dir, "_inbox");
  mkdirSync(inboxDir, { recursive: true });
  const filename = `${args.id}.draft.md`;
  const abs = join(inboxDir, filename);
  const rel = `.cairn/ground/decisions/_inbox/${filename}`;
  const fm: Record<string, unknown> = {
    id: args.id,
    title: args.classification.suggestedDecDraft || `(untitled — from ${args.block.file})`,
    type: "adr",
    status: "draft-from-source-comment",
    audience: "dual",
    generated: args.generatedAt,
    "verified-at": args.generatedAt,
    decided_at: args.generatedAt,
    decided_by: "cairn-init",
    capture_source: "init-source-comments",
    capture_confidence: args.confidence ?? "medium",
    sourceFile: args.block.file,
    sourceRange: `${args.block.startLine}-${args.block.endLine}`,
    blockId: args.block.id,
    canonicalTopic: args.classification.suggestedCanonicalTopic,
  };
  const lines: string[] = [];
  lines.push("---");
  lines.push(stringifyYaml(fm).trimEnd());
  lines.push("---");
  lines.push("");
  lines.push(`# ${args.id} — ${fm["title"] as string}`);
  lines.push("");
  lines.push("## Source comment");
  lines.push("");
  lines.push("```");
  lines.push(args.block.raw);
  lines.push("```");
  lines.push("");
  lines.push("## Proposed rationale");
  lines.push("");
  lines.push(args.block.prose);
  lines.push("");
  writeFileSync(abs, lines.join("\n"), "utf8");
  return { absPath: abs, relPath: rel };
}

interface WriteInvariantArgs {
  repoRoot: string;
  id: string;
  block: CommentBlock;
  classification: CommentClassification;
  generatedAt: string;
  /** Pre-computed write-time confidence; defaults to "medium" when absent. */
  confidence?: DraftConfidence;
}

function writeInvariantFile(
  args: WriteInvariantArgs,
): { absPath: string; relPath: string } {
  const dir = invariantsDir(args.repoRoot);
  mkdirSync(dir, { recursive: true });
  const filename = `${args.id}.md`;
  const abs = join(dir, filename);
  const rel = `.cairn/ground/invariants/${filename}`;
  const fm: Record<string, unknown> = {
    id: args.id,
    title: args.classification.suggestedInvariant.split("\n")[0]?.slice(0, 120) ?? args.id,
    type: "invariant",
    status: "active",
    audience: "dual",
    generated: args.generatedAt,
    "verified-at": args.generatedAt,
    capture_confidence: args.confidence ?? "medium",
    source_decision: null,
    sourceFile: args.block.file,
    sourceRange: `${args.block.startLine}-${args.block.endLine}`,
    blockId: args.block.id,
    canonicalTopic: args.classification.suggestedCanonicalTopic,
  };
  const lines: string[] = [];
  lines.push("---");
  lines.push(stringifyYaml(fm).trimEnd());
  lines.push("---");
  lines.push("");
  lines.push(`# §${args.id} — ${fm["title"] as string}`);
  lines.push("");
  lines.push("## Constraint");
  lines.push("");
  lines.push(args.classification.suggestedInvariant.trim());
  lines.push("");
  lines.push("## Source comment");
  lines.push("");
  lines.push("```");
  lines.push(args.block.raw);
  lines.push("```");
  lines.push("");
  writeFileSync(abs, lines.join("\n"), "utf8");
  return { absPath: abs, relPath: rel };
}

function writeYaml(path: string, payload: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, stringifyYaml(payload), "utf8");
}
