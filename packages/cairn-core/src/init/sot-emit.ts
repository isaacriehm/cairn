/**
 * SoT emit — write DEC + INV ground files from topic-index entries.
 *
 * Shared between phase 6 (docs-ingest), phase 7b (source-comments), and
 * phase 7c (rules-merge). Each phase decides which kind subset of the
 * topic-index it owns:
 *
 *   - Phase 6 — sot_source starts with `docs/`        → kind="path",  no strip
 *   - Phase 7b — sot_source maps to a source comment   → kind="ledger", strip-replace fires
 *   - Phase 7c — sot_source ∈ {CLAUDE.md, AGENTS.md, .claude/rules/*}
 *                                                       → kind="path",  no strip
 *
 * Verbatim bodies, auto-promote to `status: accepted`, content-addressed
 * ids derived from `(sot_path, title, capture_source)`, sot-bindings +
 * sot-cache updated as we emit. Plan §5.2 / §5.3 / §5.4.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { logger } from "../logger.js";
import {
  bindDec,
  bodyContentHash,
  decisionsDir,
  deriveDecId,
  deriveInvId,
  invariantsDir,
  readSotBindings,
  readSotCache,
  setSotCacheEntry,
  setTopic,
  type AnchorMap,
  type SotBindings,
  type SotCache,
  type SotKind,
  type TopicIndex,
  type TopicIndexEntry,
} from "@isaacriehm/cairn-state";
import { tokenize } from "../text/jaccard.js";

const log = logger("init.sot-emit");

type EmitKind = "decision" | "domain-rule" | "constraint" | "skip";

export interface EmitClassification {
  kind: EmitKind;
  title: string;
}

interface EmitClassifier {
  (block: { slug: string; body: string; sot_source: string; entry: TopicIndexEntry }): Promise<EmitClassification>;
}

/**
 * Override hook for id derivation. Default emit hashes
 * `(sot_path, title, capture_source)` via `deriveDecId`/`deriveInvId`.
 * Phase 7b's ledger captures need a richer input — `sot_path` is the
 * literal string `"ledger"` for every source-comment DEC, so collisions
 * are likely without source-location context. Phase 7b passes a deriver
 * keyed on `(source_file, source_offset, capture_source)`.
 */
interface IdDeriverArgs {
  entry: TopicIndexEntry;
  body: string;
  sot_path: string;
  capture_source: string;
  kind: "decision" | "constraint";
  title: string;
}

type IdDeriver = (args: IdDeriverArgs) => string;

interface EmitArgs {
  repoRoot: string;
  topicIndex: TopicIndex;
  anchorMap: AnchorMap;
  filter: (entry: TopicIndexEntry) => boolean;
  classifier: EmitClassifier;
  sot_kind: SotKind;
  capture_source: string;
  /** Optional id-derivation override; default is `(sot_path, title, capture_source)`. */
  idDeriver?: IdDeriver;
}

interface EmittedRecord {
  id: string;
  kind: "DEC" | "INV";
  sot_path: string;
  body: string;
  title: string;
  source_file: string;
  slug: string;
}

interface EmitResult {
  emitted: EmittedRecord[];
  skipped: { slug: string; reason: string }[];
  bindings: SotBindings;
  cache: SotCache;
  /**
   * Updated topic-index with `dec_id` stamped on every freshly-emitted
   * entry. Caller persists this so subsequent runs / cite lookups see
   * the canonical mapping.
   */
  topicIndex: TopicIndex;
}

