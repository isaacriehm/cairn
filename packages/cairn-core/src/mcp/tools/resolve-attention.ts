/**
 * cairn_resolve_attention — inline A/B/C resolution endpoint.
 *
 * Spec: PLUGIN_ARCHITECTURE §9 (MCP write tools — plugin-era addition).
 *
 * The cairn-attention skill calls this after the operator picks an
 * option. It maps the option (a/b/c/d) to a ground-state write (promote
 * draft, suppress finding, record resolution event).
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { z } from "zod";
import type { McpContext } from "../context.js";
import { cairnDir,
  anchorMapPath,
  bindDec,
  bodyContentHash,
  conflictsDir,
  emptyAnchorMap,
  emptySotBindings,
  readAnchorMap,
  readSotBindings,
  readSotCache,
  readTopicIndex,
  recordDriftEvent,
  setAnchor,
  setSotCacheEntry,
  topicSlug,
  writeAnchorMap,
  writeSotBindings,
  writeSotCache,
  decisionsDir,
  decisionsLedgerPath,
  invariantsDir,
  invariantsLedgerPath,
  writeDecisionsLedger,
  writeInvariantsLedger,
  parseFrontmatterRecord,
  deleteSotCacheEntry,
  unbindDec,
  alignmentPendingDir,
  archivedConflictsDir,
  deriveLedgerDecId,
  deriveLedgerInvId,
  writeFileSafe,
} from "@isaacriehm/cairn-state";
import { writeInvalidationEvent } from "../../events/index.js";
import { withWriteLock } from "../../lock.js";
import { requireBootstrap } from "../bootstrap-guard.js";
import { mcpError } from "./types.js";
import type { ToolDef } from "./types.js";
import {
  parseDraftMeta,
  runDecSourceStrip,
  type StripOutcomeSummary,
} from "../../attention/source-strip.js";
import { restoreDec } from "../../attention/restore.js";
import { tokenize } from "../../text/jaccard.js";
import {
  applyStripReplace,
  formatBareCitation,
  type ReplaceItem,
} from "../../init/source-comments/strip-replace.js";
import { writeDeferState, clearDeferState, type DeferKind } from "../../hooks/defer.js";
import { scanBypassedCommits } from "../../hooks/bypass-detection.js";
import { logger } from "../../logger.js";

const log = logger("mcp.tools.resolve-attention");

const resolveAttentionInput = {
  kind: z.enum([
    "decision_draft",
    "baseline_finding",
    "invalidation_event",
    "drift",
    "bypass",
    "review",
    "conflict",
    "alignment_pending",
  ]),
  item_id: z.string().optional(),
  // Batch form: resolve many items with the SAME kind + choice in one call.
  // The cairn-attention "defer all" path otherwise issues one MCP round-trip
  // per finding (dozens on a fresh adoption's baseline backlog). Pass
  // `item_ids` to collapse that to a single call. Mutually exclusive-ish with
  // `item_id`: when both appear, `item_ids` wins and `item_id` is ignored.
  item_ids: z.array(z.string()).optional(),
  choice: z.enum(["a", "b", "c", "d"]),
  rationale: z.string().optional(),
  defer_hours: z.number().optional(),
  flagged_items: z.array(z.string()).optional(),
};

type AttentionKind =
  | "decision_draft"
  | "invariant_draft"
  | "baseline_finding"
  | "invalidation_event"
  | "drift"
  | "bypass"
  | "review"
  | "conflict"
  | "alignment_pending";

/** Per-item resolution payload — what every kind-specific resolver consumes. */
interface Input {
  kind: AttentionKind;
  item_id: string;
  choice: "a" | "b" | "c" | "d";
  rationale?: string;
  defer_hours?: number;
  flagged_items?: string[];
}

/** Tool boundary — `item_id` (single) OR `item_ids` (batch). */
interface ToolInput {
  kind: AttentionKind;
  item_id?: string;
  item_ids?: string[];
  choice: "a" | "b" | "c" | "d";
  rationale?: string;
  defer_hours?: number;
  flagged_items?: string[];
}

async function handler(ctx: McpContext, input: ToolInput): Promise<unknown> {
  const block = requireBootstrap(ctx.repoRoot);
  if (block !== null) return block;

  const { item_id: _ignore, item_ids, ...rest } = input;

  // Batch path — same kind + choice across many ids in one round-trip.
  if (item_ids !== undefined && item_ids.length > 0) {
    const results: unknown[] = [];
    let resolved = 0;
    let failed = 0;
    for (const id of item_ids) {
      const single = await dispatchSingle(ctx, { ...rest, item_id: id });
      results.push(single);
      if (single !== null && typeof single === "object" && (single as { ok?: unknown }).ok === true) {
        resolved += 1;
      } else {
        failed += 1;
      }
    }
    return {
      ok: failed === 0,
      batch: true,
      kind: input.kind,
      choice: input.choice,
      count: item_ids.length,
      resolved,
      failed,
      results,
    };
  }

  if (input.item_id === undefined || input.item_id.length === 0) {
    return mcpError(
      "VALIDATION_FAILED",
      "resolve_attention requires item_id (or a non-empty item_ids array)",
    );
  }
  return dispatchSingle(ctx, { ...rest, item_id: input.item_id });
}

async function dispatchSingle(ctx: McpContext, input: Input): Promise<unknown> {
  switch (input.kind) {
    case "decision_draft":
      return resolveDecisionDraft(ctx, input);
    case "invariant_draft":
      return resolveInvariantDraft(ctx, input);
    case "baseline_finding":
      return resolveBaselineFinding(ctx, input);
    case "invalidation_event":
      return resolveInvalidationEvent(ctx, input);
    case "drift":
      return resolveDriftEvent(ctx, input);
    case "bypass":
      return resolveStopSignal(ctx, input, "bypass");
    case "review":
      return resolveStopSignal(ctx, input, "review");
    case "conflict":
      return resolveConflict(ctx, input);
    case "alignment_pending":
      return resolveAlignmentPending(ctx, input);
    default:
      return mcpError("VALIDATION_FAILED", `unknown kind: ${input.kind}`);
  }
}

/**
 * Shared resolution path for the two Stop-hook surfaces. choice=a/b
 * are kind-specific intents (the calling skill executes them); the
 * tool's job is to either clear an existing defer file (a/b cases)
 * or write a fresh one with the current snapshot (c).
 */
