/**
 * `cairn attention undo` runner (plan §11.7).
 *
 * Reverses Layer A auto-resolutions logged at
 * `.cairn/state/align-undo-log.jsonl`. The CLI passes `--since
 * <duration>` (default 1h); only entries within the window are
 * undone, the rest stay in the log.
 *
 * Reverses:
 *
 *   - `tier1-cite` / `tier2-cite` — find the cite line in the current
 *     source, swap it back for the original prose block. Idempotent
 *     when the source has been hand-edited away from the cite already.
 *
 *   - `tier3-creation` — delete the freshly-emitted DEC/INV file, drop
 *     its sot-bindings / sot-cache entries, clear the topic-index
 *     reference, refresh the affected ledger, and restore the source
 *     prose at the recorded offsets. All mutations run under
 *     `withWriteLock` so a parallel Layer A hook can't slip in
 *     mid-rollback.
 *
 *   - `augments` — delete the sibling DEC/INV (steps mirror
 *     tier3-creation), then trim the double-cite line in source down to
 *     the existing-id cite (the augmented entity stays referenced).
 *
 * Idempotent: the runner truncates undone entries from the log so a
 * second invocation against the same window is a no-op.
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  clearDecFromTopicIndex,
  decisionsDir,
  deleteSotCacheEntry,
  invariantsDir,
  readSotBindings,
  readSotCache,
  readTopicIndex,
  unbindDec,
  writeSotBindings,
  writeSotCache,
  writeTopicIndex,
} from "../ground/index.js";
import { writeDecisionsLedger, writeInvariantsLedger } from "../ground/ledgers.js";
import { withWriteLock } from "../lock.js";
import { logger } from "../logger.js";
import {
  alignUndoLogPath,
  pruneAlignUndoLog,
  readAlignUndoLog,
  type AlignUndoEntry,
} from "./log.js";

const log = logger("align-undo.runner");

/* -------------------------------------------------------------------------- */
/* Public surface                                                             */
/* -------------------------------------------------------------------------- */

export interface UndoArgs {
  repoRoot: string;
  /**
   * Wall-clock window. Entries with `ts` newer than `now - sinceMs`
   * are undone. Default 1h.
   */
  sinceMs?: number;
  /** Dry-run: classify entries but do not modify source / log. */
  dryRun?: boolean;
}

export interface UndoEntryOutcome {
  entry: AlignUndoEntry;
  /**
   * - `reverted`        — source was rewritten back to the original prose.
   * - `already-reverted`— the cite token is no longer in source (operator beat us).
   * - `not-supported`   — kind requires manual surgery (tier3-creation, augments).
   * - `source-missing`  — source file no longer exists.
   * - `error`           — write failed (logged + reported).
   */
  status:
    | "reverted"
    | "already-reverted"
    | "not-supported"
    | "source-missing"
    | "error";
  detail?: string;
}

export interface UndoResult {
  /** Total entries inside the undo window. */
  windowEntries: number;
  /** Entries left in the log because they were outside the window. */
  outsideWindow: number;
  /** Per-entry outcomes for everything inside the window. */
  outcomes: UndoEntryOutcome[];
  reverted: number;
  alreadyReverted: number;
  notSupported: number;
  sourceMissing: number;
  errors: number;
}

const DEFAULT_SINCE_MS = 60 * 60 * 1_000;

/* -------------------------------------------------------------------------- */
/* Run                                                                        */
/* -------------------------------------------------------------------------- */

