/**
 * Phase 10 orchestrator (v0.5.0 SoT model).
 *
 * Plan §5.4 algorithm:
 *   1. Discover sections in `CLAUDE.md`, `AGENTS.md`, `.claude/rules/*.md`.
 *   2. Topic-index lookup (built by phase 7) before classification:
 *      - **Match** — slug already owns a docs/CLAUDE.md/AGENTS.md/rule
 *        SoT and was emitted by an earlier phase. Phase 10 records the
 *        cite (no source rewrite — operator's narrative stays intact)
 *        and skips emit.
 *      - **Net-new** — slug is in topic-index but not yet emitted.
 *        Phase 10 classifies the section via Haiku (kind only:
 *        decision / domain-rule / constraint / informational), emits
 *        a verbatim DEC/INV via `sot-emit` with `sot_kind: "path"` +
 *        `sot_path: <file>#<anchor>`, auto-promotes (`status: accepted`).
 *   3. Conflict detection — for each freshly emitted entity, scan
 *      accepted DECs/INVs in `sot-cache.yaml` for high Jaccard overlap
 *      against the new body, then run a Haiku contradiction judge per
 *      candidate (`contradict | agree | unrelated`). On `contradict`,
 *      write `.cairn/ground/conflicts/<new>__<other>.md` with both
 *      prose sides + Haiku reasoning. The cairn-attention skill renders
 *      these per §5.4.1; **no source rewrite ever fires from conflicts**.
 *   4. Auto-promote — every novel entity ships `status: accepted`. The
 *      `_inbox/` draft queue is gone (the v0.4.x review surface was the
 *      v0.5.0 pivot's primary motivation).
 *
 * Output side-effects (all relative to repoRoot):
 *   - `.cairn/ground/decisions/<DEC-id>.md`        (one per novel decision/domain-rule)
 *   - `.cairn/ground/invariants/<INV-id>.md`       (one per novel constraint)
 *   - `.cairn/ground/topic-index.yaml`             (extended w/ dec_id stamps)
 *   - `.cairn/ground/sot-bindings.yaml`            (forward+reverse for new ids)
 *   - `.cairn/ground/sot-cache.yaml`               (token cache for Layer A)
 *   - `.cairn/ground/conflicts/<a>__<b>.md`        (one per contradiction)
 *   - `.cairn/baseline/rules-merge-<ISO>.yaml`     (full audit)
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { runClaude } from "../../claude/index.js";
import { cairnDir,
  bodyContentHash,
  conflictsDir,
  emptyAnchorMap,
  emptySotBindings,
  emptySotCache,
  emptyTopicIndex,
  readAnchorMap,
  readSotBindings,
  readSotCache,
  readTopicIndex,
  setSotCacheEntry,
  topicSlug,
  writeAnchorMap,
  writeSotBindings,
  writeSotCache,
  writeTopicIndex,
  writeDecisionsLedger,
  writeInvariantsLedger,
  type AnchorMap,
  type SotBindings,
  type SotCache,
  type SotCacheEntry,
  type TopicIndex,
} from "@isaacriehm/cairn-state";
import { logger } from "../../logger.js";
import { jaccard, tokenize } from "../../text/jaccard.js";
import { emitFromTopicIndex, type EmitClassification } from "../sot-emit.js";
import { discoverRuleSources } from "./discover.js";
import type { RuleSourceFile } from "./discover.js";
import { parseRuleSections } from "./parse-sections.js";
import type { RuleSection } from "./parse-sections.js";

const log = logger("init.rules-merge.ingest");

const PER_SECTION_TIMEOUT_MS = 60_000;
const SECTION_BODY_CAP = 4_000;
const CONCURRENCY = 4;
const CAPTURE_SOURCE = "init-rules-merge";

/** Conflict-scan tuning. */
const CONFLICT_JACCARD_THRESHOLD = 0.4;
const CONFLICT_MAX_CANDIDATES_PER_EMIT = 3;
const CONFLICT_MAX_JUDGE_CALLS = 25;
const CONFLICT_BODY_CAP = 1_500;
const PER_CONTRADICTION_TIMEOUT_MS = 30_000;

