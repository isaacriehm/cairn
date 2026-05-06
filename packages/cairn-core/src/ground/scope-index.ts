/**
 * Scope index — forward map from every file path in the repo to the decisions
 * and invariants that apply to that file.
 *
 * Built at init by the Tier-2 mapper LLM, maintained by the GC sweep + the
 * MCP record-decision tool when scope edits land. Read by the read-enricher
 * / write-guardian hooks (via cached accessor in
 * `hooks/post-tool-use/ledger-cache.ts`) and by the GC scope-coverage pass.
 *
 * Spec: docs/FILESYSTEM_LAYOUT.md §2.1.
 */

import { execFileSync } from "node:child_process";
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

const DEC_ID_RE = /\bDEC-[0-9a-f]{7,}\b/;
const INV_ID_RE = /\bINV-[0-9a-f]{7,}\b/;

/**
 * Mapper LLMs occasionally emit ledger-entry PROSE ("HTTP layer is the only
 * public surface…") into `decisions[]` / `invariants[]` instead of bare IDs,
 * because the user prompt lists them as `${id} — ${title}` and the JSON-mode
 * schema only constrains the type to `string`. This coercer extracts the
 * first ID-shaped token from each string and silently drops anything that
 * doesn't match — IDs only, deduplicated, order preserved.
 */
export function coerceDecisionIds(raw: readonly unknown[]): string[] {
  return coerceIds(raw, DEC_ID_RE);
}

export function coerceInvariantIds(raw: readonly unknown[]): string[] {
  return coerceIds(raw, INV_ID_RE);
}

function coerceIds(raw: readonly unknown[], re: RegExp): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const s of raw) {
    if (typeof s !== "string") continue;
    const m = s.match(re);
    if (m === null) continue;
    if (seen.has(m[0])) continue;
    seen.add(m[0]);
    out.push(m[0]);
  }
  return out;
}

export interface ScopeIndex {
  generated: string;
  files: Record<string, ScopeIndexEntry>;
}

