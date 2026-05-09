/**
 * Stop-hook signal debounce.
 *
 * Per-kind defer file: when the operator picks `[c]` defer on the
 * inline A/B/C, cairn_resolve_attention writes
 * `.cairn/.{bypass,review}-deferred-until` with the snapshot of
 * SHAs / task ids. The Stop hook in OTHER sessions reads this and
 * stays inert iff the current flagged set is a subset of the
 * deferred set and the TTL hasn't expired.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

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
  return join(repoRoot, ".cairn", `.${kind}-deferred-until`);
}

export function readDeferState(repoRoot: string, kind: DeferKind): DeferState | null {
  const path = deferStatePath(repoRoot, kind);
  if (!existsSync(path)) return null;
  
  try {
    const raw = readFileSync(path, "utf8");
    const parsed: unknown = JSON.parse(raw);
    const result = DeferStateSchema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

export function writeDeferState(
  repoRoot: string,
  kind: DeferKind,
  state: { flaggedShas: string[]; flaggedTaskIds: string[] },
): string {
  const path = deferStatePath(repoRoot, kind);
  const payload: DeferState = {
    deferred_at: new Date().toISOString(),
    deferred_for_hours: DEFAULT_DEFER_HOURS,
    flagged_shas: state.flaggedShas,
    flagged_task_ids: state.flaggedTaskIds,
  };
  mkdirSync(join(repoRoot, ".cairn"), { recursive: true });
  writeFileSync(path, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return path;
}

export function clearDeferState(repoRoot: string, kind: DeferKind): void {
  const path = deferStatePath(repoRoot, kind);
  try {
    rmSync(path, { force: true });
  } catch {
    /* ignore */
  }
}

/**
 * Returns true if `currentItems` should be suppressed based on `state`.
 */
export function isCurrentlyDeferred(
  state: DeferState,
  currentItems: { kind: "shas" | "tasks"; values: string[] },
): boolean {
  const now = new Date();
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
