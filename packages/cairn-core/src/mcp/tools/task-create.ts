import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import type { McpContext } from "../context.js";
import { requireBootstrap } from "../bootstrap-guard.js";
import { mcpError } from "../errors.js";
import { taskCreateInput } from "../schemas.js";
import type { ToolDef } from "./types.js";

interface Input {
  slug: string;
  title: string;
  goal: string;
  target_path_globs: string[];
  in_scope_decisions?: string[];
  in_scope_invariants?: string[];
  constraints?: string[];
  out_of_scope?: string[];
  acceptance?: string[];
  module?: string;
}

/**
 * Generate a `task_id` matching the regex
 * `^TSK-\d{4}-\d{2}-\d{2}-[a-z0-9-]+-\d{5}$`. The 5-digit millisecond
 * suffix collides only on same-millisecond invocations within the
 * same slug — which never happens in practice and would be caught by
 * the directory-already-exists check anyway.
 */
function generateTaskId(slug: string): string {
  const now = new Date();
  const yyyy = String(now.getUTCFullYear());
  const mm = String(now.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(now.getUTCDate()).padStart(2, "0");
  const ms = String(now.getTime()).slice(-5).padStart(5, "0");
  return `TSK-${yyyy}-${mm}-${dd}-${slug}-${ms}`;
}

function renderInvariantId(id: string): string {
  return id.startsWith("§") ? id : `§${id}`;
}

function renderBulletList(items: string[] | undefined, fallback: string): string {
  if (items === undefined || items.length === 0) return `- ${fallback}\n`;
  return items.map((item) => `- ${item}`).join("\n") + "\n";
}

async function handler(ctx: McpContext, input: Input): Promise<unknown> {
  const block = requireBootstrap(ctx.repoRoot);
  if (block !== null) return block;

  const taskId = generateTaskId(input.slug);
  const taskDir = join(ctx.repoRoot, ".cairn", "tasks", "active", taskId);
  if (existsSync(taskDir)) {
    return mcpError(
      "TASK_DIR_EXISTS",
      `${taskDir} already exists — collision on millisecond suffix; retry`,
    );
  }

  mkdirSync(taskDir, { recursive: true });

  const generatedAt = new Date().toISOString();

  const specFrontmatter = {
    id: taskId,
    title: input.title,
    type: "spec",
    status: "ready",
    audience: "dual",
    generated: generatedAt,
    target_path_globs: input.target_path_globs,
    in_scope_decisions: input.in_scope_decisions ?? [],
    in_scope_invariants: input.in_scope_invariants ?? [],
  };

  const specBody = [
    `# ${input.title}`,
    "",
    "## Goal",
    "",
    input.goal,
    "",
    "## Constraints",
    "",
    renderBulletList(input.constraints, "(no in-scope decisions or invariants applied)"),
    "## Out of scope",
    "",
    renderBulletList(input.out_of_scope, "(none)"),
    "## Acceptance",
    "",
    renderBulletList(input.acceptance, "(implementation passes the operator's spot check)"),
  ].join("\n");

  const specContent = `---\n${stringifyYaml(specFrontmatter)}---\n\n${specBody}`;
  const specPath = join(taskDir, "spec.tightened.md");
  writeFileSync(specPath, specContent, "utf8");

  const statusContent = stringifyYaml({
    id: taskId,
    phase: "running",
    module: input.module ?? input.target_path_globs[0]?.split("/")[0] ?? ".",
    title: input.title,
    started_at: generatedAt,
  });
  const statusPath = join(taskDir, "status.yaml");
  writeFileSync(statusPath, statusContent, "utf8");

  return {
    ok: true,
    task_id: taskId,
    spec_path: `.cairn/tasks/active/${taskId}/spec.tightened.md`,
    status_path: `.cairn/tasks/active/${taskId}/status.yaml`,
    in_scope_decisions: input.in_scope_decisions ?? [],
    in_scope_invariants: (input.in_scope_invariants ?? []).map(renderInvariantId),
  };
}

export const taskCreateTool: ToolDef<Input> = {
  name: "cairn_task_create",
  description:
    "Allocate a task_id and atomically write spec.tightened.md + status.yaml under .cairn/tasks/active/<task_id>/. The server controls task_id format (TSK-YYYY-MM-DD-<slug>-<5-digit-ms>) — callers cannot misformat it. Required by the cairn-direction skill before any source mutation.",
  inputSchema: taskCreateInput,
  handler,
};
