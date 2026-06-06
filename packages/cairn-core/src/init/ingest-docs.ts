/**
 * Phase 8 — staged docs ingestion.
 *
 * Replaces the v0.6 bulk-classifier path. Cuts wall from ~15 min →
 * ~75 s on platform-scale repos AND collapses the noisy ledger
 * (7000 DECs) to a curated draft inbox (30-80 drafts).
 *
 * Pipeline:
 *
 *   Stage 3 (deterministic, 0 Haiku) — marker scan
 *     Topic-index entries with `marker_kind` in {"decision","rule"} go
 *     straight to emit. The walker stamped them at parse time when it
 *     saw frontmatter `cairn.kind` or `<!-- cairn:decision -->` /
 *     `<!-- cairn:rule -->` within 3 lines of the heading.
 *
 *   Stage 1 — file-purpose binary filter (batch=30, concurrency=5)
 *     Per file: filepath + frontmatter + first 800 chars + every
 *     H1/H2/H3 line (capped at 100). Locked rigid prompt: a file is
 *     authoritative ONLY if it's a canonical rulebook, formal ADR,
 *     or list of binding domain invariants. Plans / scratchpads /
 *     UAT logs / API docs are NOT authoritative even if they
 *     contain proposed or historical decisions.
 *
 *   Stage 2 — section-level batch classifier (batch=30, concurrency=5)
 *     Same shape as the v0.6 classifier, but scoped to sections
 *     belonging to Stage-1-authoritative files AND not already
 *     handled by a marker. This is where Haiku still adds signal —
 *     the file passed the rigid filter; now decide WHICH sections
 *     of it are decisions vs context.
 *
 *   Stage 4 — emit
 *     Stage 2 + Stage 3 outputs → `.cairn/ground/decisions/_inbox/<id>.draft.md`.
 *     `status: draft`, `capture_source: init-docs-ingest`,
 *     `decided_by: cairn-init`. Body is verbatim via
 *     `readSotBody` — no Haiku paraphrasing. Operator triages via
 *     the existing `cairn-attention` skill.
 *
 * Skipped entries (everything else) stay in the topic-index as
 * unpromoted candidates for future curator passes.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import type { Dirent } from "node:fs";
import { stringify as stringifyYaml } from "yaml";
import { runClaude } from "../claude/index.js";
import {
  bodyContentHash,
  decisionsDir,
  deriveDecId,
  readAnchorMap,
  readRejectedYaml,
  readTopicIndex,
  setTopic,
  walkFs,
  writeFileCandidatesMap,
  writeTopicIndex,
  type AnchorMap,
  type TopicIndex,
  type TopicIndexEntry,
} from "@isaacriehm/cairn-state";
import { logger } from "../logger.js";
import { firstLineFallback, readSotBody } from "./sot-emit.js";

const log = logger("init.ingest-docs");

/* -------------------------------------------------------------------------- */
/* Tunables — locked tunables                                */
/* -------------------------------------------------------------------------- */

/** N files per Stage-1 Haiku call. */
const FILE_FILTER_BATCH_SIZE = 30;
/** Concurrent Stage-1 batches. */
const FILE_FILTER_CONCURRENCY = 5;
/** Stage 1 per-file context — first chars of body, frontmatter stripped. */
const FILE_FILTER_INTRO_CHARS = 800;
/** Stage 1 max ToC lines (H1/H2/H3 only). */
const FILE_FILTER_TOC_MAX_LINES = 100;
/** Stage 1 wall budget per Haiku call. */
const FILE_FILTER_TIMEOUT_MS = 60_000;

/** N sections per Stage-2 Haiku call. */
const SECTION_BATCH_SIZE = 30;
/** Concurrent Stage-2 batches. */
const SECTION_CONCURRENCY = 5;
/** Stage 2 per-section body cap (chars) before truncation marker. */
const SECTION_BODY_CAP = 2_000;
/** Stage 2 wall budget per Haiku call. */
const SECTION_TIMEOUT_MS = 120_000;

