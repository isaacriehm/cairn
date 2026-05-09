/**
 * Phase 7c orchestrator (v0.5.0 SoT model).
 *
 * Plan §5.4 algorithm:
 *   1. Discover sections in `CLAUDE.md`, `AGENTS.md`, `.claude/rules/*.md`.
 *   2. Topic-index lookup (built by phase 5b) before classification:
 *      - If section heading matches a topic-index slug → resolution="cite".
 *      - Else → resolution="classify".
 *   3. Resolution="classify":
 *      - Haiku classify section kind (decision | domain-rule | constraint | informational).
 *      - kind in {decision, domain-rule, constraint} → resolution="emit".
 *      - kind="informational" → resolution="skip".
 *   4. Contradiction judge (Layer C SessionStart drain pattern):
 *      - For resolution="emit" kinds: if a matching DEC/INV already
 *        exists in ground state (high Jaccard floor) → Haiku judge for
 *        contradiction.
 *      - If judge="contradict" → resolution="conflict" (written to `_conflicts/`).
 *      - Else → resolution="emit" (normal path).
 *   5. Final write:
 *      - resolution="cite" → append `// §DEC-NNNN` to original source (strip-replace).
 *      - resolution="emit" → write new ground file + append cite to original source.
 *
 * Side-effects: writes to ground state, writes `rules-merge-<ISO>.yaml`
 * audit file, emits invalidation events.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import {
  bodyContentHash,
  conflictsDir,
  emptyAnchorMap,
  emptySotBindings,
  readAnchorMap,
  readSotBindings,
  readTopicIndex,
  recordDriftEvent,
  setAnchor,
  topicSlug,
  writeAnchorMap,
  writeSotBindings,
  type SotCacheEntry,
  readSotCache,
} from "@isaacriehm/cairn-state";
import {
  writeDecisionsLedger,
  writeInvariantsLedger,
} from "@isaacriehm/cairn-state";
import { runClaude } from "../../claude/index.js";
import { logger } from "../../logger.js";
import { jaccard, tokenize } from "../../text/jaccard.js";
import {
  applyStripReplace,
  formatBareCitation,
  type ReplaceItem,
} from "../source-comments/strip-replace.js";
import {
  TIER2_JACCARD_FLOOR,
  isMarkdownPath,
  tier1PickWithBody,
  topKCandidates,
} from "../../hooks/sot-align-common.js";
import { emitShapeB } from "../../hooks/runners/payload.js";
import { discoverRuleSources, type RuleSourceFile } from "./discover.js";
import { parseRuleSections, type RuleSection } from "./parse-sections.js";
import { emitDec, emitInv } from "../sot-emit.js";

const log = logger("init.rules-merge");

const ClassifyResultSchema = z.object({
  kind: z.enum(["decision", "domain-rule", "constraint", "informational"]),
}).passthrough();

const ContradictionResultSchema = z.object({
  verdict: z.enum(["contradict", "agree", "unrelated"]),
  reasoning: z.string(),
}).passthrough();

const SECTION_BODY_CAP = 1200; // ~300 tokens per section
const PER_SECTION_TIMEOUT_MS = 30_000;
const PER_CONTRADICTION_TIMEOUT_MS = 20_000;

const CLASSIFY_SYSTEM =
  "You are a project-architecture classifier. You will be given a section " +
  "from a technical rule file (CLAUDE.md, AGENTS.md, or a per-topic rule). " +
  "Categorize the section into exactly one of these kinds:\n" +
  "- decision: a binding architectural or technical decision\n" +
  "- domain-rule: a domain-specific business or project rule\n" +
  "- constraint: a hard technical constraint or invariant\n" +
  "- informational: preamble, install instructions, narrative, meta-commentary\n" +
  "\nReply with JSON: { \"kind\": \"...\" }";

const CLASSIFY_SCHEMA = {
  type: "object",
  properties: {
    kind: { enum: ["decision", "domain-rule", "constraint", "informational"] },
  },
  required: ["kind"],
  additionalProperties: false,
};

const CONTRADICTION_SYSTEM =
  "You decide whether a NEW rule source-section contradicts an EXISTING ground-state decision or invariant. " +
  "You will be given the prose for both. They are usually similar (same topic). " +
  "Determine if they describe the same intent or if they contradict.\n" +
  "\nReply with JSON: { \"verdict\": \"contradict\" | \"agree\" | \"unrelated\", \"reasoning\": \"...\" }";

const CONTRADICTION_SCHEMA = {
  type: "object",
  properties: {
    verdict: { enum: ["contradict", "agree", "unrelated"] },
    reasoning: { type: "string" },
  },
  required: ["verdict", "reasoning"],
  additionalProperties: false,
};

export type RuleClassKind =
  | "decision"
  | "domain-rule"
  | "constraint"
  | "informational"
  | "operator-keep";

export interface RuleClassification {
  source: string;
  level: number;
  title: string;
  startOffset: number;
  slug: string;
  kind: RuleClassKind;
  failed: boolean;
  error?: string;
}

export interface RunRulesMergeArgs {
  repoRoot: string;
  dryRun?: boolean;
}

export interface RunRulesMergeResult {
  sourcesScanned: number;
  sectionsDiscovered: number;
  sectionsCited: number;
  sectionsEmitted: number;
  sectionsInformational: number;
  sectionsConflicting: number;
  sectionsFailed: number;
  auditPath: string | null;
}

/**
 * Orchestrate Phase 7c — rules-merge.
 */
