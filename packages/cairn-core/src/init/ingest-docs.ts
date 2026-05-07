/**
 * Phase 6 — docs ingestion (v0.5.0 SoT model).
 *
 * Reads the topic-index built by phase 5b, filters to entries whose SoT
 * source lives under `docs/*`, and emits verbatim DEC files under
 * `.cairn/ground/decisions/`. Auto-promoted to `status: accepted`. No
 * draft inbox, no LLM paraphrase — the doc paragraph itself IS the
 * canonical body, recorded with `sot_kind: path` so the lens renders
 * the live source on every read.
 *
 * Per-entry Haiku call decides `kind` only (decision / domain-rule /
 * voice-guidelines / api-docs / other). The first two emit a DEC; the
 * rest are skipped at this layer (voice + canonical-topic flows are
 * handled by other tooling now — they were file-level concerns under
 * the v0.4.x model and have no clean paragraph-level analogue).
 */

import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join, relative } from "node:path";
import type { Dirent } from "node:fs";
import { runClaude } from "../claude/index.js";
import {
  readAnchorMap,
  readTopicIndex,
  writeSotBindings,
  writeSotCache,
  writeTopicIndex,
  type TopicIndexEntry,
} from "../ground/index.js";
import { logger } from "../logger.js";
import { emitFromTopicIndex, type EmitClassification } from "./sot-emit.js";

const log = logger("init.ingest-docs");

const PER_DOC_TIMEOUT_MS = 60_000;
const DOC_BODY_CAP = 8_000;

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
  ".archive",
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

export interface IngestionResult {
  /** Verbatim DEC files written under `.cairn/ground/decisions/`. */
  decsWritten: { id: string; path: string; sourceFile: string; slug: string }[];
  /** Topic-index entries that were not emitted, with reasons. */
  skipped: { slug: string; reason: string }[];
  /** Number of topic-index entries considered (sot_source under docs/). */
  scannedEntries: number;
}

export interface RunDocsIngestionArgs {
  repoRoot: string;
  /** Smoke override — feed canned classifications keyed by slug. */
  mockClassify?: (
    entry: TopicIndexEntry,
    body: string,
  ) => DocClassification;
  /** Caller-supplied id collision Set (parallel pipeline). */
  existingDecIds?: Set<string>;
  /** Progress callback fired once per emitted entry. */
  onEntryProgress?: (row: { slug: string; emitted: boolean; total: number }) => void;
}

/* -------------------------------------------------------------------------- */
/* Discovery (still useful for sanity checks + external callers)              */
/* -------------------------------------------------------------------------- */

export function discoverDocs(repoRoot: string): DocCandidate[] {
  const docsDir = join(repoRoot, "docs");
  if (!existsSync(docsDir)) return [];
  const out: DocCandidate[] = [];
  walkDocsDir(docsDir, repoRoot, out);
  return out;
}

function walkDocsDir(dir: string, repoRoot: string, out: DocCandidate[]): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true, encoding: "utf8" });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (SKIP_DIRS.has(ent.name)) continue;
    const abs = join(dir, ent.name);
    if (ent.isDirectory()) {
      walkDocsDir(abs, repoRoot, out);
      continue;
    }
    if (!ent.isFile() || !ent.name.endsWith(".md")) continue;
    let st;
    try {
      st = statSync(abs);
    } catch {
      continue;
    }
    out.push({ path: relative(repoRoot, abs), size: st.size, group: dirGroup(relative(repoRoot, abs)) });
  }
}

function dirGroup(rel: string): string {
  const parts = rel.split("/");
  if (parts.length <= 1) return "(root)";
  return `${parts[0]}/`;
}

/* -------------------------------------------------------------------------- */
/* Haiku classifier — kind only, no rewriting                                 */
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
  },
  required: ["kind", "proposedTitle"],
} as const;

const CLASSIFY_SYSTEM = `You classify project documentation paragraphs for Cairn's Single-Source-of-Truth ledger.

Return JSON matching the supplied schema.

\`kind\` choices:
  - "decision"          paragraph describes a binding decision or architectural choice
  - "domain-rule"       paragraph describes a domain rule or constraint developers must obey
  - "voice-guidelines"  paragraph is brand voice / tone guidance
  - "api-docs"          paragraph documents an API surface or schema (descriptive, not binding)
  - "other"             nothing actionable for the cairn state layer

\`proposedTitle\` 5-10 words, imperative voice, empty for "other".

Be conservative — false-positive decisions pollute the ground state worse
than missed capture. Default to "other" when uncertain.`;

