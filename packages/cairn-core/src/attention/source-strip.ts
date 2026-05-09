/**
 * Shared source-comment strip-replace helpers for the attention surface.
 *
 * Phase 7b writes DEC drafts (extracted from essay-class JSDoc / block
 * comments) to `_inbox/` and stamps `sourceFile` + `blockId` on the
 * frontmatter. When the operator accepts a draft — either inline via
 * `cairn_resolve_attention` or in bulk via `cairn_bulk_accept_attention`
 * — the original essay should be replaced with `// §DEC-NNNN` so the
 * file ends up carrying the canonical bare cite, not the original prose.
 *
 * The full block coordinates (start/end byte offsets, language) live in
 * `.cairn/baseline/source-comments-<ISO>.yaml` (the audit YAML written
 * by phase 7b). This module reads the latest audit, looks up the block
 * by id, and runs `applyStripReplace` against the recorded range.
 *
 * Mirrors the invariant strip pass that 7b runs at adoption time. The
 * net effect: every accepted DEC draft from a source comment is bare-
 * cited inline, just like §INV constraints already are.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import {
  applyStripReplace,
  formatBareCitation,
  type ReplaceItem,
  type StripReplaceResult,
} from "../init/source-comments/strip-replace.js";
import { logger } from "../logger.js";

const DraftMetaSchema = z.object({
  blockId: z.string().nullable().optional(),
  sourceFile: z.string().nullable().optional(),
  capture_source: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
}).passthrough();

export interface DraftMeta {
  blockId: string | null;
  sourceFile: string | null;
  captureSource: string | null;
  title: string | null;
}

const AuditBlockSchema = z.object({
  block_id: z.string(),
  file: z.string(),
  lang: z.string(),
  start_offset: z.number(),
  end_offset: z.number(),
  raw: z.string().nullish(),
});

const AuditFileSchema = z.object({
  blocks: z.array(AuditBlockSchema),
}).passthrough();

interface AuditBlock {
  block_id: string;
  file: string;
  lang: string;
  start_offset: number;
  end_offset: number;
  raw: string | null;
}

/**
 * Look up the current byte range of `expectedRaw` in `file` (relative to
 * `repoRoot`). Returns null when the file is missing, the raw text
 * doesn't appear, or it appears more than once (ambiguous). This is the
 * content-search fallback that recovers from offset drift caused by
 * Phase 7b's INV strip-replace pass mutating the same file before this
 * DEC's accept ran.
 */
function findCurrentRange(
  repoRoot: string,
  file: string,
  expectedRaw: string,
): { startOffset: number; endOffset: number } | null {
  const abs = join(repoRoot, file);
  if (!existsSync(abs)) return null;
  let body: string;
  try {
    body = readFileSync(abs, "utf8");
  } catch {
    return null;
  }
  const first = body.indexOf(expectedRaw);
  if (first === -1) return null;
  // Reject ambiguous matches — if the same essay appears twice we can't
  // safely guess which one the DEC was extracted from.
  const second = body.indexOf(expectedRaw, first + 1);
  if (second !== -1) return null;
  return {
    startOffset: first,
    endOffset: first + expectedRaw.length,
  };
}

const log = logger("attention.source-strip");

export function parseDraftMeta(body: string): DraftMeta | null {
  const match = /^---\n([\s\S]*?)\n---/.exec(body);
  if (match === null) return null;
  try {
    const raw: unknown = parseYaml(match[1] ?? "");
    const result = DraftMetaSchema.safeParse(raw);
    if (!result.success) return null;
    
    const obj = result.data;
    return {
      blockId: obj.blockId ?? null,
      sourceFile: obj.sourceFile ?? null,
      captureSource: obj.capture_source ?? null,
      title: obj.title ?? null,
    };
  } catch {
    return null;
  }
}

export interface StripOutcomeSummary {
  attempted: boolean;
  files_modified: number;
  items_applied: number;
  audit_path: string | null;
  reason?: string;
}

function extractAuditBlocks(body: unknown): AuditBlock[] {
  const result = AuditFileSchema.safeParse(body);
  if (!result.success) return [];
  return result.data.blocks.map((b) => ({
    block_id: b.block_id,
    file: b.file,
    lang: b.lang,
    start_offset: b.start_offset,
    end_offset: b.end_offset,
    raw: b.raw ?? null,
  }));
}

export function findLatestSourceCommentsAudit(repoRoot: string): string | null {
  const dir = join(repoRoot, ".cairn", "baseline");
  if (!existsSync(dir)) return null;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  const candidates = entries
    .filter((n) => n.startsWith("source-comments-") && n.endsWith(".yaml"))
    .map((name) => {
      const abs = join(dir, name);
      let mtime = 0;
      try {
        mtime = statSync(abs).mtimeMs;
      } catch {
        /* best-effort */
      }
      return { abs, mtime };
    })
    .sort((a, b) => b.mtime - a.mtime);
  return candidates[0]?.abs ?? null;
}

/**
 * Strip the original source-comment block for one accepted DEC and
 * replace it with `// §DEC-NNNN` (or `# §DEC-NNNN` in hash-comment
 * languages). Reads block coordinates from the latest 7b audit YAML;
 * skips when the audit is missing, the block id isn't found, or the
 * source file is dirty (strip-replace's own dirty check).
 *
 * Returns a small summary the MCP / CLI surface can echo back to the
 * operator.
 */
