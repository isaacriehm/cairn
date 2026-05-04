/**
 * harness_resolve_attention — inline A/B/C resolution endpoint.
 *
 * Spec: PLUGIN_ARCHITECTURE §9 (MCP write tools — plugin-era addition).
 *
 * The harness-attention skill calls this after the operator picks an
 * option. It maps `kind × choice` onto the canonical resolution
 * pathway:
 *
 * | kind                | choice | resolution                                  |
 * |---------------------|--------|---------------------------------------------|
 * | decision_draft      | a      | accept — move `_inbox/<id>.draft.md` → `<id>.md`, status=accepted |
 * | decision_draft      | b      | reject — archive draft                      |
 * | decision_draft      | c      | edit-pending — return draft body (no write) |
 * | baseline_finding    | a      | triage-now — no-op (skill opens the file)   |
 * | baseline_finding    | b      | suppress — append to baseline/suppressions.yaml |
 * | baseline_finding    | c      | defer — no-op                               |
 * | invalidation_event  | a      | refresh — re-read in-scope DECs/§Vs          |
 * | invalidation_event  | b      | continue-under-old — no-op                  |
 * | invalidation_event  | c      | abort — caller archives task (no-op here)   |
 * | drift               | a/b/c  | reserved (drift surface lands later)        |
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { writeInvalidationEvent } from "../../events/index.js";
import { decisionsDir } from "../../ground/index.js";
import { withWriteLock } from "../../lock.js";
import type { McpContext } from "../context.js";
import { requireBootstrap } from "../bootstrap-guard.js";
import { mcpError } from "../errors.js";
import { resolveAttentionInput } from "../schemas.js";
import type { ToolDef } from "./types.js";

interface Input {
  item_id: string;
  choice: "a" | "b" | "c";
  kind: "decision_draft" | "baseline_finding" | "invalidation_event" | "drift";
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
  }
}

function resolveDecisionDraft(ctx: McpContext, input: Input): Promise<unknown> {
  if (!/^DEC-\d{4,}$/.test(input.item_id)) {
    return Promise.resolve(
      mcpError(
        "VALIDATION_FAILED",
        `decision_draft item_id must match DEC-NNNN, got ${input.item_id}`,
      ),
    );
  }
  const decDir = decisionsDir(ctx.repoRoot);
  const inboxPath = join(decDir, "_inbox", `${input.item_id}.draft.md`);

  if (!existsSync(inboxPath)) {
    return Promise.resolve(
      mcpError("FILE_NOT_FOUND", `no draft at ${inboxPath}`),
    );
  }

  if (input.choice === "c") {
    // Edit-pending: return the draft body so the skill can hand it to
    // the operator's editor flow. No state change.
    const body = readFileSync(inboxPath, "utf8");
    return Promise.resolve({
      ok: true,
      resolved_kind: "decision_edit_pending",
      item_id: input.item_id,
      draft_path: `.harness/ground/decisions/_inbox/${input.item_id}.draft.md`,
      body,
    });
  }

  return withWriteLock(ctx.repoRoot, () => {
    if (input.choice === "a") {
      const acceptedPath = join(decDir, `${input.item_id}.md`);
      mkdirSync(dirname(acceptedPath), { recursive: true });
      const draft = readFileSync(inboxPath, "utf8");
      const promoted = promoteDraftStatus(draft);
      writeFileSync(acceptedPath, promoted, "utf8");
      // Remove the draft after promoting so the inbox stays clean.
      renameSync(inboxPath, `${inboxPath}.accepted`);
      // Best-effort: delete the .accepted suffix file. We keep the
      // rename + cleanup as two steps so an interrupt mid-rename leaves
      // a recoverable trail rather than a vanished draft.
      try {
        renameSync(`${inboxPath}.accepted`, `${inboxPath}.accepted.bak`);
      } catch {
        // ignore — file already gone
      }
      try {
        emitEvent(ctx, "decision_accepted", input.item_id, `.harness/ground/decisions/${input.item_id}.md`);
      } catch {
        // event emission must never roll back the resolution
      }
      return {
        ok: true,
        resolved_kind: "decision_accepted",
        item_id: input.item_id,
        accepted_path: `.harness/ground/decisions/${input.item_id}.md`,
      };
    }

    // choice === "b" — reject + archive.
    const today = new Date().toISOString().slice(0, 10);
    const archivedRel = join(".archive", today, ".harness/ground/decisions/_inbox", `${input.item_id}.draft.md`);
    const archivedAbs = join(ctx.repoRoot, archivedRel);
    mkdirSync(dirname(archivedAbs), { recursive: true });
    renameSync(inboxPath, archivedAbs);
    try {
      emitEvent(ctx, "decision_rejected", input.item_id, archivedRel);
    } catch {
      // ignore
    }
    return {
      ok: true,
      resolved_kind: "decision_rejected",
      item_id: input.item_id,
      archived_to: archivedRel,
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
    const suppressionsPath = join(ctx.repoRoot, ".harness", "baseline", "suppressions.yaml");
    mkdirSync(dirname(suppressionsPath), { recursive: true });
    const initial = existsSync(suppressionsPath) ? "" : "suppressions:\n";
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
      suppressions_path: ".harness/baseline/suppressions.yaml",
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
  // Frontmatter `status: draft` → `status: accepted`. Best-effort regex
  // — if the frontmatter shape is unusual the file is still acceptable
  // (status field is advisory).
  return body.replace(/^status:\s*draft\b/m, "status: accepted");
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
    source: { session_id: ctx.sessionId ?? null, tool: "harness_resolve_attention" },
  });
}

export const resolveAttentionTool: ToolDef<Input> = {
  name: "harness_resolve_attention",
  description:
    "Resolve an inline-A/B/C attention pick — DEC draft accept/reject/edit, baseline finding suppress/defer/triage, invalidation event refresh/continue/abort. Called by the harness-attention skill after the operator picks an option.",
  inputSchema: resolveAttentionInput,
  handler,
};
