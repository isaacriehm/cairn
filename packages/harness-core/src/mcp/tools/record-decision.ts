import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import type { McpContext } from "../context.js";
import { decisionsDir, parseFrontmatter } from "../../ground/index.js";
import { DecisionAssertion, DecisionFrontmatter } from "../../ground/index.js";
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

  // Existing-id index — for ID allocation and DECISION_ID_TAKEN check.
  const existingIds = new Set<string>();
  for (const d of [dir, inboxDir]) {
    if (!existsSync(d)) continue;
    for (const e of readdirSync(d, { withFileTypes: true, encoding: "utf8" })) {
      if (!e.isFile() || !e.name.endsWith(".md")) continue;
      const fm = parseFrontmatter(readFileSync(join(d, e.name), "utf8")).frontmatter;
      const parsed = DecisionFrontmatter.safeParse(fm);
      if (parsed.success) existingIds.add(parsed.data.id);
    }
  }

  let id: string;
  if (input.id !== undefined) {
    if (existingIds.has(input.id)) {
      return mcpError("DECISION_ID_TAKEN", `${input.id} already exists`);
    }
    id = input.id;
  } else {
    id = allocateNextId(existingIds);
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
  const body = input.body_markdown ?? `# ${id} — ${input.title}\n\n## Summary\n\n${input.summary}\n`;
  const filename = target === "accepted" ? `${id}.md` : `${id}.draft.md`;
  const path = join(outDir, filename);
  const content = `---\n${stringifyYaml(frontmatter)}---\n\n${body}`;
  writeFileSync(path, content, "utf8");

  return {
    ok: true,
    id,
    target,
    path: target === "accepted"
      ? `.harness/ground/decisions/${filename}`
      : `.harness/ground/decisions/_inbox/${filename}`,
  };
}

function allocateNextId(existing: Set<string>): string {
  let n = 0;
  for (const id of existing) {
    const m = id.match(/^DEC-(\d+)$/);
    if (m?.[1]) {
      const num = Number.parseInt(m[1], 10);
      if (Number.isFinite(num) && num > n) n = num;
    }
  }
  return `DEC-${String(n + 1).padStart(4, "0")}`;
}

export const recordDecisionTool: ToolDef<Input> = {
  name: "harness_record_decision",
  description:
    "Drop a decision draft to .harness/ground/decisions/_inbox/ (target=inbox, default) or canonical (target=accepted; operator-only override). Validates assertion schemas. Allocates the next DEC-NNNN if id omitted.",
  inputSchema: recordDecisionInput,
  handler,
};