export type RuleClassKind =
  | "decision"
  | "domain-rule"
  | "constraint"
  | "informational"
  | "operator-keep";

export interface RuleClassification {
  source: string;
  level: 0 | 2 | 3;
  title: string;
  startOffset: number;
  /** Content-fingerprint slug of the section body (heading excluded). */
  slug: string;
  kind: RuleClassKind;
  failed: boolean;
  errorMessage?: string;
}

export interface RunRulesMergeArgs {
  repoRoot: string;
  /** When set, every section is classified by this fn — bypasses Haiku. */
  mockClassify?: (section: RuleSection, source: RuleSourceFile) => RuleClassification;
  /**
   * Mock contradiction judge for smokes. Receives both prose bodies +
   * candidate id, returns one of `contradict | agree | unrelated`.
   * Default off → no Haiku contradiction calls in mock-classify mode.
   */
  mockContradictionJudge?: (args: {
    newBody: string;
    candidateId: string;
    candidateBody: string;
  }) => Promise<"contradict" | "agree" | "unrelated">;
  dryRun?: boolean;
  nowIso?: string;
  /**
   * Caller-supplied DEC id Set. Same role as in `runDocsIngestion`: when
   * the parallel orchestrator runs phases 6 / 7b / 7c sequentially, all
   * three share one Set so DEC id allocations don't collide. Content-
   * addressed ids make collisions vanishingly unlikely so the Set is
   * informational.
   */
  existingDecIds?: Set<string>;
  /** Caller-supplied INV id Set. Same compat note. */
  existingInvIds?: Set<string>;
  /**
   * Optional progress callback fired after each section finishes
   * classification. Enables the cairn-adopt statusline heartbeat.
   */
  onSectionProgress?: (row: { index: number; total: number }) => void;
}

interface RuleEmittedRecord {
  id: string;
  path: string;
  sourceFile: string;
  slug: string;
  status: "accepted";
}

interface RuleCiteRecord {
  /** DEC/INV id the section was bound to (already emitted by phase 8 / 7b). */
  id: string;
  /** Section's source file. */
  sourceFile: string;
  /** Slug that resolved the topic-index lookup. */
  slug: string;
}

interface RuleConflictRecord {
  /** Newly emitted entity id (DEC or INV from this phase 10 run). */
  newId: string;
  /** Pre-existing accepted entity id the new prose contradicts. */
  otherId: string;
  /** Repo-relative path to the conflict file. */
  conflictPath: string;
  /** Haiku judge's verdict reasoning excerpt. */
  reasoning: string;
}

export interface RunRulesMergeRunResult {
  sources: RuleSourceFile[];
  sectionsTotal: number;
  classifications: RuleClassification[];
  decsWritten: RuleEmittedRecord[];
  invsWritten: RuleEmittedRecord[];
  citesEmitted: RuleCiteRecord[];
  conflicts: RuleConflictRecord[];
  auditPath: string;
  auditRelPath: string;
  kindCounts: Record<RuleClassKind, number>;
}

/** Phase was skipped because the repo is the Cairn source repo itself. */
export interface RunRulesMergeSkippedResult {
  readonly skipped: "self-adopt";
}

export type RunRulesMergeResult = RunRulesMergeRunResult | RunRulesMergeSkippedResult;

/* -------------------------------------------------------------------------- */
/* Schemas + prompts                                                          */
/* -------------------------------------------------------------------------- */

const CLASSIFY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["kind"],
  properties: {
    kind: {
      type: "string",
      enum: ["decision", "domain-rule", "constraint", "informational"],
    },
  },
} as const;