export async function runRulesMerge(
  args: RunRulesMergeArgs,
): Promise<RunRulesMergeResult> {
  const repoRoot = args.repoRoot;
  const nowIso = new Date().toISOString();
  const auditPath = join(
    repoRoot,
    ".cairn",
    "baseline",
    `rules-merge-${nowIso.replace(/[:.]/g, "-")}.yaml`,
  );

  // 1. Discover sections.
  const ruleSources = discoverRuleSources(repoRoot);
  const jobs: { source: RuleSourceFile; section: RuleSection; slug: string }[] = [];
  for (const src of ruleSources) {
    let raw: string;
    try {
      raw = readFileSync(src.absPath, "utf8");
    } catch {
      continue;
    }
    const sections = parseRuleSections(raw);
    for (const s of sections) {
      const slug = topicSlug(s.title || src.path);
      jobs.push({ source: src, section: s, slug });
    }
  }

  if (jobs.length === 0) {
    return {
      sourcesScanned: ruleSources.length,
      sectionsDiscovered: 0,
      sectionsCited: 0,
      sectionsEmitted: 0,
      sectionsInformational: 0,
      sectionsConflicting: 0,
      sectionsFailed: 0,
      auditPath: null,
    };
  }

  // 2. Topic-index lookup.
  const topicIndex = readTopicIndex(repoRoot);
  const preResolved: {
    job: (typeof jobs)[0];
    resolution: "cite" | "classify";
    existingId?: string;
  }[] = [];

  for (const j of jobs) {
    const entry = topicIndex.topics[j.slug];
    if (entry !== undefined && entry.dec_id !== null) {
      preResolved.push({ job: j, resolution: "cite", existingId: entry.dec_id ?? "" });
    } else {
      preResolved.push({ job: j, resolution: "classify" });
    }
  }

  // 3. Classify remainder.
  const classificationResults: RuleClassification[] = [];
  const classifyJobs = preResolved.filter((r) => r.resolution === "classify");
  for (const r of classifyJobs) {
    const body = stripHeading(r.job.section.body);
    const c = await classifySection({
      source: r.job.source,
      section: r.job.section,
      slug: r.job.slug,
      bodyMinusHeading: body,
    });
    classificationResults.push(c);
  }

  // 4. Contradiction check for emitted kinds.
  const invsWritten: { id: string; slug: string }[] = [];
  const decsWritten: { id: string; slug: string }[] = [];
  const stripItems: ReplaceItem[] = [];
  const conflicts: {
    slug: string;
    source: string;
    existingId: string;
    verdict: string;
    reasoning: string;
  }[] = [];

  const allClassifications = classificationResults;

  // Add the pre-resolved "cite" ones as "operator-keep" so the auditor
  // sees them in the final report.
  for (const r of preResolved.filter((r) => r.resolution === "cite")) {
    allClassifications.push({
      source: r.job.source.path,
      level: r.job.section.level,
      title: r.job.section.title,
      startOffset: r.job.section.startOffset,
      slug: r.job.slug,
      kind: "operator-keep",
      failed: false,
    });
    if (r.existingId !== undefined) {
      stripItems.push({
        blockId: `rule-${r.job.slug}`,
        file: r.job.source.path,
        startOffset: r.job.section.startOffset,
        endOffset: r.job.section.startOffset + r.job.section.body.length,
        replacement: formatBareCitation(
          r.job.source.path.endsWith(".md") ? "markdown" : "unknown",
          r.existingId,
        ),
        expectedRaw: r.job.section.body,
      });
    }
  }

  // Handle classification results.
  for (const c of classificationResults) {
    if (c.failed || c.kind === "informational") continue;
    
    // Find the original job for this result.
    const job = jobs.find(
      (j) =>
        j.source.path === c.source &&
        j.section.startOffset === c.startOffset &&
        j.slug === c.slug,
    );
    if (!job) continue;

    const body = stripHeading(job.section.body);
    const res = await resolveRuleConflict(repoRoot, c, body);
    
    if (res.resolution === "conflict" && res.existingId !== undefined) {
      conflicts.push({
        slug: c.slug,
        source: c.source,
        existingId: res.existingId,
        verdict: "contradict",
        reasoning: res.reasoning ?? "(no reasoning provided)",
      });
      continue;
    }

    if (args.dryRun !== true) {
      if (c.kind === "constraint") {
        const inv = emitInv({
          repoRoot,
          title: c.title || c.slug,
          body,
          topicSlug: c.slug,
          sourceFile: c.source,
        });
        invsWritten.push({ id: inv.id, slug: c.slug });
        stripItems.push({
          blockId: `rule-${c.slug}`,
          file: c.source,
          startOffset: c.startOffset,
          endOffset: c.startOffset + job.section.body.length,
          replacement: formatBareCitation("markdown", inv.id),
          expectedRaw: job.section.body,
        });
      } else {
        const dec = emitDec({
          repoRoot,
          title: c.title || c.slug,
          body,
          topicSlug: c.slug,
          sourceFile: c.source,
        });
        decsWritten.push({ id: dec.id, slug: c.slug });
        stripItems.push({
          blockId: `rule-${c.slug}`,
          file: c.source,
          startOffset: c.startOffset,
          endOffset: c.startOffset + job.section.body.length,
          replacement: formatBareCitation("markdown", dec.id),
          expectedRaw: job.section.body,
        });
      }
    }
  }

  // 5. Final write.
  const kindCounts: Record<RuleClassKind, number> = {
    decision: 0,
    "domain-rule": 0,
    constraint: 0,
    informational: 0,
    "operator-keep": 0,
  };
  for (const c of allClassifications) {
    const current = kindCounts[c.kind];
    kindCounts[c.kind] = current + 1;
  }

  if (args.dryRun !== true) {
    writeYaml(auditPath, {
      run_at: nowIso,
      kind_counts: kindCounts,
      sources: ruleSources.map((s) => s.path),
      sections: allClassifications.map((c) => ({
        source: c.source,
        title: c.title,
        kind: c.kind,
        slug: c.slug,
        failed: c.failed,
        error: c.error,
        resolution: serializeResolution(
          invsWritten.find((w) => w.slug === c.slug) ||
            decsWritten.find((w) => w.slug === c.slug) ||
            stripItems.find((s) => s.blockId === `rule-${c.slug}`)
              ? {
                  kind: "cite",
                  existingId:
                    invsWritten.find((w) => w.slug === c.slug)?.id ||
                    decsWritten.find((w) => w.slug === c.slug)?.id ||
                    "?",
                  slug: c.slug,
                }
              : undefined,
        ),
      })),
      conflicts: conflicts,
    });

    if (stripItems.length > 0) {
      applyStripReplace({ repoRoot, items: stripItems });
    }
    if (invsWritten.length > 0) writeInvariantsLedger({ repoRoot });
    if (decsWritten.length > 0) writeDecisionsLedger({ repoRoot });
  }

  return {
    sourcesScanned: ruleSources.length,
    sectionsDiscovered: jobs.length,
    sectionsCited: stripItems.length - (invsWritten.length + decsWritten.length),
    sectionsEmitted: invsWritten.length + decsWritten.length,
    sectionsInformational: kindCounts.informational,
    sectionsConflicting: conflicts.length,
    sectionsFailed: classificationResults.filter((r) => r.failed).length,
    auditPath: args.dryRun ? null : auditPath,
  };
}

