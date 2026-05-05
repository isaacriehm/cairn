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
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";
import { writeInvalidationEvent } from "../../events/index.js";
import { decisionsDir } from "../../ground/index.js";
import {
  clearDeferState,
  writeDeferState,
  type DeferKind,
} from "../../hooks/defer.js";
import {
  applyStripReplace,
  type ReplaceItem,
  type StripReplaceResult,
} from "../../init/source-comments/strip-replace.js";
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
      draft_path: `.cairn/ground/decisions/_inbox/${input.item_id}.draft.md`,
      body,
    });
  }

  return withWriteLock(ctx.repoRoot, () => {
    if (input.choice === "a") {
      const acceptedPath = join(decDir, `${input.item_id}.md`);
      mkdirSync(dirname(acceptedPath), { recursive: true });
      const draft = readFileSync(inboxPath, "utf8");
      const draftMeta = parseDraftFrontmatter(draft);
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
        emitEvent(ctx, "decision_accepted", input.item_id, `.cairn/ground/decisions/${input.item_id}.md`);
      } catch {
        // event emission must never roll back the resolution
      }
      let stripOutcome: StripOutcomeSummary | null = null;
      if (draftMeta?.captureSource === "init-source-comments" && draftMeta.blockId !== null) {
        stripOutcome = runSourceStrip(ctx.repoRoot, input.item_id, draftMeta);
      }
      const base = {
        ok: true,
        resolved_kind: "decision_accepted",
        item_id: input.item_id,
        accepted_path: `.cairn/ground/decisions/${input.item_id}.md`,
      } as const;
      return stripOutcome === null ? base : { ...base, source_strip: stripOutcome };
    }

    // choice === "b" — reject + archive.
    const today = new Date().toISOString().slice(0, 10);
    const archivedRel = join(".archive", today, ".cairn/ground/decisions/_inbox", `${input.item_id}.draft.md`);
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
    const suppressionsPath = join(ctx.repoRoot, ".cairn", "baseline", "suppressions.yaml");
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
  // Frontmatter `status: draft` → `status: accepted`. Best-effort regex
  // — if the frontmatter shape is unusual the file is still acceptable
  // (status field is advisory). Also covers
  // `status: draft-from-source-comment` (phase 7b's draft marker).
  return body.replace(/^status:\s*draft(?:-from-source-comment)?\b/m, "status: accepted");
}

interface DraftMeta {
  blockId: string | null;
  sourceFile: string | null;
  captureSource: string | null;
  title: string | null;
}

function parseDraftFrontmatter(body: string): DraftMeta | null {
  const match = /^---\n([\s\S]*?)\n---/.exec(body);
  if (match === null) return null;
  let parsed: unknown;
  try {
    parsed = parseYaml(match[1] ?? "");
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== "object") return null;
  const obj = parsed as Record<string, unknown>;
  return {
    blockId: typeof obj["blockId"] === "string" ? obj["blockId"] : null,
    sourceFile: typeof obj["sourceFile"] === "string" ? obj["sourceFile"] : null,
    captureSource:
      typeof obj["capture_source"] === "string" ? obj["capture_source"] : null,
    title: typeof obj["title"] === "string" ? obj["title"] : null,
  };
}

interface StripOutcomeSummary {
  attempted: boolean;
  files_modified: number;
  items_applied: number;
  audit_path: string | null;
  reason?: string;
}

function runSourceStrip(
  repoRoot: string,
  decId: string,
  meta: DraftMeta,
): StripOutcomeSummary {
  const blockId = meta.blockId;
  if (blockId === null) {
    return { attempted: false, files_modified: 0, items_applied: 0, audit_path: null, reason: "no-block-id" };
  }
  const auditPath = findLatestAudit(repoRoot);
  if (auditPath === null) {
    return { attempted: false, files_modified: 0, items_applied: 0, audit_path: null, reason: "no-audit-found" };
  }
  let auditBody: unknown;
  try {
    auditBody = parseYaml(readFileSync(auditPath, "utf8"));
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err), auditPath },
      "audit parse failed",
    );
    return { attempted: false, files_modified: 0, items_applied: 0, audit_path: auditPath, reason: "audit-parse-failed" };
  }
  const blocks = extractAuditBlocks(auditBody);
  const block = blocks.find((b) => b.block_id === blockId);
  if (block === undefined) {
    return { attempted: false, files_modified: 0, items_applied: 0, audit_path: auditPath, reason: "block-not-found" };
  }
  const replacement = formatCitation(block.lang, decId, meta.title ?? "");
  const item: ReplaceItem = {
    blockId,
    file: block.file,
    startOffset: block.start_offset,
    endOffset: block.end_offset,
    replacement,
  };
  let result: StripReplaceResult;
  try {
    result = applyStripReplace({ repoRoot, items: [item] });
  } catch (err) {
    log.warn(
      { err: err instanceof Error ? err.message : String(err), decId, blockId },
      "strip-replace failed",
    );
    return { attempted: true, files_modified: 0, items_applied: 0, audit_path: auditPath, reason: "strip-failed" };
  }
  return {
    attempted: true,
    files_modified: result.filesModified,
    items_applied: result.itemsApplied,
    audit_path: auditPath,
  };
}

function findLatestAudit(repoRoot: string): string | null {
  const dir = join(repoRoot, ".cairn", "baseline");
  if (!existsSync(dir)) return null;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return null;
  }
  const candidates = entries
    .filter((n) => n.startsWith("source-comments-") && n.endsWith(".yaml"))
    .map((name) => {
      const abs = join(dir, name);
      let mtime = 0;
      try {
        mtime = statSync(abs).mtimeMs;
      } catch {
        // ignore
      }
      return { abs, mtime };
    })
    .sort((a, b) => b.mtime - a.mtime);
  return candidates[0]?.abs ?? null;
}

interface AuditBlock {
  block_id: string;
  file: string;
  lang: string;
  start_offset: number;
  end_offset: number;
}

function extractAuditBlocks(body: unknown): AuditBlock[] {
  if (body === null || typeof body !== "object") return [];
  const obj = body as Record<string, unknown>;
  const raw = obj["blocks"];
  if (!Array.isArray(raw)) return [];
  const out: AuditBlock[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const block_id = e["block_id"];
    const file = e["file"];
    const lang = e["lang"];
    const start_offset = e["start_offset"];
    const end_offset = e["end_offset"];
    if (
      typeof block_id !== "string" ||
      typeof file !== "string" ||
      typeof lang !== "string" ||
      typeof start_offset !== "number" ||
      typeof end_offset !== "number"
    ) {
      continue;
    }
    out.push({ block_id, file, lang, start_offset, end_offset });
  }
  return out;
}

const HASH_LANGS = new Set(["py", "rb", "sh"]);

function formatCitation(lang: string, decId: string, title: string): string {
  const trimmedTitle = title.trim();
  const tail = trimmedTitle.length > 0 ? `: ${trimmedTitle}` : "";
  if (HASH_LANGS.has(lang)) {
    return `# See ${decId}${tail}`;
  }
  return `// See ${decId}${tail}`;
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