function resolveStopSignal(
  ctx: McpContext,
  input: Input,
  kind: DeferKind,
): Promise<unknown> {
  const flagged =
    input.flagged_items && input.flagged_items.length > 0
      ? input.flagged_items
      : [input.item_id];

  if (input.choice === "c") {
    return withWriteLock(ctx.repoRoot, () => {
      const state = writeDeferState(ctx.repoRoot, kind, {
        flagged_shas: kind === "bypass" ? flagged : [],
        flagged_task_ids: kind === "review" ? flagged : [],
      });
      return {
        ok: true,
        resolved_kind: `${kind}_deferred`,
        deferred_until: new Date(
          Date.parse(state.deferred_at) +
            state.deferred_for_hours * 60 * 60 * 1000,
        ).toISOString(),
        flagged_count: flagged.length,
        ...(input.rationale !== undefined ? { rationale: input.rationale } : {}),
      };
    });
  }

  // a/b: the operator engaged with the surface (either acted on it or
  // dismissed it). Clear any prior defer so the next Stop sees the
  // fresh state of the world. For bypass kind, also append the
  // resolved SHAs to `.attested-commits` — without this the next Stop
  // scan re-flags the same commits forever (the file is the only
  // source of truth the bypass detector reads).
  return withWriteLock(ctx.repoRoot, () => {
    clearDeferState(ctx.repoRoot, kind);
    let attested_count = 0;
    if (kind === "bypass") {
      attested_count = appendAttestedShas(ctx.repoRoot, flagged);
    }
    const intent =
      kind === "bypass"
        ? input.choice === "a"
          ? "bypass_record"
          : "bypass_accept"
        : input.choice === "a"
          ? "review_now"
          : "review_skip";
    return {
      ok: true,
      resolved_kind: intent,
      item_id: input.item_id,
      flagged_count: flagged.length,
      ...(kind === "bypass" ? { attested_count } : {}),
      ...(input.rationale !== undefined ? { rationale: input.rationale } : {}),
    };
  });
}

/**
 * Resolve operator-supplied SHAs (which may be short or full) against
 * the current bypass scan, then append the matching full SHAs to
 * `.cairn/.attested-commits`. Idempotent — skips entries already in
 * the file. Returns the count actually appended.
 *
 * Why this lives here: the cairn-attention skill calls this tool with
 * whatever `flagged_items` it surfaced (typically the short SHAs from
 * the Stop hook hint). The bypass detector only matches against full
 * 40-char SHAs, so we have to expand short → full before appending,
 * and the scanner is the canonical place to do that.
 */