/** Capture source stamped on every Stage 2/3 emit. */
const CAPTURE_SOURCE = "init-docs-ingest";
/** Decided-by stamp on every Stage 2/3 emit. */
const DECIDED_BY = "cairn-init";

/** Subdirs we never descend into when discovering candidate doc files. */
const SKIP_DIRS = new Set([
  ".cairn",
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  ".next",
  ".turbo",
  ".cache",
  "coverage",
]);

/* -------------------------------------------------------------------------- */
/* Public types                                                               */
/* -------------------------------------------------------------------------- */

export interface DocCandidate {
  path: string;
  size: number;
  group: string;
}

export type DocClassificationKind =
  | "decision"
  | "domain-rule"
  | "voice-guidelines"
  | "api-docs"
  | "other";

export interface DocClassification {
  kind: DocClassificationKind;
  proposedTitle: string;
}

export interface ClassifiedDoc {
  candidate: DocCandidate;
  classification: DocClassification;
  failed: boolean;
  errorMessage?: string;
}

export interface IngestionRunResult {
  /** Verbatim DEC drafts written under `_inbox/`. */
  decsWritten: { id: string; path: string; sourceFile: string; slug: string }[];
  /** Topic-index entries skipped at Stage 4 (with reason). */
  skipped: { slug: string; reason: string }[];
  /** Total topic-index entries considered (pre-rejection-filter). */
  scannedEntries: number;
  /** Stage 3 — entries emitted from operator markers (0 Haiku). */
  markerEmits: number;
  /** Stage 2 — entries emitted from authoritative-file section classifications. */
  sectionEmits: number;
  /**
   * Stage 1 — files the binary filter accepted as authoritative
   * (i.e. eligible to feed Stage 2).
   */
  authoritativeFiles: number;
  /** Total distinct files Stage 1 evaluated. */
  filesEvaluated: number;
  /**
   * Topic-index entries that remain unpromoted (`dec_id IS NULL`)
   * after this run. Surface this in the cold-start summary as
   * "K unpromoted candidates indexed".
   */
  unpromotedCandidates: number;
}

/** Phase was skipped because the repo is the Cairn source repo itself. */
export interface IngestionSkippedResult {
  readonly skipped: "self-adopt";
}

export type IngestionResult = IngestionRunResult | IngestionSkippedResult;

export interface ChunkProgressRow {
  chunksDone: number;
  totalChunks: number;
  entriesDone: number;
  totalEntries: number;
  /** Which staged phase the chunk belongs to ("file-filter" or "section-classify"). */
  stage: "file-filter" | "section-classify";
}

export interface RunDocsIngestionArgs {
  repoRoot: string;
  /**
   * Smoke override — feed canned classifications keyed by entry. When
   * set, Stages 1+2 are bypassed entirely; every non-marker candidate
   * runs through this synchronously. Stage 3 still fires.
   */
  mockClassify?: (
    entry: TopicIndexEntry,
    body: string,
  ) => DocClassification;
  /** Caller-supplied id collision Set (parallel pipeline). */
  existingDecIds?: Set<string>;
  /** Progress callback fired once per completed batch. */
  onChunkProgress?: (row: ChunkProgressRow) => void;
}

/* -------------------------------------------------------------------------- */
/* Discovery (still useful for sanity checks + external callers)              */
/* -------------------------------------------------------------------------- */

export function discoverDocs(repoRoot: string): DocCandidate[] {
  const docsDir = join(repoRoot, "docs");
  if (!existsSync(docsDir)) return [];
  const out: DocCandidate[] = [];
  walkFs({
    dir: docsDir,
    repoRoot,
    skipDirs: SKIP_DIRS,
    onFile: (rel: string, abs: string, ent: Dirent) => {
      if (!ent.name.endsWith(".md")) return;
      let st;
      try {
        st = statSync(abs);
      } catch {
        return;
      }
      out.push({
        path: rel,
        size: st.size,
        group: dirGroup(rel),
      });
    },
  });
  return out;
}

function dirGroup(rel: string): string {
  const parts = rel.split("/");
  if (parts.length <= 1) return "(root)";
  return `${parts[0]}/`;
}

