/**
 * `cairn attention undo` runner (plan §11.7).
 *
 * Reverses Layer A auto-resolutions logged at
 * `.cairn/state/align-undo-log.jsonl`. The CLI passes `--since
 * <duration>` (default 1h); only entries within the window are
 * undone, the rest stay in the log.
 *
 * Currently reverses:
 *
 *   - `tier1-cite` / `tier2-cite` — find the cite line in the current
 *     source, swap it back for the original prose block. Idempotent
 *     when the source has been hand-edited away from the cite already.
 *
 * Out of scope for v0.5.0 (deferred to v0.6 — these need targeted
 * ledger surgery + sotBindings/sotCache rollback):
 *
 *   - `tier3-creation` — would need to delete the DEC/INV file, drop
 *     its sotBindings / sotCache / topic-index entries, refresh the
 *     ledger, and restore the source. Reported in the undo summary
 *     so the operator can hand-resolve.
 *
 *   - `augments` — would need to delete the sibling DEC/INV and
 *     remove its cite from the double-cite while keeping the
 *     existing-id cite in place.
 *
 * Idempotent: the runner truncates undone entries from the log so a
 * second invocation against the same window is a no-op.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
    outcomes.push(reverseEntry(repoRoot, entry, dryRun));
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
    pruneAlignUndoLog(repoRoot, keep);
  }

  return result;
}

/* -------------------------------------------------------------------------- */
/* Per-entry reversal                                                         */
/* -------------------------------------------------------------------------- */

function reverseEntry(
  repoRoot: string,
  entry: AlignUndoEntry,
  dryRun: boolean,
): UndoEntryOutcome {
  if (entry.kind === "tier3-creation" || entry.kind === "augments") {
    return {
      entry,
      status: "not-supported",
      detail:
        entry.kind === "tier3-creation"
          ? "fresh DEC/INV creation undo deferred to v0.6 — manually delete the entity file and restore the source block"
          : "augments-sibling undo deferred to v0.6 — manually delete the sibling and trim the double-cite",
    };
  }

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
