/**
 * cairn_resolve_attention — inline A/B/C resolution endpoint.
 *
 * Spec: PLUGIN_ARCHITECTURE §9 (MCP write tools — plugin-era addition).
 *
 * The cairn-attention skill calls this after the operator picks an
 * option. It maps `kind × choice` onto the canonical resolution
 * pathway:
 *
 * | kind                | choice | resolution                                  |
 * |---------------------|--------|---------------------------------------------|
 * | decision_draft      | a      | accept — move `_inbox/<id>.draft.md` → `<id>.md`, status=accepted |
 * | decision_draft      | b      | reject — rename draft to .rejected.md (id reserved forever) |
 * | decision_draft      | c      | edit-pending — return draft body (no write) |
 * | baseline_finding    | a      | triage-now — no-op (skill opens the file)   |
 * | baseline_finding    | b      | suppress — append to baseline/suppressions.yaml |
 * | baseline_finding    | c      | defer — no-op                               |
 * | invalidation_event  | a      | refresh — re-read in-scope DECs/§INVs        |
 * | invalidation_event  | b      | continue-under-old — no-op                  |
 * | invalidation_event  | c      | abort — caller archives task (no-op here)   |
 * | drift               | a/b/c  | acknowledged (drift surface not yet active) |
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import {
  parseDraftMeta,
  restoreDec,
  runDecSourceStrip,
  type DraftMeta,
  type StripOutcomeSummary,
} from "../../attention/index.js";
import { writeInvalidationEvent } from "../../events/index.js";
import {
  archivedConflictsDir,
  bodyContentHash,
  conflictsDir,
  decisionsDir,
  invariantsDir,
  recordDriftEvent,
} from "../../ground/index.js";
import { writeDecisionsLedger, writeInvariantsLedger } from "../../ground/ledgers.js";
import {
  clearDeferState,
  writeDeferState,
  type DeferKind,
} from "../../hooks/defer.js";
import { withWriteLock } from "../../lock.js";
import { logger } from "../../logger.js";
import type { McpContext } from "../context.js";
import { requireBootstrap } from "../bootstrap-guard.js";
import { mcpError } from "../errors.js";
import { resolveAttentionInput } from "../schemas.js";
import type { ToolDef } from "./types.js";

const log = logger("mcp.resolve-attention");

interface Input {
  item_id: string;
  choice: "a" | "b" | "c" | "d";
  kind:
    | "decision_draft"
    | "baseline_finding"
    | "invalidation_event"
    | "drift"
    | "bypass"
    | "review"
    | "conflict";
  flagged_items?: string[];
  defer_hours?: number;
  rationale?: string;
}

async function handler(ctx: McpContext, input: Input): Promise<unknown> {
  const block = requireBootstrap(ctx.repoRoot);
  if (block !== null) return block;
  // The fourth choice slot is only meaningful for conflict resolution.
  // Reject `d` on every other kind so the schema's permissive enum
  // doesn't quietly fall through.
  if (input.choice === "d" && input.kind !== "conflict") {
    return mcpError(
      "VALIDATION_FAILED",
      `choice "d" is only valid for kind=conflict, got kind=${input.kind}`,
    );
  }
  switch (input.kind) {
    case "decision_draft":
      return resolveDecisionDraft(ctx, input);
    case "baseline_finding":
      return resolveBaselineFinding(ctx, input);
    case "invalidation_event":
      return resolveInvalidationEvent(ctx, input);
    case "drift":
      return {
        ok: true,
        resolved_kind: "drift_acknowledged",
        note: "drift resolution surface not yet implemented (step 7+); item left in queue",
      };
    case "bypass":
      return resolveBypass(ctx, input);
    case "review":
      return resolveReview(ctx, input);
    case "conflict":
      return resolveConflict(ctx, input);
  }
}

function resolveBypass(ctx: McpContext, input: Input): Promise<unknown> {
  return resolveStopSignal(ctx, input, "bypass");
}

function resolveReview(ctx: McpContext, input: Input): Promise<unknown> {
  return resolveStopSignal(ctx, input, "review");
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
        ...(input.defer_hours !== undefined ? { hours: input.defer_hours } : {}),
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
  // fresh state of the world.
  return withWriteLock(ctx.repoRoot, () => {
    clearDeferState(ctx.repoRoot, kind);
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
      ...(input.rationale !== undefined ? { rationale: input.rationale } : {}),
    };
  });
}

async function resolveDecisionDraft(ctx: McpContext, input: Input): Promise<unknown> {
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

  // Auto-restore: when the draft is missing but the same id sits as a
  // rejected or already-accepted entry, transparently roll it back to
  // a draft so the operator's choice (a/b/c) lands in one MCP call
  // instead of needing an explicit `cairn_attention_restore` first.
  // Idempotent re-accept on a still-canonical accepted DEC is the same
  // shape as accepting a fresh draft — rebuild ledger, no double-strip
  // (already-stripped check inside runDecSourceStrip).
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
    // Edit-pending: return the draft body so the skill can hand it to
    // the operator's editor flow. No state change.
    const body = readFileSync(inboxPath, "utf8");
    const editBase = {
      ok: true,
      resolved_kind: "decision_edit_pending",
      item_id: input.item_id,
      draft_path: `.cairn/ground/decisions/_inbox/${input.item_id}.draft.md`,
      body,
    } as const;
    return autoRestoredFrom === null
      ? editBase
      : { ...editBase, auto_restored_from: autoRestoredFrom };
  }

  return withWriteLock(ctx.repoRoot, () => {
    if (input.choice === "a") {
      const acceptedPath = join(decDir, `${input.item_id}.md`);
      mkdirSync(dirname(acceptedPath), { recursive: true });
      const draft = readFileSync(inboxPath, "utf8");
      const draftMeta = parseDraftMeta(draft);
      const promoted = promoteDraftStatus(draft);
      writeFileSync(acceptedPath, promoted, "utf8");
      // Remove the draft after promoting so the inbox stays clean.
      // The canonical accepted file at <decDir>/<id>.md is the
      // recoverable copy if the rmSync interrupts.
      try {
        rmSync(inboxPath, { force: true });
      } catch {
        // ignore — best effort, the accepted file is what matters
      }
      try {
        emitEvent(ctx, "decision_accepted", input.item_id, `.cairn/ground/decisions/${input.item_id}.md`);
      } catch {
        // event emission must never roll back the resolution
      }
      // Rebuild `.cairn/ground/decisions/decisions.ledger.yaml` from
      // every accepted DEC on disk. Cairn Lens reads the ledger to
      // resolve `// DEC-NNNN` citations inline; without this rebuild
      // the ledger sits empty and lens renders nothing.
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
        resolved_kind: "decision_accepted",
        item_id: input.item_id,
        accepted_path: `.cairn/ground/decisions/${input.item_id}.md`,
      } as const;
      const withStrip =
        stripOutcome === null ? base : { ...base, source_strip: stripOutcome };
      return autoRestoredFrom === null
        ? withStrip
        : { ...withStrip, auto_restored_from: autoRestoredFrom };
    }

    // choice === "b" — reject. Rename to .rejected.md so scanExistingDecisionIds
    // keeps the id in the high-water mark and it is never recycled.
    renameSync(inboxPath, rejectedPath);
    const rejectedRel = `.cairn/ground/decisions/_inbox/${input.item_id}.rejected.md`;
    try {
      emitEvent(ctx, "decision_rejected", input.item_id, rejectedRel);
    } catch {
      // ignore
    }
    return {
      ok: true,
      resolved_kind: "decision_rejected",
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
    const suppressionsPath = join(ctx.repoRoot, ".cairn", "baseline", "suppressions.yaml");
    mkdirSync(dirname(suppressionsPath), { recursive: true });
    // Empty / missing file → seed the YAML root key so the appended
    // entries land under a valid `suppressions:` list. statSync may
    // throw on race; treat any error as "needs header".
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

/* -------------------------------------------------------------------------- */
/* Conflict resolution (plan §5.4.1)                                          */
/* -------------------------------------------------------------------------- */

