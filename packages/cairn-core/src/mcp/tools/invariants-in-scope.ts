import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { McpContext } from "../context.js";
import { decisionsDir, invariantsDir, matchAnyGlob, parseFrontmatter } from "../../ground/index.js";
import { DecisionFrontmatter, InvariantFrontmatter, readScopeIndex } from "../../ground/index.js";
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
 * Two-source scope resolution. An invariant is "in scope for path_globs X" if
 * EITHER:
 *   1. Its `source_decision` carries scope_globs that overlap X, OR
 *   2. The scope-index lists the invariant under any file matching X.
 *
 * The scope-index path is the canonical map for source-comment-extracted
 * invariants (Phase 7b sets `source_decision: null` and seeds scope-index
 * via the strip-replace post-population pass). Without it, init-time INVs
 * would never surface here even when the source file carries the cite.
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

  const scopeIndexHits = new Set<string>();
  const scopeIndex = readScopeIndex(ctx.repoRoot);
  if (scopeIndex !== null) {
    for (const [filePath, entry] of Object.entries(scopeIndex.files)) {
      if (entry.unscoped === true) continue;
      const matches = input.path_globs.some((g) => matchAnyGlob(g, [filePath]));
      if (!matches) continue;
      for (const id of entry.invariants) scopeIndexHits.add(id);
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
    const decisionOverlap = scope.some((scopeGlob) =>
      input.path_globs.some(
        (req) => matchAnyGlob(scopeGlob, [req]) || matchAnyGlob(req, [scopeGlob]),
      ),
    );
    const scopeIndexHit = scopeIndexHits.has(fm.data.id);
    if (!decisionOverlap && !scopeIndexHit) continue;
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
  name: "cairn_invariants_in_scope",
  description:
    "List active invariants whose source_decision scope overlaps the given path_globs.",
  inputSchema: invariantsInScopeInput,
  handler,
};