// ── Internal ─────────────────────────────────────────────────────────

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
    const resultParsed = ClassifyResultSchema.safeParse(parsed);
    if (!resultParsed.success) {
      return informational(job, true, "invalid response shape");
    }
    const kind = resultParsed.data.kind;
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
    const message = err instanceof Error ? err.message : String(err);
    return informational(job, true, message);
  }
}

async function resolveRuleConflict(
  repoRoot: string,
  c: RuleClassification,
  body: string,
): Promise<{ resolution: "emit" | "conflict"; existingId?: string; reasoning?: string }> {
  // Simple Jaccard check against active state.
  const cache = readSotCache(repoRoot);
  const cacheEntries = Object.values(cache.entries).filter((e): e is SotCacheEntry => e.tokens.length > 0);
  const candidates = topKCandidates(
    tokenize(body, { codeAware: true }),
    cacheEntries,
    TIER2_JACCARD_FLOOR,
    1,
  );
  const top = candidates[0];
  if (top === undefined) return { resolution: "emit" };

  const res = await runContradictionJudge({
    repoRoot,
    candidateId: top.id,
    newProse: body,
  });
  if (res.verdict === "contradict") {
    return { resolution: "conflict", existingId: top.id, reasoning: res.reasoning };
  }
  return { resolution: "emit" };
}

