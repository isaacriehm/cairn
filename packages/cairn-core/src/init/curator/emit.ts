/**
 * Curator pipeline — Phase 9c-emit (v0.9.0).
 *
 * Reads `.cairn/init/curator/final.jsonl` (written by the
 * skill-driven curator-reduce subagent), validates each entry via
 * `validateEntry`, and writes survivors directly to ground:
 *
 *   - DEC → `.cairn/ground/decisions/<id>.md` (status: accepted)
 *   - INV → `.cairn/ground/invariants/<id>.md` (status: active)
 *
 * Frontmatter fields populated:
 *   - `id`             — content-addressed sha7 over (title, body, capture_source)
 *   - `title`          — verbatim from final entry
 *   - `status`         — "accepted" (DEC) / "active" (INV)
 *   - `capture_source` — "init-curator"
 *   - `evidence_files` — array of `path[:line-range]` strings the
 *                         curator cited as the source of the decision
 *   - `scope_globs`    — narrow globs covering the cited evidence
 *   - `topic_tags`     — short slugs for cross-referencing
 *
 * Invalid entries drop silently with a counter; operator's
 * auto-accept directive (curator plan §"Decision log" Q2) means the
 * bar is hard, not deferred to inbox.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import {
  bodyContentHash,
  cairnDir,
  decisionsDir,
  invariantsDir,
  writeDecisionsLedger,
  writeInvariantsLedger,
} from "@isaacriehm/cairn-state";
import {
  computeDecisionId,
  computeInvariantId,
  scanExistingDecisionIds,
  scanExistingInvariantIds,
} from "../../decision-capture/id.js";
import { logger } from "../../logger.js";
import { filterExistingEvidence, validateEntry, type FinalEntry } from "./validate.js";

const log = logger("init.curator.emit");

const CAPTURE_SOURCE = "init-curator";

export interface RunCuratorEmitArgs {
  repoRoot: string;
  /**
   * Draft mode (resync re-curation). Writes each entry as a reviewable
   * `_inbox/<id>.draft.md` (status `draft`) instead of graduating it
   * straight to ground, and does NOT rebuild the ledgers. The operator
   * drains the drafts via cairn-attention (accept graduates; reject
   * archives). Default false — init auto-accepts into ground.
   */
  draft?: boolean;
  /** capture_source stamped into frontmatter. Default "init-curator". */
  captureSource?: string;
}

export interface CuratorEmitWritten {
  id: string;
  /** Repo-relative POSIX path. */
  path: string;
  title: string;
}

export interface RunCuratorEmitResult {
  decsWritten: CuratorEmitWritten[];
  invsWritten: CuratorEmitWritten[];
  /** Total dropped by validators. */
  dropped: number;
  /** Per-rejection-reason counts. */
  dropReasons: Record<string, number>;
}

export async function runCuratorEmit(
  args: RunCuratorEmitArgs,
): Promise<RunCuratorEmitResult> {
  const { repoRoot } = args;
  const draft = args.draft === true;
  const captureSource = args.captureSource ?? CAPTURE_SOURCE;
  const finalAbs = cairnDir(repoRoot, "init", "curator", "final.jsonl");
  if (!existsSync(finalAbs)) {
    return {
      decsWritten: [],
      invsWritten: [],
      dropped: 0,
      dropReasons: {},
    };
  }

  const lines = readFileSync(finalAbs, "utf8").split("\n");
  const existingDecIds = scanExistingDecisionIds(repoRoot);
  const existingInvIds = scanExistingInvariantIds(repoRoot);

  const decsWritten: CuratorEmitWritten[] = [];
  const invsWritten: CuratorEmitWritten[] = [];
  const dropReasons: Record<string, number> = {};

  let lineNo = 0;
  for (const raw of lines) {
    lineNo += 1;
    if (raw.trim().length === 0) continue;

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (err) {
      bumpDrop(dropReasons, "json-parse-failed");
      log.warn(
        { lineNo, err: err instanceof Error ? err.message : String(err) },
        "curator final.jsonl line failed to parse",
      );
      continue;
    }

    const entry = coerceFinalEntry(parsed);
    if (entry === null) {
      bumpDrop(dropReasons, "shape-mismatch");
      continue;
    }

    const verdict = validateEntry(entry);
    if (!verdict.valid) {
      bumpDrop(dropReasons, verdict.rejectReason ?? "unknown");
      continue;
    }

    // Evidence is corroboration, not a gate: strip refs that don't resolve
    // on disk (doc-derived candidates routinely cite inferred or
    // submodule-only paths) but keep the entry regardless.
    entry.evidence_files = filterExistingEvidence(entry.evidence_files, repoRoot);

    if (entry.kind === "DEC") {
      const id = allocateDecId(entry, existingDecIds);
      const path = writeDecisionFile({ repoRoot, id, entry, draft, captureSource });
      existingDecIds.add(id);
      decsWritten.push({ id, path, title: entry.title });
    } else {
      const id = allocateInvId(entry, existingInvIds);
      const path = writeInvariantFile({ repoRoot, id, entry, draft, captureSource });
      existingInvIds.add(id);
      invsWritten.push({ id, path, title: entry.title });
    }
  }

  // Drafts are not graduated — leave the ledgers alone (they index ground,
  // and the operator graduates drafts later via cairn-attention).
  if (draft) {
    const dropped = Object.values(dropReasons).reduce((a, b) => a + b, 0);
    return { decsWritten, invsWritten, dropped, dropReasons };
  }

  // Rebuild aggregate ledgers when we wrote anything.
  if (decsWritten.length > 0) {
    try {
      writeDecisionsLedger({ repoRoot });
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "curator decisions ledger rebuild failed",
      );
    }
  }
  if (invsWritten.length > 0) {
    try {
      writeInvariantsLedger({ repoRoot });
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "curator invariants ledger rebuild failed",
      );
    }
  }

  const dropped = Object.values(dropReasons).reduce((a, b) => a + b, 0);
  return { decsWritten, invsWritten, dropped, dropReasons };
}