function appendAttestedShas(repoRoot: string, flagged: string[]): number {
  if (flagged.length === 0) return 0;
  const scan = scanBypassedCommits(repoRoot);
  const flaggedSet = new Set(flagged);
  const matchingFull: string[] = [];
  for (const c of scan.bypassed) {
    if (flaggedSet.has(c.sha) || flaggedSet.has(c.shortSha)) {
      matchingFull.push(c.sha);
    }
  }
  if (matchingFull.length === 0) return 0;

  const path = cairnDir(repoRoot, ".attested-commits");
  const existing = new Set<string>();
  if (existsSync(path)) {
    try {
      for (const line of readFileSync(path, "utf8").split("\n")) {
        const trimmed = line.trim();
        if (trimmed.length > 0) existing.add(trimmed);
      }
    } catch {
      // best-effort
    }
  }
  const fresh = matchingFull.filter((s) => !existing.has(s));
  if (fresh.length === 0) return 0;

  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${fresh.join("\n")}\n`, "utf8");
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "attested_commits_append_failed",
    );
    return 0;
  }
  return fresh.length;
}

async function resolveDecisionDraft(ctx: McpContext, input: Input): Promise<unknown> {
  // `d` is only meaningful for conflict resolution (keep A / keep B / merge /
  // archive both). DEC drafts accept a/b/c (accept / reject / edit) — reject
  // `d` before any filesystem lookup so the caller gets a clear validation
  // error rather than a misleading FILE_NOT_FOUND.
  if (input.choice === "d") {
    return Promise.resolve(
      mcpError(
        "VALIDATION_FAILED",
        `choice "d" is only valid for kind="conflict"; decision_draft accepts a (accept) / b (reject) / c (edit)`,
      ),
    );
  }
  if (!/^DEC-[0-9a-f]{7,}$/.test(input.item_id)) {
    return Promise.resolve(
      mcpError(
        "VALIDATION_FAILED",
        `decision_draft item_id must match DEC-<hash7>, got ${input.item_id}`,
      ),
    );
  }
  const decDir = decisionsDir(ctx.repoRoot);
  const inboxPath = join(decDir, "_inbox", `${input.item_id}.draft.md`);
  const rejectedPath = join(decDir, "_inbox", `${input.item_id}.rejected.md`);
  const acceptedPath = join(decDir, `${input.item_id}.md`);

  let autoRestoredFrom: "rejected" | "accepted" | null = null;
  if (!existsSync(inboxPath)) {
    if (existsSync(rejectedPath) || existsSync(acceptedPath)) {
      const restored = await restoreDec({
        repoRoot: ctx.repoRoot,
        decId: input.item_id,
      });
      if (!restored.ok) {
        return mcpError(
          "FILE_NOT_FOUND",
          `no draft at ${inboxPath}; auto-restore from ${restored.priorState} failed: ${restored.reason ?? "unknown"}`,
        );
      }
      autoRestoredFrom =
        restored.priorState === "rejected" || restored.priorState === "accepted"
          ? restored.priorState
          : null;
    } else {
      return mcpError("FILE_NOT_FOUND", `no draft at ${inboxPath}`);
    }
  }

  if (input.choice === "c") {
    const body = readFileSync(inboxPath, "utf8");
    const editBase = {
      ok: true,
      resolved_kind: "decision_edit_pending" as const,
      item_id: input.item_id,
      draft_path: `.cairn/ground/decisions/_inbox/${input.item_id}.draft.md`,
      body,
    };
    return autoRestoredFrom === null
      ? editBase
      : { ...editBase, auto_restored_from: autoRestoredFrom };
  }

  return withWriteLock(ctx.repoRoot, async () => {
    if (input.choice === "a") {
      const acceptedPath = join(decDir, `${input.item_id}.md`);
      mkdirSync(dirname(acceptedPath), { recursive: true });
      const draft = readFileSync(inboxPath, "utf8");
      const draftMeta = parseDraftMeta(draft);
      const promoted = promoteDraftStatus(draft);
      writeFileSync(acceptedPath, promoted, "utf8");
      try {
        rmSync(inboxPath, { force: true });
      } catch {
        // ignore
      }
      try {
        emitEvent(ctx, "decision_accepted", input.item_id, `.cairn/ground/decisions/${input.item_id}.md`);
      } catch {
        // ignore
      }
      try {
        writeDecisionsLedger({ repoRoot: ctx.repoRoot });
      } catch (err) {
        log.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "decisions ledger rebuild failed",
        );
      }
      let stripOutcome: StripOutcomeSummary | null = null;
      if (draftMeta?.captureSource === "init-source-comments" && draftMeta.blockId !== null) {
        stripOutcome = runDecSourceStrip({
          repoRoot: ctx.repoRoot,
          decId: input.item_id,
          meta: draftMeta,
        });
      }
      const base = {
        ok: true,
        resolved_kind: "decision_accepted" as const,
        item_id: input.item_id,
        accepted_path: `.cairn/ground/decisions/${input.item_id}.md`,
      };
      const withStrip =
        stripOutcome === null ? base : { ...base, source_strip: stripOutcome };
      return autoRestoredFrom === null
        ? withStrip
        : { ...withStrip, auto_restored_from: autoRestoredFrom };
    }

    // choice === "b" — reject.
    renameSync(inboxPath, rejectedPath);
    const rejectedRel = `.cairn/ground/decisions/_inbox/${input.item_id}.rejected.md`;
    try {
      emitEvent(ctx, "decision_rejected", input.item_id, rejectedRel);
    } catch {
      // ignore
    }
    return {
      ok: true,
      resolved_kind: "decision_rejected" as const,
      item_id: input.item_id,
      rejected_path: rejectedRel,
      ...(input.rationale !== undefined ? { rationale: input.rationale } : {}),
    };
  });
}

/**
 * Drain an INV draft from `invariants/_inbox/<id>.draft.md` (written by resync
 * re-curation, `runCuratorEmit({ draft: true })`). Additive sibling of
 * `resolveDecisionDraft` — kept separate so the tested DEC path (auto-restore,
 * source-strip) is untouched. INV drafts have no source block to strip and no
 * auto-restore surface yet, so this is the lean a/b/c: accept graduates to an
 * active INV, reject archives, edit hands the body back to the operator.
 */
async function resolveInvariantDraft(ctx: McpContext, input: Input): Promise<unknown> {
  if (input.choice === "d") {
    return mcpError(
      "VALIDATION_FAILED",
      `choice "d" is only valid for kind="conflict"; invariant_draft accepts a (accept) / b (reject) / c (edit)`,
    );
  }
  if (!/^INV-[0-9a-f]{7,}$/.test(input.item_id)) {
    return mcpError(
      "VALIDATION_FAILED",
      `invariant_draft item_id must match INV-<hash7>, got ${input.item_id}`,
    );
  }
  const invDir = invariantsDir(ctx.repoRoot);
  const inboxPath = join(invDir, "_inbox", `${input.item_id}.draft.md`);
  const rejectedPath = join(invDir, "_inbox", `${input.item_id}.rejected.md`);
  const activePath = join(invDir, `${input.item_id}.md`);

  if (!existsSync(inboxPath)) {
    return mcpError("FILE_NOT_FOUND", `no draft at ${inboxPath}`);
  }

  if (input.choice === "c") {
    return {
      ok: true,
      resolved_kind: "invariant_edit_pending" as const,
      item_id: input.item_id,
      draft_path: `.cairn/ground/invariants/_inbox/${input.item_id}.draft.md`,
      body: readFileSync(inboxPath, "utf8"),
    };
  }

  return withWriteLock(ctx.repoRoot, async () => {
    if (input.choice === "a") {
      mkdirSync(dirname(activePath), { recursive: true });
      const draft = readFileSync(inboxPath, "utf8");
      const promoted = draft.replace(/^status:\s*draft\b/m, "status: active");
      writeFileSync(activePath, promoted, "utf8");
      try {
        rmSync(inboxPath, { force: true });
      } catch {
        // ignore
      }
      try {
        writeInvalidationEvent(ctx.repoRoot, {
          kind: "invariant_accepted",
          refs: [{ kind: "invariant", id: input.item_id }],
          path: `.cairn/ground/invariants/${input.item_id}.md`,
          source: { session_id: ctx.sessionId ?? null, tool: "cairn_resolve_attention" },
        });
      } catch {
        // ignore
      }
      try {
        writeInvariantsLedger({ repoRoot: ctx.repoRoot });
      } catch (err) {
        log.warn(
          { err: err instanceof Error ? err.message : String(err) },
          "invariants ledger rebuild failed",
        );
      }
      return {
        ok: true,
        resolved_kind: "invariant_accepted" as const,
        item_id: input.item_id,
        accepted_path: `.cairn/ground/invariants/${input.item_id}.md`,
      };
    }

    // choice === "b" — reject.
    renameSync(inboxPath, rejectedPath);
    const rejectedRel = `.cairn/ground/invariants/_inbox/${input.item_id}.rejected.md`;
    try {
      writeInvalidationEvent(ctx.repoRoot, {
        kind: "invariant_rejected",
        refs: [{ kind: "invariant", id: input.item_id }],
        path: rejectedRel,
        source: { session_id: ctx.sessionId ?? null, tool: "cairn_resolve_attention" },
      });
    } catch {
      // ignore
    }
    return {
      ok: true,
      resolved_kind: "invariant_rejected" as const,
      item_id: input.item_id,
      rejected_path: rejectedRel,
      ...(input.rationale !== undefined ? { rationale: input.rationale } : {}),
    };
  });
}

function resolveBaselineFinding(ctx: McpContext, input: Input): Promise<unknown> {
  if (input.choice === "a") {
    return Promise.resolve({
      ok: true,
      resolved_kind: "baseline_triage",
      item_id: input.item_id,
      note: "operator selected triage-now — caller opens the flagged file",
    });
  }
  if (input.choice === "c") {
    return Promise.resolve({
      ok: true,
      resolved_kind: "baseline_deferred",
      item_id: input.item_id,
    });
  }

  // choice === "b" — append to suppressions.
  return withWriteLock(ctx.repoRoot, () => {
    const suppressionsPath = cairnDir(ctx.repoRoot, "baseline", "suppressions.yaml");
    mkdirSync(dirname(suppressionsPath), { recursive: true });
    let needsHeader = !existsSync(suppressionsPath);
    if (!needsHeader) {
      try {
        const sz = statSync(suppressionsPath).size;
        if (sz === 0) needsHeader = true;
        else {
          const head = readFileSync(suppressionsPath, "utf8");
          if (!/^suppressions\s*:/m.test(head)) needsHeader = true;
        }
      } catch {
        needsHeader = true;
      }
    }
    const initial = needsHeader ? "suppressions:\n" : "";
    const entry =
      `  - id: ${JSON.stringify(input.item_id)}\n` +
      `    suppressed_at: ${JSON.stringify(new Date().toISOString())}\n` +
      (input.rationale !== undefined
        ? `    rationale: ${JSON.stringify(input.rationale)}\n`
        : "");
    appendFileSync(suppressionsPath, `${initial}${entry}`, "utf8");
    return {
      ok: true,
      resolved_kind: "baseline_suppressed",
      item_id: input.item_id,
      suppressions_path: ".cairn/baseline/suppressions.yaml",
    };
  });
}

interface EntityRef {
  id: string;
  kind: "DEC" | "INV";
  rel: string;
  abs: string;
}

interface ConflictFile {
  abs: string;
  rel: string;
  filename: string;
  aRef: EntityRef;
  bRef: EntityRef;
  fm: Record<string, unknown>;
  body: string;
}

const CONFLICT_ID_RE = /^(DEC|INV)-[0-9a-f]{7,}$/;
const CONFLICT_PAIR_RE = /^((DEC|INV)-[0-9a-f]{7,})__((DEC|INV)-[0-9a-f]{7,})$/;

function entityRefFor(repoRoot: string, id: string): EntityRef {
  if (id.startsWith("INV-")) {
    const abs = join(invariantsDir(repoRoot), `${id}.md`);
    return { id, kind: "INV", abs, rel: `.cairn/ground/invariants/${id}.md` };
  }
  const abs = join(decisionsDir(repoRoot), `${id}.md`);
  return { id, kind: "DEC", abs, rel: `.cairn/ground/decisions/${id}.md` };
}

function parseConflictFile(repoRoot: string, itemId: string): ConflictFile | null {
  if (!CONFLICT_PAIR_RE.test(itemId)) return null;
  const dir = conflictsDir(repoRoot);
  const filename = `${itemId}.md`;
  const abs = join(dir, filename);
  if (!existsSync(abs)) return null;
  let raw: string;
  try {
    raw = readFileSync(abs, "utf8");
  } catch {
    return null;
  }
  const { fm, body } = parseFrontmatterRecord(raw);
  const aId = String(fm["a_id"] ?? itemId.split("__")[0] ?? "");
  const bId = String(fm["b_id"] ?? itemId.split("__")[1] ?? "");
  if (!CONFLICT_ID_RE.test(aId) || !CONFLICT_ID_RE.test(bId)) return null;
  return {
    abs,
    rel: `.cairn/ground/conflicts/${filename}`,
    filename,
    aRef: entityRefFor(repoRoot, aId),
    bRef: entityRefFor(repoRoot, bId),
    fm,
    body,
  };
}

interface ParsedEntity {
  fm: Record<string, unknown>;
  body: string;
  raw: string;
}

function readEntity(ref: EntityRef): ParsedEntity | null {
  if (!existsSync(ref.abs)) return null;
  let raw: string;
  try {
    raw = readFileSync(ref.abs, "utf8");
  } catch {
    return null;
  }
  const { fm, body } = parseFrontmatterRecord(raw);
  return { fm, body, raw };
}

function writeEntity(ref: EntityRef, fm: Record<string, unknown>, body: string): void {
  const content = `---\n${stringifyYaml(fm).trimEnd()}\n---\n${body.startsWith("\n") ? body : `\n${body}`}`;
  writeFileSync(ref.abs, content, "utf8");
}

function setSupersededBy(
  repoRoot: string,
  loser: EntityRef,
  winnerId: string,
  status: "superseded" | "archived",
): boolean {
  const parsed = readEntity(loser);
  if (parsed === null) return false;
  parsed.fm["status"] = status;
  if (status === "superseded") parsed.fm["superseded_by"] = winnerId;
  parsed.fm["verified-at"] = new Date().toISOString();
  writeEntity(loser, parsed.fm, parsed.body);
  return true;
}

function setSupersedes(loser: EntityRef, winner: EntityRef): boolean {
  const parsed = readEntity(winner);
  if (parsed === null) return false;
  parsed.fm["supersedes"] = loser.id;
  parsed.fm["verified-at"] = new Date().toISOString();
  writeEntity(winner, parsed.fm, parsed.body);
  return true;
}

function moveConflictToArchive(repoRoot: string, conflict: ConflictFile): string {
  const archDir = archivedConflictsDir(repoRoot);
  mkdirSync(archDir, { recursive: true });
  const archAbs = join(archDir, conflict.filename);
  renameSync(conflict.abs, archAbs);
  return `.cairn/ground/conflicts/_archived/${conflict.filename}`;
}

function deleteConflictFile(conflict: ConflictFile): void {
  try {
    rmSync(conflict.abs, { force: true });
  } catch {
    /* best-effort */
  }
}

function recordOrphanDriftEvents(
  repoRoot: string,
  refs: { ref: EntityRef; parsed: ParsedEntity | null }[],
): void {
  const ts = new Date().toISOString();
  for (const { ref, parsed } of refs) {
    if (parsed === null) continue;
    const sotKind = parsed.fm["sot_kind"];
    if (sotKind !== "path") continue;
    const sotPath = String(parsed.fm["sot_path"] ?? "");
    if (sotPath.length === 0 || sotPath === "ledger") continue;
    try {
      recordDriftEvent(repoRoot, {
        ts,
        kind: "orphan_path",
        path: sotPath,
        detail: `Conflict resolution superseded ${ref.id}; losing-side prose still lives at ${sotPath}.`,
        severity: "soft",
        dec_id: ref.id,
      });
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "orphan_path drift event write failed",
      );
    }
  }
}

function rebuildLedgers(repoRoot: string): void {
  try {
    writeDecisionsLedger({ repoRoot });
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "decisions ledger rebuild failed",
    );
  }
  try {
    writeInvariantsLedger({ repoRoot });
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "invariants ledger rebuild failed",
    );
  }
}

function cleanLosersFromSotState(
  repoRoot: string,
  losers: EntityRef[],
): void {
  let bindings = readSotBindings(repoRoot);
  let cache = readSotCache(repoRoot);
  let mutated = false;
  for (const loser of losers) {
    const nextBindings = unbindDec(bindings, loser.id);
    if (nextBindings !== bindings) {
      bindings = nextBindings;
      mutated = true;
    }
    const nextCache = deleteSotCacheEntry(cache, loser.id);
    if (nextCache !== cache) {
      cache = nextCache;
      mutated = true;
    }
  }
  if (!mutated) return;
  try {
    writeSotBindings(repoRoot, bindings);
  } catch {
    /* ignore */
  }
  try {
    writeSotCache(repoRoot, cache);
  } catch {
    /* ignore */
  }
}

function bindAndCacheMergedEntity(
  repoRoot: string,
  mergedId: string,
  mergedBody: string,
): void {
  let bindings = readSotBindings(repoRoot);
  bindings = bindDec(bindings, mergedId, "ledger");
  try {
    writeSotBindings(repoRoot, bindings);
  } catch {
    /* ignore */
  }
  let cache = readSotCache(repoRoot);
  cache = setSotCacheEntry(cache, mergedId, {
    dec_id: mergedId,
    sot_path: "ledger",
    body_hash: bodyContentHash(mergedBody),
    tokens: Array.from(tokenize(mergedBody, { codeAware: true })),
    shingles: [],
    mtime_ms: Date.now(),
  });
  try {
    writeSotCache(repoRoot, cache);
  } catch {
    /* ignore */
  }
}

interface AlignmentPendingState {
  abs: string;
  rel: string;
  filename: string;
  fm: Record<string, unknown>;
  blockProse: string;
  existingId: string | null;
  existingBody: string | null;
}

function loadAlignmentPending(
  repoRoot: string,
  itemId: string,
): AlignmentPendingState | null {
  const dir = alignmentPendingDir(repoRoot);
  const filename = `${itemId}.md`;
  const abs = join(dir, filename);
  if (!existsSync(abs)) return null;
  let raw: string;
  try {
    raw = readFileSync(abs, "utf8");
  } catch {
    return null;
  }
  const { fm, body } = parseFrontmatterRecord(raw);
  const blockMatch = body.match(/##\s+Block[^\n]*\n+```\n([\s\S]*?)\n```/);
  const blockProse = blockMatch?.[1]?.trim() ?? "";
  const existingId =
    typeof fm["existing_id"] === "string" ? (fm["existing_id"] as string) : null;
  let existingBody: string | null = null;
  if (existingId !== null) {
    const existingMatch = body.match(/##\s+Existing\s+\S+[^\n]*\n+```\n([\s\S]*?)\n```/);
    existingBody = existingMatch?.[1]?.trim() ?? null;
  }
  return {
    abs,
    rel: `.cairn/ground/alignment-pending/${filename}`,
    filename,
    fm,
    blockProse,
    existingId,
    existingBody,
  };
}

function buildPendingReplaceItem(
  fm: Record<string, unknown>,
  rawProse: string,
  replacement: string,
): ReplaceItem | null {
  const file = typeof fm["source_file"] === "string" ? fm["source_file"] : null;
  const startOffset =
    typeof fm["start_offset"] === "number" ? fm["start_offset"] : null;
  const endOffset =
    typeof fm["end_offset"] === "number" ? fm["end_offset"] : null;
  if (file === null || startOffset === null || endOffset === null) return null;
  return {
    blockId: typeof fm["slug"] === "string" ? `pending:${fm["slug"]}` : "pending:unknown",
    file,
    startOffset,
    endOffset,
    replacement,
    expectedRaw: typeof fm["raw"] === "string" ? (fm["raw"] as string) : rawProse,
  };
}

async function resolveAlignmentPending(
  ctx: McpContext,
  input: Input,
): Promise<unknown> {
  const state = loadAlignmentPending(ctx.repoRoot, input.item_id);
  if (state === null) {
    return mcpError(
      "FILE_NOT_FOUND",
      `no alignment-pending file for item_id=${input.item_id}`,
    );
  }
  const kind = String(state.fm["kind"] ?? "");
  const lang = typeof state.fm["lang"] === "string" ? state.fm["lang"] : "unknown";
  const sourceFile = typeof state.fm["source_file"] === "string" ? state.fm["source_file"] : "";
  const startLine = typeof state.fm["start_line"] === "number" ? state.fm["start_line"] : 0;

  return withWriteLock(ctx.repoRoot, () => {
    if (kind === "tier2-ambiguous") {
      if (state.existingId === null) {
        return mcpError(
          "VALIDATION_FAILED",
          "tier2-ambiguous pending entry missing existing_id",
        );
      }
      if (input.choice === "a") {
        const replacement = formatBareCitation(lang, state.existingId);
        const item = buildPendingReplaceItem(state.fm, state.blockProse, replacement);
        if (item !== null) applyStripReplace({
          repoRoot: ctx.repoRoot,
          items: [item],
          dirtyDecisions: { [item.file]: "overwrite" },
        });
        rmSync(state.abs, { force: true });
        return {
          ok: true,
          resolved_kind: "alignment_cite",
          item_id: input.item_id,
          existing_id: state.existingId,
        };
      }
      if (input.choice === "b") {
        const id = emitOperatorAugmentSibling(ctx.repoRoot, {
          source_file: sourceFile,
          source_offset: startLine,
          existingId: state.existingId,
          delta: state.blockProse,
          rationale: input.rationale ?? "",
        });
        const replacement =
          formatBareCitation(lang, state.existingId) +
          "\n" +
          formatBareCitation(lang, id);
        const item = buildPendingReplaceItem(state.fm, state.blockProse, replacement);
        if (item !== null) applyStripReplace({
          repoRoot: ctx.repoRoot,
          items: [item],
          dirtyDecisions: { [item.file]: "overwrite" },
        });
        rmSync(state.abs, { force: true });
        try {
          writeDecisionsLedger({ repoRoot: ctx.repoRoot });
        } catch {
          /* best-effort */
        }
        return {
          ok: true,
          resolved_kind: "alignment_augments",
          item_id: input.item_id,
          existing_id: state.existingId,
          new_id: id,
        };
      }
      if (input.choice === "c") {
        const id = emitFreshDec(ctx.repoRoot, {
          source_file: sourceFile,
          source_offset: startLine,
          body: state.blockProse,
          captureSuffix: "operator-new",
          related: null,
        });
        const replacement = formatBareCitation(lang, id);
        const item = buildPendingReplaceItem(state.fm, state.blockProse, replacement);
        if (item !== null) applyStripReplace({
          repoRoot: ctx.repoRoot,
          items: [item],
          dirtyDecisions: { [item.file]: "overwrite" },
        });
        rmSync(state.abs, { force: true });
        try {
          writeDecisionsLedger({ repoRoot: ctx.repoRoot });
        } catch {
          /* best-effort */
        }
        return {
          ok: true,
          resolved_kind: "alignment_new",
          item_id: input.item_id,
          new_id: id,
        };
      }
      if (input.choice === "d") {
        const id = emitFreshDec(ctx.repoRoot, {
          source_file: sourceFile,
          source_offset: startLine,
          body: state.blockProse,
          captureSuffix: "operator-replace",
          related: state.existingId,
        });
        const existingRef = entityRefFor(ctx.repoRoot, state.existingId);
        const parsed = readEntity(existingRef);
        if (parsed !== null) {
          parsed.fm["status"] = "superseded";
          parsed.fm["superseded_by"] = id;
          parsed.fm["verified-at"] = new Date().toISOString();
          writeEntity(existingRef, parsed.fm, parsed.body);
        }
        const replacement = formatBareCitation(lang, id);
        const item = buildPendingReplaceItem(state.fm, state.blockProse, replacement);
        if (item !== null) applyStripReplace({
          repoRoot: ctx.repoRoot,
          items: [item],
          dirtyDecisions: { [item.file]: "overwrite" },
        });
        rmSync(state.abs, { force: true });
        try {
          writeDecisionsLedger({ repoRoot: ctx.repoRoot });
          writeInvariantsLedger({ repoRoot: ctx.repoRoot });
        } catch {
          /* best-effort */
        }
        return {
          ok: true,
          resolved_kind: "alignment_replace",
          item_id: input.item_id,
          new_id: id,
          superseded_id: state.existingId,
        };
      }
    }

    if (kind === "tier3-ambiguous") {
      if (input.choice === "a" || input.choice === "b") {
        const isInv = input.choice === "b";
        const id = emitFreshDec(ctx.repoRoot, {
          source_file: sourceFile,
          source_offset: startLine,
          body: state.blockProse,
          captureSuffix: isInv ? "operator-constraint" : "operator-decision",
          related: null,
          asInv: isInv,
        });
        const replacement = formatBareCitation(lang, id);
        const item = buildPendingReplaceItem(state.fm, state.blockProse, replacement);
        if (item !== null) applyStripReplace({
          repoRoot: ctx.repoRoot,
          items: [item],
          dirtyDecisions: { [item.file]: "overwrite" },
        });
        rmSync(state.abs, { force: true });
        try {
          if (isInv) writeInvariantsLedger({ repoRoot: ctx.repoRoot });
          else writeDecisionsLedger({ repoRoot: ctx.repoRoot });
        } catch {
          /* best-effort */
        }
        return {
          ok: true,
          resolved_kind: isInv ? "alignment_constraint" : "alignment_decision",
          item_id: input.item_id,
          new_id: id,
        };
      }
      if (input.choice === "c" || input.choice === "d") {
        rmSync(state.abs, { force: true });
        return {
          ok: true,
          resolved_kind:
            input.choice === "c" ? "alignment_descriptive" : "alignment_skip",
          item_id: input.item_id,
        };
      }
    }

    return mcpError(
      "VALIDATION_FAILED",
      `unsupported alignment_pending kind=${kind} or choice=${input.choice}`,
    );
  });
}

interface FreshDecArgs {
  source_file: string;
  source_offset: number;
  body: string;
  captureSuffix: string;
  related: string | null;
  asInv?: boolean;
}

function emitFreshDec(repoRoot: string, args: FreshDecArgs): string {
  const isInv = args.asInv === true;
  const inputs = {
    source_file: args.source_file,
    source_offset: args.source_offset,
    capture_source: `layer-a-resolve-${args.captureSuffix}`,
  };
  const id = isInv ? deriveLedgerInvId(inputs) : deriveLedgerDecId(inputs);
  const dir = isInv ? invariantsDir(repoRoot) : decisionsDir(repoRoot);
  const abs = join(dir, `${id}.md`);
  const trimmed = args.body.trim();
  const now = new Date().toISOString();
  const fm: Record<string, unknown> = {
    id,
    title: firstLineOf(trimmed),
    type: isInv ? "invariant" : "adr",
    status: isInv ? "active" : "accepted",
    audience: "dual",
    generated: now,
    "verified-at": now,
    sot_kind: "ledger",
    sot_path: "ledger",
    sot_content_hash: bodyContentHash(trimmed),
    capture_source: `layer-a-resolve-${args.captureSuffix}`,
    source_file: args.source_file,
  };
  if (!isInv) {
    fm["decided_at"] = now;
    fm["decided_by"] = "cairn-resolve-attention";
  }
  if (args.related !== null) fm["related"] = args.related;
  mkdirSync(dir, { recursive: true });
  writeFileSync(abs, `---\n${stringifyYaml(fm).trimEnd()}\n---\n\n${trimmed}\n`, "utf8");

  let bindings = readSotBindings(repoRoot);
  bindings = bindDec(bindings, id, "ledger");
  writeSotBindings(repoRoot, bindings);

  let cache = readSotCache(repoRoot);
  cache = setSotCacheEntry(cache, id, {
    dec_id: id,
    sot_path: "ledger",
    body_hash: bodyContentHash(trimmed),
    tokens: Array.from(tokenize(trimmed, { codeAware: true })),
    shingles: [],
    mtime_ms: Date.now(),
  });
  writeSotCache(repoRoot, cache);
  return id;
}

interface OperatorAugmentArgs {
  source_file: string;
  source_offset: number;
  existingId: string;
  delta: string;
  rationale: string;
}

function emitOperatorAugmentSibling(repoRoot: string, args: OperatorAugmentArgs): string {
  return emitFreshDec(repoRoot, {
    source_file: args.source_file,
    source_offset: args.source_offset,
    body: args.delta,
    captureSuffix: `operator-augments-${args.existingId}`,
    related: args.existingId,
  });
}

function firstLineOf(text: string): string {
  const first = text.split("\n").find((l) => l.trim().length > 0) ?? "";
  return first.replace(/^[#*\-\s>]+/, "").trim().slice(0, 120) || "(untitled)";
}

async function resolveConflict(ctx: McpContext, input: Input): Promise<unknown> {
  const conflict = parseConflictFile(ctx.repoRoot, input.item_id);
  if (conflict === null) {
    return mcpError(
      "FILE_NOT_FOUND",
      `no conflict file for item_id=${input.item_id}`,
    );
  }

  return withWriteLock(ctx.repoRoot, async () => {
    const winner = input.choice === "a" ? conflict.aRef : conflict.bRef;
    const loser = input.choice === "a" ? conflict.bRef : conflict.aRef;

    if (input.choice === "a" || input.choice === "b") {
      const loserBefore = readEntity(loser);
      const winnerOk = setSupersedes(loser, winner);
      const loserOk = setSupersededBy(ctx.repoRoot, loser, winner.id, "superseded");
      if (!winnerOk || !loserOk) {
        return mcpError(
          "VALIDATION_FAILED",
          `conflict resolution failed: missing entity`,
        );
      }
      recordOrphanDriftEvents(ctx.repoRoot, [{ ref: loser, parsed: loserBefore }]);
      deleteConflictFile(conflict);
      cleanLosersFromSotState(ctx.repoRoot, [loser]);
      rebuildLedgers(ctx.repoRoot);
      try {
        writeInvalidationEvent(ctx.repoRoot, {
          kind: "conflict_resolved_supersede",
          refs: [
            { kind: winner.kind === "DEC" ? "decision" : "invariant", id: winner.id },
            { kind: loser.kind === "DEC" ? "decision" : "invariant", id: loser.id },
          ],
          path: winner.rel,
          source: { session_id: ctx.sessionId ?? null, tool: "cairn_resolve_attention" },
        });
      } catch {
        /* ignore */
      }
      return {
        ok: true,
        resolved_kind: "conflict_supersede",
        item_id: input.item_id,
        winner_id: winner.id,
        loser_id: loser.id,
        winner_path: winner.rel,
        loser_path: loser.rel,
        ...(input.rationale !== undefined ? { rationale: input.rationale } : {}),
      };
    }

    if (input.choice === "c") {
      const aBefore = readEntity(conflict.aRef);
      const bBefore = readEntity(conflict.bRef);
      const merge = mergeConflict(ctx.repoRoot, conflict, input.rationale);
      if ("error" in merge) return merge.error;
      recordOrphanDriftEvents(ctx.repoRoot, [
        { ref: conflict.aRef, parsed: aBefore },
        { ref: conflict.bRef, parsed: bBefore },
      ]);
      deleteConflictFile(conflict);
      cleanLosersFromSotState(ctx.repoRoot, [conflict.aRef, conflict.bRef]);
      rebuildLedgers(ctx.repoRoot);
      try {
        writeInvalidationEvent(ctx.repoRoot, {
          kind: "conflict_resolved_merge",
          refs: [
            { kind: "decision", id: merge.mergedId },
            {
              kind: conflict.aRef.kind === "DEC" ? "decision" : "invariant",
              id: conflict.aRef.id,
            },
            {
              kind: conflict.bRef.kind === "DEC" ? "decision" : "invariant",
              id: conflict.bRef.id,
            },
          ],
          path: merge.mergedRel,
          source: { session_id: ctx.sessionId ?? null, tool: "cairn_resolve_attention" },
        });
      } catch {
        /* ignore */
      }
      return {
        ok: true,
        resolved_kind: "conflict_merge",
        item_id: input.item_id,
        merged_id: merge.mergedId,
        merged_path: merge.mergedRel,
        superseded_a: conflict.aRef.id,
        superseded_b: conflict.bRef.id,
        ...(input.rationale !== undefined ? { rationale: input.rationale } : {}),
      };
    }

    // choice === "d" — archive both.
    const aBefore = readEntity(conflict.aRef);
    const bBefore = readEntity(conflict.bRef);
    setSupersededBy(ctx.repoRoot, conflict.aRef, conflict.bRef.id, "archived");
    setSupersededBy(ctx.repoRoot, conflict.bRef, conflict.aRef.id, "archived");
    recordOrphanDriftEvents(ctx.repoRoot, [
      { ref: conflict.aRef, parsed: aBefore },
      { ref: conflict.bRef, parsed: bBefore },
    ]);
    const archivedRel = moveConflictToArchive(ctx.repoRoot, conflict);
    cleanLosersFromSotState(ctx.repoRoot, [conflict.aRef, conflict.bRef]);
    rebuildLedgers(ctx.repoRoot);
    try {
      writeInvalidationEvent(ctx.repoRoot, {
        kind: "conflict_resolved_archive",
        refs: [
          {
            kind: conflict.aRef.kind === "DEC" ? "decision" : "invariant",
            id: conflict.aRef.id,
          },
          {
            kind: conflict.bRef.kind === "DEC" ? "decision" : "invariant",
            id: conflict.bRef.id,
          },
        ],
        path: archivedRel,
        source: { session_id: ctx.sessionId ?? null, tool: "cairn_resolve_attention" },
      });
    } catch {
      /* ignore */
    }
    return {
      ok: true,
      resolved_kind: "conflict_archive",
      item_id: input.item_id,
      a_id: conflict.aRef.id,
      b_id: conflict.bRef.id,
      archived_path: archivedRel,
      ...(input.rationale !== undefined ? { rationale: input.rationale } : {}),
    };
  });
}

function mergeConflict(
  repoRoot: string,
  conflict: ConflictFile,
  rationale?: string,
): MergeOk | MergeError {
  const a = readEntity(conflict.aRef);
  const b = readEntity(conflict.bRef);
  if (a === null || b === null) {
    return {
      error: mcpError(
        "VALIDATION_FAILED",
        `merge requires both entities present on disk`,
      ),
    };
  }
  const now = new Date().toISOString();
  const mergedKind: "DEC" | "INV" =
    conflict.aRef.kind === "INV" && conflict.bRef.kind === "INV" ? "INV" : "DEC";
  const mergedId = synthesizeMergedId(mergedKind, conflict.aRef.id, conflict.bRef.id);
  // Logical display label only — the actual write routes through the dir
  // helpers below so ghost repos land the merged entity out-of-repo (under
  // cairnDir), never inside the client tree. `join(repoRoot, ".cairn/…")` here
  // would write in-repo in ghost and split-brain against the cairnDir-routed
  // ledger/anchor writers that follow.
  const mergedRel =
    mergedKind === "DEC"
      ? `.cairn/ground/decisions/${mergedId}.md`
      : `.cairn/ground/invariants/${mergedId}.md`;
  const mergedAbs = join(
    mergedKind === "DEC" ? decisionsDir(repoRoot) : invariantsDir(repoRoot),
    `${mergedId}.md`,
  );
  const titleA = String(a.fm["title"] ?? conflict.aRef.id);
  const titleB = String(b.fm["title"] ?? conflict.bRef.id);
  const mergedTitle = `Merged: ${titleA} + ${titleB}`;
  const mergedBody = [
    "",
    `# ${mergedId} — ${mergedTitle}`,
    "",
    `## ${conflict.aRef.id} (one side of the merge)`,
    "",
    a.body.trim(),
    "",
    `## ${conflict.bRef.id} (other side of the merge)`,
    "",
    b.body.trim(),
    "",
    "## Merge rationale",
    "",
    rationale !== undefined && rationale.trim().length > 0
      ? rationale.trim()
      : "(operator merged both sides via cairn-attention conflict resolution)",
    "",
  ].join("\n");
  const mergedFm: Record<string, unknown> = {
    id: mergedId,
    title: mergedTitle,
    type: mergedKind === "DEC" ? "adr" : "invariant",
    status: mergedKind === "DEC" ? "accepted" : "active",
    audience: "dual",
    generated: now,
    "verified-at": now,
    sot_kind: "ledger",
    sot_path: "ledger",
    sot_content_hash: bodyContentHash(mergedBody),
    capture_source: "conflict-merge",
    related: `${conflict.aRef.id},${conflict.bRef.id}`,
  };
  if (mergedKind === "DEC") {
    mergedFm["decided_at"] = now;
    mergedFm["decided_by"] = "cairn-conflict-merge";
  }
  writeFileSafe(
    mergedAbs,
    `---\n${stringifyYaml(mergedFm).trimEnd()}\n---\n${mergedBody}`,
  );
  setSupersededBy(repoRoot, conflict.aRef, mergedId, "superseded");
  setSupersededBy(repoRoot, conflict.bRef, mergedId, "superseded");
  bindAndCacheMergedEntity(repoRoot, mergedId, mergedBody);
  return { mergedId, mergedRel };
}

