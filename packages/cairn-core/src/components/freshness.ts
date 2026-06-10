/**
 * Headerless component freshness — the edit-time gate (ghost-mode design).
 *
 * In committed mode the `@cairn <Name>` header rots in place the moment someone
 * edits a component and ignores the comment — caught only by a later sensor.
 * Ghost has no header, so the out-of-repo registry has to *detect* a body change
 * at edit time and decide whether the classification it stored is still valid.
 *
 * The hard rule: **the hot edit path never calls the LLM.** This module is the
 * cheap-to-expensive gate that runs on every Write/Edit and exits free at the
 * first layer that settles it. Reclassification (the only LLM spend) is deferred
 * to a quota-expected context (a `components audit` / backfill, or the operator
 * acting on the surfaced "N components changed" offer) — never here.
 *
 *   - **L0 — registered?** Edited path not in the registry → stop. Zero cost.
 *     (Most edits — committed repos exit even earlier on the `isGhost` guard.)
 *   - **L1 — body changed?** Whole-file fingerprint matches the stored hash →
 *     stop. Zero work. (A Write that didn't actually change bytes.)
 *   - **L2 — identity changed (deterministic only)?** Body differs, but the
 *     exports + unit-shape are unchanged and the registered export symbol still
 *     exists → an internal refactor → refresh the fingerprint, no flag, no LLM.
 *   - **L3 — identity may have genuinely changed.** Exports changed, the shape
 *     flipped, or the registered export vanished → mark the entry
 *     `needs_reconfirm` (+ refresh the fingerprint/snapshot), free. The expensive
 *     reclassify runs later.
 *
 * v1 anchors on a whole-file fingerprint (one component per file is the UI
 * convention, so the file body *is* the component span); the export-span hash is
 * a later precision refinement. Every path is `isGhost`-gated — committed mode's
 * header is its own SoT and this never runs there.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  bodyContentHash,
  extractExportNames,
  isGhost,
  lookupComponentEntryByFile,
  profileForFile,
  readComponentRegistry,
  registerComponentEntry,
  type ComponentRegistryEntry,
} from "@isaacriehm/cairn-state";
import { logger } from "../logger.js";

const log = logger("components.freshness");

export type FreshnessAction =
  | "inert" // committed mode — the gate does not apply
  | "not-registered" // L0 — path isn't a registered unit
  | "unchanged" // L1 — whole-file fingerprint still matches
  | "refreshed" // L2 — internal refactor; fingerprint/snapshot refreshed, no flag
  | "reconfirm"; // L3 — identity changed; entry flagged needs_reconfirm

export interface FreshnessResult {
  action: FreshnessAction;
  /** Repo-relative path the gate ran against. */
  file: string;
  /** The registered component name, when the path resolved to one. */
  name: string | null;
  /**
   * Operator-facing one-liner for the L3 case (surfaced as a PostToolUse hint),
   * or null for every settled-free outcome.
   */
  hint: string | null;
}

function inert(file: string): FreshnessResult {
  return { action: "inert", file, name: null, hint: null };
}

/** Set equality, order-independent — a reorder is not an identity change. */
function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = new Set(a);
  for (const x of b) if (!sa.has(x)) return false;
  return true;
}

/**
 * Run the L0–L3 freshness gate against one repo-relative file. Pure, fast,
 * deterministic — NO LLM. Mutates the registry only when a registered
 * component's body actually changed (L2 refresh or L3 flag). Best-effort: any
 * failure degrades to `inert` so the hot Write path is never blocked.
 */
export function runComponentFreshness(
  repoRoot: string,
  relPath: string,
): FreshnessResult {
  try {
    // Committed mode: the in-file header is the SoT — this gate does not apply.
    if (!isGhost(repoRoot)) return inert(relPath);

    // L0 — is this a registered unit? (Cheap: one small yaml read, memoized
    // isGhost already short-circuited committed repos to zero cost.)
    const reg = readComponentRegistry(repoRoot);
    const entry = lookupComponentEntryByFile(reg, relPath);
    if (entry === null) {
      return { action: "not-registered", file: relPath, name: null, hint: null };
    }

    const abs = join(repoRoot, relPath);
    if (!existsSync(abs)) {
      // Deletion is GC/orphan territory, not freshness — leave the entry as-is.
      return { action: "not-registered", file: relPath, name: entry.name, hint: null };
    }
    let source: string;
    try {
      source = readFileSync(abs, "utf8");
    } catch {
      return { action: "not-registered", file: relPath, name: entry.name, hint: null };
    }

    // L1 — body changed? Whole-file fingerprint vs the stored hash.
    const hash = bodyContentHash(source);
    if (hash === entry.anchor.content_hash) {
      return { action: "unchanged", file: relPath, name: entry.name, hint: null };
    }

    // Body differs — L2/L3 deterministic identity check.
    const exportsNow = extractExportNames(source, relPath);
    const shapeNow = profileForFile(relPath)?.isUnitShaped(source, relPath) ?? false;

    // No baseline snapshot (legacy entry registered before snapshots existed):
    // backfill it on this edit, never flag — we have nothing to compare against.
    const hasBaseline =
      (entry.exports?.length ?? 0) > 0 || entry.unit_shaped !== undefined;

    const identityChanged =
      hasBaseline &&
      (!sameSet(exportsNow, entry.exports ?? []) ||
        (entry.unit_shaped !== undefined && entry.unit_shaped !== shapeNow) ||
        !exportsNow.includes(entry.export));

    const updated: ComponentRegistryEntry = {
      ...entry,
      anchor: { ...entry.anchor, content_hash: hash },
      exports: exportsNow,
      unit_shaped: shapeNow,
      // Latch the flag: an internal refactor must NOT clear a reconfirm that a
      // prior identity change already raised — only an actual reclassify clears
      // it. So once true, stay true until re-confirmed.
      needs_reconfirm: identityChanged ? true : entry.needs_reconfirm,
    };
    registerComponentEntry(repoRoot, updated, reg);

    if (identityChanged) {
      return {
        action: "reconfirm",
        file: relPath,
        name: entry.name,
        hint: `⬡ ${entry.name} changed shape/exports — re-confirm its registry purpose with \`cairn components audit\` (ghost: no source edit).`,
      };
    }
    return { action: "refreshed", file: relPath, name: entry.name, hint: null };
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err), file: relPath },
      "component freshness gate failed; degrading to inert",
    );
    return inert(relPath);
  }
}
