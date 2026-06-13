import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { McpContext } from "../context.js";
import {
  decisionsDir,
  invariantsDir,
  matchAnyGlob,
  parseFrontmatter,
} from "@isaacriehm/cairn-state";
import {
  DecisionFrontmatter,
  InvariantFrontmatter,
  readScopeIndex,
} from "@isaacriehm/cairn-state";
import { inScopeInput } from "../schemas.js";
import type { ToolDef } from "./types.js";

interface Input {
  path_globs: string[];
  types?: ("decision" | "invariant")[];
  status?: string[];
}

interface Summary {
  id: string;
  kind: "decision" | "invariant";
  title: string;
  status: string;
  scope_globs?: string[];
  source_decision?: string | null;
  decided_at?: string;
}

async function handler(ctx: McpContext, input: Input): Promise<unknown> {
  const types = new Set(input.types ?? ["decision", "invariant"]);
  const path_globs = input.path_globs;
  const statusFilter = input.status ? new Set(input.status) : null;

  const scopeIndex = readScopeIndex(ctx.repoRoot);
  const decIndexHits = new Set<string>();
  const invIndexHits = new Set<string>();

  if (scopeIndex !== null) {
    for (const [filePath, entry] of Object.entries(scopeIndex.files)) {
      if (entry.unscoped === true) continue;
      const matches = path_globs.some((g) => matchAnyGlob(g, [filePath]));
      if (!matches) continue;
      for (const id of entry.decisions) decIndexHits.add(id);
      for (const id of entry.invariants) invIndexHits.add(id);
    }
  }

  const out: Summary[] = [];

  // Decisions
  if (types.has("decision")) {
    const dir = decisionsDir(ctx.repoRoot);
    if (existsSync(dir)) {
      const wantStatus = statusFilter ?? new Set(["accepted"]);
      for (const entry of readdirSync(dir, {
        withFileTypes: true,
        encoding: "utf8",
      })) {
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
                path_globs.some(
                  (req) =>
                    matchAnyGlob(scopeGlob, [req]) ||
                    matchAnyGlob(req, [scopeGlob]),
                ),
              );
        const indexHit = decIndexHits.has(fm.data.id);
        if (!overlap && !indexHit) continue;

        out.push({
          id: fm.data.id,
          kind: "decision",
          title: fm.data.title,
          status: fm.data.status,
          ...(fm.data.scope_globs ? { scope_globs: fm.data.scope_globs } : {}),
          ...(fm.data.decided_at ? { decided_at: fm.data.decided_at } : {}),
        });
      }
    }
  }

  // Invariants
  if (types.has("invariant")) {
    const iDir = invariantsDir(ctx.repoRoot);
    const dDir = decisionsDir(ctx.repoRoot);
    if (existsSync(iDir)) {
      const wantStatus = statusFilter ?? new Set(["active"]);
      const decisionScopeById = new Map<string, string[]>();
      if (existsSync(dDir)) {
        for (const entry of readdirSync(dDir, {
          withFileTypes: true,
          encoding: "utf8",
        })) {
          if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
          const parsed = parseFrontmatter(
            readFileSync(join(dDir, entry.name), "utf8"),
          );
          const fm = DecisionFrontmatter.safeParse(parsed.frontmatter);
          if (!fm.success) continue;
          decisionScopeById.set(fm.data.id, fm.data.scope_globs ?? []);
        }
      }

      for (const entry of readdirSync(iDir, {
        withFileTypes: true,
        encoding: "utf8",
      })) {
        if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
        const parsed = parseFrontmatter(
          readFileSync(join(iDir, entry.name), "utf8"),
        );
        const fm = InvariantFrontmatter.safeParse(parsed.frontmatter);
        if (!fm.success) continue;
        const status = fm.data.status ?? "active";
        if (!wantStatus.has(status)) continue;

        const sourceDecision = fm.data.source_decision ?? null;
        const scope = sourceDecision
          ? decisionScopeById.get(sourceDecision) ?? []
          : [];
        const overlap = scope.some((scopeGlob) =>
          path_globs.some(
            (req) =>
              matchAnyGlob(scopeGlob, [req]) || matchAnyGlob(req, [scopeGlob]),
          ),
        );
        const indexHit = invIndexHits.has(fm.data.id);
        // A Layer-A capture has no parent decision and isn't in the
        // init-built scope-index, so neither `overlap` nor `indexHit` fires
        // for it. Match its own `source_file` against the requested globs so
        // a captured invariant is discoverable by the file it documents.
        const sourceFile =
          typeof fm.data.source_file === "string" ? fm.data.source_file : "";
        const sourceFileHit =
          sourceFile.length > 0 && matchAnyGlob(sourceFile, path_globs);
        if (!overlap && !indexHit && !sourceFileHit) continue;

        out.push({
          id: fm.data.id,
          kind: "invariant",
          title: fm.data.title,
          status,
          source_decision: sourceDecision,
        });
      }
    }
  }

  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

export const inScopeTool: ToolDef<Input> = {
  name: "cairn_in_scope",
  description:
    "List decisions AND/OR invariants whose scope overlaps the given path_globs. Returns summaries with ID, title, and status. Use `types: ['decision']` or `types: ['invariant']` to filter; omit `types` for both. Replaces the legacy `cairn_decisions_in_scope` and `cairn_invariants_in_scope` tools — those names no longer exist; pass `types` to this tool instead.",
  inputSchema: inScopeInput,
  handler,
};
