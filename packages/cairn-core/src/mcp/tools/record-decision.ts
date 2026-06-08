import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import {
  computeDecisionId,
  scanExistingDecisionIds,
} from "../../decision-capture/index.js";
import type { McpContext } from "../context.js";
import { writeInvalidationEvent } from "../../events/index.js";
import { isDuplicateOfAccepted } from "../../attention/dedup.js";
import {
  bodyContentHash,
  decisionsAutoAccept,
  decisionsDir,
  deriveDecId,
  readAnchorMap,
  readRejectedYaml,
  readTopicIndex,
  setTopic,
  writeDecisionsLedger,
  writeFileCandidatesMap,
  writeTopicIndex,
  type TopicIndexEntry,
} from "@isaacriehm/cairn-state";
import { DecisionAssertion } from "@isaacriehm/cairn-state";
import { withWriteLock } from "../../lock.js";
import { requireBootstrap } from "../bootstrap-guard.js";
import { mcpError } from "../errors.js";
import { recordDecisionInput } from "../schemas.js";
import { readSotBody } from "../../init/sot-emit.js";
import type { ToolDef } from "./types.js";

interface Input {
  id?: string;
  slug?: string;
  title?: string;
  summary?: string;
  scope_globs?: string[];
  supersedes?: string;
  assertions?: unknown[];
  human_review_hint?: string;
  body_markdown?: string;
  target?: "inbox" | "accepted";
}