export async function runAttentionUndo(args: UndoArgs): Promise<UndoResult> {
  const { repoRoot } = args;
  const sinceMs = args.sinceMs ?? DEFAULT_SINCE_MS;
  const dryRun = args.dryRun === true;
  const cutoff = Date.now() - sinceMs;

  const all = readAlignUndoLog(repoRoot);
  const inside: AlignUndoEntry[] = [];
  const outside: AlignUndoEntry[] = [];
  for (const e of all) {
    const tsMs = Date.parse(e.ts);
    if (Number.isFinite(tsMs) && tsMs >= cutoff) {
      inside.push(e);
    } else {
      outside.push(e);
    }
  }

  const outcomes: UndoEntryOutcome[] = [];
  // Process newest first — undoing in reverse order matches typical
  // operator intent ("undo my last 5 minutes of cites").
  inside.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts));
  for (const entry of inside) {
    outcomes.push(await reverseEntry(repoRoot, entry, dryRun));
  }

  const result: UndoResult = {
    windowEntries: inside.length,
    outsideWindow: outside.length,
    outcomes,
    reverted: outcomes.filter((o) => o.status === "reverted").length,
    alreadyReverted: outcomes.filter((o) => o.status === "already-reverted").length,
    notSupported: outcomes.filter((o) => o.status === "not-supported").length,
    sourceMissing: outcomes.filter((o) => o.status === "source-missing").length,
    errors: outcomes.filter((o) => o.status === "error").length,
  };

  if (!dryRun) {
    // Keep entries that we couldn't undo (not-supported / errors) so
    // the operator can re-attempt or hand-resolve. Entries we
    // reverted (or that were already reverted) are removed.
    const keep: AlignUndoEntry[] = [
      ...outside,
      ...outcomes
        .filter((o) => o.status === "not-supported" || o.status === "error")
        .map((o) => o.entry),
    ];
    await pruneAlignUndoLog(repoRoot, keep);
  }

  return result;
}

/* -------------------------------------------------------------------------- */
/* Per-entry reversal                                                         */
/* -------------------------------------------------------------------------- */

async function reverseEntry(
  repoRoot: string,
  entry: AlignUndoEntry,
  dryRun: boolean,
): Promise<UndoEntryOutcome> {
  if (entry.kind === "tier3-creation") {
    return reverseTier3Creation(repoRoot, entry, dryRun);
  }
  if (entry.kind === "augments") {
    return reverseAugments(repoRoot, entry, dryRun);
  }
  return reverseCite(repoRoot, entry, dryRun);
}

