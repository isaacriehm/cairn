/**
 * Curator pipeline — Phase 9a-walker top-level (v0.9.0).
 *
 * Builds the unified corpus by running three sub-walkers:
 *
 *   - Source comments (existing `walkSourceComments`) — essay-class
 *     block comments per source file
 *   - Doc paragraphs (existing `discoverDocs` + paragraph splitter)
 *     — README + docs/**\/*.md paragraphs ≥80 chars
 *   - Rule sections (existing `discoverRuleSources` +
 *     `parseRuleSections`) — H2/H3 sections from CLAUDE.md /
 *     AGENTS.md / .claude/rules/**\/*.md
 *
 * Each candidate runs through the regex pre-filter (`regex-prefilter.ts`)
 * which drops 60-80% of raw blocks (test files, JSX comments, license
 * headers, JSDoc with only @tags, etc.). Survivors get written to
 * `.cairn/init/curator/corpus.jsonl` and packed into shards capped
 * at 120k input tokens (`shards.json`).
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { walkSourceComments } from "../source-comments/walker.js";
import { discoverRuleSources } from "../rules-merge/discover.js";
import { parseRuleSections } from "../rules-merge/parse-sections.js";
import {
  applyPrefilter,
  type DropReason,
} from "./regex-prefilter.js";
import {
  packShards,
  writeCorpus,
  writeShardCorpora,
  writeShards,
  type CorpusRecord,
  type SourceKind,
} from "./corpus.js";
import { walkFs } from "@isaacriehm/cairn-state";
import type { Dirent } from "node:fs";
import { readMapperOutputFile } from "../phases/mapper-output-io.js";

const MIN_DOC_PARAGRAPH_CHARS = 80;
const SOURCE_FILE_CAP = 5_000;
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "target",
  "out",
  ".next",
  ".turbo",
  ".cairn",
]);

export interface RunCuratorWalkerArgs {
  repoRoot: string;
}

export interface RunCuratorWalkerResult {
  corpus_path: string;
  shards_path: string;
  records_total: number;
  records_by_kind: { comment: number; doc: number; rule: number };
  dropped: Record<string, number>;
  shards: number;
  total_input_tokens_estimate: number;
}

export async function runCuratorWalker(
  args: RunCuratorWalkerArgs,
): Promise<RunCuratorWalkerResult> {
  const { repoRoot } = args;
  const offLimitsGlobs = loadOffLimitsGlobs(repoRoot);
  const moduleFlagsByPrefix = loadModuleFlags(repoRoot);

  const dropped: Record<DropReason, number> = {
    "test-file": 0,
    "generated-dir": 0,
    "archive-dir": 0,
    "off-limits-glob": 0,
    "jsx-block-comment": 0,
    "license-header": 0,
    "jsdoc-tag-only": 0,
    "todo-or-banner-only": 0,
    "below-minimum-prose": 0,
  };

  const records: CorpusRecord[] = [];

  // ── 1. Source-comment sub-walker ──────────────────────────────────
  const commentWalk = walkSourceComments({
    repoRoot,
    fileCap: SOURCE_FILE_CAP,
  });
  for (const block of commentWalk.blocks) {
    const result = applyPrefilter({
      file: block.file,
      source_kind: "comment",
      prose: block.prose,
      raw: block.raw,
      offLimitsGlobs,
    });
    if (result.drop) {
      dropped[result.reason as DropReason] += 1;
      continue;
    }
    const moduleSlug = moduleSlugForFile(block.file);
    const enclosing = detectEnclosingSymbol(repoRoot, block.file, block.endOffset);
    const record: CorpusRecord = {
      comment_id: shortHash(`${block.file}:${block.startLine}-${block.endLine}`),
      source_kind: "comment",
      file: block.file,
      module: moduleSlug,
      lang: block.lang,
      prose_clean: result.cleanedProse,
      nearby_imports: detectNearbyImports(repoRoot, block.file),
      module_flags: moduleFlagsByPrefix[moduleSlug] ?? [],
      line_range: [block.startLine, block.endLine],
    };
    if (enclosing !== undefined) record.enclosing_symbol = enclosing;
    records.push(record);
  }

  // ── 2. Doc-paragraph sub-walker ───────────────────────────────────
  for (const doc of discoverDocsForCurator(repoRoot)) {
    let raw: string;
    try {
      raw = readFileSync(join(repoRoot, doc), "utf8");
    } catch {
      continue;
    }
    const paragraphs = splitMarkdownParagraphs(raw);
    let lineCursor = 1;
    for (const p of paragraphs) {
      const startLine = lineCursor;
      const endLine = startLine + countNewlines(p) - 1;
      lineCursor = endLine + 2; // +1 for the trailing newline + 1 blank-line separator
      if (p.length < MIN_DOC_PARAGRAPH_CHARS) continue;
      const result = applyPrefilter({
        file: doc,
        source_kind: "doc",
        prose: p,
        offLimitsGlobs,
      });
      if (result.drop) {
        dropped[result.reason as DropReason] += 1;
        continue;
      }
      const moduleSlug = "docs";
      records.push({
        comment_id: shortHash(`${doc}:${startLine}-${endLine}`),
        source_kind: "doc",
        file: doc,
        module: moduleSlug,
        lang: "md",
        prose_clean: result.cleanedProse,
        line_range: [startLine, endLine],
        module_flags: moduleFlagsByPrefix[moduleSlug] ?? [],
      });
    }
  }

  // ── 3. Rule-section sub-walker ────────────────────────────────────
  for (const ruleFile of discoverRuleSources(repoRoot)) {
    let raw: string;
    try {
      raw = readFileSync(ruleFile.absPath, "utf8");
    } catch {
      continue;
    }
    const sections = parseRuleSections(raw);
    for (const sec of sections) {
      // Preamble (level 0) is the first slab before any heading; rare
      // to carry a real decision and often boilerplate. Skip.
      if (sec.level === 0) continue;
      // Honor operator-protected `<!-- cairn:keep --> ` blocks — those
      // are deliberately kept untouched.
      if (sec.protectedByKeepMarker) continue;
      const startLine = lineFromOffset(raw, sec.startOffset);
      const endLine = startLine + countNewlines(sec.body) - 1;
      const result = applyPrefilter({
        file: ruleFile.path,
        source_kind: "rule",
        prose: sec.body,
        offLimitsGlobs,
      });
      if (result.drop) {
        dropped[result.reason as DropReason] += 1;
        continue;
      }
      const moduleSlug = "rules";
      records.push({
        comment_id: shortHash(`${ruleFile.path}:${startLine}-${endLine}`),
        source_kind: "rule",
        file: ruleFile.path,
        module: moduleSlug,
        lang: "md",
        prose_clean: result.cleanedProse,
        line_range: [startLine, endLine],
        module_flags: moduleFlagsByPrefix[moduleSlug] ?? [],
      });
    }
  }

  // ── 4. Persist corpus + per-shard slices + shard plan ─────────────
  const corpus = writeCorpus(repoRoot, records);
  const plan = packShards(records);
  // Write ready-to-read per-shard corpus slices BEFORE the plan so each
  // shard's `shard_file` basename lands in shards.json. The cairn-adopt
  // skill reads these directly instead of slicing the corpus in Bash.
  writeShardCorpora(repoRoot, records, plan);
  const shardsPath = writeShards(repoRoot, plan);

  return {
    corpus_path: corpus.corpus_path,
    shards_path: shardsPath,
    records_total: corpus.records_total,
    records_by_kind: corpus.records_by_kind,
    dropped,
    shards: plan.shards.length,
    total_input_tokens_estimate: plan.total_input_tokens_estimate,
  };
}

/* -------------------------------------------------------------------------- */
/* Helpers — module / docs / rules / off-limits                               */
/* -------------------------------------------------------------------------- */