const CLASSIFY_SYSTEM = `You classify markdown sections of project-rule files for Cairn's Single-Source-of-Truth ledger.

Each section comes from CLAUDE.md, AGENTS.md, or a .claude/rules/*.md file.

Return JSON matching the schema. \`kind\` choices:
  - "decision"       paragraph describes a binding decision or architectural choice
  - "domain-rule"    paragraph states a domain rule developers must follow (treated as a decision in the ledger)
  - "constraint"     paragraph states a hard constraint / invariant (must / must not / never / always)
  - "informational"  TOC, walkthrough, history, formatting notes — nothing actionable

Be conservative — false-positive ledger entries pollute ground state worse than missed capture.
Default to "informational" when uncertain.`;

const CONTRADICTION_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict"],
  properties: {
    verdict: { type: "string", enum: ["contradict", "agree", "unrelated"] },
    reasoning: { type: "string" },
  },
} as const;

const CONTRADICTION_SYSTEM = `You compare two project-rule statements for contradiction.

Return JSON: { "verdict": "contradict" | "agree" | "unrelated", "reasoning": "<one sentence>" }.

  - "contradict"  the two statements cannot both be true / followed at once
  - "agree"       the two statements describe the same rule with compatible wording
  - "unrelated"   the statements address different topics

Be conservative on "contradict" — only flag a true logical contradiction (one says X, the other says NOT X). Surface-level differences in tone or scope are NOT contradictions.`;

/* -------------------------------------------------------------------------- */
/* Public                                                                     */
/* -------------------------------------------------------------------------- */

