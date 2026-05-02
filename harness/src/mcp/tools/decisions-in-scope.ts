import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { McpContext } from "../context.js";
import { decisionsDir, matchAnyGlob, parseFrontmatter } from "../../ground/index.js";
import { DecisionFrontmatter } from "../../ground/index.js";
import { decisionsInScopeInput } from "../schemas.js";
import type { ToolDef } from "./types.js";

interface Input {
  path_globs: string[];
  status?: ("draft" | "accepted" | "superseded" | "archived")[];
}

interface Summary {
  id: string;
  title: string;
  status: string;
  scope_globs?: string[];
  supersedes?: string | null;
  superseded_by?: string | null;
  decided_at?: string;
}

async function handler(ctx: McpContext, input: Input): Promise<unknown> {
  const wantStatus = new Set(input.status ?? ["accepted"]);
  const dir = decisionsDir(ctx.repoRoot);
  if (!existsSync(dir)) return [];
  const out: Summary[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true, encoding: "utf8" })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const abs = join(dir, entry.name);
    const parsed = parseFrontmatter(readFileSync(abs, "utf8"));
    const fm = DecisionFrontmatter.safeParse(parsed.frontmatter);
    if (!fm.success) continue;
    if (!wantStatus.has(fm.data.status)) continue;
    const scope = fm.data.scope_globs ?? [];
    const overlap =
      scope.length === 0
        ? false
        : scope.some((scopeGlob) =>
            input.path_globs.some(
              (req) => matchAnyGlob(scopeGlob, [req]) || matchAnyGlob(req, [scopeGlob]),
            ),
          );
    if (!overlap) continue;
    out.push({
      id: fm.data.id,
      title: fm.data.title,
      status: fm.data.status,
      ...(fm.data.scope_globs !== undefined ? { scope_globs: fm.data.scope_globs } : {}),
      ...(fm.data.supersedes !== undefined ? { supersedes: fm.data.supersedes } : {}),
      ...(fm.data.superseded_by !== undefined ? { superseded_by: fm.data.superseded_by } : {}),
      ...(fm.data.decided_at !== undefined ? { decided_at: fm.data.decided_at } : {}),
    });
  }
  out.sort((a, b) => (b.decided_at ?? "").localeCompare(a.decided_at ?? ""));
  return out;
}

export const decisionsInScopeTool: ToolDef<Input> = {
  name: "harness_decisions_in_scope",
  description:
    "List decision summaries whose scope_globs overlap any of the given path_globs.",
  inputSchema: decisionsInScopeInput,
  handler,
};