interface EntityRef {
  id: string;
  kind: "DEC" | "INV";
  /** Repo-relative path of the ground file. */
  rel: string;
  /** Absolute path of the ground file. */
  abs: string;
}

interface ConflictFile {
  abs: string;
  rel: string;
  filename: string;
  aRef: EntityRef;
  bRef: EntityRef;
  /** Frontmatter parsed from the conflict yaml. */
  fm: Record<string, unknown>;
  /** Conflict body (prose A + prose B + reasoning), useful for merge. */
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
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  let fm: Record<string, unknown> = {};
  if (fmMatch !== null && fmMatch[1] !== undefined) {
    try {
      const parsed = parseYaml(fmMatch[1]);
      if (typeof parsed === "object" && parsed !== null) {
        fm = parsed as Record<string, unknown>;
      }
    } catch {
      /* best-effort */
    }
  }
  const body = fmMatch !== null ? raw.slice(fmMatch[0].length) : raw;
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
  const fmMatch = raw.match(/^---\n([\s\S]*?)\n---\n?/);
  let fm: Record<string, unknown> = {};
  if (fmMatch !== null && fmMatch[1] !== undefined) {
    try {
      const parsed = parseYaml(fmMatch[1]);
      if (typeof parsed === "object" && parsed !== null) {
        fm = parsed as Record<string, unknown>;
      }
    } catch {
      /* best-effort */
    }
  }
  const body = fmMatch !== null ? raw.slice(fmMatch[0].length) : raw;
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

/**
 * Plan §5.4.1 — losing-side prose stays in its source file
 * post-resolution; the doc / CLAUDE.md / AGENTS.md narrative is
 * preserved as-is. The original sot_path entry is now bound to a
 * superseded / archived id, so phase 5b's next walk would re-emit a
 * fresh DEC with the same content-addressed id (loop). Recording an
 * `orphan_path` drift event surfaces the prose to the operator's
 * attention queue so they can pick: re-cite the winner manually,
 * promote it to a fresh DEC, or delete the orphan paragraph.
 *
 * The drift event includes `dec_id` pointing at the just-superseded
 * entity so the attention surface can render context (which side won,
 * what the orphan body looks like).
 */
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
      "decisions ledger rebuild failed after conflict resolution",
    );
  }
  try {
    writeInvariantsLedger({ repoRoot });
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err) },
      "invariants ledger rebuild failed after conflict resolution",
    );
  }
}

