import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { McpContext } from "../context.js";
import { decisionsDir, matchAnyGlob, parseFrontmatter } from "../../ground/index.js";
import { DecisionFrontmatter } from "../../ground/index.js";
import { decisionsForSymbolInput } from "../schemas.js";
import type { ToolDef } from "./types.js";

interface Input {
  file: string;
  symbol: string;
}

async function handler(ctx: McpContext, input: Input): Promise<unknown> {
  const dir = decisionsDir(ctx.repoRoot);
  if (!existsSync(dir)) return [];
  const out: { id: string; title: string; status: string; scope_globs?: string[] }[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true, encoding: "utf8" })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const abs = join(dir, entry.name);
    const raw = readFileSync(abs, "utf8");
    const parsed = parseFrontmatter(raw);
    const fm = DecisionFrontmatter.safeParse(parsed.frontmatter);
    if (!fm.success) continue;
    if (fm.data.status !== "accepted") continue;
    const scope = fm.data.scope_globs ?? [];
    if (!scope.some((g) => matchAnyGlob(input.file, [g]))) continue;
    if (!parsed.body.includes(input.symbol)) continue;
    out.push({
      id: fm.data.id,
      title: fm.data.title,
      status: fm.data.status,
      ...(fm.data.scope_globs !== undefined ? { scope_globs: fm.data.scope_globs } : {}),
    });
  }
  return out;
}

export const decisionsForSymbolTool: ToolDef<Input> = {
  name: "harness_decisions_for_symbol",
  description:
    "Decisions whose scope_globs cover `file` AND whose body explicitly mentions `symbol`. Smaller result than path-glob alone.",
  inputSchema: decisionsForSymbolInput,
  handler,
};
