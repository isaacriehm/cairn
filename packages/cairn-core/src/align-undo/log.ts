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
import { dirname, join } from "node:path";
import { z } from "zod";
import { logger } from "../logger.js";

const log = logger("align-undo.log");

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
  return join(repoRoot, ".cairn", "state", "align-undo-log.jsonl");
}

export function appendAlignUndoEntry(repoRoot: string, entry: AlignUndoEntry): void {
  const validated = AlignUndoEntry.parse(entry);
  const path = alignUndoLogPath(repoRoot);
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(validated)}\n`, "utf8");
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "align-undo log append failed",
    );
  }
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
export function pruneAlignUndoLog(
  repoRoot: string,
  remaining: AlignUndoEntry[],
): void {
  const path = alignUndoLogPath(repoRoot);
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
}