function moduleSlugForFile(file: string): string {
  // Top-level dir wins; if path has no dir, use "(root)".
  const idx = file.indexOf("/");
  if (idx === -1) return "(root)";
  return file.slice(0, idx);
}

function loadOffLimitsGlobs(repoRoot: string): string[] {
  const mapperOut = readMapperOutputFile(repoRoot);
  const fromMapper = mapperOut?.output.off_limits_globs;
  if (Array.isArray(fromMapper)) return fromMapper;
  return [];
}

function loadModuleFlags(repoRoot: string): Record<string, string[]> {
  const mapperOut = readMapperOutputFile(repoRoot);
  const km = mapperOut?.output.key_modules;
  if (!Array.isArray(km)) return {};
  const out: Record<string, string[]> = {};
  for (const m of km) {
    if (typeof m !== "object" || m === null) continue;
    const slug = (m as { slug?: unknown }).slug;
    const flags = (m as { flags?: unknown }).flags;
    if (typeof slug === "string" && Array.isArray(flags)) {
      out[slug] = flags.filter((f): f is string => typeof f === "string");
    }
  }
  return out;
}

/**
 * Doc-walker for curator. Includes README + every .md under `docs/`,
 * skipping `.archive/`, `.planning/archive/`, and the standard
 * generated-output dirs. Mirrors `discoverDocs` but adds the README at
 * the repo root and tolerates missing `docs/` dirs gracefully.
 */
