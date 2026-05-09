/**
 * Phase 10 — deterministic strip + replace.
 *
 * Mechanical only. Never LLM-rewritten. Inputs are `ReplaceItem[]` produced
 * by the caller from a `source-comments-<ISO>.yaml` audit + a resolution map
 * (which §INV or TSK to cite). Per-file consent + backup + diff preview is the
 * caller's responsibility (the skill that surfaces inline A/B/C). This module
 * owns the safety and replacement primitives:
 *
 *   1. dirty-check — `git status --porcelain` per file. Caller picks
 *      stash / skip / overwrite per the inline prompt; we honor the decision.
 *   2. backup — copy original to `.cairn/backups/source/<rel>.original`
 *      before any edit (one snapshot per file, never overwritten).
 *   3. replace — mechanical string substitution at the recorded byte range,
 *      preserving leading indentation by default.
 *
 * Spec §15 + §10 + §16 for backup convention.
 */

import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { logger } from "../../logger.js";

const log = logger("init.source-comments.strip-replace");

export type DirtyDecision = "stash" | "skip" | "overwrite";

export interface ReplaceItem {
  blockId: string;
  /** Repo-relative POSIX path. */
  file: string;
  /** Inclusive byte offset into the file. Must match the audit. */
  startOffset: number;
  /** Exclusive byte offset (one past the end of the block). */
  endOffset: number;
  /**
   * Replacement comment text. Caller composes per spec §15:
   *   - "// §INV-NNNN" for invariant cites
   *   - "// TODO(TSK-<id>)" for active-task links
   *   - leave undefined (item omitted entirely) to skip stripping a block
   *
   * The replacer prepends the same leading indentation the original block had.
   */
  replacement: string;
  /** Default true — strip the original block & re-indent the replacement. */
  preserveIndent?: boolean;
  /**
   * Bytes the audit captured at [startOffset, endOffset). When present,
   * applyToFileContent skips the item with reason `range-mismatch` if
   * the file has been edited between the audit and the strip — protects
   * against silently corrupting unrelated source on stale offsets.
   */
  expectedRaw?: string;
}

export interface StripReplaceArgs {
  repoRoot: string;
  items: ReplaceItem[];
  /**
   * Per-file dirty-check decisions, keyed by repo-relative path. Files absent
   * from this map and dirty are *skipped* (safe default). Files clean are
   * always processed regardless of map presence.
   */
  dirtyDecisions?: Record<string, DirtyDecision>;
  /** When true, no files are written; backup operations are skipped too. */
  dryRun?: boolean;
}

export type SkipReason =
  | "dirty-skipped"
  | "dirty-no-decision"
  | "missing-file"
  | "range-mismatch"
  | "overlap";

export interface FileOutcome {
  file: string;
  /** Full new file contents — present only on success or dry-run. */
  newContent?: string;
  itemsApplied: number;
  itemsSkipped: { blockId: string; reason: SkipReason }[];
  backupPath?: string;
  /** Set when the whole file was skipped (e.g. dirty + caller decided skip). */
  fileSkipReason?: SkipReason;
  /** Set when the file was dirty and the operator chose to stash. */
  stashed?: boolean;
}

export interface StripReplaceResult {
  files: FileOutcome[];
  filesModified: number;
  filesSkipped: number;
  backupsWritten: string[];
  itemsApplied: number;
  itemsSkipped: number;
}

/* -------------------------------------------------------------------------- */
/* Public                                                                     */
/* -------------------------------------------------------------------------- */

