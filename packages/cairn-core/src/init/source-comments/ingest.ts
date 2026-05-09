/**
 * Phase 7b orchestrator (v0.5.0 SoT model) — walker → classifier →
 * topic-index lookup → emit-or-cite → strip-replace.
 *
 * Plan §5.3 algorithm:
 *   1. Walk source files for prose-bearing comments (existing logic).
 *   2. Topic-index lookup (built by phase 5b) before classification:
 *      - If block body matches a topic-index entry verbatim (hash) → resolution="cite".
 *      - Else → resolution="classify".
 *   3. Resolution="classify":
 *      - Haiku classify block kind (rationale | constraint | citation | license | other).
 *      - kind="rationale" → resolution="emit-decision".
 *      - kind="constraint" → resolution="emit-invariant".
 *      - kind in {citation, license, other} → resolution="skip".
 *   4. Final write:
 *      - resolution="cite" → append `// §DEC-NNNN` to original source (strip-replace).
 *      - resolution="emit" → write new ground file + append cite to original source.
 *
 * Side-effects: writes to ground state, writes `source-comments-<ISO>.yaml`
 * audit file, emits invalidation events.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import {
  anchorMapPath,
  bodyContentHash,
  decisionsDir,
  deriveDecId,
  readAnchorMap,
  readRejectedYaml,
  readTopicIndex,
  setTopic,
  walkFs,
  writeFileCandidatesMap,
  writeTopicIndex,
  type AnchorMap,
  type TopicIndex,
  type TopicIndexEntry,
} from "@isaacriehm/cairn-state";
import {
  writeDecisionsLedger,
  writeInvariantsLedger,
} from "@isaacriehm/cairn-state";
import { logger } from "../../logger.js";
import {
  applyStripReplace,
  formatBareCitation,
  type ReplaceItem,
} from "./strip-replace.js";
import {
  isMarkdownPath,
  readEntityBody,
} from "../../hooks/sot-align-common.js";
import { walkSourceComments, type CommentBlock } from "./walker.js";
import { classifyBlocks, type CommentClassification } from "./classify.js";
import { emitDec, emitInv } from "../sot-emit.js";
import { readScopeIndex, writeScopeIndex, type ScopeIndex, type ScopeIndexEntry } from "@isaacriehm/cairn-state";

const log = logger("init.source-comments.ingest");

export interface IngestSourceCommentsArgs {
  repoRoot: string;
  dryRun?: boolean;
}

export interface IngestSourceCommentsResult {
  filesScanned: number;
  blocksDiscovered: number;
  blocksCited: number;
  blocksEmittedDec: number;
  blocksEmittedInv: number;
  blocksSkipped: number;
  blocksFailed: number;
  auditPath: string | null;
  stripError: string | null;
}

/**
 * Coerce decision ids to strings.
 */
function coerceDecisionIds(ids: unknown[]): string[] {
  return ids.filter((id): id is string => typeof id === "string");
}

/**
 * Coerce invariant ids to strings.
 */
function coerceInvariantIds(ids: unknown[]): string[] {
  return ids.filter((id): id is string => typeof id === "string");
}

/**
 * Orchestrate Phase 7b — source-comments ingestion.
 */
