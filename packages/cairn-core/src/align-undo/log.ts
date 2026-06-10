/**
 * Layer A audit log for `cairn attention undo` (plan §11.7).
 *
 * Every Layer A auto-resolution (Tier 1 cite, Tier 2 same cite, Tier 3
 * fresh DEC creation, augments-DEC/INV emission) appends one line to
 * `.cairn/state/align-undo-log.jsonl`. The CLI command
 * `cairn attention undo [--since <duration>]` reads recent entries and
 * reverses them.
 *
 * The deviation from plan §11.7's literal "reads invalidation events
 * from `.cairn/events/`" — invalidation events are designed for
 * cross-session broadcast (kind, refs, source), not for carrying the
 * (file, offset, original_raw) metadata that undo needs. Keeping the
 * undo log separate avoids polluting the broadcast surface and lets
 * the GC retention policy stay independent.
 *
 * Truncation policy: `cairn attention undo` rewrites the log keeping
 * only entries OUTSIDE the undo window so re-running `undo` against
 * the same window is idempotent.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { withWriteLock } from "../lock.js";
import { logger } from "../logger.js";
import { cairnDir } from "@isaacriehm/cairn-state";

const log = logger("align-undo.log");

/**
 * Drop entries older than this on the next append + GC sweep. Operators
 * who never run `cairn attention undo` would otherwise accumulate one
 * line per Layer A auto-resolution forever.
 */
const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Skip the read-rewrite GC pass when the log is below this line count
 * — steady-state operators don't pay for the read on every append.
 */
const GC_THRESHOLD_LINES = 256;

export const AlignUndoEntry = z.object({
  ts: z.string(),
  session_id: z.string().nullish(),
  kind: z.enum(["tier1-cite", "tier2-cite", "tier3-creation", "augments"]),
  file: z.string(),
  start_offset: z.number(),
  end_offset: z.number(),
  /** Original prose block raw (incl. comment delimiters) before strip-replace. */
  original_raw: z.string(),
  /** Replacement that was inserted (e.g. `// §DEC-1234567`). */
  replacement: z.string(),
  /** DEC/INV id cited (tier1/tier2 cite) or freshly emitted (tier3 / augments). */
  primary_id: z.string(),
  /** For tier3-creation: was the freshly-emitted entity a DEC or INV? */
  primary_kind: z.enum(["DEC", "INV"]).optional(),
  /** For augments: the existing entity id that was augmented (its cite stays). */
  augments_existing_id: z.string().optional(),
});
export type AlignUndoEntry = z.infer<typeof AlignUndoEntry>;

export function alignUndoLogPath(repoRoot: string): string {
  return cairnDir(repoRoot, "state", "align-undo-log.jsonl");
}

export async function appendAlignUndoEntry(
  repoRoot: string,
  entry: AlignUndoEntry,
): Promise<void> {
  const validated = AlignUndoEntry.parse(entry);
  const path = alignUndoLogPath(repoRoot);
  // Wrap the read-trim-append cycle in the project write lock so two
  // concurrent Layer A invocations (or a session running `cairn
  // attention undo` in another shell) can't interleave a partial
  // append against a rewrite.
  await withWriteLock(repoRoot, () => {
    try {
      mkdirSync(dirname(path), { recursive: true });
      const remaining = sweepStale(path);
      if (remaining === null) {
        appendFileSync(path, `${JSON.stringify(validated)}\n`, "utf8");
        return;
      }
      remaining.push(validated);
      writeFileSync(
        path,
        `${remaining.map((e) => JSON.stringify(e)).join("\n")}\n`,
        "utf8",
      );
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "align-undo log append failed",
      );
    }
  });
}

/**
 * Read the current log and drop entries older than `MAX_AGE_MS`.
 * Returns the surviving entries when a GC pass actually ran, or `null`
 * when the log is small enough to skip the rewrite (cheap append path).
 */
function sweepStale(path: string): AlignUndoEntry[] | null {
  if (!existsSync(path)) return null;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  if (text.trim().length === 0) return null;
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length < GC_THRESHOLD_LINES) return null;
  const cutoff = Date.now() - MAX_AGE_MS;
  const surviving: AlignUndoEntry[] = [];
  for (const line of lines) {
    try {
      const parsed = AlignUndoEntry.parse(JSON.parse(line));
      const ts = Date.parse(parsed.ts);
      if (Number.isFinite(ts) && ts >= cutoff) surviving.push(parsed);
    } catch {
      // Drop malformed entries on this GC pass.
    }
  }
  return surviving;
}

export function readAlignUndoLog(repoRoot: string): AlignUndoEntry[] {
  const path = alignUndoLogPath(repoRoot);
  if (!existsSync(path)) return [];
  const text = readFileSync(path, "utf8");
  if (text.trim().length === 0) return [];
  const out: AlignUndoEntry[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      out.push(AlignUndoEntry.parse(JSON.parse(trimmed)));
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "skipping malformed align-undo entry",
      );
    }
  }
  return out;
}

/**
 * Rewrite the undo log keeping only the entries NOT in `undone`.
 * Idempotency: running `cairn attention undo --since <window>` twice
 * on the same window does nothing the second time because the entries
 * inside the window have already been removed.
 */
export async function pruneAlignUndoLog(
  repoRoot: string,
  remaining: AlignUndoEntry[],
): Promise<void> {
  const path = alignUndoLogPath(repoRoot);
  // Lock so a concurrent `appendAlignUndoEntry` from a parallel Layer A
  // hook can't slip a write between our read and rewrite.
  await withWriteLock(repoRoot, () => {
    try {
      mkdirSync(dirname(path), { recursive: true });
      if (remaining.length === 0) {
        writeFileSync(path, "", "utf8");
        return;
      }
      writeFileSync(
        path,
        `${remaining.map((e) => JSON.stringify(e)).join("\n")}\n`,
        "utf8",
      );
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "align-undo log prune failed",
      );
    }
  });
}
