import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { McpContext } from "../context.js";
import {
  decisionsDir,
  invariantsDir,
  manifestPath,
  matchAnyGlob,
  parseFrontmatter,
} from "../../ground/index.js";
import { searchInput } from "../schemas.js";
import type { ToolDef } from "./types.js";

interface Input {
  query: string;
  scope?: string[];
  kinds?: ("decision" | "invariant" | "task" | "run" | "doc" | "manifest")[];
  limit?: number;
}

interface ResultRecord {
  id: string;
  kind: string;
  title: string;
  path?: string;
  score: number;
}

/**
 * Naive substring index over decisions, invariants, tasks/active, and the
 * canonical-zone manifest entries. Phase 4 baseline; can be uplifted to FTS
 * (e.g., MiniSearch / Lunr) without changing the tool surface.
 *
 * Score: 0.5 base + 0.25 if title hit + 0.25 if body hit. Caps at 1.0.
 */
async function handler(ctx: McpContext, input: Input): Promise<unknown> {
  const limit = Math.min(input.limit ?? 20, 50);
  const wantKinds = new Set(input.kinds ?? ["decision", "invariant", "task", "doc"]);
  const q = input.query.toLowerCase();
  const out: ResultRecord[] = [];

  if (wantKinds.has("decision")) {
    const dir = decisionsDir(ctx.repoRoot);
    if (existsSync(dir)) {
      for (const e of readdirSync(dir, { withFileTypes: true, encoding: "utf8" })) {
        if (!e.isFile() || !e.name.endsWith(".md")) continue;
        const path = join(dir, e.name);
        const raw = readFileSync(path, "utf8");
        const parsed = parseFrontmatter(raw);
        const fm = parsed.frontmatter as { id?: string; title?: string } | null;
        if (!fm?.id || !fm.title) continue;
        const titleHit = fm.title.toLowerCase().includes(q);
        const bodyHit = parsed.body.toLowerCase().includes(q);
        if (!titleHit && !bodyHit) continue;
        out.push({
          id: fm.id,
          kind: "decision",
          title: fm.title,
          path: relative(ctx.repoRoot, path).replace(/\\/g, "/"),
          score: Math.min(1, 0.5 + (titleHit ? 0.25 : 0) + (bodyHit ? 0.25 : 0)),
        });
      }
    }
  }

  if (wantKinds.has("invariant")) {
    const dir = invariantsDir(ctx.repoRoot);
    if (existsSync(dir)) {
      for (const e of readdirSync(dir, { withFileTypes: true, encoding: "utf8" })) {
        if (!e.isFile() || !e.name.endsWith(".md")) continue;
        const path = join(dir, e.name);
        const raw = readFileSync(path, "utf8");
        const parsed = parseFrontmatter(raw);
        const fm = parsed.frontmatter as { id?: string; title?: string } | null;
        if (!fm?.id || !fm.title) continue;
        const titleHit = fm.title.toLowerCase().includes(q);
        const bodyHit = parsed.body.toLowerCase().includes(q);
        if (!titleHit && !bodyHit) continue;
        out.push({
          id: fm.id,
          kind: "invariant",
          title: fm.title,
          path: relative(ctx.repoRoot, path).replace(/\\/g, "/"),
          score: Math.min(1, 0.5 + (titleHit ? 0.25 : 0) + (bodyHit ? 0.25 : 0)),
        });
      }
    }
  }

  if (wantKinds.has("task")) {
    const tasksDir = join(ctx.repoRoot, ".harness", "tasks", "active");
    if (existsSync(tasksDir)) {
      for (const e of readdirSync(tasksDir, { withFileTypes: true, encoding: "utf8" })) {
        if (!e.isDirectory()) continue;
        const spec = join(tasksDir, e.name, "spec.tightened.md");
        const fallback = join(tasksDir, e.name, "spec.md");
        const target = existsSync(spec) ? spec : existsSync(fallback) ? fallback : null;
        if (!target) continue;
        const raw = readFileSync(target, "utf8");
        const parsed = parseFrontmatter(raw);
        const fm = parsed.frontmatter as { id?: string } | null;
        if (!fm?.id) continue;
        const titleLine = parsed.body.match(/^#\s+(.+)$/m)?.[1] ?? fm.id;
        const titleHit = titleLine.toLowerCase().includes(q);
        const bodyHit = parsed.body.toLowerCase().includes(q);
        if (!titleHit && !bodyHit) continue;
        out.push({
          id: fm.id,
          kind: "task",
          title: titleLine,
          path: relative(ctx.repoRoot, target).replace(/\\/g, "/"),
          score: Math.min(1, 0.5 + (titleHit ? 0.25 : 0) + (bodyHit ? 0.25 : 0)),
        });
      }
    }
  }

  if (wantKinds.has("doc")) {
    const docsRoot = join(ctx.repoRoot, "docs");
    if (existsSync(docsRoot)) walkDocs(docsRoot, ctx.repoRoot, q, out);
  }

  if (wantKinds.has("manifest")) {
    const path = manifestPath(ctx.repoRoot);
    if (existsSync(path)) {
      const text = readFileSync(path, "utf8");
      if (text.toLowerCase().includes(q)) {
        out.push({
          id: "manifest",
          kind: "manifest",
          title: "ground/manifest.yaml",
          path: relative(ctx.repoRoot, path).replace(/\\/g, "/"),
          score: 0.5,
        });
      }
    }
  }

  let filtered = out;
  if (input.scope && input.scope.length > 0) {
    filtered = out.filter((r) =>
      r.path !== undefined ? matchAnyGlob(r.path, input.scope ?? []) : false,
    );
  }
  filtered.sort((a, b) => b.score - a.score);
  return filtered.slice(0, limit);
}

function walkDocs(dir: string, repoRoot: string, q: string, out: ResultRecord[]): void {
  for (const e of readdirSync(dir, { withFileTypes: true, encoding: "utf8" })) {
    const abs = join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === "_research") continue;
      walkDocs(abs, repoRoot, q, out);
    } else if (e.isFile() && e.name.endsWith(".md")) {
      try {
        const raw = readFileSync(abs, "utf8");
        const parsed = parseFrontmatter(raw);
        const titleLine = parsed.body.match(/^#\s+(.+)$/m)?.[1] ?? e.name;
        const titleHit = titleLine.toLowerCase().includes(q);
        const bodyHit = parsed.body.toLowerCase().includes(q);
        if (!titleHit && !bodyHit) continue;
        out.push({
          id: relative(repoRoot, abs).replace(/\\/g, "/"),
          kind: "doc",
          title: titleLine,
          path: relative(repoRoot, abs).replace(/\\/g, "/"),
          score: Math.min(1, 0.5 + (titleHit ? 0.25 : 0) + (bodyHit ? 0.25 : 0)),
        });
      } catch {
        // unreadable; skip
      }
    }
  }
}

export const searchTool: ToolDef<Input> = {
  name: "harness_search",
  description:
    "Naive substring search over decisions, invariants, tasks, docs, and manifest. Returns compact records (~50 tokens each) sorted by score. Phase 4 baseline; FTS uplift later.",
  inputSchema: searchInput,
  handler,
};