function reverseCite(
  repoRoot: string,
  entry: AlignUndoEntry,
  dryRun: boolean,
): UndoEntryOutcome {
  const abs = join(repoRoot, entry.file);
  if (!existsSync(abs)) {
    return { entry, status: "source-missing", detail: `${entry.file} no longer exists` };
  }
  let source: string;
  try {
    source = readFileSync(abs, "utf8");
  } catch (err) {
    return {
      entry,
      status: "error",
      detail: `cannot read ${entry.file}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  // Locate the cite line in the current source. The exact byte offsets
  // recorded at log-time are stale (the strip-replace re-flowed the
  // file), so we search for the literal replacement string instead.
  const replacement = entry.replacement.trimEnd();
  const idx = source.indexOf(replacement);
  if (idx === -1) {
    // Already hand-edited away — operator removed the cite themselves.
    return {
      entry,
      status: "already-reverted",
      detail: `cite "${replacement.trim()}" not found in ${entry.file}`,
    };
  }

  // Swap the replacement (matched + any trailing whitespace until newline) for the original raw.
  // Replacement is typically a one-liner like "// §DEC-aaaaaaa"; we
  // want to preserve indentation if the original raw had any.
  const lineStart = source.lastIndexOf("\n", idx) + 1;
  const lineEnd = source.indexOf("\n", idx + replacement.length);
  const cutEnd = lineEnd === -1 ? source.length : lineEnd;
  const before = source.slice(0, lineStart);
  const after = source.slice(cutEnd);
  // Match the indentation that strip-replace prepended on the cite —
  // leading whitespace from `lineStart` up to the `idx`.
  const indent = source.slice(lineStart, idx);
  const reflowedOriginal = reapplyIndent(entry.original_raw, indent);
  const next = `${before}${reflowedOriginal}${after}`;

  if (!dryRun) {
    try {
      writeFileSync(abs, next, "utf8");
    } catch (err) {
      log.warn(
        { file: entry.file, err: err instanceof Error ? err.message : String(err) },
        "align-undo write failed",
      );
      return {
        entry,
        status: "error",
        detail: `cannot write ${entry.file}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }
  return { entry, status: "reverted", detail: `${entry.file}` };
}

/**
 * Reverse a tier3-creation undo entry — Layer A spawned a fresh
 * DEC/INV from this prose block, strip-replaced the source with a
 * cite. Rolling back deletes the entity file, drops every sot-state
 * surface that referenced it, and restores the source block.
 */
async function reverseTier3Creation(
  repoRoot: string,
  entry: AlignUndoEntry,
  dryRun: boolean,
): Promise<UndoEntryOutcome> {
  const kind = derivePrimaryKind(entry);
  const entityDir = kind === "INV" ? invariantsDir(repoRoot) : decisionsDir(repoRoot);
  const entityPath = join(entityDir, `${entry.primary_id}.md`);
  const sourceCheck = checkSourceForReversal(repoRoot, entry);
  if (sourceCheck.status !== "ready") {
    const { status, detail } = sourceCheck;
    return { entry, status, detail };
  }

  if (dryRun) {
    return {
      entry,
      status: "reverted",
      detail: `[dry-run] would delete ${kind === "INV" ? "INV" : "DEC"} ${entry.primary_id} + restore ${entry.file}`,
    };
  }

  try {
    await withWriteLock(repoRoot, () => {
      // Source restore first so a partial failure doesn't leave the
      // operator with an orphaned cite pointing at a deleted entity.
      writeFileSync(sourceCheck.absSource, sourceCheck.next, "utf8");
      // Entity removal — `force: true` so an already-deleted file is a no-op.
      rmSync(entityPath, { force: true });
      let bindings = readSotBindings(repoRoot);
      const nextBindings = unbindDec(bindings, entry.primary_id);
      if (nextBindings !== bindings) {
        bindings = nextBindings;
        writeSotBindings(repoRoot, bindings);
      }
      let cache = readSotCache(repoRoot);
      const nextCache = deleteSotCacheEntry(cache, entry.primary_id);
      if (nextCache !== cache) {
        cache = nextCache;
        writeSotCache(repoRoot, cache);
      }
      let topics = readTopicIndex(repoRoot);
      const nextTopics = clearDecFromTopicIndex(topics, entry.primary_id);
      if (nextTopics !== topics) {
        topics = nextTopics;
        writeTopicIndex(repoRoot, topics);
      }
      if (kind === "INV") {
        writeInvariantsLedger({ repoRoot });
      } else {
        writeDecisionsLedger({ repoRoot });
      }
    });
  } catch (err) {
    log.warn(
      { file: entry.file, primary_id: entry.primary_id, err: err instanceof Error ? err.message : String(err) },
      "tier3-creation undo failed",
    );
    return {
      entry,
      status: "error",
      detail: `tier3-creation undo failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return {
    entry,
    status: "reverted",
    detail: `deleted ${kind} ${entry.primary_id} + restored ${entry.file}`,
  };
}

/**
 * Reverse an augments undo entry — Layer A emitted a sibling DEC/INV
 * alongside an existing one and stamped the source with a double-cite
 * (`// §existing\n// §new`). Rolling back deletes the sibling and
 * trims the source line down to the existing cite.
 */
async function reverseAugments(
  repoRoot: string,
  entry: AlignUndoEntry,
  dryRun: boolean,
): Promise<UndoEntryOutcome> {
  const kind = derivePrimaryKind(entry);
  const entityDir = kind === "INV" ? invariantsDir(repoRoot) : decisionsDir(repoRoot);
  const entityPath = join(entityDir, `${entry.primary_id}.md`);
  // The replacement is `<existingCite>\n<newCite>` — first line is the
  // cite we want to keep, second line is the sibling cite to drop.
  const replacement = entry.replacement.trimEnd();
  const newlineIdx = replacement.indexOf("\n");
  if (newlineIdx === -1) {
    return {
      entry,
      status: "error",
      detail: `augments replacement missing newline boundary: ${replacement}`,
    };
  }
  const keepCite = replacement.slice(0, newlineIdx);
  const sourceAbs = join(repoRoot, entry.file);
  if (!existsSync(sourceAbs)) {
    return { entry, status: "source-missing", detail: `${entry.file} no longer exists` };
  }
  let source: string;
  try {
    source = readFileSync(sourceAbs, "utf8");
  } catch (err) {
    return {
      entry,
      status: "error",
      detail: `cannot read ${entry.file}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const idx = source.indexOf(replacement);
  if (idx === -1) {
    return {
      entry,
      status: "already-reverted",
      detail: `double-cite "${replacement.trim()}" not found in ${entry.file}`,
    };
  }
  const next = `${source.slice(0, idx)}${keepCite}${source.slice(idx + replacement.length)}`;

  if (dryRun) {
    return {
      entry,
      status: "reverted",
      detail: `[dry-run] would delete sibling ${kind} ${entry.primary_id} + trim double-cite in ${entry.file}`,
    };
  }

  try {
    await withWriteLock(repoRoot, () => {
      writeFileSync(sourceAbs, next, "utf8");
      rmSync(entityPath, { force: true });
      let bindings = readSotBindings(repoRoot);
      const nextBindings = unbindDec(bindings, entry.primary_id);
      if (nextBindings !== bindings) {
        bindings = nextBindings;
        writeSotBindings(repoRoot, bindings);
      }
      let cache = readSotCache(repoRoot);
      const nextCache = deleteSotCacheEntry(cache, entry.primary_id);
      if (nextCache !== cache) {
        cache = nextCache;
        writeSotCache(repoRoot, cache);
      }
      let topics = readTopicIndex(repoRoot);
      const nextTopics = clearDecFromTopicIndex(topics, entry.primary_id);
      if (nextTopics !== topics) {
        topics = nextTopics;
        writeTopicIndex(repoRoot, topics);
      }
      if (kind === "INV") {
        writeInvariantsLedger({ repoRoot });
      } else {
        writeDecisionsLedger({ repoRoot });
      }
    });
  } catch (err) {
    log.warn(
      { file: entry.file, primary_id: entry.primary_id, err: err instanceof Error ? err.message : String(err) },
      "augments undo failed",
    );
    return {
      entry,
      status: "error",
      detail: `augments undo failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return {
    entry,
    status: "reverted",
    detail: `deleted sibling ${kind} ${entry.primary_id} + trimmed double-cite in ${entry.file}`,
  };
}

/**
 * Helper for tier3-creation: precompute the source-restore content so
 * a missing source surfaces before we touch the entity files. Returns
 * the restored source text + abs path on success, or a non-`reverted`
 * outcome status.
 */
function checkSourceForReversal(
  repoRoot: string,
  entry: AlignUndoEntry,
):
  | { status: "source-missing"; detail: string }
  | { status: "already-reverted"; detail: string }
  | { status: "error"; detail: string }
  | { status: "ready"; absSource: string; next: string } {
  const abs = join(repoRoot, entry.file);
  if (!existsSync(abs)) {
    return { status: "source-missing", detail: `${entry.file} no longer exists` };
  }
  let source: string;
  try {
    source = readFileSync(abs, "utf8");
  } catch (err) {
    return {
      status: "error",
      detail: `cannot read ${entry.file}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const replacement = entry.replacement.trimEnd();
  const idx = source.indexOf(replacement);
  if (idx === -1) {
    return {
      status: "already-reverted",
      detail: `cite "${replacement.trim()}" not found in ${entry.file}`,
    };
  }
  const lineStart = source.lastIndexOf("\n", idx) + 1;
  const lineEnd = source.indexOf("\n", idx + replacement.length);
  const cutEnd = lineEnd === -1 ? source.length : lineEnd;
  const indent = source.slice(lineStart, idx);
  const reflowedOriginal = reapplyIndent(entry.original_raw, indent);
  const next = `${source.slice(0, lineStart)}${reflowedOriginal}${source.slice(cutEnd)}`;
  return { status: "ready", absSource: abs, next };
}

function derivePrimaryKind(entry: AlignUndoEntry): "DEC" | "INV" {
  if (entry.primary_kind !== undefined) return entry.primary_kind;
  return entry.primary_id.startsWith("INV-") ? "INV" : "DEC";
}

/**
 * Re-apply the leading indent that the cite line carried so the
 * restored original block lines up at the right column. Most blocks'
 * raw already includes the full indentation — we only prepend `indent`
 * to lines that start without it, which handles JSDoc / line-comment
 * blocks captured at column 0.
 */
function reapplyIndent(raw: string, indent: string): string {
  if (indent.length === 0) return raw;
  const lines = raw.split("\n");
  const out: string[] = [];
  let isFirst = true;
  for (const line of lines) {
    if (isFirst) {
      out.push(line);
      isFirst = false;
      continue;
    }
    if (line.length === 0) {
      out.push(line);
      continue;
    }
    if (line.startsWith(indent) || /^\s/.test(line)) {
      out.push(line);
      continue;
    }
    out.push(`${indent}${line}`);
  }
  return out.join("\n");
}