/**
 * Derive the merged entity's id deterministically from the two source ids.
 *
 * Content-addressed like every other emit path (`deriveLedger{Dec,Inv}Id`):
 * the same conflict pair always yields the same merged id, so re-running a
 * merge reuses the id instead of forking a new entity. (The previous
 * `Date.now()+Math.random()` seed broke that idempotency contract.)
 */
function synthesizeMergedId(
  kind: "DEC" | "INV",
  aId: string,
  bId: string,
): string {
  const derive = kind === "DEC" ? deriveLedgerDecId : deriveLedgerInvId;
  return derive({
    source_file: `conflict-merge:${aId}+${bId}`,
    source_offset: 0,
    capture_source: "conflict-merge",
  });
}

function resolveInvalidationEvent(_ctx: McpContext, input: Input): Promise<unknown> {
  // `d` is conflict-only; the shared Input schema permits it, so reject it here
  // rather than index a 3-key map with `undefined` and return a malformed
  // `invalidation_undefined` success.
  if (input.choice === "d") {
    return Promise.resolve(
      mcpError(
        "VALIDATION_FAILED",
        `choice "d" is only valid for kind="conflict"; invalidation accepts a (refresh) / b (continue) / c (abort)`,
      ),
    );
  }
  const map: Record<"a" | "b" | "c", string> = {
    a: "refresh",
    b: "continue_under_old",
    c: "abort",
  };
  const choice = input.choice as "a" | "b" | "c";
  return Promise.resolve({
    ok: true,
    resolved_kind: `invalidation_${map[choice]}`,
    item_id: input.item_id,
    ...(input.rationale !== undefined ? { rationale: input.rationale } : {}),
  });
}

