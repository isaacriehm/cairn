/**
 * Phase 7c orchestrator — discover + parse + Haiku classify + persist.
 *
 * Ingests CLAUDE.md, AGENTS.md, .claude/CLAUDE.md, and `.claude/rules/**.md`
 * during init. Each H2/H3 section is classified by Haiku as:
 *
 *   - "rule-net-new"  — section states a rule cairn doesn't have yet (DEC draft to inbox)
 *   - "rule-conflict" — section conflicts with existing cairn state (soft-conflict to attention)
 *   - "informational" — TOC, history, walkthrough — no action
 *   - "operator-keep" — already inside keep-marker block (skipped pre-classification)
 *
 * Net-new rules become DEC drafts in `.cairn/ground/decisions/_inbox/`.
 * Soft conflicts append to `.cairn/baseline/rule-conflicts-<ISO>.yaml`.
 *
 * Resilient: a single Haiku failure marks the section "informational" and
 * continues. All output paths captured in the result so the skill can surface
 * them.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { runClaude } from "../../claude/index.js";
import {
  computeDecisionId,
  scanExistingDecisionIds,
} from "../../decision-capture/id.js";
import { decisionsDir } from "../../ground/paths.js";
import { logger } from "../../logger.js";
import { discoverRuleSources } from "./discover.js";
import type { RuleSourceFile } from "./discover.js";
import { parseRuleSections } from "./parse-sections.js";
import type { RuleSection } from "./parse-sections.js";

const log = logger("init.rules-merge.ingest");

const PER_SECTION_TIMEOUT_MS = 60_000;
const SECTION_BODY_CAP = 4_000;
const CONCURRENCY = 4;

export type RuleClassKind =
  | "rule-net-new"
  | "rule-conflict"
  | "informational"
  | "operator-keep";

export interface RuleClassification {
  source: string;
  level: 2 | 3 | 0;
  title: string;
  startOffset: number;
  kind: RuleClassKind;
  proposedDecTitle: string;
  proposedRationale: string;
  conflictsWith: string;
  failed: boolean;
  errorMessage?: string;
}

export interface RunRulesMergeArgs {
  repoRoot: string;
  /** When set, every section is classified by this fn — bypasses Haiku. */
  mockClassify?: (section: RuleSection, source: RuleSourceFile) => RuleClassification;
  dryRun?: boolean;
  nowIso?: string;
  /**
   * Caller-supplied DEC id Set. Same role as in `runDocsIngestion`: when
   * the parallel orchestrator runs phases 6 / 7b / 7c concurrently, all
   * three share one Set so DEC id allocations don't collide.
   */
  existingDecIds?: Set<string>;
  /**
   * Optional progress callback fired after each section finishes
   * classification. Enables the cairn-adopt statusline heartbeat.
   */
  onSectionProgress?: (row: { index: number; total: number }) => void;
}

export interface RunRulesMergeResult {
  sources: RuleSourceFile[];
  sectionsTotal: number;
  classifications: RuleClassification[];
  decDraftsWritten: { id: string; path: string; sourceFile: string }[];
  conflictsRecorded: number;
  conflictsPath: string | null;
  auditPath: string;
  auditRelPath: string;
  kindCounts: Record<RuleClassKind, number>;
}

/* -------------------------------------------------------------------------- */
/* Schema + prompt                                                            */
/* -------------------------------------------------------------------------- */

const CLASSIFY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["kind"],
  properties: {
    kind: {
      type: "string",
      enum: ["rule-net-new", "rule-conflict", "informational", "operator-keep"],
    },
    proposed_dec_title: { type: "string" },
    proposed_rationale: { type: "string" },
    conflicts_with: { type: "string" },
  },
} as const;

const CLASSIFY_SYSTEM = `You classify markdown sections of project-rule files for Cairn adoption.

Each section comes from one of: CLAUDE.md, AGENTS.md, .claude/CLAUDE.md, or a .claude/rules/*.md file.

Return JSON matching the schema. \`kind\` must be exactly one of:
  - "rule-net-new"   the section states a binding rule cairn doesn't yet have
  - "rule-conflict"  the section contradicts an existing cairn rule (provide conflicts_with id when known)
  - "informational"  TOC, walkthrough, history, formatting notes — nothing to ingest
  - "operator-keep"  the section is wrapped in keep-markers (rare — caller usually filters first)

Optional fields:
  - proposed_dec_title  5-10 word imperative title (only when kind = "rule-net-new")
  - proposed_rationale  2-3 sentence summary (only when kind = "rule-net-new")
  - conflicts_with      DEC-NNNN or §INV-NNNN id (only when kind = "rule-conflict")

Be conservative. When in doubt, "informational".`;