function discoverDocsForCurator(repoRoot: string): string[] {
  const out: string[] = [];
  for (const top of ["README.md", "README", "Readme.md"]) {
    if (existsSync(join(repoRoot, top))) {
      out.push(top);
      break;
    }
  }
  const docsDir = join(repoRoot, "docs");
  if (existsSync(docsDir)) {
    walkFs({
      dir: docsDir,
      repoRoot,
      onDir: (_rel: string, _abs: string, ent: Dirent) => {
        if (ent.name.startsWith(".")) return false;
        if (SKIP_DIRS.has(ent.name)) return false;
        return true;
      },
      onFile: (rel: string, abs: string, ent: Dirent) => {
        if (!ent.name.endsWith(".md")) return;
        // Drop .planning/archive/ paths.
        if (/(?:^|\/)\.planning\/archive\//.test(rel)) return;
        try {
          statSync(abs);
        } catch {
          return;
        }
        out.push(rel);
      },
    });
  }
  return out;
}

/**
 * Split markdown into paragraphs on blank-line boundaries. Headings
 * become standalone paragraphs (the heading line itself + nothing
 * else), so the prefilter's "below-minimum-prose" rule sweeps them
 * out. Code fences stay as one paragraph each.
 */
function splitMarkdownParagraphs(raw: string): string[] {
  const out: string[] = [];
  const lines = raw.split("\n");
  let buffer: string[] = [];
  let inFence = false;
  const flush = (): void => {
    if (buffer.length === 0) return;
    const joined = buffer.join("\n").trim();
    if (joined.length > 0) out.push(joined);
    buffer = [];
  };
  for (const line of lines) {
    if (/^\s*```/.test(line)) {
      buffer.push(line);
      inFence = !inFence;
      continue;
    }
    if (!inFence && line.trim().length === 0) {
      flush();
      continue;
    }
    buffer.push(line);
  }
  flush();
  return out;
}

function countNewlines(s: string): number {
  let n = 1;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\n") n += 1;
  }
  return n;
}

function lineFromOffset(raw: string, offset: number): number {
  let line = 1;
  const cap = Math.min(offset, raw.length);
  for (let i = 0; i < cap; i++) {
    if (raw[i] === "\n") line += 1;
  }
  return line;
}

function shortHash(seed: string): string {
  return createHash("sha256").update(seed).digest("hex").slice(0, 7);
}

/* -------------------------------------------------------------------------- */
/* Source-comment context heuristics                                          */
/* -------------------------------------------------------------------------- */

/**
 * Best-effort enclosing-symbol detection. After the comment block ends,
 * scan up to 4 lines forward for the first JS/TS/Python/Rust/Go-style
 * declaration. Returns undefined when nothing matches; the curator
 * subagent treats absence as "anonymous block".
 */
function detectEnclosingSymbol(
  repoRoot: string,
  file: string,
  endOffset: number,
): string | undefined {
  let raw: string;
  try {
    raw = readFileSync(join(repoRoot, file), "utf8");
  } catch {
    return undefined;
  }
  const tail = raw.slice(endOffset, endOffset + 800);
  const lines = tail.split("\n").slice(0, 4);
  for (const line of lines) {
    const m =
      line.match(
        /^\s*(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|const|let|var|enum|namespace)\s+([A-Za-z_$][\w$]*)/,
      ) ??
      line.match(/^\s*(?:def|fn|func)\s+([A-Za-z_][\w]*)/) ??
      line.match(/^\s*(?:struct|impl|trait)\s+([A-Za-z_][\w]*)/);
    if (m && m[1]) return m[1];
  }
  return undefined;
}

/**
 * Top-of-file imports — first 30 lines. Heuristic narrative for the
 * curator subagent ("this module imports X — likely a Y handler").
 */
function detectNearbyImports(repoRoot: string, file: string): string[] {
  let raw: string;
  try {
    raw = readFileSync(join(repoRoot, file), "utf8");
  } catch {
    return [];
  }
  const head = raw.split("\n").slice(0, 30);
  const out: string[] = [];
  for (const line of head) {
    const js = line.match(/^\s*import\s+(?:[\w{},*\s]+\s+from\s+)?["']([^"']+)["']/);
    if (js && js[1]) out.push(js[1]);
    const py = line.match(/^\s*(?:from\s+(\S+)\s+import|import\s+(\S+))/);
    if (py) {
      const mod = py[1] ?? py[2];
      if (mod) out.push(mod);
    }
    if (out.length >= 8) break;
  }
  return out;
}