export function scopeIndexPath(repoRoot: string): string {
  return join(repoRoot, ".cairn", "ground", "scope-index.yaml");
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

/* -------------------------------------------------------------------------- */
/* Deterministic citation rescan                                              */
/* -------------------------------------------------------------------------- */

const CITATION_RE = /§(?:INV|DEC)-\d{4,}/g;

const RESCAN_SOURCE_EXT_RE =
  /\.(?:ts|tsx|cts|mts|js|jsx|cjs|mjs|py|rb|go|rs|java|kt|swift|c|cc|cpp|h|hpp|cs|php|sql|sh|bash)$/i;

const RESCAN_SKIP_DIR_RE =
  /(?:^|\/)(?:node_modules|dist|build|out|\.next|\.turbo|\.cache|coverage|\.cairn|\.archive|\.git)(?:\/|$)/;

export interface RescanScopeIndexResult {
  filesScanned: number;
  entriesAdded: number;
  entriesUpdated: number;
  entriesUnchanged: number;
  /** True when scope-index.yaml was rewritten. */
  dirty: boolean;
}

/**
 * Deterministic regex sweep — walk every git-tracked source file, parse
 * `§INV-NNNN` / `§DEC-NNNN` cite tokens, and sync the scope-index so the
 * in-scope tools never lag behind source-cite reality. No LLM, no
 * incremental tracking complexity. Cheap enough to run on every
 * SessionStart (~100ms on 50k files).
 *
 * Honors `unscoped: true` entries — never touches them. Skips files with
 * no citations and no prior entry to avoid polluting the index. When a
 * file's cite set differs from its scope-index entry (added, removed, or
 * stale ids), the entry is rewritten with the deterministically-sorted
 * current set.
 */
export function rescanScopeIndex(repoRoot: string): RescanScopeIndexResult {
  const sourceFiles = listGitTrackedSourceFiles(repoRoot);
  const existing = readScopeIndex(repoRoot) ?? {
    generated: new Date().toISOString(),
    files: {},
  };
  let entriesAdded = 0;
  let entriesUpdated = 0;
  let entriesUnchanged = 0;
  let dirty = false;

  for (const rel of sourceFiles) {
    const prior = existing.files[rel];
    if (prior?.unscoped === true) continue;
    const found = scanFileCitations(join(repoRoot, rel));
    if (found === null) continue;

    if (
      found.decisions.length === 0 &&
      found.invariants.length === 0 &&
      prior === undefined
    ) {
      continue;
    }

    if (prior === undefined) {
      existing.files[rel] = {
        decisions: found.decisions,
        invariants: found.invariants,
      };
      entriesAdded += 1;
      dirty = true;
      continue;
    }

    const sameDecs =
      prior.decisions.length === found.decisions.length &&
      prior.decisions.every((d, i) => d === found.decisions[i]);
    const sameInvs =
      prior.invariants.length === found.invariants.length &&
      prior.invariants.every((v, i) => v === found.invariants[i]);
    if (sameDecs && sameInvs) {
      entriesUnchanged += 1;
      continue;
    }

    existing.files[rel] = {
      decisions: found.decisions,
      invariants: found.invariants,
    };
    entriesUpdated += 1;
    dirty = true;
  }

  if (dirty) {
    writeScopeIndex(repoRoot, {
      generated: new Date().toISOString(),
      files: existing.files,
    });
  }

  return {
    filesScanned: sourceFiles.length,
    entriesAdded,
    entriesUpdated,
    entriesUnchanged,
    dirty,
  };
}

function scanFileCitations(
  absPath: string,
): { decisions: string[]; invariants: string[] } | null {
  let body: string;
  try {
    body = readFileSync(absPath, "utf8");
  } catch {
    return null;
  }
  return parseCitations(body);
}

function parseCitations(body: string): {
  decisions: string[];
  invariants: string[];
} {
  const decs = new Set<string>();
  const invs = new Set<string>();
  for (const m of body.matchAll(CITATION_RE)) {
    const tok = m[0].slice(1);
    if (tok.startsWith("DEC-")) decs.add(tok);
    else if (tok.startsWith("INV-")) invs.add(tok);
  }
  return {
    decisions: [...decs].sort(),
    invariants: [...invs].sort(),
  };
}

/**
 * Single-file scope-index sync from in-memory content. Called by the
 * PostToolUse(Write/Edit) hook so an agent's writes don't leave the
 * scope-index stale until the next SessionStart rescan. Same regex
 * parser as `rescanScopeIndex`, but bounded to one file — O(1) cost,
 * no walker.
 *
 * Honors `unscoped: true` entries (skips them). Honors the same skip
 * rule the rescan does: file with no citations and no prior entry is
 * a no-op so we don't pollute the index with empty rows.
 */
export function syncFileScopeFromContent(
  repoRoot: string,
  repoRelPath: string,
  content: string,
): { dirty: boolean } {
  const found = parseCitations(content);
  const existing = readScopeIndex(repoRoot) ?? {
    generated: new Date().toISOString(),
    files: {},
  };
  const prior = existing.files[repoRelPath];
  if (prior?.unscoped === true) return { dirty: false };
  if (
    found.decisions.length === 0 &&
    found.invariants.length === 0 &&
    prior === undefined
  ) {
    return { dirty: false };
  }
  if (prior !== undefined) {
    const sameDecs =
      prior.decisions.length === found.decisions.length &&
      prior.decisions.every((d, i) => d === found.decisions[i]);
    const sameInvs =
      prior.invariants.length === found.invariants.length &&
      prior.invariants.every((v, i) => v === found.invariants[i]);
    if (sameDecs && sameInvs) return { dirty: false };
  }
  existing.files[repoRelPath] = {
    decisions: found.decisions,
    invariants: found.invariants,
  };
  writeScopeIndex(repoRoot, {
    generated: new Date().toISOString(),
    files: existing.files,
  });
  return { dirty: true };
}

function listGitTrackedSourceFiles(repoRoot: string): string[] {
  let out: string;
  try {
    out = execFileSync(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      { cwd: repoRoot, maxBuffer: 100 * 1024 * 1024 },
    ).toString("utf8");
  } catch {
    return [];
  }
  const acc: string[] = [];
  for (const path of out.split("\0")) {
    if (path.length === 0) continue;
    if (RESCAN_SKIP_DIR_RE.test(path)) continue;
    if (!RESCAN_SOURCE_EXT_RE.test(path)) continue;
    acc.push(path);
  }
  return acc;
}

export interface RebuildScopeIndexOptions {
  repoRoot: string;
  /** Hard timeout for the mapper LLM call (ms). Default 300000. */
  timeoutMs?: number;
}

export interface RebuildScopeIndexResult {
  /** Absolute path to the file written. */
  path: string;
  /** Total scope-index entries after the rescan (added + updated + unchanged). */
  filesClassified: number;
  /** Wall-clock ms for the rescan. */
  durationMs: number;
}

/**
 * `cairn scope rebuild` — full deterministic resync of `.cairn/ground/
 * scope-index.yaml` from current source-cite reality. Used to be a
 * Sonnet call (`runMapper`-style) that re-classified files via the
 * Tier-2 mapper, but classification was always the wrong abstraction
 * — bare-symbol citations in source are the canonical source of truth,
 * `rescanScopeIndex` parses them deterministically, and the result
 * matches what the read-enricher legend actually shows.
 *
 * No LLM. No tokens. No mapper. Just a regex sweep over git-tracked
 * source files and an atomic write.
 */
export async function rebuildScopeIndex(
  opts: RebuildScopeIndexOptions,
): Promise<RebuildScopeIndexResult> {
  log.info({ repo_root: opts.repoRoot }, "scope rebuild — deterministic rescan");
  const startedAt = Date.now();
  const result = rescanScopeIndex(opts.repoRoot);
  return {
    path: scopeIndexPath(opts.repoRoot),
    filesClassified:
      result.entriesAdded + result.entriesUpdated + result.entriesUnchanged,
    durationMs: Date.now() - startedAt,
  };
}