async function classifyEntry(
  entry: TopicIndexEntry,
  body: string,
): Promise<DocClassification> {
  const capped = body.length > DOC_BODY_CAP ? `${body.slice(0, DOC_BODY_CAP)}\n…[truncated]` : body;
  const prompt = `Source: ${entry.sot_source}\nSlug: ${entry.slug}\n\n---\n${capped}`;
  const result = await runClaude({
    tier: "haiku",
    system: CLASSIFY_SYSTEM,
    prompt,
    jsonSchema: CLASSIFY_SCHEMA,
    timeoutMs: PER_DOC_TIMEOUT_MS,
    isolateAmbientContext: true,
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
  };
}

/* -------------------------------------------------------------------------- */
/* Orchestrator                                                               */
/* -------------------------------------------------------------------------- */

export async function runDocsIngestion(
  args: RunDocsIngestionArgs,
): Promise<IngestionResult> {
  const topicIndex = readTopicIndex(args.repoRoot);
  const anchorMap = readAnchorMap(args.repoRoot);

  const candidateEntries = Object.values(topicIndex.topics).filter((entry) =>
    isDocSoT(entry) && entry.dec_id === undefined,
  );

  if (candidateEntries.length === 0) {
    log.info("phase 6 found no eligible docs entries in topic-index");
    return { decsWritten: [], skipped: [], scannedEntries: 0 };
  }

  let processed = 0;

  const result = await emitFromTopicIndex({
    repoRoot: args.repoRoot,
    topicIndex,
    anchorMap,
    filter: (entry) => isDocSoT(entry) && entry.dec_id === undefined,
    classifier: async ({ body, entry }) => {
      let cls: DocClassification;
      try {
        cls = args.mockClassify !== undefined
          ? args.mockClassify(entry, body)
          : await classifyEntry(entry, body);
      } catch (err) {
        log.warn(
          { slug: entry.slug, err: err instanceof Error ? err.message : String(err) },
          "classifier failed; skipping",
        );
        return { kind: "skip", title: "" } satisfies EmitClassification;
      }
      processed += 1;
      if (args.onEntryProgress !== undefined) {
        args.onEntryProgress({
          slug: entry.slug,
          emitted: cls.kind === "decision" || cls.kind === "domain-rule",
          total: candidateEntries.length,
        });
      }
      if (cls.kind === "decision" || cls.kind === "domain-rule") {
        return { kind: "decision", title: cls.proposedTitle } satisfies EmitClassification;
      }
      return { kind: "skip", title: cls.proposedTitle } satisfies EmitClassification;
    },
    sot_kind: "path",
    capture_source: "init-docs-ingest",
  });

  writeSotBindings(args.repoRoot, result.bindings);
  writeSotCache(args.repoRoot, result.cache);
  writeTopicIndex(args.repoRoot, result.topicIndex);

  const decsWritten = result.emitted.map((rec) => ({
    id: rec.id,
    path: relativeDecPath(rec.id),
    sourceFile: rec.source_file,
    slug: rec.slug,
  }));

  log.info(
    {
      scanned: candidateEntries.length,
      emitted: decsWritten.length,
      skipped: result.skipped.length,
      processed,
    },
    "phase 6 complete",
  );

  return {
    decsWritten,
    skipped: result.skipped,
    scannedEntries: candidateEntries.length,
  };
}

function relativeDecPath(id: string): string {
  return `.cairn/ground/decisions/${id}.md`;
}

/**
 * Phase 6 owns every topic-index entry whose SoT candidate was tagged
 * `kind="doc"` by the phase 5b walker. Path-prefix matching would lock
 * us to `docs/` and miss `documentation/`, `official_docs/`, etc.; the
 * walker's per-candidate kind is already the right discriminant.
 */
function isDocSoT(entry: { sot_source: string; candidates: { file: string; kind: string }[] }): boolean {
  const sot = entry.candidates.find((c) => c.file === entry.sot_source);
  return sot !== undefined && sot.kind === "doc";
}

