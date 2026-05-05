import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { McpContext } from "../context.js";
import { decisionsDir, parseFrontmatter } from "../../ground/index.js";
import { DecisionFrontmatter } from "../../ground/index.js";
import { mcpError } from "../errors.js";
import { decisionGetInput } from "../schemas.js";
import type { ToolDef } from "./types.js";

interface Input {
  id: string;
}

async function handler(ctx: McpContext, input: Input): Promise<unknown> {
  const dir = decisionsDir(ctx.repoRoot);
  if (!existsSync(dir)) {
    return mcpError("DECISION_NOT_FOUND", `No decisions directory at ${dir}`);
  }
  // Search both the canonical accepted layer and the `_inbox/` drafts
  // layer. The cairn-attention skill calls this on every pending DEC
  // path; resolving drafts keeps the skill on the MCP surface instead
  // of falling back to `cat` / Read on the raw file.
  const inboxDir = join(dir, "_inbox");
  const searchDirs = [dir, inboxDir].filter((d) => existsSync(d));
  for (const searchDir of searchDirs) {
    const files = readdirSync(searchDir, { withFileTypes: true, encoding: "utf8" });
    for (const f of files) {
      if (!f.isFile() || !f.name.endsWith(".md")) continue;
      const abs = join(searchDir, f.name);
      const parsed = parseFrontmatter(readFileSync(abs, "utf8"));
      const fm = DecisionFrontmatter.safeParse(parsed.frontmatter);
      if (!fm.success) continue;
      if (fm.data.id !== input.id) continue;
      return {
        id: fm.data.id,
        title: fm.data.title,
        status: fm.data.status,
        ...(fm.data.scope_globs !== undefined ? { scope_globs: fm.data.scope_globs } : {}),
        ...(fm.data.supersedes !== undefined ? { supersedes: fm.data.supersedes } : {}),
        ...(fm.data.superseded_by !== undefined ? { superseded_by: fm.data.superseded_by } : {}),
        ...(fm.data.decided_at !== undefined ? { decided_at: fm.data.decided_at } : {}),
        ...(fm.data.assertions !== undefined ? { assertions: fm.data.assertions } : {}),
        ...(fm.data.human_review_hint !== undefined
          ? { human_review_hint: fm.data.human_review_hint }
          : {}),
        ...(fm.data.related_invariants !== undefined
          ? { related_invariants: fm.data.related_invariants }
          : {}),
        body_markdown: parsed.body,
      };
    }
  }
  return mcpError("DECISION_NOT_FOUND", `No decision with id ${input.id}`);
}

export const decisionGetTool: ToolDef<Input> = {
  name: "cairn_decision_get",
  description:
    "Returns full ADR + assertions block for a decision id. Resolves both accepted decisions (`.cairn/ground/decisions/<id>.md`) and pending drafts (`_inbox/<id>.draft.md`); the response's `status` field tells the caller which layer the decision came from.",
  inputSchema: decisionGetInput,
  handler,
};