async function handler(ctx: McpContext, input: Input): Promise<unknown> {
  const block = requireBootstrap(ctx.repoRoot);
  if (block !== null) return block;
  const dir = decisionsDir(ctx.repoRoot);
  const inboxDir = join(dir, "_inbox");

  // Validate assertions, if provided. Inline the valid-kind list in the
  // error envelope so an AI that hallucinates a kind (e.g. `no-pattern`)
  // can self-correct on the retry — saving an MCP round-trip.
  const VALID_KINDS = [
    "schema_must_contain",
    "text_must_match",
    "text_must_not_match",
    "index_must_exist",
    "ast_pattern",
    "file_must_not_be_modified",
    "query_must_filter_by",
    "route_must_have_guard",
    "event_must_emit",
    "service_method_must_call",
    "human_review_hint",
  ];
  if (input.assertions !== undefined) {
    for (const a of input.assertions) {
      const result = DecisionAssertion.safeParse(a);
      if (!result.success) {
        const submittedKind =
          a !== null && typeof a === "object" && "kind" in (a as object)
            ? (a as Record<string, unknown>)["kind"]
            : undefined;
        return mcpError(
          "INVALID_ASSERTION_KIND",
          `assertion failed schema (kind=${JSON.stringify(submittedKind)}); valid kinds: ${VALID_KINDS.join(", ")}. Per-assertion glob field is 'in_globs', not 'scope_globs'.`,
          {
            assertion: a,
            valid_kinds: VALID_KINDS,
            issues: result.error.issues,
          },
        );
      }
    }
  }

  return withWriteLock(ctx.repoRoot, async () => {
    const existingIds = scanExistingDecisionIds(ctx.repoRoot);
    // `target` may be promoted from "inbox" to "accepted" by the
    // auto-accept gate below (after the body/title are resolved).
    let target = input.target ?? "inbox";

    let id: string;
    let body: string;
    let title: string;
    let scopeGlobs: string[] = input.scope_globs ?? [];
    let decidedBy = ctx.sessionId ? `session:${ctx.sessionId}` : "user";
    let sotKind: "ledger" | "path" = "ledger";
    let sotPath = "ledger";
    let sourceFile: string | undefined;

    if (input.slug) {
      // AI Candidate Promotion path
      const topicIndex = readTopicIndex(ctx.repoRoot);
      const entry = topicIndex.topics[input.slug];
      if (entry === undefined) {
        return mcpError("VALIDATION_FAILED", `slug "${input.slug}" not in topic-index`);
      }
      if (entry.dec_id !== undefined) {
        return {
          ok: true,
          id: entry.dec_id,
          target,
          path: relativePath(entry.dec_id, target),
          warning: `DEC already exists for slug ${input.slug}`,
        };
      }

      const rejected = readRejectedYaml(ctx.repoRoot);
      if (rejected.has(input.slug)) {
        return mcpError("VALIDATION_FAILED", `slug "${input.slug}" was previously rejected`);
      }

      const anchorMap = readAnchorMap(ctx.repoRoot);
      const sotBody = readSotBody(ctx.repoRoot, entry, anchorMap);
      if (sotBody === null) {
        return mcpError("VALIDATION_FAILED", "source body unreadable");
      }

      // Drift check
      if (entry.content_hash !== undefined && bodyContentHash(sotBody) !== entry.content_hash) {
        return mcpError("VALIDATION_FAILED", "Source file modified since index build");
      }

      title = input.title ?? firstLineFallback(sotBody);
      body = sotBody;
      sotKind = "path";
      sotPath = entryToSotPath(entry);
      sourceFile = entry.sot_source;
      decidedBy = "ai-curator";

      id = allocateUniqueDecId(
        { sot_path: sotPath, title, capture_source: "ai-proposed" },
        existingIds,
      );

      // Update topic index
      const updatedTopicIndex = setTopic(topicIndex, input.slug, {
        ...entry,
        dec_id: id,
      });
      writeTopicIndex(ctx.repoRoot, updatedTopicIndex);
      writeFileCandidatesMap(ctx.repoRoot, updatedTopicIndex);
    } else {
      // Manual path
      if (!input.title || !input.summary) {
        return mcpError("VALIDATION_FAILED", "title and summary required for manual record");
      }
      title = input.title;
      id = input.id ?? computeDecisionId(
        {
          title,
          rationale: input.summary,
          capture_source: "user-record",
          scope_globs: scopeGlobs,
          ...(input.body_markdown ? { body_markdown: input.body_markdown } : {}),
          timestamp_ms: Date.now(),
        },
        existingIds,
      );
      body = input.body_markdown ?? `# ${id} — ${title}\n\n## Summary\n\n${input.summary}\n`;
    }

    if (input.supersedes !== undefined && !existingIds.has(input.supersedes)) {
      return mcpError("SUPERSEDES_NOT_FOUND", `supersedes target "${input.supersedes}" not found`);
    }

    // ── Auto-accept gate ──────────────────────────────────────────────
    // When auto-accept is on (the default) and the caller did NOT pin a
    // target, an AI-proposed decision lands straight in the ledger instead
    // of the triage inbox — the human review checkpoint shifts to the
    // committed-ground-state PR diff. Verify-then-accept: assertions
    // already passed schema validation above; here we dedup against the
    // accepted ledger so a restatement of an existing decision still queues
    // as a draft for human eyes rather than silently re-landing.
    //
    // An explicit `target` is always honored: `"accepted"` forces direct
    // accept (skips the dedup gate); `"inbox"` forces a triage draft even
    // when auto-accept is globally on (the per-call escape hatch).
    let autoAccepted = false;
    let dedupNote: string | undefined;
    if (input.target === undefined && decisionsAutoAccept(ctx.repoRoot)) {
      const dup = isDuplicateOfAccepted({ repoRoot: ctx.repoRoot, title });
      if (dup.dup) {
        dedupNote =
          `near-duplicate of accepted ${dup.matchId} ("${dup.matchTitle}", ` +
          `sim ${dup.similarity}) — queued as a draft for triage instead of ` +
          `auto-accepting`;
      } else {
        target = "accepted";
        autoAccepted = true;
      }
    }

    const outDir = target === "accepted" ? dir : inboxDir;
    mkdirSync(outDir, { recursive: true });

    const frontmatter = {
      id,
      title,
      type: "adr",
      status: target === "accepted" ? "accepted" : "draft",
      audience: "dual",
      generated: new Date().toISOString(),
      "verified-at": new Date().toISOString(),
      decided_at: new Date().toISOString().slice(0, 10),
      decided_by: decidedBy,
      scope_globs: scopeGlobs,
      sot_kind: sotKind,
      sot_path: sotPath,
      sot_content_hash: bodyContentHash(body),
      source_file: sourceFile,
      ...(autoAccepted ? { auto_accepted: true } : {}),
      ...(input.supersedes !== undefined ? { supersedes: input.supersedes } : {}),
      ...(input.assertions !== undefined ? { assertions: input.assertions } : {}),
      ...(input.human_review_hint !== undefined ? { human_review_hint: input.human_review_hint } : {}),
    };

    const filename = target === "accepted" ? `${id}.md` : `${id}.draft.md`;
    const path = join(outDir, filename);
    const content = `---\n${stringifyYaml(frontmatter)}---\n\n${body}`;
    writeFileSync(path, content, "utf8");

    const relPath = relativePath(id, target);

    // Direct accept path: extend `decisions.ledger.yaml` immediately so
    // `cairn_in_scope` sees the new DEC without waiting for the next
    // SessionStart rebuild. The bulk-accept and resolve-attention
    // accept paths already do this; the direct-accept path used to skip
    // it, which produced ledger-drift over long-running adoptions.
    if (target === "accepted") {
      try {
        writeDecisionsLedger({ repoRoot: ctx.repoRoot });
      } catch {
        /* best-effort */
      }
    }

    try {
      writeInvalidationEvent(ctx.repoRoot, {
        kind: target === "accepted" ? "decision_accepted" : "decision_drafted",
        refs: [
          { kind: "decision", id },
          ...(input.supersedes !== undefined ? ([{ kind: "decision", id: input.supersedes }] as const) : []),
        ],
        path: relPath,
        source: { session_id: ctx.sessionId ?? null, tool: "cairn_record_decision" },
      });
    } catch {
      /* ignore */
    }

    return {
      ok: true,
      id,
      target,
      path: relPath,
      auto_accepted: autoAccepted,
      ...(dedupNote !== undefined ? { note: dedupNote } : {}),
    };
  });
}

