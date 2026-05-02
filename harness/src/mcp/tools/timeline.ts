import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { McpContext } from "../context.js";
import { runsTerminalDir } from "../../ground/index.js";
import { timelineInput } from "../schemas.js";
import type { ToolDef } from "./types.js";

interface Input {
  scope?: string[];
  since?: string;
  until?: string;
  kinds?: string[];
}

interface RunMeta {
  run_id: string;
  task_id?: string;
  agent_role?: string;
  started_at?: string;
  finished_at?: string;
  phase?: string;
  scoped_module?: string;
}

interface TimelineEvent {
  ts: string;
  kind: string;
  run_id: string;
  task_id?: string;
  detail?: string;
}

/**
 * Returns chronologically ordered run/event records intersecting the scope
 * window. Naive — reads runs/terminal/<id>/meta.json files. Phase 4 baseline;
 * heavier indexing later.
 */
async function handler(ctx: McpContext, input: Input): Promise<unknown> {
  const out: TimelineEvent[] = [];
  const since = input.since ? Date.parse(input.since) : 0;
  const until = input.until ? Date.parse(input.until) : Number.POSITIVE_INFINITY;
  const wantKinds = input.kinds ? new Set(input.kinds) : null;

  const dir = runsTerminalDir(ctx.repoRoot);
  if (existsSync(dir)) {
    for (const e of readdirSync(dir, { withFileTypes: true, encoding: "utf8" })) {
      if (!e.isDirectory()) continue;
      const meta = readJson<RunMeta>(join(dir, e.name, "meta.json"));
      if (!meta) continue;
      const ts = meta.finished_at ?? meta.started_at;
      if (!ts) continue;
      const tsMs = Date.parse(ts);
      if (Number.isNaN(tsMs) || tsMs < since || tsMs > until) continue;
      if (wantKinds && !wantKinds.has("run")) continue;
      // scope filter — naive: the run's scoped_module substring match.
      if (input.scope && input.scope.length > 0 && meta.scoped_module) {
        const hit = input.scope.some((g) => meta.scoped_module?.includes(g) ?? false);
        if (!hit) continue;
      }
      out.push({
        ts,
        kind: "run",
        run_id: meta.run_id,
        ...(meta.task_id !== undefined ? { task_id: meta.task_id } : {}),
        ...(meta.phase !== undefined ? { detail: meta.phase } : {}),
      });
    }
  }
  out.sort((a, b) => b.ts.localeCompare(a.ts));
  return out;
}

function readJson<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

export const timelineTool: ToolDef<Input> = {
  name: "harness_timeline",
  description:
    "Chronological run-event stream intersecting the scope window. Reads runs/terminal/. Useful for `what happened to <module> this week` without reading file bodies.",
  inputSchema: timelineInput,
  handler,
};
