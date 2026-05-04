/**
 * Phase 6.1 — docs ingestion sweep.
 *
 * Scans the adopted repo for existing documentation, classifies each file
 * via a Haiku call, and:
 *   - decision / domain-rule  → DEC draft in decisions/_inbox/
 *   - voice-guidelines        → brand/voice.md (only when current is empty placeholder)
 *   - api-docs / other        → canonical-map topics.yaml entry (when topicSlug present)
 *
 * Cap 20 docs total — largest by byte count first. One Haiku call per doc.
 * Concurrency cap of 4 in-flight to avoid rate limits.
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
import { stringify as stringifyYaml } from "yaml";
import { runClaude } from "../claude/index.js";
import { allocateDecisionId, scanExistingDecisionIds } from "../decision-capture/id.js";
import { decisionsDir } from "../ground/paths.js";
import { logger } from "../logger.js";

const log = logger("init.ingest-docs");

const MAX_DOCS = 20;
const CONCURRENCY = 4;
const PER_DOC_TIMEOUT_MS = 60_000;
const DOC_BODY_CAP = 8_000;

const VOICE_PLACEHOLDER_MARKER = "(operator: replace this paragraph";

/** Where init looks for existing docs. */
const DISCOVER_DIRS = [
  "docs",
  ".planning",
  "planning",
  "decisions",
  "adr",
  "architecture",
];

/** Top-level files always considered. */
const DISCOVER_TOP_FILES = ["AGENTS.md", "README.md", "CLAUDE.md"];

/** Subdirs we never descend into. */
const SKIP_DIRS = new Set([
  ".harness",
  ".harness-build",
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  ".next",
  ".turbo",
  ".cache",
  "coverage",
  ".archive",
]);

export interface DocCandidate {
  /** Repo-relative path. */
  path: string;
  /** Byte count for largest-first ordering. */
  size: number;
  /** Bucket reported on the per-folder progress display. */
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
  proposedRationale: string;
  topicSlug: string;
}

export interface ClassifiedDoc {
  candidate: DocCandidate;
  classification: DocClassification;
  /** Set when the Haiku call failed; the doc is skipped downstream. */
  failed: boolean;
  errorMessage?: string;
}

export interface IngestionResult {
  /** Per-doc classification outcomes. */
  classifications: ClassifiedDoc[];
  /** DEC drafts written to decisions/_inbox/. */
  decDraftsWritten: { id: string; path: string; sourceFile: string }[];
  /** Canonical-map topic entries appended to topics.yaml. */
  canonicalTopicsAdded: { topic: string; canonicalPath: string }[];
  /** brand/voice.md was rewritten from the placeholder. */
  voiceUpdated: boolean;
  /** Group → progress row text shown during ingestion. */
  groupCounts: { group: string; drafts: number; total: number }[];
}

export interface RunDocsIngestionArgs {
  repoRoot: string;
  /** Called with one row per group as it finishes. */
  onGroupProgress?: (row: { group: string; drafts: number; total: number; ok: boolean }) => void;
  /**
   * Skip the LLM round-trip — used by smokes. When set, every candidate is
   * classified as "other" with empty fields; nothing is written.
   */
  mockClassify?: (candidate: DocCandidate, body: string) => DocClassification;
}

/* -------------------------------------------------------------------------- */
/* Discovery                                                                  */
/* -------------------------------------------------------------------------- */

export function discoverDocs(repoRoot: string): DocCandidate[] {
  const out: DocCandidate[] = [];

  for (const f of DISCOVER_TOP_FILES) {
    const abs = join(repoRoot, f);
    if (!existsSync(abs)) continue;
    try {
      const st = statSync(abs);
      if (!st.isFile()) continue;
      out.push({ path: f, size: st.size, group: f });
    } catch {
      continue;
    }
  }

  for (const d of DISCOVER_DIRS) {
    const abs = join(repoRoot, d);
    if (!existsSync(abs)) continue;
    let dirStat;
    try {
      dirStat = statSync(abs);
    } catch {
      continue;
    }
    if (!dirStat.isDirectory()) continue;
    walkMarkdown(abs, repoRoot, `${d}/`, out);
  }

  // Top-level loose .md files that aren't already covered.
  let topEntries: string[] = [];
  try {
    topEntries = readdirSync(repoRoot, { encoding: "utf8" });
  } catch {
    topEntries = [];
  }
  for (const e of topEntries) {
    if (!e.endsWith(".md")) continue;
    if (DISCOVER_TOP_FILES.includes(e)) continue;
    const abs = join(repoRoot, e);
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    out.push({ path: e, size: st.size, group: "(root)" });
  }

  return out;
}