/* -------------------------------------------------------------------------- */
/* Stage 1 — file-purpose binary filter                                       */
/*                                                                            */
/* Locked rigid prompt — DO NOT paraphrase. A file is authoritative ONLY      */
/* if it's a canonical rulebook, a formal ADR, or a list of active binding   */
/* domain invariants. Plans / scratchpads / UAT logs / API docs are NOT     */
/* authoritative even if they contain proposed or historical decisions.      */
/* -------------------------------------------------------------------------- */

const FILE_FILTER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["files"],
  properties: {
    files: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["path", "is_authoritative", "reason"],
        properties: {
          path: { type: "string" },
          is_authoritative: { type: "boolean" },
          reason: { type: "string" },
        },
      },
    },
  },
} as const;

const FILE_FILTER_SYSTEM = `You are a rigid filter for an architecture ledger. A file is authoritative ONLY if it is a canonical rulebook, a formal Architecture Decision Record (ADR), or a list of active, binding domain invariants.

If a file is a project plan, research scratchpad, UAT log, status update, or API documentation, it is NOT authoritative, even if it contains proposed or historical decisions.

Evaluate the provided filepath, frontmatter, intro, and Table of Contents. Return JSON:
{ "files": [ { "path": "<filepath>", "is_authoritative": <bool>, "reason": "10 words max" }, ... ] }

EXACTLY one entry per input filepath. Do NOT omit. Do NOT invent paths.`;

interface FileFilterInput {
  path: string;
  frontmatter: string | null;
  introChars: string;
  toc: string;
}

export interface FileFilterVerdict {
  is_authoritative: boolean;
  reason: string;
}

function buildFileFilterInputs(
  repoRoot: string,
  files: string[],
): FileFilterInput[] {
  const out: FileFilterInput[] = [];
  for (const rel of files) {
    const abs = join(repoRoot, rel);
    if (!existsSync(abs)) continue;
    let raw: string;
    try {
      raw = readFileSync(abs, "utf8");
    } catch {
      continue;
    }
    const { frontmatter, body } = splitFrontmatter(raw);
    const introChars = body.slice(0, FILE_FILTER_INTRO_CHARS);
    const toc = extractToc(body);
    out.push({ path: rel, frontmatter, introChars, toc });
  }
  return out;
}

function splitFrontmatter(raw: string): { frontmatter: string | null; body: string } {
  const m = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  if (m === null) return { frontmatter: null, body: raw };
  const fm = m[1] ?? "";
  return { frontmatter: fm, body: raw.slice(m[0].length) };
}

function extractToc(body: string): string {
  const lines = body.split("\n");
  const toc: string[] = [];
  for (const line of lines) {
    if (/^#{1,3}\s+/.test(line)) {
      toc.push(line.trim());
      if (toc.length >= FILE_FILTER_TOC_MAX_LINES) break;
    }
  }
  return toc.join("\n");
}

