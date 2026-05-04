import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import type { McpContext } from "../context.js";
import { dropTaskInput } from "../schemas.js";
import type { ToolDef } from "./types.js";

interface Input {
  title: string;
  body: string;
  intent: "run_pilot" | "review_module" | "fix_issue" | "eval" | "staleness_scan" | "unknown";
  target_path_globs?: string[];
  priority?: number;
  parent_task_id?: string;
  source?: string;
}

async function handler(ctx: McpContext, input: Input): Promise<unknown> {
  const today = new Date().toISOString().slice(0, 10);
  const slug = input.title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  // ms-suffix gives uniqueness when the same agent files multiple tasks per second.
  const id = `TSK-${today}-${slug || "task"}-${Date.now() % 100000}`;
  const dir = join(ctx.repoRoot, ".harness", "tasks", "active", id);
  mkdirSync(dir, { recursive: true });

  const frontmatter = {
    id,
    type: "spec",
    status: "tightening",
    audience: "dual",
    generated: new Date().toISOString(),
    source: input.source ?? "agent_spawned",
    intent: input.intent,
    priority: input.priority ?? 5,
    ...(input.parent_task_id !== undefined ? { parent_task_id: input.parent_task_id } : {}),
    ...(input.target_path_globs !== undefined ? { target_path_globs: input.target_path_globs } : {}),
    trust_class: "code",
  };

  const spec = `---\n${stringifyYaml(frontmatter)}---\n\n# ${input.title}\n\n${input.body}\n`;
  writeFileSync(join(dir, "spec.md"), spec, "utf8");

  const status = {
    phase: "tightening",
    attempts: 0,
    last_event_at: new Date().toISOString(),
    queued_position: null,
    related_run_ids: [],
  };
  writeFileSync(join(dir, "status.yaml"), stringifyYaml(status), "utf8");

  return { ok: true, id, path: `.harness/tasks/active/${id}/spec.md` };
}

export const dropTaskTool: ToolDef<Input> = {
  name: "harness_drop_task",
  description:
    "Create a new active task — writes spec.md + status.yaml under .harness/tasks/active/<id>/. Used by spec-planner subagent. Operator-issued tasks come via the frontend adapter, not this tool.",
  inputSchema: dropTaskInput,
  handler,
};