function walkMarkdown(
  dir: string,
  repoRoot: string,
  group: string,
  out: DocCandidate[],
): void {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true, encoding: "utf8" });
  } catch {
    return;
  }
  for (const e of entries) {
    const abs = join(dir, e.name);
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
      walkMarkdown(abs, repoRoot, group, out);
      continue;
    }
    if (!e.isFile()) continue;
    if (!e.name.endsWith(".md")) continue;
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    out.push({ path: relative(repoRoot, abs), size: st.size, group });
  }
}

/* -------------------------------------------------------------------------- */
/* Classification (Haiku)                                                     */
/* -------------------------------------------------------------------------- */

const CLASSIFY_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    kind: {
      type: "string",
      enum: ["decision", "domain-rule", "voice-guidelines", "api-docs", "other"],
    },
    proposedTitle: { type: "string" },
    proposedRationale: { type: "string" },
    topicSlug: { type: "string" },
  },
  required: ["kind", "proposedTitle", "proposedRationale", "topicSlug"],
} as const;

const CLASSIFY_SYSTEM = `You classify project documentation files for Harness adoption.

Return JSON matching the supplied schema.

\`kind\` choices:
  - "decision"          file describes a binding decision or architectural choice
  - "domain-rule"       file describes a domain rule or constraint
  - "voice-guidelines"  file is user-facing copy / tone / brand voice guidance
  - "api-docs"          file documents an API surface or schema
  - "other"             nothing actionable for the harness state layer

\`proposedTitle\`     5-10 words, imperative voice, empty for "other"
\`proposedRationale\` 2-3 sentences summarising the binding content, empty for "other"
\`topicSlug\`         kebab-case slug suitable for canonical-map lookup, empty when no clear topic

Be conservative: prefer "other" over a low-confidence classification.`;

async function classifyDoc(
  candidate: DocCandidate,
  body: string,
): Promise<DocClassification> {
  const capped = body.length > DOC_BODY_CAP ? `${body.slice(0, DOC_BODY_CAP)}\n…[truncated]` : body;
  const prompt = `Path: ${candidate.path}\nSize: ${candidate.size} bytes\n\n---\n${capped}`;
  const result = await runClaude({
    tier: "haiku",
    system: CLASSIFY_SYSTEM,
    prompt,
    jsonSchema: CLASSIFY_SCHEMA,
    timeoutMs: PER_DOC_TIMEOUT_MS,
  });
  const parsed = result.parsed;
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("haiku returned non-object classification");
  }
  const r = parsed as Record<string, unknown>;
  const kind = r["kind"];
  if (
    kind !== "decision" &&
    kind !== "domain-rule" &&
    kind !== "voice-guidelines" &&
    kind !== "api-docs" &&
    kind !== "other"
  ) {
    throw new Error(`haiku returned unexpected kind: ${String(kind)}`);
  }
  return {
    kind,
    proposedTitle: typeof r["proposedTitle"] === "string" ? r["proposedTitle"] : "",
    proposedRationale:
      typeof r["proposedRationale"] === "string" ? r["proposedRationale"] : "",
    topicSlug: typeof r["topicSlug"] === "string" ? r["topicSlug"] : "",
  };
}

/* -------------------------------------------------------------------------- */
/* Concurrency-capped fan-out                                                 */
/* -------------------------------------------------------------------------- */

async function classifyAll(
  candidates: DocCandidate[],
  repoRoot: string,
  mockClassify: RunDocsIngestionArgs["mockClassify"] | undefined,
): Promise<ClassifiedDoc[]> {
  const results: ClassifiedDoc[] = new Array(candidates.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < candidates.length) {
      const idx = cursor++;
      const candidate = candidates[idx];
      if (candidate === undefined) continue;
      let body = "";
      try {
        body = readFileSync(join(repoRoot, candidate.path), "utf8");
      } catch (err) {
        results[idx] = {
          candidate,
          classification: emptyClassification(),
          failed: true,
          errorMessage: err instanceof Error ? err.message : String(err),
        };
        continue;
      }
      try {
        const classification =
          mockClassify !== undefined
            ? mockClassify(candidate, body)
            : await classifyDoc(candidate, body);
        results[idx] = { candidate, classification, failed: false };
      } catch (err) {
        log.warn(
          { path: candidate.path, err: err instanceof Error ? err.message : String(err) },
          "classifyDoc failed",
        );
        results[idx] = {
          candidate,
          classification: emptyClassification(),
          failed: true,
          errorMessage: err instanceof Error ? err.message : String(err),
        };
      }
    }
  }
  const workers = Array.from({ length: Math.min(CONCURRENCY, candidates.length) }, () =>
    worker(),
  );
  await Promise.all(workers);
  return results;
}

