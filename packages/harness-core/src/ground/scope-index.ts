/**
 * Scope index — forward map from every file path in the repo to the decisions
 * and invariants that apply to that file.
 *
 * Built at init by the Tier-2 mapper LLM, maintained by the daemon. Read by
 * the read-enricher / write-guardian hooks (via cached accessor in
 * `hooks/post-tool-use/ledger-cache.ts`) and by the GC scope-coverage pass.
 *
 * Spec: docs/DOCS_SPEC.md §3.8.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export interface ScopeIndexEntry {
  decisions: string[];
  invariants: string[];
  unscoped?: true;
}

export interface ScopeIndex {
  generated: string;
  files: Record<string, ScopeIndexEntry>;
}

export function scopeIndexPath(repoRoot: string): string {
  return join(repoRoot, ".harness", "ground", "scope-index.yaml");
}

export function readScopeIndex(repoRoot: string): ScopeIndex | null {
  const path = scopeIndexPath(repoRoot);
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = parseYaml(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const generated =
    typeof (parsed as Record<string, unknown>)["generated"] === "string"
      ? ((parsed as Record<string, unknown>)["generated"] as string)
      : new Date().toISOString();
  const filesRaw = (parsed as Record<string, unknown>)["files"];
  const files: Record<string, ScopeIndexEntry> = {};
  if (typeof filesRaw === "object" && filesRaw !== null) {
    for (const [k, v] of Object.entries(filesRaw)) {
      if (typeof v !== "object" || v === null) continue;
      const e = v as Record<string, unknown>;
      const decisions = Array.isArray(e["decisions"])
        ? (e["decisions"] as unknown[]).filter(
            (x): x is string => typeof x === "string",
          )
        : [];
      const invariants = Array.isArray(e["invariants"])
        ? (e["invariants"] as unknown[]).filter(
            (x): x is string => typeof x === "string",
          )
        : [];
      const entry: ScopeIndexEntry = { decisions, invariants };
      if (e["unscoped"] === true) entry.unscoped = true;
      files[k] = entry;
    }
  }
  return { generated, files };
}

export function lookupScope(
  index: ScopeIndex,
  repoRelativePath: string,
): ScopeIndexEntry | null {
  const entry = index.files[repoRelativePath];
  if (entry === undefined) return null;
  return entry;
}

export function writeScopeIndex(repoRoot: string, index: ScopeIndex): void {
  const path = scopeIndexPath(repoRoot);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, stringifyYaml(index), "utf8");
}