async function runContradictionJudge(args: {
  repoRoot: string;
  candidateId: string;
  newProse: string;
}): Promise<{ verdict: "contradict" | "agree" | "unrelated"; reasoning: string }> {
  const existingPath = join(
    args.candidateId.startsWith("DEC-") ? decisionsDir(args.repoRoot) : invariantsDir(args.repoRoot),
    `${args.candidateId}.md`,
  );
  if (!existsSync(existingPath)) return { verdict: "unrelated", reasoning: "existing missing" };
  const existingProse = readFileSync(existingPath, "utf8");
  const prompt = [
    "Existing ground-state rule:",
    existingProse,
    "",
    "New rule section from source:",
    args.newProse,
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
    const resultParsed = ContradictionResultSchema.safeParse(parsed);
    if (!resultParsed.success) {
      return { verdict: "unrelated", reasoning: "(invalid judge response)" };
    }
    return resultParsed.data;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(
      {
        candidateId: args.candidateId,
        err: message,
      },
      "contradiction judge failed; treating as unrelated",
    );
    return { verdict: "unrelated", reasoning: "(judge failed)" };
  }
}

function informational(
  job: { source: RuleSourceFile; section: RuleSection; slug: string },
  failed: boolean,
  error?: string,
): RuleClassification {
  return {
    source: job.source.path,
    level: job.section.level,
    title: job.section.title,
    startOffset: job.section.startOffset,
    slug: job.slug,
    kind: "informational",
    failed,
    ...(error !== undefined ? { error } : {}),
  };
}

function decisionsDir(repoRoot: string): string {
  return join(repoRoot, ".cairn", "ground", "decisions");
}

function invariantsDir(repoRoot: string): string {
  return join(repoRoot, ".cairn", "ground", "invariants");
}

function stripHeading(body: string): string {
  // parseRuleSections always pushes the heading line as the first entry
  // of `body`; strip it so the slug + emitted DEC body match phase 5b's
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

function serializeResolution(
  resolution:
    | { kind: "cite"; existingId: string; slug: string }
    | { kind: "emit"; slug: string; emitKind: "decision" | "constraint" }
    | undefined,
): unknown | null {
  if (resolution === undefined) return null;
  if (resolution.kind === "cite") {
    return { kind: "cite", existing_id: resolution.existingId, slug: resolution.slug };
  }
  return { kind: "emit", slug: resolution.slug, emit_kind: resolution.emitKind };
}