async function resolveConflict(ctx: McpContext, input: Input): Promise<unknown> {
  const conflict = parseConflictFile(ctx.repoRoot, input.item_id);
  if (conflict === null) {
    return mcpError(
      "FILE_NOT_FOUND",
      `no conflict file for item_id=${input.item_id} (expected .cairn/ground/conflicts/${input.item_id}.md)`,
    );
  }

  return withWriteLock(ctx.repoRoot, () => {
    const winner = input.choice === "a" ? conflict.aRef : conflict.bRef;
    const loser = input.choice === "a" ? conflict.bRef : conflict.aRef;

    if (input.choice === "a" || input.choice === "b") {
      const loserBefore = readEntity(loser);
      const winnerOk = setSupersedes(loser, winner);
      const loserOk = setSupersededBy(ctx.repoRoot, loser, winner.id, "superseded");
      if (!winnerOk || !loserOk) {
        return mcpError(
          "VALIDATION_FAILED",
          `conflict resolution failed: missing entity (winner=${winnerOk ? "ok" : "missing"}, loser=${loserOk ? "ok" : "missing"})`,
        );
      }
      recordOrphanDriftEvents(ctx.repoRoot, [{ ref: loser, parsed: loserBefore }]);
      deleteConflictFile(conflict);
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
        /* best-effort */
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
        /* best-effort */
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

    // choice === "d" — archive both. Conflict file moves to _archived/.
    const aBefore = readEntity(conflict.aRef);
    const bBefore = readEntity(conflict.bRef);
    const aOk = setSupersededBy(ctx.repoRoot, conflict.aRef, conflict.bRef.id, "archived");
    const bOk = setSupersededBy(ctx.repoRoot, conflict.bRef, conflict.aRef.id, "archived");
    recordOrphanDriftEvents(ctx.repoRoot, [
      { ref: conflict.aRef, parsed: aBefore },
      { ref: conflict.bRef, parsed: bBefore },
    ]);
    const archivedRel = moveConflictToArchive(ctx.repoRoot, conflict);
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
      /* best-effort */
    }
    if (!aOk || !bOk) {
      log.warn(
        { aOk, bOk, item_id: input.item_id },
        "archive-both: one or both entities missing on disk",
      );
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

interface MergeError {
  error: ReturnType<typeof mcpError>;
}
interface MergeOk {
  mergedId: string;
  mergedRel: string;
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
        `merge requires both entities present on disk (a=${a !== null}, b=${b !== null})`,
      ),
    };
  }
  const now = new Date().toISOString();
  // Merged entity inherits the kind of A (the freshly captured side).
  // Mixed DEC/INV merges produce a DEC by convention — the merged
  // entity carries combined narrative, not a single hard constraint.
  const mergedKind: "DEC" | "INV" =
    conflict.aRef.kind === "INV" && conflict.bRef.kind === "INV" ? "INV" : "DEC";
  const mergedId = synthesizeMergedId(repoRoot, mergedKind);
  const mergedRel =
    mergedKind === "DEC"
      ? `.cairn/ground/decisions/${mergedId}.md`
      : `.cairn/ground/invariants/${mergedId}.md`;
  const mergedAbs = join(repoRoot, mergedRel);
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
  mkdirSync(dirname(mergedAbs), { recursive: true });
  writeFileSync(
    mergedAbs,
    `---\n${stringifyYaml(mergedFm).trimEnd()}\n---\n${mergedBody}`,
    "utf8",
  );
  // Both old entries get superseded_by → new merged id.
  setSupersededBy(repoRoot, conflict.aRef, mergedId, "superseded");
  setSupersededBy(repoRoot, conflict.bRef, mergedId, "superseded");
  return { mergedId, mergedRel };
}

function synthesizeMergedId(repoRoot: string, kind: "DEC" | "INV"): string {
  // Content-addressed style — derive from the timestamp + a counter so
  // re-runs in the same millisecond don't collide. We don't have the
  // verbatim merged-body hash easily reachable here without circular
  // dependencies; the timestamp gives us a stable-enough seed since
  // merges are operator-driven and infrequent.
  const dir = kind === "DEC" ? decisionsDir(repoRoot) : invariantsDir(repoRoot);
  const existing = new Set<string>();
  if (existsSync(dir)) {
    try {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isFile() && e.name.endsWith(".md")) {
          existing.add(e.name.replace(/\.md$/, ""));
        }
      }
    } catch {
      /* best-effort */
    }
  }
  const seed = `merge-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`;
  let candidate = `${kind}-${hashHex(seed).slice(0, 7)}`;
  let suffix = 0;
  while (existing.has(candidate)) {
    suffix += 1;
    candidate = `${kind}-${hashHex(`${seed}-${suffix}`).slice(0, 7)}`;
  }
  return candidate;
}