export async function runRulesMerge(args: RunRulesMergeArgs): Promise<RunRulesMergeResult> {
  const repoRoot = args.repoRoot;
  const nowIso = args.nowIso ?? new Date().toISOString();
  const tsSlug = nowIso.replace(/[:.]/g, "-").slice(0, 19);

  // ── 1. Discover + walk sections ──────────────────────────────────
  const sources = discoverRuleSources(repoRoot);
  const ruleFilesSet = new Set(sources.map((s) => s.path));
  const sectionsBySlug = new Map<string, SectionContext>();
  const allClassifications: RuleClassification[] = [];

  type Job = {
    source: RuleSourceFile;
    section: RuleSection;
    slug: string;
    bodyMinusHeading: string;
    anchor: string;
  };
  const jobs: Job[] = [];

  for (const source of sources) {
    let body: string;
    try {
      body = readFileSync(source.absPath, "utf8");
    } catch (err) {
      log.warn(
        { source: source.path, err: err instanceof Error ? err.message : String(err) },
        "rule source unreadable; skipping",
      );
      continue;
    }
    const sections = parseRuleSections(body);
    for (const section of sections) {
      if (section.level === 0) continue;
      if (section.protectedByKeepMarker) {
        allClassifications.push({
          source: source.path,
          level: section.level,
          title: section.title,
          startOffset: section.startOffset,
          slug: "",
          kind: "operator-keep",
          failed: false,
        });
        continue;
      }
      const bodyMinusHeading = stripLeadingHeading(section.body);
      if (bodyMinusHeading.length === 0) {
        // Empty body after heading strip — nothing to classify or fingerprint.
        continue;
      }
      const slug = topicSlug(bodyMinusHeading);
      const anchor = headingToAnchor(section.title);
      const job: Job = { source, section, slug, bodyMinusHeading, anchor };
      jobs.push(job);
      sectionsBySlug.set(slug, {
        sourcePath: source.path,
        sectionTitle: section.title,
        anchor,
        bodyMinusHeading,
      });
    }
  }

  // ── 2. Classify each non-keep section ────────────────────────────
  if (args.mockClassify !== undefined) {
    for (const [idx, job] of jobs.entries()) {
      const cls = args.mockClassify(job.section, job.source);
      // Mock callers may not stamp `slug`; fill it in for them so the
      // emit filter has something to look up.
      allClassifications.push({ ...cls, slug: cls.slug.length > 0 ? cls.slug : job.slug });
      args.onSectionProgress?.({ index: idx + 1, total: jobs.length });
    }
  } else {
    let cursor = 0;
    let completed = 0;
    const total = jobs.length;
    const worker = async (): Promise<void> => {
      while (cursor < jobs.length) {
        const idx = cursor++;
        const job = jobs[idx];
        if (job === undefined) continue;
        const cls = await classifySection(job);
        allClassifications.push(cls);
        completed += 1;
        args.onSectionProgress?.({ index: completed, total });
      }
    };
    const workers = Array.from(
      { length: Math.min(CONCURRENCY, jobs.length) },
      () => worker(),
    );
    await Promise.all(workers);
  }

  const kindBySlug = new Map<string, RuleClassKind>();
  for (const cls of allClassifications) {
    if (cls.slug.length > 0) kindBySlug.set(cls.slug, cls.kind);
  }

  // ── 3. Read ground state + identify cite-existing slugs ──────────
  let topicIndex: TopicIndex = readTopicIndex(repoRoot);
  if (Object.keys(topicIndex.topics).length === 0) topicIndex = emptyTopicIndex();
  let anchorMap: AnchorMap = readAnchorMap(repoRoot);
  if (Object.keys(anchorMap.anchors).length === 0) anchorMap = emptyAnchorMap();

  const citesEmitted: RuleCiteRecord[] = [];
  for (const [slug, ctx] of sectionsBySlug) {
    const entry = topicIndex.topics[slug];
    if (entry !== undefined && entry.dec_id !== undefined && !ruleFilesSet.has(entry.sot_source)) {
      // Slug already SoT'd by phase 8 (docs); operator's CLAUDE.md / AGENTS.md
      // section is a cite of the same fact. No source rewrite — operator's
      // narrative stays intact. Plan §5.4.1.
      citesEmitted.push({ id: entry.dec_id, sourceFile: ctx.sourcePath, slug });
    }
  }

  // ── 4. Emit (sot-emit, sot_kind=path) ────────────────────────────
  const emit = await emitFromTopicIndex({
    repoRoot,
    topicIndex,
    anchorMap,
    filter: (entry) =>
      entry.dec_id === undefined &&
      ruleFilesSet.has(entry.sot_source) &&
      kindBySlug.has(entry.slug) &&
      isEmittableKind(kindBySlug.get(entry.slug)!),
    classifier: async ({ entry }): Promise<EmitClassification> => {
      const ctx = sectionsBySlug.get(entry.slug);
      const k = kindBySlug.get(entry.slug);
      if (k === undefined || ctx === undefined) return { kind: "skip", title: "" };
      if (k === "constraint") return { kind: "constraint", title: ctx.sectionTitle };
      if (k === "decision" || k === "domain-rule") {
        return { kind: "decision", title: ctx.sectionTitle };
      }
      return { kind: "skip", title: "" };
    },
    sot_kind: "path",
    capture_source: CAPTURE_SOURCE,
  });

  topicIndex = emit.topicIndex;
  if (args.dryRun !== true) {
    persistGroundState({
      repoRoot,
      topicIndex,
      anchorMap,
      bindings: emit.bindings,
      cache: emit.cache,
    });
  }

  // ── 5. Build emitted records ─────────────────────────────────────
  const decsWritten: RuleEmittedRecord[] = [];
  const invsWritten: RuleEmittedRecord[] = [];
  for (const rec of emit.emitted) {
    const ctx = sectionsBySlug.get(rec.slug);
    const target: RuleEmittedRecord = {
      id: rec.id,
      path:
        rec.kind === "DEC"
          ? `.cairn/ground/decisions/${rec.id}.md`
          : `.cairn/ground/invariants/${rec.id}.md`,
      sourceFile: ctx?.sourcePath ?? rec.source_file,
      slug: rec.slug,
      status: "accepted",
    };
    if (rec.kind === "DEC") decsWritten.push(target);
    else invsWritten.push(target);
  }

  // ── 6. Conflict scan ─────────────────────────────────────────────
  const conflicts: RuleConflictRecord[] = [];
  if (args.dryRun !== true && emit.emitted.length > 0) {
    let judgeCalls = 0;
    for (const rec of emit.emitted) {
      if (judgeCalls >= CONFLICT_MAX_JUDGE_CALLS) break;
      const candidates = jaccardCandidates({
        newId: rec.id,
        newBody: rec.body,
        cache: emit.cache,
        threshold: CONFLICT_JACCARD_THRESHOLD,
        topK: CONFLICT_MAX_CANDIDATES_PER_EMIT,
      });
      for (const cand of candidates) {
        if (judgeCalls >= CONFLICT_MAX_JUDGE_CALLS) break;
        judgeCalls += 1;
        const candBody = readEmittedBody(repoRoot, cand.id);
        if (candBody === null) continue;
        const verdict = await runContradictionJudge({
          newBody: rec.body,
          candidateId: cand.id,
          candidateBody: candBody,
          mock: args.mockContradictionJudge,
        });
        if (verdict.verdict === "contradict") {
          const conflictPath = writeConflictFile({
            repoRoot,
            newId: rec.id,
            newBody: rec.body,
            newSourceFile: rec.source_file,
            otherId: cand.id,
            otherBody: candBody,
            otherSotPath: cand.sot_path,
            reasoning: verdict.reasoning,
            generatedAt: nowIso,
          });
          conflicts.push({
            newId: rec.id,
            otherId: cand.id,
            conflictPath,
            reasoning: verdict.reasoning,
          });
        }
      }
    }
  }

  // ── 7. Ledger rebuilds ───────────────────────────────────────────
  if (args.dryRun !== true) {
    if (decsWritten.length > 0) {
      try {
        writeDecisionsLedger({ repoRoot });
      } catch (err) {
        log.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "decisions ledger rebuild failed",
        );
      }
    }
    if (invsWritten.length > 0) {
      try {
        writeInvariantsLedger({ repoRoot });
      } catch (err) {
        log.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "invariants ledger rebuild failed",
        );
      }
    }
  }

  // ── 8. Audit yaml ───────────────────────────────────────────────
  const auditRelPath = `.cairn/baseline/rules-merge-${tsSlug}.yaml`;
  const auditPath = join(repoRoot, auditRelPath);

  const kindCounts: Record<RuleClassKind, number> = {
    decision: 0,
    "domain-rule": 0,
    constraint: 0,
    informational: 0,
    "operator-keep": 0,
  };
  for (const c of allClassifications) {
    kindCounts[c.kind] = (kindCounts[c.kind] ?? 0) + 1;
  }

  if (args.dryRun !== true) {
    writeYaml(auditPath, {
      run_at: nowIso,
      sources: sources.map((s) => ({ path: s.path, kind: s.kind, size: s.size })),
      sections_total: allClassifications.length,
      kind_counts: kindCounts,
      decs_written: decsWritten.length,
      invs_written: invsWritten.length,
      cites_emitted: citesEmitted.length,
      conflicts: conflicts.length,
      classifications: allClassifications.map((c) => ({
        source: c.source,
        title: c.title,
        level: c.level,
        kind: c.kind,
        slug: c.slug,
        start_offset: c.startOffset,
        failed: c.failed,
        ...(c.errorMessage !== undefined ? { error: c.errorMessage } : {}),
      })),
    });
  }

  log.info(
    {
      sources: sources.length,
      sections: allClassifications.length,
      kindCounts,
      decs: decsWritten.length,
      invs: invsWritten.length,
      cites: citesEmitted.length,
      conflicts: conflicts.length,
    },
    "rules merge complete",
  );

  return {
    sources,
    sectionsTotal: allClassifications.length,
    classifications: allClassifications,
    decsWritten,
    invsWritten,
    citesEmitted,
    conflicts,
    auditPath,
    auditRelPath,
    kindCounts,
  };
}

