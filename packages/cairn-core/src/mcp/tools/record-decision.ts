import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import {
  computeDecisionId,
  scanExistingDecisionIds,
} from "../../decision-capture/index.js";
import type { McpContext } from "../context.js";
import { writeInvalidationEvent } from "../../events/index.js";
import { decisionsDir } from "../../ground/index.js";
import { DecisionAssertion } from "../../ground/index.js";
import { withWriteLock } from "../../lock.js";
import { requireBootstrap } from "../bootstrap-guard.js";
import { mcpError } from "../errors.js";
import { recordDecisionInput } from "../schemas.js";
import type { ToolDef } from "./types.js";

interface Input {
  id?: string;
  title: string;
  summary: string;
  scope_globs: string[];
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

  // Validate assertions, if provided. (Pre-lock — pure schema check.)
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

  return withWriteLock(ctx.repoRoot, () => {
    // Re-scan inside the lock so concurrent allocators see each other's writes.
    const existingIds = scanExistingDecisionIds(ctx.repoRoot);

    let id: string;
    if (input.id !== undefined) {
      if (existingIds.has(input.id)) {
        return mcpError("DECISION_ID_TAKEN", `${input.id} already exists`);
      }
      id = input.id;
    } else {
      // Manual user-record path has no source provenance — fold a
      // millisecond timestamp in so two distinct decisions with
      // identical title + summary still hash to different ids.
      id = computeDecisionId(
        {
          title: input.title,
          rationale: input.summary,
          capture_source: "user-record",
          scope_globs: input.scope_globs,
          ...(input.body_markdown !== undefined
            ? { body_markdown: input.body_markdown }
            : {}),
          timestamp_ms: Date.now(),
        },
        existingIds,
      );
    }

    if (input.supersedes !== undefined && !existingIds.has(input.supersedes)) {
      return mcpError(
        "SUPERSEDES_NOT_FOUND",
        `supersedes target "${input.supersedes}" not found`,
      );
    }

    const target = input.target ?? "inbox";
    const outDir = target === "accepted" ? dir : inboxDir;
    mkdirSync(outDir, { recursive: true });

    const frontmatter = {
      id,
      title: input.title,
      type: "adr",
      status: target === "accepted" ? "accepted" : "draft",
      audience: "dual",
      generated: new Date().toISOString(),
      "verified-at": new Date().toISOString(),
      decided_at: new Date().toISOString().slice(0, 10),
      scope_globs: input.scope_globs,
      ...(input.supersedes !== undefined ? { supersedes: input.supersedes } : {}),
      ...(input.assertions !== undefined ? { assertions: input.assertions } : {}),
      ...(input.human_review_hint !== undefined
        ? { human_review_hint: input.human_review_hint }
        : {}),
    };
    const body =
      input.body_markdown ?? `# ${id} — ${input.title}\n\n## Summary\n\n${input.summary}\n`;
    const filename = target === "accepted" ? `${id}.md` : `${id}.draft.md`;
    const path = join(outDir, filename);
    const content = `---\n${stringifyYaml(frontmatter)}---\n\n${body}`;
    writeFileSync(path, content, "utf8");

    const relPath =
      target === "accepted"
        ? `.cairn/ground/decisions/${filename}`
        : `.cairn/ground/decisions/_inbox/${filename}`;
    try {
      writeInvalidationEvent(ctx.repoRoot, {
        kind: target === "accepted" ? "decision_accepted" : "decision_drafted",
        refs: [
          { kind: "decision", id },
          ...(input.supersedes !== undefined
            ? ([{ kind: "decision", id: input.supersedes }] as const)
            : []),
        ],
        path: relPath,
        source: { session_id: ctx.sessionId ?? null, tool: "cairn_record_decision" },
      });
    } catch {
      // Event emission must never roll back the underlying write.
    }

    return { ok: true, id, target, path: relPath };
  });
}

export const recordDecisionTool: ToolDef<Input> = {
  name: "cairn_record_decision",
  description:
    "Drop a decision draft to .cairn/ground/decisions/_inbox/ (target=inbox, default) or canonical (target=accepted; operator-only override). Validates assertion schemas. Allocates the next DEC-NNNN if id omitted.",
  inputSchema: recordDecisionInput,
  handler,
};
