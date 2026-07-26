import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import type { McpContext } from "../context.js";
import { cairnDir,
  decisionsDir,
  invariantsDir,
  manifestPath,
  matchAnyGlob,
  parseFrontmatter,
} from "@isaacriehm/cairn-state";
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
 * Substring search over decisions, invariants, tasks/active, and the
 * canonical-zone manifest entries.
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
    const tasksDir = cairnDir(ctx.repoRoot, "tasks", "active");
    if (existsSync(tasksDir)) {
      for (const e of readdirSync(tasksDir, { withFileTypes: true, encoding: "utf8" })) {
        if (!e.isDirectory()) continue;
        const spec = join(tasksDir, e.name, "spec.tightened.md");
        const fallback = join(tasksDir, e.name, "spec.md");
        const target = existsSync(spec) ? spec : existsSync(fallback) ? fallback : null;
        if (!target) continue;
        const raw = readFileSync(target, "utf8");
        const parsed = parseFrontmatter(raw);
        const fm = parsed.frontmatter;
        const id = typeof fm?.id === "string" ? fm.id : null;
        if (id === null) continue;
        const titleLine = parsed.body.match(/^#\s+(.+)$/m)?.[1] ?? id;
        const titleHit = titleLine.toLowerCase().includes(q);
        const bodyHit = parsed.body.toLowerCase().includes(q);
        if (!titleHit && !bodyHit) continue;
        out.push({
          id,
          kind: "task",
          title: titleLine,
          path: relative(ctx.repoRoot, target).replace(/\\/g, "/"),
          score: Math.min(1, 0.5 + (titleHit ? 0.25 : 0) + (bodyHit ? 0.25 : 0)),
        });
      }
    }
  }

  if (wantKinds.has("run")) {
    for (const zone of ["active", "terminal"] as const) {
      const runsDir = cairnDir(ctx.repoRoot, "runs", zone);
      if (!existsSync(runsDir)) continue;
      for (const e of readdirSync(runsDir, { withFileTypes: true, encoding: "utf8" })) {
        if (!e.isDirectory()) continue;
        const runDir = join(runsDir, e.name);
        const runId = e.name;
        let title = runId;
        const parts: string[] = [runId];
        const metaPath = join(runDir, "meta.json");
        if (existsSync(metaPath)) {
          try {
            const meta = JSON.parse(readFileSync(metaPath, "utf8")) as {
              run_id?: string;
              task_id?: string;
            };
            if (typeof meta.run_id === "string") title = meta.run_id;
            if (typeof meta.task_id === "string") parts.push(meta.task_id);
          } catch {
            // unreadable meta; search run id only
          }
        }
        for (const name of ["mcp-calls.jsonl", "sensor-results.yaml"] as const) {
          const artifact = join(runDir, name);
          if (existsSync(artifact)) {
            try {
              parts.push(readFileSync(artifact, "utf8"));
            } catch {
              // skip unreadable artifact
            }
          }
        }
        const blob = parts.join("\n").toLowerCase();
        if (!blob.includes(q)) continue;
        const titleHit = title.toLowerCase().includes(q) || runId.toLowerCase().includes(q);
        const bodyHit = !titleHit;
        out.push({
          id: runId,
          kind: "run",
          title,
          path: relative(ctx.repoRoot, runDir).replace(/\\/g, "/"),
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
  name: "cairn_search",
  description:
    "Substring search over decisions, invariants, tasks, docs, and manifest. Returns compact records (~50 tokens each) sorted by score.",
  inputSchema: searchInput,
  handler,
};