/* -------------------------------------------------------------------------- */
/* Per-section classifier                                                     */
/* -------------------------------------------------------------------------- */

interface SectionContext {
  sourcePath: string;
  sectionTitle: string;
  anchor: string;
  bodyMinusHeading: string;
}

async function classifySection(job: {
  source: RuleSourceFile;
  section: RuleSection;
  slug: string;
  bodyMinusHeading: string;
}): Promise<RuleClassification> {
  const body =
    job.bodyMinusHeading.length > SECTION_BODY_CAP
      ? `${job.bodyMinusHeading.slice(0, SECTION_BODY_CAP)}\n…[truncated]`
      : job.bodyMinusHeading;
  const prompt = [
    `Source: ${job.source.path}`,
    `Section title: ${job.section.title || "(preamble)"}`,
    `Heading level: ${job.section.level}`,
    "",
    "Body:",
    body,
  ].join("\n");
  try {
    const result = await runClaude({
      tier: "haiku",
      system: CLASSIFY_SYSTEM,
      prompt,
      jsonSchema: CLASSIFY_SCHEMA,
      timeoutMs: PER_SECTION_TIMEOUT_MS,
      isolateAmbientContext: true,
    });
    const parsed = result.parsed;
    if (typeof parsed !== "object" || parsed === null) {
      return informational(job, true, "non-object response");
    }
    const r = parsed as Record<string, unknown>;
    const kindRaw = r["kind"];
    const kind: RuleClassKind =
      kindRaw === "decision" ||
      kindRaw === "domain-rule" ||
      kindRaw === "constraint"
        ? kindRaw
        : "informational";
    return {
      source: job.source.path,
      level: job.section.level,
      title: job.section.title,
      startOffset: job.section.startOffset,
      slug: job.slug,
      kind,
      failed: false,
    };
  } catch (err) {
    return informational(job, true, err instanceof Error ? err.message : String(err));
  }
}