/* -------------------------------------------------------------------------- */
/* Internals                                                                  */
/* -------------------------------------------------------------------------- */

function bumpDrop(reasons: Record<string, number>, key: string): void {
  reasons[key] = (reasons[key] ?? 0) + 1;
}

/**
 * Loose JSON → FinalEntry coercion. Returns null when required fields
 * are missing or the wrong type. Validators catch deeper quality
 * issues; this guard only ensures the shape is parseable.
 */
function coerceFinalEntry(raw: unknown): FinalEntry | null {
  if (typeof raw !== "object" || raw === null) return null;
  const o = raw as Record<string, unknown>;
  const kind = o["kind"];
  if (kind !== "DEC" && kind !== "INV") return null;
  const title = o["title"];
  if (typeof title !== "string") return null;
  const body = o["body"];
  if (typeof body !== "string") return null;
  const scope = o["scope_globs"];
  if (!Array.isArray(scope)) return null;
  const evidence = o["evidence_files"];
  if (!Array.isArray(evidence)) return null;
  const tags = o["topic_tags"];
  if (!Array.isArray(tags)) return null;
  return {
    kind,
    title,
    body,
    scope_globs: scope.filter((s): s is string => typeof s === "string"),
    evidence_files: evidence.filter((s): s is string => typeof s === "string"),
    topic_tags: tags.filter((s): s is string => typeof s === "string"),
  };
}

function allocateDecId(entry: FinalEntry, existing: Set<string>): string {
  return computeDecisionId(
    {
      title: entry.title,
      rationale: entry.body,
      capture_source: CAPTURE_SOURCE,
      scope_globs: entry.scope_globs,
      body_markdown: entry.body,
    },
    existing,
  );
}

function allocateInvId(entry: FinalEntry, existing: Set<string>): string {
  // Invariant id derivation hashes a smaller surface — pin
  // (title, raw=body, capture_source) so curator ids stay stable
  // across re-runs that produce the same final entry.
  return computeInvariantId(
    {
      title: entry.title,
      raw: entry.body,
    },
    existing,
  );
}

interface WriteFileArgs {
  repoRoot: string;
  id: string;
  entry: FinalEntry;
  draft: boolean;
  captureSource: string;
}

function writeDecisionFile(args: WriteFileArgs): string {
  const baseDir = decisionsDir(args.repoRoot);
  const dir = args.draft ? join(baseDir, "_inbox") : baseDir;
  mkdirSync(dir, { recursive: true });
  const filename = args.draft ? `${args.id}.draft.md` : `${args.id}.md`;
  writeFileSync(join(dir, filename), renderDecision(args), "utf8");
  return args.draft
    ? `.cairn/ground/decisions/_inbox/${filename}`
    : `.cairn/ground/decisions/${filename}`;
}

function writeInvariantFile(args: WriteFileArgs): string {
  const baseDir = invariantsDir(args.repoRoot);
  const dir = args.draft ? join(baseDir, "_inbox") : baseDir;
  mkdirSync(dir, { recursive: true });
  const filename = args.draft ? `${args.id}.draft.md` : `${args.id}.md`;
  writeFileSync(join(dir, filename), renderInvariant(args), "utf8");
  return args.draft
    ? `.cairn/ground/invariants/_inbox/${filename}`
    : `.cairn/ground/invariants/${filename}`;
}

function renderDecision(args: WriteFileArgs): string {
  const now = new Date().toISOString();
  const fm = {
    id: args.id,
    title: args.entry.title,
    type: "adr",
    status: args.draft ? "draft" : "accepted",
    audience: "dual",
    generated: now,
    "verified-at": now,
    decided_at: now.slice(0, 10),
    decided_by: args.captureSource,
    capture_source: args.captureSource,
    sot_kind: "ledger",
    sot_path: "ledger",
    sot_content_hash: bodyContentHash(args.entry.body),
    scope_globs: args.entry.scope_globs,
    evidence_files: args.entry.evidence_files,
    topic_tags: args.entry.topic_tags,
  };
  return joinFrontmatter(fm, args.entry.body);
}

function renderInvariant(args: WriteFileArgs): string {
  const now = new Date().toISOString();
  const fm = {
    id: args.id,
    title: args.entry.title,
    type: "invariant",
    status: args.draft ? "draft" : "active",
    audience: "dual",
    generated: now,
    "verified-at": now,
    capture_source: args.captureSource,
    sot_kind: "ledger",
    sot_path: "ledger",
    sot_content_hash: bodyContentHash(args.entry.body),
    scope_globs: args.entry.scope_globs,
    evidence_files: args.entry.evidence_files,
    topic_tags: args.entry.topic_tags,
  };
  return joinFrontmatter(fm, args.entry.body);
}

function joinFrontmatter(fm: Record<string, unknown>, body: string): string {
  return ["---", stringifyYaml(fm).trimEnd(), "---", "", body.trim(), ""].join("\n");
}