export function applyStripReplace(args: StripReplaceArgs): StripReplaceResult {
  const byFile = groupItemsByFile(args.items);
  const dirtyMap = computeDirtyMap(args.repoRoot, [...byFile.keys()]);
  const outcomes: FileOutcome[] = [];
  const backupsWritten: string[] = [];

  let filesModified = 0;
  let filesSkipped = 0;
  let itemsApplied = 0;
  let itemsSkipped = 0;

  for (const [file, items] of byFile) {
    const abs = join(args.repoRoot, file);
    if (!existsSync(abs)) {
      const skipped: { blockId: string; reason: SkipReason }[] = items.map((it) => ({
        blockId: it.blockId,
        reason: "missing-file",
      }));
      outcomes.push({
        file,
        itemsApplied: 0,
        itemsSkipped: skipped,
        fileSkipReason: "missing-file",
      });
      filesSkipped += 1;
      itemsSkipped += skipped.length;
      continue;
    }
    const isDirty = dirtyMap.get(file) === true;
    let stashed = false;
    if (isDirty) {
      const decision = args.dirtyDecisions?.[file];
      if (decision === undefined || decision === "skip") {
        outcomes.push({
          file,
          itemsApplied: 0,
          itemsSkipped: items.map((it) => ({
            blockId: it.blockId,
            reason: decision === undefined ? "dirty-no-decision" : "dirty-skipped",
          })),
          fileSkipReason: decision === undefined ? "dirty-no-decision" : "dirty-skipped",
        });
        filesSkipped += 1;
        itemsSkipped += items.length;
        continue;
      }
      if (decision === "stash") {
        const ok = stashFile(args.repoRoot, file, args.dryRun === true);
        if (!ok) {
          outcomes.push({
            file,
            itemsApplied: 0,
            itemsSkipped: items.map((it) => ({
              blockId: it.blockId,
              reason: "dirty-skipped",
            })),
            fileSkipReason: "dirty-skipped",
          });
          filesSkipped += 1;
          itemsSkipped += items.length;
          continue;
        }
        stashed = true;
      }
      // "overwrite" falls through — we accept the destruction, caller acked it.
    }

    const original = readFileSync(abs, "utf8");
    const overlapping = detectOverlaps(items);
    if (overlapping.length > 0) {
      const overlapIds = new Set(overlapping);
      outcomes.push({
        file,
        itemsApplied: 0,
        itemsSkipped: items.map((it) => ({
          blockId: it.blockId,
          reason: overlapIds.has(it.blockId) ? "overlap" : "range-mismatch",
        })),
        fileSkipReason: "overlap",
      });
      filesSkipped += 1;
      itemsSkipped += items.length;
      continue;
    }

    const { content, applied, skipped } = applyToFileContent(original, items);
    if (applied === 0) {
      outcomes.push({
        file,
        newContent: content,
        itemsApplied: 0,
        itemsSkipped: skipped,
      });
      filesSkipped += 1;
      itemsSkipped += skipped.length;
      continue;
    }

    let backupPath: string | undefined;
    if (args.dryRun !== true) {
      backupPath = backupOriginal(args.repoRoot, file);
      backupsWritten.push(backupPath);
      writeFileSync(abs, content, "utf8");
    }
    outcomes.push({
      file,
      newContent: content,
      itemsApplied: applied,
      itemsSkipped: skipped,
      ...(backupPath !== undefined ? { backupPath } : {}),
      ...(stashed ? { stashed: true } : {}),
    });
    filesModified += 1;
    itemsApplied += applied;
    itemsSkipped += skipped.length;
  }

  return {
    files: outcomes,
    filesModified,
    filesSkipped,
    backupsWritten,
    itemsApplied,
    itemsSkipped,
  };
}

/**
 * Build a unified-diff-like preview without touching disk. Used by the skill
 * before the per-module / per-file consent prompt. Returns `{ file, before,
 * after }` per file; caller renders.
 */
export function previewStripReplace(args: {
  repoRoot: string;
  items: ReplaceItem[];
}): { file: string; before: string; after: string }[] {
  const byFile = groupItemsByFile(args.items);
  const out: { file: string; before: string; after: string }[] = [];
  for (const [file, items] of byFile) {
    const abs = join(args.repoRoot, file);
    if (!existsSync(abs)) continue;
    const before = readFileSync(abs, "utf8");
    const overlap = detectOverlaps(items);
    if (overlap.length > 0) {
      out.push({ file, before, after: before });
      continue;
    }
    const { content } = applyToFileContent(before, items);
    out.push({ file, before, after: content });
  }
  return out;
}

/**
 * Build a bare-symbol citation comment for a given language + symbol id.
 *
 *   §DEC-0042   →  `// §DEC-0042`   in C-like languages
 *   §DEC-0042   →  `# §DEC-0042`    in py / rb / sh / lua
 *
 * Single source of truth for citation formatting — both phase 7b's
 * inline invariant strip-replace and the post-DEC-accept strip in
 * `cairn_resolve_attention` resolve through this helper so the two
 * paths stay consistent.
 */
const HASH_LANGS = new Set(["py", "rb", "sh", "lua"]);