export async function runSourceCommentsIngestion(
  args: IngestSourceCommentsArgs,
): Promise<IngestSourceCommentsResult> {
  const repoRoot = args.repoRoot;
  const nowIso = new Date().toISOString();
  const auditPath = join(
    repoRoot,
    ".cairn",
    "baseline",
    `source-comments-${nowIso.replace(/[:.]/g, "-")}.yaml`,
  );

  // 1. Walk.
  const walkResult = walkSourceComments({ repoRoot });
  const blocks = walkResult.blocks;
  if (blocks.length === 0) {
    return {
      filesScanned: walkResult.filesAvailable,
      blocksDiscovered: 0,
      blocksCited: 0,
      blocksEmittedDec: 0,
      blocksEmittedInv: 0,
      blocksSkipped: 0,
      blocksFailed: 0,
      auditPath: null,
      stripError: null,
      };

  }

  // 2. Topic-index lookup + Classifier.
  const topicIndex = readTopicIndex(repoRoot);
  const rejected = readRejectedYaml(repoRoot);
  const anchorMap = readAnchorMap(repoRoot);

  const preResolved: {
    block: CommentBlock;
    resolution: "cite" | "classify" | "skip-rejected";
    existingId?: string;
    slug?: string;
  }[] = [];

  for (const b of blocks) {
    const hash = bodyContentHash(b.raw);
    const existing = Object.entries(topicIndex.topics).find(
      ([_, entry]) => entry.content_hash === hash,
    );

    if (existing !== undefined) {
      const [slug, entry] = existing;
      if (rejected.has(slug)) {
        preResolved.push({ block: b, resolution: "skip-rejected", slug });
      } else if (entry.dec_id !== null) {
        preResolved.push({ block: b, resolution: "cite", existingId: entry.dec_id ?? "", slug });
      } else {
        // Topic exists but not yet a DEC — still needs classification to
        // decide IF it should be a DEC/INV.
        preResolved.push({ block: b, resolution: "classify", slug });
      }
    } else {
      preResolved.push({ block: b, resolution: "classify" });
    }
  }

  // 3. Classify.
  const toClassify = preResolved
    .filter((r) => r.resolution === "classify")
    .map((r) => r.block);
  let classifications: Map<string, CommentClassification> = new Map();
  if (toClassify.length > 0) {
    const res = await classifyBlocks({
      blocks: toClassify,
      repoRoot,
    });
    classifications = "byId" in res ? (res as { byId: Map<string, CommentClassification> }).byId : new Map();
  }

  // 4. Resolve final resolutions and build ground-state writes.
  const finalResolutions: {
    block: CommentBlock;
    resolution: "cite" | "emit-decision" | "emit-invariant" | "skip" | "failed";
    existingId?: string;
    slug?: string;
  }[] = [];

  const invsWritten: { id: string; slug: string }[] = [];
  const decsWritten: { id: string; slug: string }[] = [];
  const stripItems: ReplaceItem[] = [];

  for (const r of preResolved) {
    if (r.resolution === "skip-rejected") {
      finalResolutions.push({ ...r, resolution: "skip" });
      continue;
    }
    if (r.resolution === "cite") {
      finalResolutions.push({ ...r, resolution: "cite" });
      if (args.dryRun !== true && r.existingId !== undefined) {
        stripItems.push({
          blockId: r.block.id,
          file: r.block.file,
          startOffset: r.block.startOffset,
          endOffset: r.block.endOffset,
          replacement: formatBareCitation(r.block.lang, r.existingId),
          expectedRaw: r.block.raw,
        });
      }
      continue;
    }

    const c = classifications.get(r.block.id);
    if (c === undefined) {
      finalResolutions.push({ ...r, resolution: "failed" });
      continue;
    }
    if (c.failed) {
      finalResolutions.push({ ...r, resolution: "failed" });
      continue;
    }

    if (c.kind === "rationale") {
      const slug = r.slug ?? c.blockId; // TODO: better slugging
      finalResolutions.push({ ...r, resolution: "emit-decision", slug });
      if (args.dryRun !== true) {
        const dec = emitDec({
          repoRoot,
          title: r.block.raw.split("\n")[0]?.replace(/^\s*[*#/]+\s*/, "").slice(0, 80) || slug,
          body: r.block.raw,
          topicSlug: slug,
          sourceFile: r.block.file,
        });
        decsWritten.push({ id: dec.id, slug });
        stripItems.push({
          blockId: r.block.id,
          file: r.block.file,
          startOffset: r.block.startOffset,
          endOffset: r.block.endOffset,
          replacement: formatBareCitation(r.block.lang, dec.id),
          expectedRaw: r.block.raw,
        });
      }
    } else if (c.kind === "constraint") {
      const slug = r.slug ?? c.blockId;
      finalResolutions.push({ ...r, resolution: "emit-invariant", slug });
      if (args.dryRun !== true) {
        const inv = emitInv({
          repoRoot,
          title: r.block.raw.split("\n")[0]?.replace(/^\s*[*#/]+\s*/, "").slice(0, 80) || slug,
          body: r.block.raw,
          topicSlug: slug,
          sourceFile: r.block.file,
        });
        invsWritten.push({ id: inv.id, slug });
        stripItems.push({
          blockId: r.block.id,
          file: r.block.file,
          startOffset: r.block.startOffset,
          endOffset: r.block.endOffset,
          replacement: formatBareCitation(r.block.lang, inv.id),
          expectedRaw: r.block.raw,
        });
      }
    } else {
      finalResolutions.push({ ...r, resolution: "skip" });
    }
  }

  // 5. Final write.
  let stripError: string | undefined;
  if (stripItems.length > 0 && args.dryRun !== true) {
    try {
      const result = applyStripReplace({
        repoRoot,
        items: stripItems,
      });
      try {
        updateScopeIndexFromStripItems(repoRoot, stripItems);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn(
          { err: message },
          "scope-index update from strip items failed",
        );
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      stripError = message;
      log.warn({ err: stripError }, "strip-replace failed");
    }
  } else if (stripItems.length === 0) {
    log.info("strip-replace: no items (no rationale/constraint blocks classified)");
  }

  if (args.dryRun !== true) {
    writeYaml(auditPath, {
      run_at: nowIso,
      blocks: finalResolutions.map((r) => ({
        id: r.block.id,
        file: r.block.file,
        lang: r.block.lang,
        start_offset: r.block.startOffset,
        end_offset: r.block.endOffset,
        resolution: r.resolution,
        existing_id: r.existingId,
        slug: r.slug,
        raw: r.block.raw,
      })),
    });
    if (invsWritten.length > 0) {
      try {
        writeInvariantsLedger({ repoRoot });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn(
          { err: message },
          "invariants ledger rebuild failed",
        );
      }
    }
    if (decsWritten.length > 0) {
      try {
        writeDecisionsLedger({ repoRoot });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn(
          { err: message },
          "decisions ledger rebuild failed",
        );
      }
    }
  }

  return {
    filesScanned: walkResult.filesAvailable,
    blocksDiscovered: blocks.length,
    blocksCited: finalResolutions.filter((r) => r.resolution === "cite").length,
    blocksEmittedDec: decsWritten.length,
    blocksEmittedInv: invsWritten.length,
    blocksSkipped: finalResolutions.filter((r) => r.resolution === "skip").length,
    blocksFailed: finalResolutions.filter((r) => r.resolution === "failed").length,
    auditPath: args.dryRun ? null : auditPath,
    stripError: stripError ?? null,
  };


}

/**
 * Update the scope-index ground file with the newly created citations.
 * This keeps `cairn_in_scope` accurate immediately after adoption without
 * requiring a manual `cairn scope rebuild`.
 */
function updateScopeIndexFromStripItems(
  repoRoot: string,
  items: ReplaceItem[],
): void {
  const decsByFile = new Map<string, Set<string>>();
  const invsByFile = new Map<string, Set<string>>();

  for (const it of items) {
    const idMatch = it.replacement.match(/§(DEC|INV)-([0-9a-f]{7,})/);
    if (!idMatch) continue;
    const kind = idMatch[1];
    const id = `${kind}-${idMatch[2]}`;
    if (kind === "DEC") {
      let set = decsByFile.get(it.file);
      if (!set) {
        set = new Set();
        decsByFile.set(it.file, set);
      }
      set.add(id);
    } else {
      let set = invsByFile.get(it.file);
      if (!set) {
        set = new Set();
        invsByFile.set(it.file, set);
      }
      set.add(id);
    }
  }

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

function serializeResolution(
  resolution:
    | { kind: "cite"; existingId: string; slug: string }
    | { kind: "emit"; slug: string; emitKind: "decision" | "constraint" }
    | undefined,
): unknown | null {
  if (resolution === undefined) return null;
  if (resolution.kind === "cite") {
    return { kind: "cite", existing_id: resolution.existingId, slug: resolution.slug };
  }
  return { kind: "emit", slug: resolution.slug, emit_kind: resolution.emitKind };
}
