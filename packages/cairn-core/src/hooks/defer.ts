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
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";

export type DeferKind = "bypass" | "review";

export interface DeferState {
  /** ISO timestamp when the operator chose defer. */
  deferred_at: string;
  /** Hours from `deferred_at` until the suppression window expires. */
  deferred_for_hours: number;
  /** Bypass commit SHAs at the time of defer (full SHAs, not short). */
  flagged_shas: string[];
  /** Reviewer-pending task ids at the time of defer. */
  flagged_task_ids: string[];
}

const DEFAULT_DEFER_HOURS = 24;

export function deferStatePath(repoRoot: string, kind: DeferKind): string {
  return join(repoRoot, ".cairn", `.${kind}-deferred-until`);
}

export function readDeferState(repoRoot: string, kind: DeferKind): DeferState | null {
  const path = deferStatePath(repoRoot, kind);
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  if (!isDeferState(parsed)) return null;
  return parsed;
}

export function writeDeferState(
  repoRoot: string,
  kind: DeferKind,
  snapshot: {
    flagged_shas?: string[];
    flagged_task_ids?: string[];
    /** Override defer window. Default from config.yaml or 24h. */
    hours?: number;
    /** ISO timestamp; defaults to new Date().toISOString(). */
    nowIso?: string;
  },
): DeferState {
  let defaultHours = DEFAULT_DEFER_HOURS;
  try {
    const cfgPath = join(repoRoot, ".cairn", "config.yaml");
    if (existsSync(cfgPath)) {
      const cfg = parseYaml(readFileSync(cfgPath, "utf8"));
      if (cfg && typeof cfg === "object" && typeof cfg.defer_hours === "number") {
        defaultHours = cfg.defer_hours;
      }
    }
  } catch {
    // stay with 24
  }

  const state: DeferState = {
    deferred_at: snapshot.nowIso ?? new Date().toISOString(),
    deferred_for_hours: snapshot.hours ?? defaultHours,
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

/**
 * Returns true when `state` is still suppressing — within the time
 * window AND every currently-flagged item is in the deferred snapshot
 * (no new bypasses / new pending reviews have appeared).
 *
 * If anything new appears, the suppression breaks and the Stop hook
 * surfaces the warning again — which is the right behavior, because
 * "defer for 24h" was a promise about the items the operator saw,
 * not a blanket mute.
 */
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

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function isDeferState(x: unknown): x is DeferState {
  if (x === null || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o["deferred_at"] === "string" &&
    typeof o["deferred_for_hours"] === "number" &&
    isStringArray(o["flagged_shas"]) &&
    isStringArray(o["flagged_task_ids"])
  );
}
