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
import { detectAll } from "../init/detect.js";
import {
  buildMapperUserPrompt,
  MAPPER_OUTPUT_SCHEMA,
  MAPPER_SYSTEM_PROMPT,
  validateMapperOutput,
  type MapperOutput,
  type MapperScopeIndex,
} from "../init/mapper.js";
import { buildRepoSummary } from "../init/walker.js";
import { logger } from "../logger.js";
import { runClaude } from "../claude/index.js";

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

const log = logger("ground.scope-index");

export interface RebuildScopeIndexOptions {
  repoRoot: string;
  /** Hard timeout for the mapper LLM call (ms). Default 300000. */
  timeoutMs?: number;
}

export interface RebuildScopeIndexResult {
  /** Absolute path to the file written. */
  path: string;
  /** Number of files classified in the new index. */
  filesClassified: number;
  /** Mapper duration in ms. */
  mapperDurationMs: number;
  /** Resolved model id. */
  model: string;
}

/**
 * Re-run the init mapper LLM scoped to the scope-index field of its output and
 * write the result to `.harness/ground/scope-index.yaml`. Used by the
 * `harness scope rebuild` CLI subcommand to populate scope coverage after
 * decisions/invariants land — the init-time skeleton ships empty.
 *
 * Throws if the LLM call fails. Caller (CLI) catches and prints a user-facing
 * error.
 */
export async function rebuildScopeIndex(
  opts: RebuildScopeIndexOptions,
): Promise<RebuildScopeIndexResult> {
  const detection = await detectAll(opts.repoRoot);
  const summary = buildRepoSummary({ repoRoot: opts.repoRoot });
  const userPrompt = buildMapperUserPrompt({ detection, summary });

  log.info(
    {
      slug: detection.project_slug,
      total_files: summary.total_files,
    },
    "scope rebuild — mapper dispatch",
  );

  const result = await runClaude({
    tier: "sonnet",
    prompt: userPrompt,
    system: MAPPER_SYSTEM_PROMPT,
    jsonSchema: MAPPER_OUTPUT_SCHEMA as object,
    timeoutMs: opts.timeoutMs ?? 300_000,
  });
  const mapperOutput: MapperOutput = validateMapperOutput(result.parsed);
  const scopeIndex: MapperScopeIndex = mapperOutput.scope_index;

  // Coerce mapper-shape `unscoped: boolean` → ground-shape `unscoped: true`.
  const files: Record<string, ScopeIndexEntry> = {};
  for (const [path, e] of Object.entries(scopeIndex.files)) {
    const entry: ScopeIndexEntry = {
      decisions: e.decisions,
      invariants: e.invariants,
    };
    if (e.unscoped === true) entry.unscoped = true;
    files[path] = entry;
  }
  const next: ScopeIndex = {
    generated: new Date().toISOString(),
    files,
  };
  writeScopeIndex(opts.repoRoot, next);

  return {
    path: scopeIndexPath(opts.repoRoot),
    filesClassified: Object.keys(files).length,
    mapperDurationMs: result.durationMs,
    model: result.model,
  };
}