function emptyClassification(): DocClassification {
  return { kind: "other", proposedTitle: "", proposedRationale: "", topicSlug: "" };
}

/* -------------------------------------------------------------------------- */
/* Persisters                                                                 */
/* -------------------------------------------------------------------------- */

function writeDecDraftFromDoc(args: {
  repoRoot: string;
  id: string;
  classification: DocClassification;
  sourceFile: string;
}): { absPath: string; relPath: string } {
  const dir = decisionsDir(args.repoRoot);
  const inboxDir = join(dir, "_inbox");
  mkdirSync(inboxDir, { recursive: true });
  const filename = `${args.id}.draft.md`;
  const abs = join(inboxDir, filename);
  const rel = `.harness/ground/decisions/_inbox/${filename}`;
  const now = new Date().toISOString();
  const fm: Record<string, unknown> = {
    id: args.id,
    title: args.classification.proposedTitle || `(untitled — from ${args.sourceFile})`,
    type: "adr",
    status: "draft-from-init-docs",
    audience: "dual",
    generated: now,
    "verified-at": now,
    decided_at: now,
    decided_by: "harness-init",
    capture_source: "init-docs",
    capture_confidence: "medium",
    sourceFile: args.sourceFile,
    proposedTitle: args.classification.proposedTitle,
    proposedRationale: args.classification.proposedRationale,
  };
  const lines: string[] = [];
  lines.push("---");
  lines.push(stringifyYaml(fm).trimEnd());
  lines.push("---");
  lines.push("");
  lines.push(`# ${args.id} — ${fm["title"] as string}`);
  lines.push("");
  lines.push("## Source");
  lines.push(`Captured from \`${args.sourceFile}\` during \`harness init\`.`);
  lines.push("");
  lines.push("## Proposed rationale");
  lines.push(args.classification.proposedRationale.trim() || "(none extracted)");
  lines.push("");
  lines.push(
    "Operator: confirm via `harness attention`, edit, or discard. Until confirmed, this draft is not binding.",
  );
  lines.push("");
  writeFileSync(abs, lines.join("\n"), "utf8");
  return { absPath: abs, relPath: rel };
}

interface CanonicalTopicEntry {
  topic: string;
  canonical_path: string;
  audience?: string;
  status?: string;
}

function appendCanonicalTopics(args: {
  repoRoot: string;
  entries: { topic: string; canonicalPath: string }[];
}): { added: { topic: string; canonicalPath: string }[] } {
  if (args.entries.length === 0) return { added: [] };
  const path = join(
    args.repoRoot,
    ".harness",
    "ground",
    "canonical-map",
    "topics.yaml",
  );
  if (!existsSync(path)) {
    // Seed file missing — bail rather than overwrite an unexpected state.
    return { added: [] };
  }
  const text = readFileSync(path, "utf8");
  const existing = parseExistingTopicSlugs(text);
  const added: { topic: string; canonicalPath: string }[] = [];
  const lines: string[] = [];
  // Preserve original file by appending; keep operator's hand-curated comments.
  lines.push(text.trimEnd());
  lines.push("");
  lines.push("# ── Added by harness init Phase 6 — adoption ingestion ──");
  for (const entry of args.entries) {
    if (existing.has(entry.topic)) continue;
    if (entry.topic.length === 0) continue;
    const block: CanonicalTopicEntry = {
      topic: entry.topic,
      canonical_path: entry.canonicalPath,
      audience: "dual",
      status: "current",
    };
    lines.push(
      formatTopicEntry(block).trimEnd(),
    );
    existing.add(entry.topic);
    added.push(entry);
  }
  if (added.length === 0) return { added: [] };
  lines.push("");
  writeFileSync(path, lines.join("\n"), "utf8");
  return { added };
}

function parseExistingTopicSlugs(text: string): Set<string> {
  const out = new Set<string>();
  const re = /^\s*-\s*topic:\s*([\w./:-]+)\s*$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m[1] !== undefined) out.add(m[1]);
  }
  return out;
}

function formatTopicEntry(entry: CanonicalTopicEntry): string {
  const lines: string[] = [];
  lines.push(`  - topic: ${entry.topic}`);
  lines.push(`    canonical_path: ${entry.canonical_path}`);
  if (entry.audience !== undefined) lines.push(`    audience: ${entry.audience}`);
  if (entry.status !== undefined) lines.push(`    status: ${entry.status}`);
  return lines.join("\n");
}