export function runDecSourceStrip(args: {
  repoRoot: string;
  decId: string;
  meta: DraftMeta;
}): StripOutcomeSummary {
  const blockId = args.meta.blockId;
  if (blockId === null) {
    return {
      attempted: false,
      files_modified: 0,
      items_applied: 0,
      audit_path: null,
      reason: "no-block-id",
    };
  }
  const auditPath = findLatestSourceCommentsAudit(args.repoRoot);
  if (auditPath === null) {
    return {
      attempted: false,
      files_modified: 0,
      items_applied: 0,
      audit_path: null,
      reason: "no-audit-found",
    };
  }
  let auditBody: unknown;
  try {
    auditBody = parseYaml(readFileSync(auditPath, "utf8"));
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err), auditPath },
      "audit parse failed",
    );
    return {
      attempted: false,
      files_modified: 0,
      items_applied: 0,
      audit_path: auditPath,
      reason: "audit-parse-failed",
    };
  }
  const blocks = extractAuditBlocks(auditBody);
  const block = blocks.find((b) => b.block_id === blockId);
  if (block === undefined) {
    return {
      attempted: false,
      files_modified: 0,
      items_applied: 0,
      audit_path: auditPath,
      reason: "block-not-found",
    };
  }
  const replacement = formatBareCitation(block.lang, args.decId);
  // Idempotency: if the file already carries the bare cite, the strip
  // already landed (typical when `cairn fix dec-strip` re-runs after a
  // partial first pass). Surface as `already-stripped` so re-runs don't
  // look like failures.
  const absFile = join(args.repoRoot, block.file);
  if (existsSync(absFile)) {
    try {
      const current = readFileSync(absFile, "utf8");
      if (current.includes(replacement)) {
        return {
          attempted: false,
          files_modified: 0,
          items_applied: 0,
          audit_path: auditPath,
          reason: "already-stripped",
        };
      }
    } catch {
      /* fall through to the strip path */
    }
  }
  // Phase 7b's INV strip pass already mutated the same source file inline
  // for any constraint blocks it found, so by accept time the file is
  // virtually always "dirty" against HEAD AND the recorded byte offsets
  // for OTHER blocks in that same file have shifted. Try the recorded
  // offsets first (cheapest path); on `range-mismatch` fall back to a
  // content search for `block.raw` and re-issue with current offsets.
  // Operator consented to source mutation at adoption time — pass
  // `overwrite` so the dirty check doesn't bail.
  const buildItem = (startOffset: number, endOffset: number): ReplaceItem => ({
    blockId,
    file: block.file,
    startOffset,
    endOffset,
    replacement,
    ...(block.raw !== null ? { expectedRaw: block.raw } : {}),
  });
  const item = buildItem(block.start_offset, block.end_offset);
  let result: StripReplaceResult;
  try {
    result = applyStripReplace({
      repoRoot: args.repoRoot,
      items: [item],
      dirtyDecisions: { [block.file]: "overwrite" },
    });
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err), decId: args.decId, blockId },
      "strip-replace failed",
    );
    return {
      attempted: true,
      files_modified: 0,
      items_applied: 0,
      audit_path: auditPath,
      reason: "strip-failed",
    };
  }
  // applyStripReplace runs successfully but can still return zero items
  // applied (range-mismatch when audit offsets are stale, missing-file,
  // overlap, etc.). Surface the underlying reason instead of swallowing
  // it as "unknown" — `cairn fix dec-strip` and the resolve-attention
  // skill both need the operator-facing detail.
  if (result.itemsApplied === 0) {
    const fileOutcome = result.files.find((f) => f.file === block.file);
    const itemReason = fileOutcome?.itemsSkipped.find((s) => s.blockId === blockId)
      ?.reason;
    const reason = itemReason ?? fileOutcome?.fileSkipReason ?? "no-items-applied";

    // Content-search fallback: when the audit's recorded offsets no
    // longer match the file (because earlier INV / DEC strips shifted
    // bytes), look up `block.raw` directly in the current file and
    // re-issue with the current range. Only attempted on
    // range-mismatch — every other reason (missing-file, dirty-skipped,
    // overlap) needs operator action, not a coordinate retry.
    if (reason === "range-mismatch" && block.raw !== null) {
      const current = findCurrentRange(args.repoRoot, block.file, block.raw);
      if (current !== null) {
        const retryItem = buildItem(current.startOffset, current.endOffset);
        try {
          const retryResult = applyStripReplace({
            repoRoot: args.repoRoot,
            items: [retryItem],
            dirtyDecisions: { [block.file]: "overwrite" },
          });
          if (retryResult.itemsApplied > 0) {
            return {
              attempted: true,
              files_modified: retryResult.filesModified,
              items_applied: retryResult.itemsApplied,
              audit_path: auditPath,
            };
          }
          const retryFile = retryResult.files.find((f) => f.file === block.file);
          const retryReason =
            retryFile?.itemsSkipped.find((s) => s.blockId === blockId)?.reason ??
            retryFile?.fileSkipReason ??
            "range-mismatch";
          return {
            attempted: true,
            files_modified: 0,
            items_applied: 0,
            audit_path: auditPath,
            reason: retryReason,
          };
        } catch (err) {
          log.warn(
            {
              err: err instanceof Error ? err.message : String(err),
              decId: args.decId,
              blockId,
            },
            "strip-replace content-search retry failed",
          );
          return {
            attempted: true,
            files_modified: 0,
            items_applied: 0,
            audit_path: auditPath,
            reason: "strip-failed",
          };
        }
      }
      return {
        attempted: true,
        files_modified: 0,
        items_applied: 0,
        audit_path: auditPath,
        reason: "raw-not-in-file",
      };
    }
    return {
      attempted: true,
      files_modified: 0,
      items_applied: 0,
      audit_path: auditPath,
      reason,
    };
  }
  return {
    attempted: true,
    files_modified: result.filesModified,
    items_applied: result.itemsApplied,
    audit_path: auditPath,
  };
}