/**
 * Drift events (GC staleness findings — doc-source drift, doc-claim drift,
 * scope-orphan, generator drift) surface in the cairn-attention queue and
 * resolve via the same A/B/C path. Resolution records the operator's intent;
 * the actual repair (re-sync the drifted source) is a caller action, exactly
 * like baseline/invalidation findings. The staleness log is an append-only
 * advisory snapshot rebuilt by the next GC sweep, so there is no per-event
 * entry to mutate here.
 */
function resolveDriftEvent(_ctx: McpContext, input: Input): Promise<unknown> {
  // `d` is conflict-only; reject the schema-permitted-but-unsupported choice
  // instead of returning a malformed `drift_undefined` success.
  if (input.choice === "d") {
    return Promise.resolve(
      mcpError(
        "VALIDATION_FAILED",
        `choice "d" is only valid for kind="conflict"; drift accepts a (refresh) / b (defer) / c (dismiss)`,
      ),
    );
  }
  const map: Record<"a" | "b" | "c", string> = {
    a: "refresh",
    b: "defer",
    c: "dismiss",
  };
  const choice = input.choice as "a" | "b" | "c";
  return Promise.resolve({
    ok: true,
    resolved_kind: `drift_${map[choice]}`,
    item_id: input.item_id,
    ...(input.rationale !== undefined ? { rationale: input.rationale } : {}),
  });
}