export function formatBareCitation(lang: string, symbolId: string): string {
  if (HASH_LANGS.has(lang)) return `# §${symbolId}`;
  return `// §${symbolId}`;
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                  */
/* -------------------------------------------------------------------------- */

function groupItemsByFile(items: ReplaceItem[]): Map<string, ReplaceItem[]> {
  const m = new Map<string, ReplaceItem[]>();
  for (const it of items) {
    const list = m.get(it.file);
    if (list !== undefined) list.push(it);
    else m.set(it.file, [it]);
  }
  return m;
}

function detectOverlaps(items: ReplaceItem[]): string[] {
  const sorted = [...items].sort((a, b) => a.startOffset - b.startOffset);
  const offenders: string[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const prev = sorted[i - 1];
    const cur = sorted[i];
    if (prev === undefined || cur === undefined) continue;
    if (cur.startOffset < prev.endOffset) {
      offenders.push(prev.blockId, cur.blockId);
    }
  }
  return offenders;
}

interface ApplyOutcome {
  content: string;
  applied: number;
  skipped: { blockId: string; reason: SkipReason }[];
}

function applyToFileContent(original: string, items: ReplaceItem[]): ApplyOutcome {
  // Apply right-to-left so earlier offsets remain valid as we mutate.
  const sorted = [...items].sort((a, b) => b.startOffset - a.startOffset);
  let content = original;
  let applied = 0;
  const skipped: { blockId: string; reason: SkipReason }[] = [];
  for (const it of sorted) {
    if (it.startOffset < 0 || it.endOffset > content.length) {
      skipped.push({ blockId: it.blockId, reason: "range-mismatch" });
      continue;
    }
    if (
      it.expectedRaw !== undefined &&
      content.slice(it.startOffset, it.endOffset) !== it.expectedRaw
    ) {
      // The file changed between the audit run and now — strip would
      // overwrite unrelated bytes. Skip safely.
      skipped.push({ blockId: it.blockId, reason: "range-mismatch" });
      continue;
    }
    const indent = leadingIndent(content, it.startOffset);
    const preserve = it.preserveIndent !== false;
    const replacement = preserve ? `${indent}${it.replacement}` : it.replacement;
    content =
      content.slice(0, it.startOffset - indent.length) +
      replacement +
      content.slice(it.endOffset);
    applied += 1;
  }
  return { content, applied, skipped };
}

function leadingIndent(body: string, offset: number): string {
  let i = offset;
  while (i > 0 && (body[i - 1] === " " || body[i - 1] === "\t")) i -= 1;
  return body.slice(i, offset);
}

function backupOriginal(repoRoot: string, relFile: string): string {
  const backupRel = join(".cairn", "backups", "source", `${relFile}.original`);
  const abs = join(repoRoot, backupRel);
  if (existsSync(abs)) {
    log.debug({ file: relFile, backup: backupRel }, "backup exists — skipping copy");
    return abs;
  }
  mkdirSync(dirname(abs), { recursive: true });
  copyFileSync(join(repoRoot, relFile), abs);
  return abs;
}

function computeDirtyMap(repoRoot: string, files: string[]): Map<string, boolean> {
  const out = new Map<string, boolean>();
  if (files.length === 0) return out;
  try {
    const argsList = ["status", "--porcelain", "--", ...files];
    const result = execFileSync("git", argsList, {
      cwd: repoRoot,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
    });
    const dirty = new Set<string>();
    for (const line of result.split("\n")) {
      if (line.length === 0) continue;
      // " M path/to/file" or "?? path/to/file"
      const path = line.slice(3).trim().replace(/^"(.*)"$/, "$1");
      if (path.length > 0) dirty.add(path);
    }
    for (const f of files) out.set(f, dirty.has(f));
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "git status failed — assuming all files clean",
    );
    for (const f of files) out.set(f, false);
  }
  return out;
}

function stashFile(repoRoot: string, relFile: string, dryRun: boolean): boolean {
  if (dryRun) return true;
  try {
    execFileSync(
      "git",
      ["stash", "push", "--keep-index", "-m", `cairn-strip-replace ${relFile}`, "--", relFile],
      { cwd: repoRoot, encoding: "utf8" },
    );
    return true;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(
      { file: relFile, err: message },
      "git stash failed",
    );
    return false;
  }
}

const _internal = {
  applyToFileContent,
  detectOverlaps,
  leadingIndent,
};
