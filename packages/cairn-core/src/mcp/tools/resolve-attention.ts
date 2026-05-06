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
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
  parseDraftMeta,
  restoreDec,
  runDecSourceStrip,
  type DraftMeta,
  type StripOutcomeSummary,
} from "../../attention/index.js";
import { writeInvalidationEvent } from "../../events/index.js";
import { decisionsDir } from "../../ground/index.js";
import { writeDecisionsLedger } from "../../ground/ledgers.js";
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
  choice: "a" | "b" | "c";
  kind:
    | "decision_draft"
    | "baseline_finding"
    | "invalidation_event"
    | "drift"
    | "bypass"
    | "review";
  flagged_items?: string[];
  defer_hours?: number;
  rationale?: string;
}

async function handler(ctx: McpContext, input: Input): Promise<unknown> {
  const block = requireBootstrap(ctx.repoRoot);
  if (block !== null) return block;
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

function resolveInvalidationEvent(_ctx: McpContext, input: Input): Promise<unknown> {
  // Per spec §7: A=refresh, B=continue-under-old, C=abort. The marker
  // stamping + scope refresh happens in the calling skill, since it
  // owns the session id. This tool just acknowledges the resolution
  // so the skill can record it.
  const map = { a: "refresh", b: "continue_under_old", c: "abort" } as const;
  return Promise.resolve({
    ok: true,
    resolved_kind: `invalidation_${map[input.choice]}`,
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