export async function emitFromTopicIndex(args: EmitArgs): Promise<EmitResult> {
  const { repoRoot, topicIndex, anchorMap, filter, classifier, sot_kind, capture_source, idDeriver } = args;

  let bindings = readSotBindings(repoRoot);
  let cache = readSotCache(repoRoot);

  const emitted: EmittedRecord[] = [];
  const skipped: { slug: string; reason: string }[] = [];
  let updatedTopicIndex = topicIndex;

  for (const [slug, entry] of Object.entries(topicIndex.topics)) {
    if (!filter(entry)) continue;

    const body = readSotBody(repoRoot, entry, anchorMap);
    if (body === null) {
      skipped.push({ slug, reason: "anchor-map missing or body unreadable" });
      continue;
    }

    let cls: EmitClassification;
    try {
      cls = await classifier({ slug, body, sot_source: entry.sot_source, entry });
    } catch (err) {
      log.warn(
        { slug, err: err instanceof Error ? err.message : String(err) },
        "classifier failed; skipping entry",
      );
      skipped.push({ slug, reason: "classifier failed" });
      continue;
    }

    if (cls.kind === "skip") {
      skipped.push({ slug, reason: "classified as skip" });
      continue;
    }

    const sot_path = sot_kind === "ledger"
      ? "ledger"
      : entryToSotPath(entry);

    if (entry.dec_id !== undefined) {
      // Already emitted in a prior pass — re-run is idempotent.
      skipped.push({ slug, reason: `already emitted as ${entry.dec_id}` });
      continue;
    }

    const titleSeed = cls.title.length > 0 ? cls.title : firstLineFallback(body);
    const kindForId: "decision" | "constraint" =
      cls.kind === "constraint" ? "constraint" : "decision";
    const derivedId = idDeriver !== undefined
      ? idDeriver({ entry, body, sot_path, capture_source, kind: kindForId, title: titleSeed })
      : kindForId === "constraint"
        ? deriveInvId({ sot_path, title: titleSeed, capture_source })
        : deriveDecId({ sot_path, title: titleSeed, capture_source });

    if (cls.kind === "constraint") {
      writeInvariantFile({
        repoRoot,
        id: derivedId,
        title: titleSeed,
        body,
        sot_kind,
        sot_path,
        source_file: entry.sot_source,
        capture_source,
      });
      bindings = bindDec(bindings, derivedId, sot_path);
      cache = setSotCacheEntry(cache, derivedId, {
        dec_id: derivedId,
        sot_path,
        body_hash: bodyContentHash(body),
        tokens: Array.from(tokenize(body, { codeAware: true })),
        shingles: [],
        mtime_ms: Date.now(),
      });
      emitted.push({
        id: derivedId,
        kind: "INV",
        sot_path,
        body,
        title: titleSeed,
        source_file: entry.sot_source,
        slug,
      });
    } else {
      writeDecisionFile({
        repoRoot,
        id: derivedId,
        title: titleSeed,
        body,
        sot_kind,
        sot_path,
        source_file: entry.sot_source,
        capture_source,
      });
      bindings = bindDec(bindings, derivedId, sot_path);
      cache = setSotCacheEntry(cache, derivedId, {
        dec_id: derivedId,
        sot_path,
        body_hash: bodyContentHash(body),
        tokens: Array.from(tokenize(body, { codeAware: true })),
        shingles: [],
        mtime_ms: Date.now(),
      });
      emitted.push({
        id: derivedId,
        kind: "DEC",
        sot_path,
        body,
        title: titleSeed,
        source_file: entry.sot_source,
        slug,
      });
    }

    updatedTopicIndex = setTopic(updatedTopicIndex, slug, { ...entry, dec_id: derivedId });
  }

  return { emitted, skipped, bindings, cache, topicIndex: updatedTopicIndex };
}

/* -------------------------------------------------------------------------- */
/* Body lookup                                                                */
/* -------------------------------------------------------------------------- */

export function readSotBody(
  repoRoot: string,
  entry: TopicIndexEntry,
  anchorMap: AnchorMap,
): string | null {
  const sot = entry.candidates.find((c) => c.file === entry.sot_source);
  if (sot === undefined) return null;
  const anchor = anchorMap.anchors[entry.slug];
  const range = anchor?.line_range ?? sot.line_range;
  if (range === undefined) return null;
  const abs = join(repoRoot, sot.file);
  if (!existsSync(abs)) return null;
  let raw: string;
  try {
    raw = readFileSync(abs, "utf8");
  } catch {
    return null;
  }
  const lines = raw.split("\n");
  const [startOneBased, endOneBased] = range;
  const start = Math.max(0, startOneBased - 1);
  const end = Math.min(lines.length, endOneBased);
  return lines.slice(start, end).join("\n").trim();
}

function entryToSotPath(entry: TopicIndexEntry): string {
  const sot = entry.candidates.find((c) => c.file === entry.sot_source);
  if (sot === undefined) return entry.sot_source;
  if (sot.anchor !== undefined && sot.anchor.length > 0) {
    return `${entry.sot_source}#${sot.anchor}`;
  }
  return entry.sot_source;
}

/**
 * Derive a fallback title from the first prose-bearing line of the body.
 *
 * Source bodies arrive verbatim from `readSotBody`, so the walker's
 * language-specific marker stripping (C-style, JSDoc, Python docstring,
 * Ruby block comment, hash clusters, etc.) doesn't apply here — we
 * have to handle every comment syntax the source-comment walker
 * accepts. Mirrors the language coverage of
 * `init/source-comments/walker.ts` (C-family, Python, Ruby, Rust, Go,
 * shell, Lua, …) plus markdown headings.
 *
 * Strategy: walk lines until one yields real prose. Per line: strip
 * leading whitespace, then strip every leading comment marker we
 * recognize, then trim. Skip lines that are empty after stripping,
 * pure separators, JSDoc-style `@tag` annotations, or block-comment
 * boundary markers (`"""`, `=begin`, `--[[`, `{-`, `(*`, etc.).
 *
 * Exported so phase 6 (docs) and phase 7b (source-comments) share one
 * implementation — there used to be a divergent copy in ingest-docs.ts.
 */