function relativePath(id: string, target: "inbox" | "accepted"): string {
  return target === "accepted"
    ? `.cairn/ground/decisions/${id}.md`
    : `.cairn/ground/decisions/_inbox/${id}.draft.md`;
}

function entryToSotPath(entry: TopicIndexEntry): string {
  const sot = entry.candidates.find((c) => c.file === entry.sot_source);
  if (sot === undefined) return entry.sot_source;
  if (sot.anchor !== undefined && sot.anchor.length > 0) {
    return `${entry.sot_source}#${sot.anchor}`;
  }
  return entry.sot_source;
}

function firstLineFallback(body: string): string {
  const first = body.split("\n").find((l) => l.trim().length > 0) ?? "";
  return first.replace(/^#+\s*/, "").trim().slice(0, 120) || "(untitled)";
}

function allocateUniqueDecId(
  input: { sot_path: string; title: string; capture_source: string },
  existingIds: Set<string>,
): string {
  const id = deriveDecId(input);
  if (!existingIds.has(id)) {
    existingIds.add(id);
    return id;
  }
  for (let suffix = 2; suffix < 1_000; suffix += 1) {
    const tagged = deriveDecId({ ...input, title: `${input.title} #${suffix}` });
    if (!existingIds.has(tagged)) {
      existingIds.add(tagged);
      return tagged;
    }
  }
  existingIds.add(id);
  return id;
}

export const recordDecisionTool: ToolDef<Input> = {
  name: "cairn_record_decision",
  description:
    "Record a decision. Use `slug` to promote a candidate from the topic index, or provide `title` and `summary` for a manual entry. By default decisions AUTO-ACCEPT straight into the ledger (the human review checkpoint is the committed-ground-state PR diff); a near-duplicate of an already-accepted decision falls back to an `_inbox/` draft instead. The response reports `auto_accepted` and, on dedup fallback, a `note`. Set `decisions.auto_accept: false` in `.cairn/config.yaml` to restore per-draft triage. `target='accepted'` forces direct accept (skips the dedup gate).\n\n" +
    "**`assertions` schema** (only emit one of these `kind` values — anything else returns INVALID_ASSERTION_KIND):\n" +
    "- `text_must_match` / `text_must_not_match`: `{id, kind, pattern, in_globs[]}` — regex over files in globs.\n" +
    "- `ast_pattern`: `{id, kind, language, pattern, in_globs[]}` — AST grep in named lang over globs.\n" +
    "- `file_must_not_be_modified`: `{id, kind, path}` — single file is read-only.\n" +
    "- `schema_must_contain`: `{id, kind, table, column, column_type?, nullable?}` — DB schema.\n" +
    "- `index_must_exist`: `{id, kind, table, columns[], where?}` — DB index.\n" +
    "- `query_must_filter_by`: `{id, kind, orm, in_globs[], table, columns[], operator: 'eq'|'in'|'between'|'is_not_null', require_combination: 'and'|'or'}`.\n" +
    "- `route_must_have_guard`: `{id, kind, in_globs[], guard, require_on[]}`.\n" +
    "- `event_must_emit`: `{id, kind, in_globs[], after_method, event_key, payload_must_include?[]}`.\n" +
    "- `service_method_must_call`: `{id, kind, in_globs[], in_method, must_call, before_returning?}`.\n" +
    "- `human_review_hint`: `{id, kind, description}` — fallback when the rule can't be machine-checked.\n" +
    "**Field hint**: the field is `in_globs` (where to scan), not `scope_globs`. `scope_globs` is the top-level decision field; per-assertion globs use `in_globs`.",
  inputSchema: recordDecisionInput,
  handler,
};