async function classifyFileBatch(
  inputs: FileFilterInput[],
): Promise<Map<string, FileFilterVerdict>> {
  if (inputs.length === 0) return new Map();
  const blocks = inputs
    .map((it) => {
      const fmBlock = it.frontmatter !== null
        ? `frontmatter:\n${it.frontmatter}\n`
        : `frontmatter: (none)\n`;
      const tocBlock = it.toc.length > 0 ? `toc:\n${it.toc}\n` : `toc: (none)\n`;
      const intro = it.introChars.length > 0
        ? `intro:\n${it.introChars}`
        : `intro: (empty)`;
      return `=== path: ${it.path}\n${fmBlock}${tocBlock}${intro}`;
    })
    .join("\n\n");
  const prompt = `Classify each file. Return one entry per path.\n\n${blocks}`;
  const result = await runClaude({
    tier: "haiku",
    system: FILE_FILTER_SYSTEM,
    prompt,
    jsonSchema: FILE_FILTER_SCHEMA,
    timeoutMs: FILE_FILTER_TIMEOUT_MS,
    isolateAmbientContext: true,
  });
  const parsed = result.parsed;
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("haiku file-filter returned non-object");
  }
  const arr = (parsed as Record<string, unknown>)["files"];
  if (!Array.isArray(arr)) {
    throw new Error("haiku file-filter missing `files` array");
  }
  const out = new Map<string, FileFilterVerdict>();
  for (const raw of arr) {
    if (typeof raw !== "object" || raw === null) continue;
    const e = raw as Record<string, unknown>;
    const path = e["path"];
    const flag = e["is_authoritative"];
    const reason = e["reason"];
    if (typeof path !== "string") continue;
    if (typeof flag !== "boolean") continue;
    out.set(path, {
      is_authoritative: flag,
      reason: typeof reason === "string" ? reason : "",
    });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Stage 2 — section batch classifier (kind + proposedTitle)                  */
/* -------------------------------------------------------------------------- */

const SECTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["classifications"],
  properties: {
    classifications: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["slug", "kind", "proposedTitle"],
        properties: {
          slug: { type: "string" },
          kind: {
            type: "string",
            enum: ["decision", "domain-rule", "voice-guidelines", "api-docs", "other"],
          },
          proposedTitle: { type: "string" },
        },
      },
    },
  },
} as const;

const SECTION_SYSTEM = `You classify N sections from authoritative project documentation for Cairn's Single-Source-of-Truth ledger.

These sections come from files already filtered as canonical rulebooks, ADRs, or binding invariant lists. Decide which sections are themselves binding decisions / rules vs supporting context.

Return JSON: { "classifications": [ { "slug": "...", "kind": "...", "proposedTitle": "..." }, ... ] }

EXACTLY one classification per input section, keyed by its slug. Do NOT omit. Do NOT invent slugs. If unsure, kind="other".

\`kind\` choices:
  - "decision"          binding decision or architectural choice
  - "domain-rule"       domain rule or constraint developers must obey
  - "voice-guidelines"  brand voice / tone guidance
  - "api-docs"          API surface / schema documentation (descriptive)
  - "other"             nothing actionable for the cairn state layer

\`proposedTitle\` 5-10 words, imperative voice. Empty string for "other".

Be conservative — false-positive decisions pollute the ground state worse than missed capture. Default to "other" when uncertain.`;

interface SectionInput {
  slug: string;
  body: string;
  sot_source: string;
}