/* -------------------------------------------------------------------------- */
/* Public                                                                     */
/* -------------------------------------------------------------------------- */

export async function runRulesMerge(args: RunRulesMergeArgs): Promise<RunRulesMergeResult> {
  const repoRoot = args.repoRoot;
  const nowIso = args.nowIso ?? new Date().toISOString();
  const tsSlug = nowIso.replace(/[:.]/g, "-").slice(0, 19);

  const sources = discoverRuleSources(repoRoot);
  const allClassifications: RuleClassification[] = [];

  type Job = { source: RuleSourceFile; section: RuleSection };
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
      if (section.level === 0) continue; // skip preamble
      if (section.protectedByKeepMarker) {
        allClassifications.push({
          source: source.path,
          level: section.level,
          title: section.title,
          startOffset: section.startOffset,
          kind: "operator-keep",
          proposedDecTitle: "",
          proposedRationale: "",
          conflictsWith: "",
          failed: false,
        });
        continue;
      }
      jobs.push({ source, section });
    }
  }

  if (args.mockClassify !== undefined) {
    for (const [idx, job] of jobs.entries()) {
      allClassifications.push(args.mockClassify(job.section, job.source));
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
        const cls = await classifySection(job.source, job.section);
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

  // Persist DEC drafts + conflicts.
  const decDraftsWritten: { id: string; path: string; sourceFile: string }[] = [];
  const conflictRows: ConflictRow[] = [];
  const existingIds = args.existingDecIds ?? scanExistingDecisionIds(repoRoot);

  for (const cls of allClassifications) {
    if (cls.kind === "rule-net-new" && cls.proposedDecTitle.length > 0) {
      const id = computeDecisionId(
        {
          title: cls.proposedDecTitle,
          rationale: cls.proposedRationale,
          capture_source: "init-rules-merge",
          source_file: cls.source,
          source_offset: cls.startOffset,
          raw: cls.title,
        },
        existingIds,
      );
      existingIds.add(id);
      if (args.dryRun !== true) {
        const written = writeDecDraft({
          repoRoot,
          id,
          classification: cls,
          generatedAt: nowIso,
        });
        decDraftsWritten.push({ id, path: written.relPath, sourceFile: cls.source });
      } else {
        decDraftsWritten.push({
          id,
          path: `.cairn/ground/decisions/_inbox/${id}.draft.md`,
          sourceFile: cls.source,
        });
      }
    }
    if (cls.kind === "rule-conflict") {
      conflictRows.push({
        source_file: cls.source,
        section_title: cls.title,
        section_offset: cls.startOffset,
        conflicts_with: cls.conflictsWith,
      });
    }
  }

  const auditRelPath = `.cairn/baseline/rules-merge-${tsSlug}.yaml`;
  const auditPath = join(repoRoot, auditRelPath);
  let conflictsPath: string | null = null;

  const kindCounts: Record<RuleClassKind, number> = {
    "rule-net-new": 0,
    "rule-conflict": 0,
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
      classifications: allClassifications.map((c) => ({
        source: c.source,
        title: c.title,
        level: c.level,
        kind: c.kind,
        start_offset: c.startOffset,
        proposed_dec_title: c.proposedDecTitle,
        proposed_rationale: c.proposedRationale,
        conflicts_with: c.conflictsWith,
        failed: c.failed,
        ...(c.errorMessage !== undefined ? { error: c.errorMessage } : {}),
      })),
    });
    if (conflictRows.length > 0) {
      const rel = `.cairn/baseline/rule-conflicts-${tsSlug}.yaml`;
      conflictsPath = join(repoRoot, rel);
      writeYaml(conflictsPath, {
        run_at: nowIso,
        conflicts: conflictRows,
      });
    }
  }

  log.info(
    {
      sources: sources.length,
      sections: allClassifications.length,
      kindCounts,
      decDrafts: decDraftsWritten.length,
      conflicts: conflictRows.length,
    },
    "rules merge complete",
  );

  return {
    sources,
    sectionsTotal: allClassifications.length,
    classifications: allClassifications,
    decDraftsWritten,
    conflictsRecorded: conflictRows.length,
    conflictsPath,
    auditPath,
    auditRelPath,
    kindCounts,
  };
}

