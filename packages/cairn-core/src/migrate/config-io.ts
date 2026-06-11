/**
 * `.cairn/config.yaml` mutation helpers for migrations.
 *
 * Uses the `yaml` Document API so edits preserve key order + comments rather
 * than round-tripping through a plain object. All writes are whole-file
 * rewrites of the single config.yaml — callers serialize via the migrate
 * lock.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { parseDocument, type Document } from "yaml";
import { configPath } from "@isaacriehm/cairn-state";

/**
 * Parse `config.yaml` once. Returns null when absent / unreadable. Pass the
 * result to `readConfigPin` / `configHasKeys` to share a single parse across
 * the runner's read-only selection phase (the apply phase re-reads fresh, since
 * each migration may mutate the file).
 */
export function loadConfigDoc(repoRoot: string): Document | null {
  const p = configPath(repoRoot);
  if (!existsSync(p)) return null;
  try {
    return parseDocument(readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

/** Read the `cairn_version` pin, or null when absent / unreadable. */
export function readConfigPin(repoRoot: string, doc?: Document | null): string | null {
  const d = doc !== undefined ? doc : loadConfigDoc(repoRoot);
  if (d === null) return null;
  const v = d.get("cairn_version");
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** Set the `cairn_version` pin. No-op (returns false) when already equal. */
export function writeConfigPin(repoRoot: string, version: string): boolean {
  const p = configPath(repoRoot);
  if (!existsSync(p)) return false;
  const doc = parseDocument(readFileSync(p, "utf8"));
  if (doc.get("cairn_version") === version) return false;
  doc.set("cairn_version", version);
  writeFileSync(p, doc.toString(), "utf8");
  return true;
}

/** Which of `keys` are present as top-level config keys. */
export function configHasKeys(
  repoRoot: string,
  keys: readonly string[],
  doc?: Document | null,
): string[] {
  const d = doc !== undefined ? doc : loadConfigDoc(repoRoot);
  if (d === null) return [];
  return keys.filter((k) => d.has(k));
}

/**
 * Parse `config.yaml`, hand the Document to `fn`, and write it back iff `fn`
 * reports a mutation. The single round-trip preserves key order + comments
 * outside whatever `fn` rewrites. No-op (returns false) when the file is
 * absent. Callers serialize via the migrate lock.
 */
export function mutateConfig(
  repoRoot: string,
  fn: (doc: Document) => boolean,
): boolean {
  const p = configPath(repoRoot);
  if (!existsSync(p)) return false;
  const doc = parseDocument(readFileSync(p, "utf8"));
  const changed = fn(doc);
  if (changed) writeFileSync(p, doc.toString(), "utf8");
  return changed;
}

/** Delete top-level `keys`; returns the keys actually removed. */
export function deleteConfigKeys(repoRoot: string, keys: readonly string[]): string[] {
  const p = configPath(repoRoot);
  if (!existsSync(p)) return [];
  const doc = parseDocument(readFileSync(p, "utf8"));
  const removed: string[] = [];
  for (const k of keys) {
    if (doc.has(k)) {
      doc.delete(k);
      removed.push(k);
    }
  }
  if (removed.length > 0) writeFileSync(p, doc.toString(), "utf8");
  return removed;
}
