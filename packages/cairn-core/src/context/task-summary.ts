/**
 * Active-task summary reader for the per-session statusline + Section-0
 * resume payload. Walks `.cairn/tasks/active/` and returns the first
 * task whose `status.yaml` is in flight.
 *
 * Phase mapping aligns `status.yaml`'s vocabulary with the StatusJson
 * `task_state` enum. Terminal phases (succeeded/failed/aborted) and
 * unrecognized values collapse to `idle` so the surface stays quiet
 * when nothing is actually in flight.
 */

import { type Dirent, existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { cairnDir, parseFrontmatter } from "@isaacriehm/cairn-state";
import type { TaskState } from "../status-line/index.js";

import { z } from "zod";

const StatusFileSchema = z.object({
  phase: z.string().optional(),
}).passthrough();

export interface ActiveTaskSummary {
  taskId: string;
  taskState: TaskState;
  /** Title pulled from spec.tightened.md `# Heading`; falls back to taskId. */
  taskModule: string;
}

const ACTIVE_PHASES: ReadonlySet<string> = new Set([
  "queued",
  "tightening",
  "running",
  "sensor_check",
  "reviewing",
  "backprop",
]);

function mapPhase(phase: string): TaskState {
  switch (phase) {
    case "queued":
    case "tightening":
    case "running":
    case "reviewing":
    case "backprop":
      return phase;
    case "sensor_check":
      return "sensing";
    default:
      return "idle";
  }
}

export function readActiveTaskSummary(repoRoot: string): ActiveTaskSummary | null {
  const activeDir = cairnDir(repoRoot, "tasks", "active");
  if (!existsSync(activeDir)) return null;

  let dirents: Dirent[];
  try {
    dirents = readdirSync(activeDir, { withFileTypes: true, encoding: "utf8" });
  } catch {
    return null;
  }

  for (const e of dirents) {
    if (!e.isDirectory()) continue;
    const taskDir = join(activeDir, e.name);
    const statusPath = join(taskDir, "status.yaml");
    if (!existsSync(statusPath)) continue;

    let parsed: unknown;
    try {
      parsed = parseYaml(readFileSync(statusPath, "utf8"));
    } catch {
      continue;
    }
    if (typeof parsed !== "object" || parsed === null) continue;
    const phase = (parsed as { phase?: unknown }).phase;
    if (typeof phase !== "string" || !ACTIVE_PHASES.has(phase)) continue;

    let title = e.name;
    const specPath = join(taskDir, "spec.tightened.md");
    if (existsSync(specPath)) {
      try {
        const specText = readFileSync(specPath, "utf8");
        const body = parseFrontmatter(specText).body;
        const m = body.match(/^#\s+(.+)$/m);
        if (m && m[1]) title = m[1].trim();
      } catch {
        // fall through to taskId
      }
    }

    return {
      taskId: e.name,
      taskState: mapPhase(phase),
      taskModule: title,
    };
  }

  return null;
}
