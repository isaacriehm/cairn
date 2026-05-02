import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { McpContext } from "../context.js";
import { invariantsDir, parseFrontmatter } from "../../ground/index.js";
import { InvariantFrontmatter } from "../../ground/index.js";
import { mcpError } from "../errors.js";
import { invariantGetInput } from "../schemas.js";
import type { ToolDef } from "./types.js";

interface Input {
  id: string;
}

async function handler(ctx: McpContext, input: Input): Promise<unknown> {
  const dir = invariantsDir(ctx.repoRoot);
  if (!existsSync(dir)) {
    return mcpError("INVARIANT_NOT_FOUND", `No invariants directory`);
  }
  for (const entry of readdirSync(dir, { withFileTypes: true, encoding: "utf8" })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const parsed = parseFrontmatter(readFileSync(join(dir, entry.name), "utf8"));
    const fm = InvariantFrontmatter.safeParse(parsed.frontmatter);
    if (!fm.success) continue;
    if (fm.data.id !== input.id) continue;
    return {
      id: fm.data.id,
      title: fm.data.title,
      status: fm.data.status ?? "active",
      ...(fm.data.source_run !== undefined ? { source_run: fm.data.source_run } : {}),
      ...(fm.data.source_decision !== undefined
        ? { source_decision: fm.data.source_decision }
        : {}),
      ...(fm.data.introduced_for_bug !== undefined
        ? { introduced_for_bug: fm.data.introduced_for_bug }
        : {}),
      ...(fm.data.sensor !== undefined ? { sensor: fm.data.sensor } : {}),
      ...(fm.data.e2e !== undefined ? { e2e: fm.data.e2e } : {}),
      ...(fm.data.naming_convention !== undefined
        ? { naming_convention: fm.data.naming_convention }
        : {}),
      ...(fm.data.superseded_by !== undefined ? { superseded_by: fm.data.superseded_by } : {}),
      body_markdown: parsed.body,
    };
  }
  return mcpError("INVARIANT_NOT_FOUND", `No invariant with id ${input.id}`);
}

export const invariantGetTool: ToolDef<Input> = {
  name: "harness_invariant_get",
  description: "Returns §V invariant body + linked sensor + linked e2e by id.",
  inputSchema: invariantGetInput,
  handler,
};
