import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { McpContext } from "../context.js";
import { decisionsDir, invariantsDir, matchAnyGlob, parseFrontmatter } from "../../ground/index.js";
import { DecisionFrontmatter, InvariantFrontmatter } from "../../ground/index.js";
import { invariantsInScopeInput } from "../schemas.js";
import type { ToolDef } from "./types.js";

interface Input {
  path_globs: string[];
  status?: ("active" | "superseded")[];
}

interface Summary {
  id: string;
  title: string;
  status: string;
  source_decision?: string | null;
}

/**
 * Invariants don't carry their own scope_globs — they inherit scope from the
 * decision that introduced them (source_decision). To answer "which invariants
 * apply to globs X?", we look up each invariant's source decision and check
 * its scope_globs against the requested globs.
 */
async function handler(ctx: McpContext, input: Input): Promise<unknown> {
  const wantStatus = new Set(input.status ?? ["active"]);
  const decisionScopeById = new Map<string, string[]>();
  const dDir = decisionsDir(ctx.repoRoot);
  if (existsSync(dDir)) {
    for (const entry of readdirSync(dDir, { withFileTypes: true, encoding: "utf8" })) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      const parsed = parseFrontmatter(readFileSync(join(dDir, entry.name), "utf8"));
      const fm = DecisionFrontmatter.safeParse(parsed.frontmatter);
      if (!fm.success) continue;
      decisionScopeById.set(fm.data.id, fm.data.scope_globs ?? []);
    }
  }

  const iDir = invariantsDir(ctx.repoRoot);
  if (!existsSync(iDir)) return [];
  const out: Summary[] = [];
  for (const entry of readdirSync(iDir, { withFileTypes: true, encoding: "utf8" })) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    const parsed = parseFrontmatter(readFileSync(join(iDir, entry.name), "utf8"));
    const fm = InvariantFrontmatter.safeParse(parsed.frontmatter);
    if (!fm.success) continue;
    const status = fm.data.status ?? "active";
    if (!wantStatus.has(status)) continue;
    const sourceDecision = fm.data.source_decision ?? null;
    const scope = sourceDecision ? decisionScopeById.get(sourceDecision) ?? [] : [];
    const overlap = scope.some((scopeGlob) =>
      input.path_globs.some(
        (req) => matchAnyGlob(scopeGlob, [req]) || matchAnyGlob(req, [scopeGlob]),
      ),
    );
    if (!overlap) continue;
    out.push({
      id: fm.data.id,
      title: fm.data.title,
      status,
      source_decision: sourceDecision,
    });
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

export const invariantsInScopeTool: ToolDef<Input> = {
  name: "harness_invariants_in_scope",
  description:
    "List active invariants whose source_decision scope overlaps the given path_globs.",
  inputSchema: invariantsInScopeInput,
  handler,
};
