import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import {
  computeDecisionId,
  scanExistingDecisionIds,
} from "../../decision-capture/index.js";
import type { McpContext } from "../context.js";
import { writeInvalidationEvent } from "../../events/index.js";
import {
  bodyContentHash,
  decisionsDir,
  deriveDecId,
  readAnchorMap,
  readRejectedYaml,
  readTopicIndex,
  setTopic,
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

  // Validate assertions, if provided.
  if (input.assertions !== undefined) {
    for (const a of input.assertions) {
      const result = DecisionAssertion.safeParse(a);
      if (!result.success) {
        return mcpError("INVALID_ASSERTION_KIND", "assertion failed schema", {
          assertion: a,
          issues: result.error.issues,
        });
      }
    }
  }

  return withWriteLock(ctx.repoRoot, async () => {
    const existingIds = scanExistingDecisionIds(ctx.repoRoot);
    const target = input.target ?? "inbox";
    const outDir = target === "accepted" ? dir : inboxDir;

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
      ...(input.supersedes !== undefined ? { supersedes: input.supersedes } : {}),
      ...(input.assertions !== undefined ? { assertions: input.assertions } : {}),
      ...(input.human_review_hint !== undefined ? { human_review_hint: input.human_review_hint } : {}),
    };

    const filename = target === "accepted" ? `${id}.md` : `${id}.draft.md`;
    const path = join(outDir, filename);
    const content = `---\n${stringifyYaml(frontmatter)}---\n\n${body}`;
    writeFileSync(path, content, "utf8");

    const relPath = relativePath(id, target);
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

    return { ok: true, id, target, path: relPath };
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
    "Record a decision in the ledger or inbox. Use `slug` to promote a candidate from the topic index, or provide `title` and `summary` for a manual entry. Use `target=accepted` (operator only) to bypass the inbox.",
  inputSchema: recordDecisionInput,
  handler,
};