function hashHex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

function resolveInvalidationEvent(_ctx: McpContext, input: Input): Promise<unknown> {
  // Per spec §7: A=refresh, B=continue-under-old, C=abort. The marker
  // stamping + scope refresh happens in the calling skill, since it
  // owns the session id. This tool just acknowledges the resolution
  // so the skill can record it.
  const map: Record<"a" | "b" | "c", string> = {
    a: "refresh",
    b: "continue_under_old",
    c: "abort",
  };
  // The "d" slot is filtered out for non-conflict kinds in the top
  // dispatcher, so this cast is safe.
  const choice = input.choice as "a" | "b" | "c";
  return Promise.resolve({
    ok: true,
    resolved_kind: `invalidation_${map[choice]}`,
    item_id: input.item_id,
    ...(input.rationale !== undefined ? { rationale: input.rationale } : {}),
  });
}

function promoteDraftStatus(body: string): string {
  // Frontmatter `status: draft*` → `status: accepted`. Best-effort
  // regex — covers every draft marker the init pipeline emits:
  //   - `draft` (legacy / generic)
  //   - `draft-from-init-docs` (phase 6)
  //   - `draft-from-source-comment` (phase 7b)
  //   - `draft-from-rules-merge` (phase 7c)
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

export const resolveAttentionTool: ToolDef<Input> = {
  name: "cairn_resolve_attention",
  description:
    "Resolve an inline-A/B/C attention pick — DEC draft accept/reject/edit, baseline finding suppress/defer/triage, invalidation event refresh/continue/abort. Called by the cairn-attention skill after the operator picks an option.",
  inputSchema: resolveAttentionInput,
  handler,
};
