import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { McpContext } from "../context.js";
import { decisionsDir, invariantsDir } from "../../ground/index.js";
import { mcpError } from "../errors.js";
import { getFullInput } from "../schemas.js";
import type { ToolDef } from "./types.js";

interface Input {
  id: string;
  kind: "decision" | "invariant" | "task" | "run";
}

async function handler(ctx: McpContext, input: Input): Promise<unknown> {
  switch (input.kind) {
    case "decision": {
      const path = join(decisionsDir(ctx.repoRoot), `${input.id}.md`);
      if (!existsSync(path)) {
        return mcpError("DECISION_NOT_FOUND", `No decision file at ${path}`);
      }
      return { id: input.id, kind: input.kind, content: readFileSync(path, "utf8") };
    }
    case "invariant": {
      const path = join(invariantsDir(ctx.repoRoot), `${input.id}.md`);
      if (!existsSync(path)) {
        return mcpError("INVARIANT_NOT_FOUND", `No invariant file at ${path}`);
      }
      return { id: input.id, kind: input.kind, content: readFileSync(path, "utf8") };
    }
    case "task": {
      const path = join(ctx.repoRoot, ".harness", "tasks", "active", input.id, "spec.tightened.md");
      const fallback = join(ctx.repoRoot, ".harness", "tasks", "active", input.id, "spec.md");
      const target = existsSync(path) ? path : existsSync(fallback) ? fallback : null;
      if (!target) {
        return mcpError("TASK_NOT_FOUND", `No active task ${input.id}`);
      }
      return { id: input.id, kind: input.kind, content: readFileSync(target, "utf8") };
    }
    case "run": {
      const meta = join(ctx.repoRoot, ".harness", "runs", "active", input.id, "meta.json");
      if (!existsSync(meta)) {
        return mcpError("RUN_NOT_FOUND", `No active run ${input.id}`);
      }
      return { id: input.id, kind: input.kind, content: readFileSync(meta, "utf8") };
    }
  }
}

export const getFullTool: ToolDef<Input> = {
  name: "harness_get_full",
  description:
    "Fetch full content of an artifact by id + kind (decision | invariant | task | run). Used after harness_search/timeline narrows candidates.",
  inputSchema: getFullInput,
  handler,
};