function informational(
  job: { source: RuleSourceFile; section: RuleSection; slug: string },
  failed: boolean,
  errorMessage?: string,
): RuleClassification {
  return {
    source: job.source.path,
    level: job.section.level,
    title: job.section.title,
    startOffset: job.section.startOffset,
    slug: job.slug,
    kind: "informational",
    failed,
    ...(errorMessage !== undefined ? { errorMessage } : {}),
  };
}

function isEmittableKind(kind: RuleClassKind): boolean {
  return kind === "decision" || kind === "domain-rule" || kind === "constraint";
}

/* -------------------------------------------------------------------------- */
/* Conflict detection                                                         */
/* -------------------------------------------------------------------------- */

interface JaccardCandidate {
  id: string;
  sot_path: string;
  similarity: number;
}

function jaccardCandidates(args: {
  newId: string;
  newBody: string;
  cache: SotCache;
  threshold: number;
  topK: number;
}): JaccardCandidate[] {
  const newTokens = tokenize(args.newBody, { codeAware: true });
  const scored: JaccardCandidate[] = [];
  for (const [id, entry] of Object.entries(args.cache.entries) as [
    string,
    SotCacheEntry,
  ][]) {
    if (id === args.newId) continue;
    const candidateTokens = new Set(entry.tokens);
    const score = jaccard(newTokens, candidateTokens);
    if (score < args.threshold) continue;
    scored.push({ id, sot_path: entry.sot_path, similarity: score });
  }
  scored.sort((a, b) => b.similarity - a.similarity);
  return scored.slice(0, args.topK);
}

