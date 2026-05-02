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
  const files = readdirSync(dir, { withFileTypes: true, encoding: "utf8" });
  for (const f of files) {
    if (!f.isFile() || !f.name.endsWith(".md")) continue;
    const abs = join(dir, f.name);
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
  return mcpError("DECISION_NOT_FOUND", `No decision with id ${input.id}`);
}

export const decisionGetTool: ToolDef<Input> = {
  name: "harness_decision_get",
  description: "Returns full ADR + assertions block for a decision id.",
  inputSchema: decisionGetInput,
  handler,
};