export function firstLineFallback(body: string): string {
  // Block-comment boundary markers we should skip outright. These
  // never carry prose content — they're always the open/close of a
  // multi-line comment block in their respective languages.
  const PURE_MARKER_LINE = /^("""|'''|=begin\b.*|=end\b.*|--\[\[|--\]\]|\{-|-\}|\(\*|\*\))$/;

  for (const raw of body.split("\n")) {
    const cleaned = raw
      .replace(/^\s+/, "")                // leading whitespace
      .replace(/\*+\/\s*$/, "")           // trailing `*/`
      .replace(/^\/\*+\s*/, "")           // leading `/**` or `/*`
      .replace(/^\/\/+\s*/, "")           // leading `//` (C-family, Rust, Go, Swift, Kotlin)
      .replace(/^\*+\s*/, "")             // leading `*` (JSDoc continuation)
      .replace(/^("""|''')\s*/, "")       // leading Python triple-quote on a content line
      .replace(/\s*("""|''')\s*$/, "")    // trailing Python triple-quote on a content line
      .replace(/^#+\s*/, "")              // markdown heading marker (also Python/Ruby/shell `#`)
      .replace(/^[─━–—=*~_-]{2,}\s*/, "") // leading separator dashes (incl. ASCII `-`)
      .replace(/\s*[─━–—=*~_-]{2,}\s*$/, "") // trailing separator dashes
      .trim();
    if (cleaned.length === 0) continue;                       // marker-only line
    if (PURE_MARKER_LINE.test(cleaned)) continue;             // block-comment boundary
    if (cleaned.startsWith("@")) continue;                    // JSDoc / language annotation
    if (/^[─━–—=*~_-]+$/.test(cleaned)) continue;             // pure separator
    return cleaned.slice(0, 120);
  }
  return "(untitled)";
}

/* -------------------------------------------------------------------------- */
/* Filesystem writers                                                         */
/* -------------------------------------------------------------------------- */

interface WriteEntityArgs {
  repoRoot: string;
  id: string;
  title: string;
  body: string;
  sot_kind: SotKind;
  sot_path: string;
  source_file: string;
  capture_source: string;
}

function writeDecisionFile(args: WriteEntityArgs): void {
  const dir = decisionsDir(args.repoRoot);
  mkdirSync(dir, { recursive: true });
  const abs = join(dir, `${args.id}.md`);
  writeFileSync(abs, renderEntity({ ...args, kind: "DEC" }), "utf8");
  log.debug({ abs, id: args.id }, "wrote decision");
}

function writeInvariantFile(args: WriteEntityArgs): void {
  const dir = invariantsDir(args.repoRoot);
  mkdirSync(dir, { recursive: true });
  const abs = join(dir, `${args.id}.md`);
  writeFileSync(abs, renderEntity({ ...args, kind: "INV" }), "utf8");
  log.debug({ abs, id: args.id }, "wrote invariant");
}

export function emitDec(args: {
  repoRoot: string;
  title: string;
  body: string;
  topicSlug: string;
  sourceFile: string;
}): { id: string } {
  const capture_source = "cairn-init";
  const sot_path = "ledger";
  const id = deriveDecId({ sot_path, title: args.title, capture_source });
  writeDecisionFile({
    repoRoot: args.repoRoot,
    id,
    title: args.title,
    body: args.body,
    sot_kind: "ledger",
    sot_path,
    source_file: args.sourceFile,
    capture_source,
  });
  return { id };
}

export function emitInv(args: {
  repoRoot: string;
  title: string;
  body: string;
  topicSlug: string;
  sourceFile: string;
}): { id: string } {
  const capture_source = "cairn-init";
  const sot_path = "ledger";
  const id = deriveInvId({ sot_path, title: args.title, capture_source });
  writeInvariantFile({
    repoRoot: args.repoRoot,
    id,
    title: args.title,
    body: args.body,
    sot_kind: "ledger",
    sot_path,
    source_file: args.sourceFile,
    capture_source,
  });
  return { id };
}

function renderEntity(args: WriteEntityArgs & { kind: "DEC" | "INV" }): string {
  const now = new Date().toISOString();
  const fm: Record<string, unknown> = {
    id: args.id,
    title: args.title,
    type: args.kind === "DEC" ? "adr" : "invariant",
    status: "accepted",
    audience: "dual",
    generated: now,
    "verified-at": now,
    sot_kind: args.sot_kind,
    sot_path: args.sot_path,
    sot_content_hash: bodyContentHash(args.body),
    capture_source: args.capture_source,
    source_file: args.source_file,
  };
  if (args.kind === "DEC") {
    fm["decided_at"] = now;
    fm["decided_by"] = "cairn-init";
  }
  const out: string[] = [];
  out.push("---");
  out.push(stringifyYaml(fm).trimEnd());
  out.push("---");
  out.push("");
  out.push(args.body.trimEnd());
  out.push("");
  return out.join("\n");
}