/* -------------------------------------------------------------------------- */
/* Classify single section (Haiku)                                            */
/* -------------------------------------------------------------------------- */

async function classifySection(
  source: RuleSourceFile,
  section: RuleSection,
): Promise<RuleClassification> {
  const body =
    section.body.length > SECTION_BODY_CAP
      ? `${section.body.slice(0, SECTION_BODY_CAP)}\n…[truncated]`
      : section.body;
  const prompt = [
    `Source: ${source.path}`,
    `Section title: ${section.title || "(preamble)"}`,
    `Heading level: ${section.level}`,
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
      return informational({
        source: source.path,
        section,
        failed: true,
        errorMessage: "non-object response",
      });
    }
    const r = parsed as Record<string, unknown>;
    const kindRaw = r["kind"];
    const kind: RuleClassKind =
      kindRaw === "rule-net-new" ||
      kindRaw === "rule-conflict" ||
      kindRaw === "operator-keep"
        ? kindRaw
        : "informational";
    return {
      source: source.path,
      level: section.level,
      title: section.title,
      startOffset: section.startOffset,
      kind,
      proposedDecTitle:
        typeof r["proposed_dec_title"] === "string" ? r["proposed_dec_title"] : "",
      proposedRationale:
        typeof r["proposed_rationale"] === "string" ? r["proposed_rationale"] : "",
      conflictsWith: typeof r["conflicts_with"] === "string" ? r["conflicts_with"] : "",
      failed: false,
    };
  } catch (err) {
    return informational({
      source: source.path,
      section,
      failed: true,
      errorMessage: err instanceof Error ? err.message : String(err),
    });
  }
}

function informational(args: {
  source: string;
  section: RuleSection;
  failed: boolean;
  errorMessage?: string;
}): RuleClassification {
  return {
    source: args.source,
    level: args.section.level,
    title: args.section.title,
    startOffset: args.section.startOffset,
    kind: "informational",
    proposedDecTitle: "",
    proposedRationale: "",
    conflictsWith: "",
    failed: args.failed,
    ...(args.errorMessage !== undefined ? { errorMessage: args.errorMessage } : {}),
  };
}

/* -------------------------------------------------------------------------- */
/* Persisters                                                                 */
/* -------------------------------------------------------------------------- */

interface ConflictRow {
  source_file: string;
  section_title: string;
  section_offset: number;
  conflicts_with: string;
}

function writeDecDraft(args: {
  repoRoot: string;
  id: string;
  classification: RuleClassification;
  generatedAt: string;
}): { absPath: string; relPath: string } {
  const dir = decisionsDir(args.repoRoot);
  const inboxDir = join(dir, "_inbox");
  mkdirSync(inboxDir, { recursive: true });
  const filename = `${args.id}.draft.md`;
  const abs = join(inboxDir, filename);
  const rel = `.cairn/ground/decisions/_inbox/${filename}`;
  const fm: Record<string, unknown> = {
    id: args.id,
    title: args.classification.proposedDecTitle || `(untitled — from ${args.classification.source})`,
    type: "adr",
    status: "draft-from-rules-merge",
    audience: "dual",
    generated: args.generatedAt,
    "verified-at": args.generatedAt,
    decided_at: args.generatedAt,
    decided_by: "cairn-init",
    capture_source: "init-rules-merge",
    capture_confidence: "medium",
    sourceFile: args.classification.source,
    sectionTitle: args.classification.title,
  };
  const lines: string[] = [];
  lines.push("---");
  lines.push(stringifyYaml(fm).trimEnd());
  lines.push("---");
  lines.push("");
  lines.push(`# ${args.id} — ${fm["title"] as string}`);
  lines.push("");
  lines.push("## Source section");
  lines.push("");
  lines.push(`From \`${args.classification.source}\`, section "${args.classification.title}".`);
  lines.push("");
  lines.push("## Proposed rationale");
  lines.push("");
  lines.push(args.classification.proposedRationale);
  lines.push("");
  writeFileSync(abs, lines.join("\n"), "utf8");
  return { absPath: abs, relPath: rel };
}

function writeYaml(path: string, payload: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, stringifyYaml(payload), "utf8");
}