function maybeUpdateVoiceFromDoc(args: {
  repoRoot: string;
  voiceDoc: ClassifiedDoc;
}): boolean {
  const path = join(args.repoRoot, ".harness", "ground", "brand", "voice.md");
  if (!existsSync(path)) return false;
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return false;
  }
  if (!text.includes(VOICE_PLACEHOLDER_MARKER)) return false;
  const sourceBody = readSourceBody(args.repoRoot, args.voiceDoc.candidate.path);
  if (sourceBody === null) return false;
  const now = new Date().toISOString();
  const fm: Record<string, unknown> = {
    type: "rule",
    status: "current",
    audience: "dual",
    generated: now,
    "verified-at": now,
    "source-commits": ["init-ingestion"],
    sourceFile: args.voiceDoc.candidate.path,
  };
  const out: string[] = [];
  out.push("---");
  out.push(stringifyYaml(fm).trimEnd());
  out.push("---");
  out.push("");
  out.push("# Brand voice");
  out.push("");
  out.push(`<!-- Imported from \`${args.voiceDoc.candidate.path}\` during \`harness init\`. -->`);
  out.push("");
  out.push(sourceBody.trim());
  out.push("");
  writeFileSync(path, out.join("\n"), "utf8");
  return true;
}

function readSourceBody(repoRoot: string, relPath: string): string | null {
  try {
    const text = readFileSync(join(repoRoot, relPath), "utf8");
    // Strip frontmatter if present so we don't double-stack it.
    const m = text.match(/^---\n[\s\S]*?\n---\n?([\s\S]*)$/);
    return m?.[1] ?? text;
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------------------- */
/* Orchestrator                                                               */
/* -------------------------------------------------------------------------- */

export async function runDocsIngestion(
  args: RunDocsIngestionArgs,
): Promise<IngestionResult> {
  const candidates = discoverDocs(args.repoRoot);
  candidates.sort((a, b) => b.size - a.size);
  const top = candidates.slice(0, MAX_DOCS);
  if (top.length === 0) {
    return {
      classifications: [],
      decDraftsWritten: [],
      canonicalTopicsAdded: [],
      voiceUpdated: false,
      groupCounts: [],
    };
  }

  const classifications = await classifyAll(top, args.repoRoot, args.mockClassify);

  // Allocate DEC ids serially so we never collide with each other or with
  // drafts already in _inbox/ from the mapper's heavyweight-comment extractor.
  const seenIds = scanExistingDecisionIds(args.repoRoot);
  const decDraftsWritten: IngestionResult["decDraftsWritten"] = [];
  const canonicalEntries: { topic: string; canonicalPath: string }[] = [];
  let voiceUpdated = false;

  for (const c of classifications) {
    if (c.failed) continue;
    const k = c.classification.kind;
    if (k === "decision" || k === "domain-rule") {
      const id = allocateDecisionId(args.repoRoot, seenIds);
      seenIds.add(id);
      const written = writeDecDraftFromDoc({
        repoRoot: args.repoRoot,
        id,
        classification: c.classification,
        sourceFile: c.candidate.path,
      });
      decDraftsWritten.push({
        id,
        path: written.relPath,
        sourceFile: c.candidate.path,
      });
    }
    if (k === "voice-guidelines" && !voiceUpdated) {
      voiceUpdated = maybeUpdateVoiceFromDoc({
        repoRoot: args.repoRoot,
        voiceDoc: c,
      });
    }
    if (c.classification.topicSlug.length > 0) {
      canonicalEntries.push({
        topic: c.classification.topicSlug,
        canonicalPath: c.candidate.path,
      });
    }
  }

  const canonical = appendCanonicalTopics({
    repoRoot: args.repoRoot,
    entries: canonicalEntries,
  });

  // Group rollup for the progress display.
  const groupCounts = rollupGroupCounts(classifications, decDraftsWritten);
  if (args.onGroupProgress !== undefined) {
    for (const row of groupCounts) {
      args.onGroupProgress({ ...row, ok: true });
    }
  }

  return {
    classifications,
    decDraftsWritten,
    canonicalTopicsAdded: canonical.added,
    voiceUpdated,
    groupCounts,
  };
}

function rollupGroupCounts(
  classifications: ClassifiedDoc[],
  drafts: IngestionResult["decDraftsWritten"],
): IngestionResult["groupCounts"] {
  const draftsByPath = new Set(drafts.map((d) => d.sourceFile));
  const totals = new Map<string, { drafts: number; total: number }>();
  for (const c of classifications) {
    const key = c.candidate.group;
    const cur = totals.get(key) ?? { drafts: 0, total: 0 };
    cur.total += 1;
    if (draftsByPath.has(c.candidate.path)) cur.drafts += 1;
    totals.set(key, cur);
  }
  return Array.from(totals.entries()).map(([group, c]) => ({
    group,
    drafts: c.drafts,
    total: c.total,
  }));
}

