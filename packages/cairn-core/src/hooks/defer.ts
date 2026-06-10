/**
 * Stop-hook signal debounce.
 *
 * Per-kind defer file: when the operator picks `[c]` defer on the
 * inline A/B/C, cairn_resolve_attention writes
 * `.cairn/.{bypass,review}-deferred-until` with the snapshot of
 * SHAs / task-ids that were flagged. Subsequent Stop hooks suppress
 * the warning while:
 *   1. now < deferred_at + deferred_for_hours, AND
 *   2. the current scan's flagged set ⊆ the deferred set
 *      (anything new shows up).
 *
 * Pure read/write/check helpers — no side effects beyond filesystem.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { cairnDir } from "@isaacriehm/cairn-state";

export type DeferKind = "bypass" | "review";

const DeferStateSchema = z.object({
  deferred_at: z.string(),
  deferred_for_hours: z.number(),
  flagged_shas: z.array(z.string()),
  flagged_task_ids: z.array(z.string()),
});

export type DeferState = z.infer<typeof DeferStateSchema>;

const DEFAULT_DEFER_HOURS = 24;

export function deferStatePath(repoRoot: string, kind: DeferKind): string {
  return cairnDir(repoRoot, `.${kind}-deferred-until`);
}

export function readDeferState(repoRoot: string, kind: DeferKind): DeferState | null {
  const path = deferStatePath(repoRoot, kind);
  if (!existsSync(path)) return null;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    const result = DeferStateSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export function writeDeferState(
  repoRoot: string,
  kind: DeferKind,
  snapshot: {
    flagged_shas?: string[];
    flagged_task_ids?: string[];
    /** Override defer window. Default 24h. */
    hours?: number;
    /** ISO timestamp; defaults to new Date().toISOString(). */
    nowIso?: string;
  },
): DeferState {
  const state: DeferState = {
    deferred_at: snapshot.nowIso ?? new Date().toISOString(),
    deferred_for_hours: snapshot.hours ?? DEFAULT_DEFER_HOURS,
    flagged_shas: [...(snapshot.flagged_shas ?? [])],
    flagged_task_ids: [...(snapshot.flagged_task_ids ?? [])],
  };
  const path = deferStatePath(repoRoot, kind);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2), "utf8");
  return state;
}

export function clearDeferState(repoRoot: string, kind: DeferKind): void {
  rmSync(deferStatePath(repoRoot, kind), { force: true });
}

export function isDeferActive(
  state: DeferState,
  now: Date,
  currentItems: { kind: "shas" | "task_ids"; values: string[] },
): boolean {
  const deferredAt = Date.parse(state.deferred_at);
  if (Number.isNaN(deferredAt)) return false;
  const expiresAt = deferredAt + state.deferred_for_hours * 60 * 60 * 1000;
  if (now.getTime() >= expiresAt) return false;

  const snapshotSet = new Set(
    currentItems.kind === "shas" ? state.flagged_shas : state.flagged_task_ids,
  );
  for (const item of currentItems.values) {
    if (!snapshotSet.has(item)) return false;
  }
  return true;
}
