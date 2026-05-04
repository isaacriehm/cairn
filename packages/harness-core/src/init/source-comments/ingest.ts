/**
 * Phase 7b orchestrator — walker → classifier → persist.
 *
 * Output:
 *   - DEC drafts (one per "rationale" classification with non-empty title)
 *     written to `.harness/ground/decisions/_inbox/<id>.draft.md`
 *   - Invariant proposals appended to
 *     `.harness/baseline/invariant-proposals-<ISO>.yaml`
 *   - Canonical-map citations appended to
 *     `.harness/baseline/canonical-citations-<ISO>.yaml`
 *   - Full audit (every block + classification) at
 *     `.harness/baseline/source-comments-<ISO>.yaml` — consumed by the
 *     strip-replace stage so it doesn't have to re-walk.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import {
  allocateDecisionId,
  scanExistingDecisionIds,
} from "../../decision-capture/id.js";
import { decisionsDir } from "../../ground/paths.js";
import { logger } from "../../logger.js";
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
}

export interface IngestSourceCommentsResult {
  walk: WalkResult;
  classifications: CommentClassification[];
  decDraftsWritten: { id: string; path: string; sourceFile: string }[];
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
  const invariantProposals: InvariantProposal[] = [];
  const canonicalCitations: CanonicalCitation[] = [];

  const existingIds = scanExistingDecisionIds(repoRoot);

  for (let i = 0; i < walk.blocks.length; i++) {
    const block = walk.blocks[i];
    const cls = classifyResult.classifications[i];
    if (block === undefined || cls === undefined) continue;

    if (cls.kind === "rationale" && cls.suggestedDecDraft.length > 0) {
      const id = allocateDecisionId(repoRoot, existingIds);
      existingIds.add(id);
      if (args.dryRun !== true) {
        const written = writeDecDraft({
          repoRoot,
          id,
          block,
          classification: cls,
          generatedAt: nowIso,
        });
        decDraftsWritten.push({
          id,
          path: written.relPath,
          sourceFile: block.file,
        });
      } else {
        decDraftsWritten.push({
          id,
          path: `.harness/ground/decisions/_inbox/${id}.draft.md`,
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

  const auditRelPath = `.harness/baseline/source-comments-${tsSlug}.yaml`;
  const auditPath = join(repoRoot, auditRelPath);
  let invariantProposalsPath: string | null = null;
  let canonicalCitationsPath: string | null = null;

  if (args.dryRun !== true) {
    writeYaml(auditPath, {
      run_at: nowIso,
      files_scanned: walk.files.length,
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
        classification: classifyResult.classifications[idx] ?? null,
      })),
    });
    if (invariantProposals.length > 0) {
      const rel = `.harness/baseline/invariant-proposals-${tsSlug}.yaml`;
      invariantProposalsPath = join(repoRoot, rel);
      writeYaml(invariantProposalsPath, {
        run_at: nowIso,
        proposals: invariantProposals,
      });
    }
    if (canonicalCitations.length > 0) {
      const rel = `.harness/baseline/canonical-citations-${tsSlug}.yaml`;
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

  return {
    walk,
    classifications: classifyResult.classifications,
    decDraftsWritten,
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
}

function writeDecDraft(args: WriteDecDraftArgs): { absPath: string; relPath: string } {
  const dir = decisionsDir(args.repoRoot);
  const inboxDir = join(dir, "_inbox");
  mkdirSync(inboxDir, { recursive: true });
  const filename = `${args.id}.draft.md`;
  const abs = join(inboxDir, filename);
  const rel = `.harness/ground/decisions/_inbox/${filename}`;
  const fm: Record<string, unknown> = {
    id: args.id,
    title: args.classification.suggestedDecDraft || `(untitled — from ${args.block.file})`,
    type: "adr",
    status: "draft-from-source-comment",
    audience: "dual",
    generated: args.generatedAt,
    "verified-at": args.generatedAt,
    decided_at: args.generatedAt,
    decided_by: "harness-init",
    capture_source: "init-source-comments",
    capture_confidence: "medium",
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

function writeYaml(path: string, payload: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, stringifyYaml(payload), "utf8");
}
