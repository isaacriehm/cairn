/**
 * `.cairn/config.yaml` mutation helpers for migrations.
 *
 * Uses the `yaml` Document API so edits preserve key order + comments rather
 * than round-tripping through a plain object. All writes are whole-file
 * rewrites of the single config.yaml — callers serialize via the migrate
 * lock.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseDocument } from "yaml";

function configPath(repoRoot: string): string {
  return join(repoRoot, ".cairn", "config.yaml");
}

/** Read the `cairn_version` pin, or null when absent / unreadable. */
export function readConfigPin(repoRoot: string): string | null {
  const p = configPath(repoRoot);
  if (!existsSync(p)) return null;
  try {
    const doc = parseDocument(readFileSync(p, "utf8"));
    const v = doc.get("cairn_version");
    return typeof v === "string" && v.length > 0 ? v : null;
  } catch {
    return null;
  }
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
export function configHasKeys(repoRoot: string, keys: readonly string[]): string[] {
  const p = configPath(repoRoot);
  if (!existsSync(p)) return [];
  try {
    const doc = parseDocument(readFileSync(p, "utf8"));
    return keys.filter((k) => doc.has(k));
  } catch {
    return [];
  }
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