async function runContradictionJudge(args: {
  newBody: string;
  candidateId: string;
  candidateBody: string;
  mock?: RunRulesMergeArgs["mockContradictionJudge"];
}): Promise<{ verdict: "contradict" | "agree" | "unrelated"; reasoning: string }> {
  if (args.mock !== undefined) {
    const verdict = await args.mock({
      newBody: args.newBody,
      candidateId: args.candidateId,
      candidateBody: args.candidateBody,
    });
    return { verdict, reasoning: `(mock judge → ${verdict})` };
  }
  const a = capBody(args.newBody);
  const b = capBody(args.candidateBody);
  const prompt = [
    "Statement A (newly captured by phase 10):",
    a,
    "",
    `Statement B (already accepted as ${args.candidateId}):`,
    b,
    "",
    "Do these statements logically contradict each other?",
  ].join("\n");
  try {
    const result = await runClaude({
      tier: "haiku",
      system: CONTRADICTION_SYSTEM,
      prompt,
      jsonSchema: CONTRADICTION_SCHEMA,
      timeoutMs: PER_CONTRADICTION_TIMEOUT_MS,
      isolateAmbientContext: true,
    });
    const parsed = result.parsed;
    if (typeof parsed !== "object" || parsed === null) {
      return { verdict: "unrelated", reasoning: "(non-object judge response)" };
    }
    const r = parsed as Record<string, unknown>;
    const verdictRaw = r["verdict"];
    const verdict: "contradict" | "agree" | "unrelated" =
      verdictRaw === "contradict" || verdictRaw === "agree"
        ? verdictRaw
        : "unrelated";
    const reasoning = typeof r["reasoning"] === "string" ? r["reasoning"] : "";
    return { verdict, reasoning };
  } catch (err) {
    log.warn(
      {
        candidateId: args.candidateId,
        err: err instanceof Error ? err.message : String(err),
      },
      "contradiction judge failed; treating as unrelated",
    );
    return { verdict: "unrelated", reasoning: "(judge failed)" };
  }
}

function capBody(body: string): string {
  return body.length > CONFLICT_BODY_CAP
    ? `${body.slice(0, CONFLICT_BODY_CAP)}\n…[truncated]`
    : body;
}

interface WriteConflictArgs {
  repoRoot: string;
  newId: string;
  newBody: string;
  newSourceFile: string;
  otherId: string;
  otherBody: string;
  otherSotPath: string;
  reasoning: string;
  generatedAt: string;
}

function writeConflictFile(args: WriteConflictArgs): string {
  const dir = conflictsDir(args.repoRoot);
  mkdirSync(dir, { recursive: true });
  const filename = `${args.newId}__${args.otherId}.md`;
  const abs = join(dir, filename);
  const rel = `.cairn/ground/conflicts/${filename}`;
  const fm: Record<string, unknown> = {
    a_id: args.newId,
    a_source: args.newSourceFile,
    a_capture_source: CAPTURE_SOURCE,
    b_id: args.otherId,
    b_sot_path: args.otherSotPath,
    detected_at: args.generatedAt,
    detector: "phase-7c-contradiction-judge",
    severity: "soft",
    reasoning: args.reasoning,
  };
  const lines: string[] = [];
  lines.push("---");
  lines.push(stringifyYaml(fm).trimEnd());
  lines.push("---");
  lines.push("");
  lines.push(`# Conflict — ${args.newId} vs ${args.otherId}`);
  lines.push("");
  lines.push(`## ${args.newId} (just captured from \`${args.newSourceFile}\`)`);
  lines.push("");
  lines.push("```");
  lines.push(args.newBody.trimEnd());
  lines.push("```");
  lines.push("");
  lines.push(`## ${args.otherId} (already accepted, sot_path: \`${args.otherSotPath}\`)`);
  lines.push("");
  lines.push("```");
  lines.push(args.otherBody.trimEnd());
  lines.push("```");
  lines.push("");
  lines.push("## Judge reasoning");
  lines.push("");
  lines.push(args.reasoning.trim().length > 0 ? args.reasoning.trim() : "(no reasoning provided)");
  lines.push("");
  writeFileSync(abs, lines.join("\n"), "utf8");
  return rel;
}

