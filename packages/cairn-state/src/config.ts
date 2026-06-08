/**
 * Top-level `.cairn/config.yaml` reader for the non-component sections.
 *
 * (The `components:` block has its own typed loader in components.ts.)
 * Kept deliberately small + tolerant: a missing or malformed config is
 * never fatal — callers get the documented defaults.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

/** Parse `.cairn/config.yaml` into a plain object ({} when absent/broken). */
export function loadCairnConfig(repoRoot: string): Record<string, unknown> {
  const p = join(repoRoot, ".cairn", "config.yaml");
  if (!existsSync(p)) return {};
  try {
    const doc = parseYaml(readFileSync(p, "utf8"));
    return typeof doc === "object" && doc !== null
      ? (doc as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/**
 * Whether AI-proposed decisions + invariants auto-accept into the ledger
 * instead of queuing as `_inbox/` drafts for operator triage.
 *
 * Defaults to TRUE — Cairn runs inside an autonomous coding agent and the
 * human review checkpoint shifts to the committed-ground-state PR diff
 * (see docs/PLUGIN_ARCHITECTURE.md). Set `decisions.auto_accept: false`
 * in `.cairn/config.yaml` to restore the per-draft triage queue.
 */
export function decisionsAutoAccept(repoRoot: string): boolean {
  const cfg = loadCairnConfig(repoRoot);
  const decisions = cfg["decisions"];
  if (typeof decisions === "object" && decisions !== null) {
    const v = (decisions as Record<string, unknown>)["auto_accept"];
    if (typeof v === "boolean") return v;
  }
  return true;
}