async function classifySectionBatch(
  items: SectionInput[],
): Promise<Map<string, DocClassification>> {
  if (items.length === 0) return new Map();
  const sections = items
    .map((it, i) => {
      const capped = it.body.length > SECTION_BODY_CAP
        ? `${it.body.slice(0, SECTION_BODY_CAP)}\n…[truncated]`
        : it.body;
      return `[${i + 1}] slug=${it.slug} source=${it.sot_source}\n${capped}`;
    })
    .join("\n\n---\n\n");
  const prompt = `Classify each section. Return one entry per slug.\n\n${sections}`;
  const result = await runClaude({
    tier: "haiku",
    system: SECTION_SYSTEM,
    prompt,
    jsonSchema: SECTION_SCHEMA,
    timeoutMs: SECTION_TIMEOUT_MS,
    isolateAmbientContext: true,
  });
  const parsed = result.parsed;
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("haiku section batch returned non-object");
  }
  const arr = (parsed as Record<string, unknown>)["classifications"];
  if (!Array.isArray(arr)) {
    throw new Error("haiku section batch missing `classifications`");
  }
  const out = new Map<string, DocClassification>();
  for (const raw of arr) {
    if (typeof raw !== "object" || raw === null) continue;
    const e = raw as Record<string, unknown>;
    const slug = e["slug"];
    const kind = e["kind"];
    if (typeof slug !== "string") continue;
    if (
      kind !== "decision" &&
      kind !== "domain-rule" &&
      kind !== "voice-guidelines" &&
      kind !== "api-docs" &&
      kind !== "other"
    ) {
      continue;
    }
    out.set(slug, {
      kind,
      proposedTitle: typeof e["proposedTitle"] === "string" ? e["proposedTitle"] : "",
    });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Orchestrator                                                               */
/* -------------------------------------------------------------------------- */

interface CandidateContext {
  entry: TopicIndexEntry;
  body: string;
}

export async function runDocsIngestion(
  args: RunDocsIngestionArgs,
): Promise<IngestionResult> {
  const topicIndex = readTopicIndex(args.repoRoot);
  const anchorMap = readAnchorMap(args.repoRoot);
  const rejected = readRejectedYaml(args.repoRoot);

  const allCandidates = Object.values(topicIndex.topics).filter(
    (entry) => isDocSoT(entry) && entry.dec_id === undefined && !rejected.has(entry.slug),
  );

  if (allCandidates.length === 0) {
    log.info("phase 8 found no eligible docs entries in topic-index");
    writeFileCandidatesMap(args.repoRoot, topicIndex);
    return zeroResult(allCandidates.length, topicIndex);
  }

  // Read each candidate body once. Stage 3 needs the body for title
  // derivation; Stages 1/2 don't, but reading up front keeps the
  // pipeline single-pass over entries. Bodies that fail to read are
  // dropped — anchor-map drift is the only realistic cause and the
  // entry stays as a candidate for the next phase 7 refresh.
  const ctxBySlug = new Map<string, CandidateContext>();
  for (const entry of allCandidates) {
    const body = readSotBody(args.repoRoot, entry, anchorMap);
    if (body === null) continue;
    ctxBySlug.set(entry.slug, { entry, body });
  }

  // ── Stage 3 — marker scan (deterministic, 0 Haiku) ──
  const markerCandidates: CandidateContext[] = [];
  const nonMarkerCandidates: CandidateContext[] = [];
  for (const ctx of ctxBySlug.values()) {
    if (ctx.entry.marker_kind !== undefined) markerCandidates.push(ctx);
    else nonMarkerCandidates.push(ctx);
  }

  // ── Mock path — bypass Stages 1+2; run mockClassify on every
  //    non-marker candidate. Smokes only.
  let sectionEmits: { ctx: CandidateContext; cls: DocClassification }[] = [];
  let authoritativeFileCount = 0;
  let filesEvaluated = 0;

  if (args.mockClassify !== undefined) {
    for (const ctx of nonMarkerCandidates) {
      let cls: DocClassification;
      try {
        cls = args.mockClassify(ctx.entry, ctx.body);
      } catch (err) {
        log.warn(
          { slug: ctx.entry.slug, err: err instanceof Error ? err.message : String(err) },
          "mockClassify failed; skipping",
        );
        continue;
      }
      if (cls.kind === "decision" || cls.kind === "domain-rule") {
        sectionEmits.push({ ctx, cls });
      }
    }
    if (args.onChunkProgress !== undefined) {
      args.onChunkProgress({
        chunksDone: 1,
        totalChunks: 1,
        entriesDone: nonMarkerCandidates.length,
        totalEntries: nonMarkerCandidates.length,
        stage: "section-classify",
      });
    }
  } else {
    // ── Stage 1 — file-purpose binary filter ──
    const distinctFiles = [
      ...new Set(nonMarkerCandidates.map((c) => c.entry.sot_source)),
    ].sort();
    filesEvaluated = distinctFiles.length;
    const stage1Args: Parameters<typeof runStage1FileFilter>[0] = {
      repoRoot: args.repoRoot,
      files: distinctFiles,
    };
    if (args.onChunkProgress !== undefined) {
      stage1Args.onChunkProgress = args.onChunkProgress;
    }
    const fileVerdicts = await runStage1FileFilter(stage1Args);
    const authoritativeFiles = new Set<string>();
    for (const [path, v] of fileVerdicts.entries()) {
      if (v.is_authoritative) authoritativeFiles.add(path);
    }
    authoritativeFileCount = authoritativeFiles.size;

    // ── Stage 2 — section batch classifier (scoped) ──
    const stage2Inputs = nonMarkerCandidates.filter((c) =>
      authoritativeFiles.has(c.entry.sot_source),
    );
    const stage2Args: Parameters<typeof runStage2SectionClassifier>[0] = {
      candidates: stage2Inputs,
    };
    if (args.onChunkProgress !== undefined) {
      stage2Args.onChunkProgress = args.onChunkProgress;
    }
    sectionEmits = await runStage2SectionClassifier(stage2Args);
  }

  // ── Stage 4 — emit drafts to `_inbox/` ──
  const existingDecIds = args.existingDecIds ?? scanExistingDecIds(args.repoRoot);
  const finalEmits = [
    ...markerCandidates.map((ctx) => {
      const kind: "decision" | "domain-rule" =
        ctx.entry.marker_kind === "rule" ? "domain-rule" : "decision";
      return { ctx, cls: { kind, proposedTitle: deriveMarkerTitle(ctx) } };
    }),
    ...sectionEmits,
  ];

  let updatedTopicIndex = topicIndex;
  const decsWritten: IngestionRunResult["decsWritten"] = [];
  const skipped: IngestionRunResult["skipped"] = [];

  for (const { ctx, cls } of finalEmits) {
    const sot_path = entryToSotPath(ctx.entry);
    const titleSeed = cls.proposedTitle.length > 0
      ? cls.proposedTitle
      : firstLineFallback(ctx.body);
    const id = allocateUniqueDecId(
      { sot_path, title: titleSeed, capture_source: CAPTURE_SOURCE },
      existingDecIds,
    );
    const draftPath = writeDraftToInbox({
      repoRoot: args.repoRoot,
      id,
      title: titleSeed,
      body: ctx.body,
      sot_path,
      source_file: ctx.entry.sot_source,
    });
    decsWritten.push({
      id,
      path: relativeInboxPath(id),
      sourceFile: ctx.entry.sot_source,
      slug: ctx.entry.slug,
    });
    updatedTopicIndex = setTopic(updatedTopicIndex, ctx.entry.slug, {
      ...ctx.entry,
      dec_id: id,
    });
    log.debug({ id, slug: ctx.entry.slug, draftPath }, "phase 8 emitted draft");
  }

  // Refresh topic-index + file-candidates-map so the read-enrich hook
  // sees the post-emit candidate counts. Anchor-map / sot-bindings /
  // sot-cache stay untouched — drafts in `_inbox/` aren't canonical
  // until the operator (or `cairn attention`) accepts them.
  writeTopicIndex(args.repoRoot, updatedTopicIndex);
  writeFileCandidatesMap(args.repoRoot, updatedTopicIndex);

  const unpromotedCandidates = countUnpromoted(updatedTopicIndex);

  log.info(
    {
      scanned: allCandidates.length,
      emitted: decsWritten.length,
      markerEmits: markerCandidates.length,
      sectionEmits: sectionEmits.length,
      authoritativeFiles: authoritativeFileCount,
      filesEvaluated,
      unpromotedCandidates,
    },
    "phase 8 complete",
  );

  return {
    decsWritten,
    skipped,
    scannedEntries: allCandidates.length,
    markerEmits: markerCandidates.length,
    sectionEmits: sectionEmits.length,
    authoritativeFiles: authoritativeFileCount,
    filesEvaluated,
    unpromotedCandidates,
  };
}

/* -------------------------------------------------------------------------- */
/* Stage runners                                                              */
/* -------------------------------------------------------------------------- */

export async function runStage1FileFilter(args: {
  repoRoot: string;
  files: string[];
  onChunkProgress?: (row: ChunkProgressRow) => void;
}): Promise<Map<string, FileFilterVerdict>> {
  const verdicts = new Map<string, FileFilterVerdict>();
  if (args.files.length === 0) return verdicts;

  const inputs = buildFileFilterInputs(args.repoRoot, args.files);
  const chunks: FileFilterInput[][] = [];
  for (let i = 0; i < inputs.length; i += FILE_FILTER_BATCH_SIZE) {
    chunks.push(inputs.slice(i, i + FILE_FILTER_BATCH_SIZE));
  }
  let nextIdx = 0;
  let chunksDone = 0;
  let entriesDone = 0;

  const worker = async (): Promise<void> => {
    for (;;) {
      const idx = nextIdx;
      nextIdx += 1;
      if (idx >= chunks.length) return;
      const chunk = chunks[idx]!;
      try {
        const map = await classifyFileBatch(chunk);
        for (const [path, v] of map.entries()) verdicts.set(path, v);
      } catch (err) {
        log.warn(
          { chunkIdx: idx, size: chunk.length, err: err instanceof Error ? err.message : String(err) },
          "phase 8 stage 1 file-filter failed; chunk treated as non-authoritative",
        );
      }
      chunksDone += 1;
      entriesDone += chunk.length;
      if (args.onChunkProgress !== undefined) {
        args.onChunkProgress({
          chunksDone,
          totalChunks: chunks.length,
          entriesDone,
          totalEntries: inputs.length,
          stage: "file-filter",
        });
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(FILE_FILTER_CONCURRENCY, Math.max(1, chunks.length)) }, () =>
      worker(),
    ),
  );
  return verdicts;
}

async function runStage2SectionClassifier(args: {
  candidates: CandidateContext[];
  onChunkProgress?: (row: ChunkProgressRow) => void;
}): Promise<{ ctx: CandidateContext; cls: DocClassification }[]> {
  const out: { ctx: CandidateContext; cls: DocClassification }[] = [];
  if (args.candidates.length === 0) return out;

  const items: SectionInput[] = args.candidates.map((c) => ({
    slug: c.entry.slug,
    body: c.body,
    sot_source: c.entry.sot_source,
  }));
  const ctxBySlug = new Map(args.candidates.map((c) => [c.entry.slug, c] as const));
  const chunks: SectionInput[][] = [];
  for (let i = 0; i < items.length; i += SECTION_BATCH_SIZE) {
    chunks.push(items.slice(i, i + SECTION_BATCH_SIZE));
  }
  let nextIdx = 0;
  let chunksDone = 0;
  let entriesDone = 0;
  const verdicts = new Map<string, DocClassification>();

  const worker = async (): Promise<void> => {
    for (;;) {
      const idx = nextIdx;
      nextIdx += 1;
      if (idx >= chunks.length) return;
      const chunk = chunks[idx]!;
      try {
        const map = await classifySectionBatch(chunk);
        for (const [slug, cls] of map.entries()) verdicts.set(slug, cls);
      } catch (err) {
        log.warn(
          { chunkIdx: idx, size: chunk.length, err: err instanceof Error ? err.message : String(err) },
          "phase 8 stage 2 batch failed; chunk skipped",
        );
      }
      chunksDone += 1;
      entriesDone += chunk.length;
      if (args.onChunkProgress !== undefined) {
        args.onChunkProgress({
          chunksDone,
          totalChunks: chunks.length,
          entriesDone,
          totalEntries: items.length,
          stage: "section-classify",
        });
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(SECTION_CONCURRENCY, Math.max(1, chunks.length)) }, () =>
      worker(),
    ),
  );
  for (const [slug, cls] of verdicts.entries()) {
    if (cls.kind !== "decision" && cls.kind !== "domain-rule") continue;
    const ctx = ctxBySlug.get(slug);
    if (ctx === undefined) continue;
    out.push({ ctx, cls });
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Inbox emit                                                                 */
/* -------------------------------------------------------------------------- */

interface WriteDraftArgs {
  repoRoot: string;
  id: string;
  title: string;
  body: string;
  sot_path: string;
  source_file: string;
}

function writeDraftToInbox(args: WriteDraftArgs): string {
  const inboxDir = join(decisionsDir(args.repoRoot), "_inbox");
  mkdirSync(inboxDir, { recursive: true });
  const abs = join(inboxDir, `${args.id}.draft.md`);
  const now = new Date().toISOString();
  const fm: Record<string, unknown> = {
    id: args.id,
    title: args.title,
    type: "adr",
    status: "draft",
    audience: "dual",
    generated: now,
    "verified-at": now,
    decided_at: now,
    decided_by: DECIDED_BY,
    sot_kind: "path",
    sot_path: args.sot_path,
    sot_content_hash: bodyContentHash(args.body),
    capture_source: CAPTURE_SOURCE,
    source_file: args.source_file,
  };
  const out: string[] = [];
  out.push("---");
  out.push(stringifyYaml(fm).trimEnd());
  out.push("---");
  out.push("");
  out.push(args.body.trimEnd());
  out.push("");
  writeFileSync(abs, out.join("\n"), "utf8");
  return abs;
}

function relativeInboxPath(id: string): string {
  return `.cairn/ground/decisions/_inbox/${id}.draft.md`;
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

function isDocSoT(entry: TopicIndexEntry): boolean {
  const sot = entry.candidates.find((c) => c.file === entry.sot_source);
  return sot !== undefined && sot.kind === "doc";
}

function entryToSotPath(entry: TopicIndexEntry): string {
  const sot = entry.candidates.find((c) => c.file === entry.sot_source);
  if (sot === undefined) return entry.sot_source;
  if (sot.anchor !== undefined && sot.anchor.length > 0) {
    return `${entry.sot_source}#${sot.anchor}`;
  }
  return entry.sot_source;
}

// firstLineFallback now lives in sot-emit.ts (single source of truth).
// Imported above as `firstLineFallback`.

function deriveMarkerTitle(ctx: CandidateContext): string {
  // Prefer the topic-index entry's anchor text (post-walker normalization)
  // when present; fall back to the SoT body's first non-blank line.
  const sot = ctx.entry.candidates.find((c) => c.file === ctx.entry.sot_source);
  if (sot?.anchor !== undefined && sot.anchor.length > 0) {
    return sot.anchor.replace(/[-_]+/g, " ").trim().slice(0, 120) || firstLineFallback(ctx.body);
  }
  return firstLineFallback(ctx.body);
}

/**
 * Allocate a DEC id that doesn't collide with `existingIds`. The
 * derivation is content-stable, but two distinct topics with identical
 * `(sot_path, title, capture_source)` tuples would clash — fall back
 * to a counter suffix in that pathological case.
 */
function allocateUniqueDecId(
  input: { sot_path: string; title: string; capture_source: string },
  existingIds: Set<string>,
): string {
  let id = deriveDecId(input);
  if (!existingIds.has(id)) {
    existingIds.add(id);
    return id;
  }
  for (let suffix = 2; suffix < 1_000; suffix += 1) {
    const tagged = deriveDecId({ ...input, title: `${input.title} #${suffix}` });
    if (!existingIds.has(tagged)) {
      existingIds.add(tagged);
      return tagged;
    }
  }
  // Exceedingly unlikely. If we hit it, return the deterministic id and
  // let the filesystem write fail loudly rather than fabricating a
  // random suffix that would break subsequent re-runs.
  existingIds.add(id);
  return id;
}

function scanExistingDecIds(repoRoot: string): Set<string> {
  const out = new Set<string>();
  const dir = decisionsDir(repoRoot);
  for (const sub of [dir, join(dir, "_inbox")]) {
    let entries: Dirent[];
    try {
      entries = readdirSync(sub, { withFileTypes: true, encoding: "utf8" });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isFile()) continue;
      const m = e.name.match(/^(DEC-[0-9a-f]{7,})/);
      if (m === null) continue;
      out.add(m[1]!);
    }
  }
  return out;
}

function countUnpromoted(topicIndex: TopicIndex): number {
  let n = 0;
  for (const e of Object.values(topicIndex.topics)) {
    if (e.dec_id === undefined) n += 1;
  }
  return n;
}

function zeroResult(scanned: number, topicIndex: TopicIndex): IngestionRunResult {
  return {
    decsWritten: [],
    skipped: [],
    scannedEntries: scanned,
    markerEmits: 0,
    sectionEmits: 0,
    authoritativeFiles: 0,
    filesEvaluated: 0,
    unpromotedCandidates: countUnpromoted(topicIndex),
  };
}