function promoteDraftStatus(body: string): string {
  return body.replace(/^status:\s*draft(?:-from-[a-z-]+)?\b/m, "status: accepted");
}

function emitEvent(
  ctx: McpContext,
  kind: string,
  decId: string,
  path: string,
): void {
  writeInvalidationEvent(ctx.repoRoot, {
    kind,
    refs: [{ kind: "decision", id: decId }],
    path,
    source: { session_id: ctx.sessionId ?? null, tool: "cairn_resolve_attention" },
  });
}

export const resolveAttentionTool: ToolDef<ToolInput> = {
  name: "cairn_resolve_attention",
  description:
    "Resolve an inline-A/B/C attention pick — DEC draft accept/reject/edit, baseline finding suppress/defer/triage, invalidation event refresh/continue/abort, drift event refresh/defer/dismiss. Called by the cairn-attention skill after the operator picks an option. Pass `item_id` for one item, or `item_ids` (array) to apply the SAME kind + choice to many in a single call — use this for bulk defer/suppress (e.g. \"defer all remaining baseline findings\") instead of one call per finding.",
  inputSchema: resolveAttentionInput,
  handler,
};

interface MergeError {
  error: ReturnType<typeof mcpError>;
}
interface MergeOk {
  mergedId: string;
  mergedRel: string;
}