function readEmittedBody(repoRoot: string, id: string): string | null {
  const isDec = id.startsWith("DEC-");
  const dir = isDec
    ? cairnDir(repoRoot, "ground", "decisions")
    : cairnDir(repoRoot, "ground", "invariants");
  const abs = join(dir, `${id}.md`);
  if (!existsSync(abs)) return null;
  let raw: string;
  try {
    raw = readFileSync(abs, "utf8");
  } catch {
    return null;
  }
  // Strip frontmatter — body is everything past the second `---` line.
  const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (fmMatch === null) return raw.trim();
  return raw.slice(fmMatch[0].length).trim();
}

/* -------------------------------------------------------------------------- */
/* Helpers                                                                    */
/* -------------------------------------------------------------------------- */

interface PersistGroundStateArgs {
  repoRoot: string;
  topicIndex: TopicIndex;
  anchorMap: AnchorMap;
  bindings: SotBindings;
  cache: SotCache;
}

function persistGroundState(args: PersistGroundStateArgs): void {
  const { repoRoot } = args;
  // Re-read each ground-state file right before write so concurrent
  // writers (phase 8 / 7b) don't get clobbered. parallel-678 runs the
  // three phases sequentially under v0.5.0; this merge is defense in
  // depth for the individual phase tools.
  const freshTopic = readTopicIndex(repoRoot);
  const baseTopic = Object.keys(freshTopic.topics).length > 0 ? freshTopic : emptyTopicIndex();
  for (const [slug, entry] of Object.entries(args.topicIndex.topics)) {
    baseTopic.topics[slug] = entry;
  }
  baseTopic.generated = new Date().toISOString();
  writeTopicIndex(repoRoot, baseTopic);

  const freshAnchor = readAnchorMap(repoRoot);
  const baseAnchor = Object.keys(freshAnchor.anchors).length > 0 ? freshAnchor : emptyAnchorMap();
  for (const [slug, anchor] of Object.entries(args.anchorMap.anchors)) {
    baseAnchor.anchors[slug] = anchor;
  }
  baseAnchor.generated = new Date().toISOString();
  writeAnchorMap(repoRoot, baseAnchor);

  const freshBindings = readSotBindings(repoRoot);
  const baseBindings =
    Object.keys(freshBindings.forward).length > 0 ? freshBindings : emptySotBindings();
  for (const [decId, sotPath] of Object.entries(args.bindings.forward)) {
    baseBindings.forward[decId] = sotPath;
  }
  for (const [sotPath, decIds] of Object.entries(args.bindings.reverse)) {
    const seen = new Set(baseBindings.reverse[sotPath] ?? []);
    for (const id of decIds) seen.add(id);
    baseBindings.reverse[sotPath] = Array.from(seen);
  }
  baseBindings.generated = new Date().toISOString();
  writeSotBindings(repoRoot, baseBindings);

  const freshCache = readSotCache(repoRoot);
  let baseCache = Object.keys(freshCache.entries).length > 0 ? freshCache : emptySotCache();
  for (const [decId, entry] of Object.entries(args.cache.entries)) {
    baseCache = setSotCacheEntry(baseCache, decId, entry);
  }
  baseCache.generated = new Date().toISOString();
  writeSotCache(repoRoot, baseCache);
}

function stripLeadingHeading(body: string): string {
  // parseRuleSections always pushes the heading line as the first entry
  // of `body`; strip it so the slug + emitted DEC body match phase 7's
  // section fingerprint convention (heading excluded from fingerprint).
  const newlineIdx = body.indexOf("\n");
  const trimmedFirst = body.slice(0, newlineIdx === -1 ? body.length : newlineIdx).trim();
  if (trimmedFirst.startsWith("#")) {
    return body.slice(newlineIdx === -1 ? body.length : newlineIdx + 1).trim();
  }
  return body.trim();
}

function headingToAnchor(line: string): string {
  return line
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-");
}

function writeYaml(path: string, payload: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, stringifyYaml(payload), "utf8");
}

