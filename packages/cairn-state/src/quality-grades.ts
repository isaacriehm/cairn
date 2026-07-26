import { type Dirent, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { runsTerminalDir } from "./paths.js";
import { type QualityGrade, type QualityGrades } from "./schemas.js";

interface SensorResult {
  sensor: string;
  status: "pass" | "fail" | "skip";
}

interface RunMeta {
  task_id?: string;
  agent_role?: string;
  scoped_module?: string;
  finished_at?: string;
}

export interface QualityGradesOptions {
  repoRoot: string;
  /** Number of most recent terminal runs to consider (default 50). */
  recentRunCount?: number;
}

export function buildQualityGrades(opts: QualityGradesOptions): QualityGrades {
  const dir = runsTerminalDir(opts.repoRoot);
  const limit = opts.recentRunCount ?? 50;
  const moduleAccum = new Map<string, { passes: number; total: number; drifts: number; latest: string; runs: number }>();

  if (existsSync(dir)) {
    const runIds = listRecentRuns(dir, limit);
    for (const runId of runIds) {
      const meta = readJsonIfExists<RunMeta>(join(dir, runId, "meta.json"));
      const sensors = readYamlIfExists<SensorResult[]>(join(dir, runId, "sensor-results.yaml"));
      const moduleKey = meta?.scoped_module ?? "unscoped";
      const acc = moduleAccum.get(moduleKey) ?? {
        passes: 0,
        total: 0,
        drifts: 0,
        latest: "",
        runs: 0,
      };
      acc.runs += 1;
      if (sensors) {
        for (const s of sensors) {
          if (s.status === "skip") continue;
          acc.total += 1;
          if (s.status === "pass") acc.passes += 1;
        }
      }
      if (meta?.finished_at && (!acc.latest || meta.finished_at > acc.latest)) {
        acc.latest = meta.finished_at;
      }
      moduleAccum.set(moduleKey, acc);
    }
  }

  const modules: QualityGrade[] = [];
  for (const [module, acc] of moduleAccum) {
    const passRate = acc.total === 0 ? 1 : acc.passes / acc.total;
    const score = Math.round(passRate * 100);
    modules.push({
      module,
      score,
      pass_rate: Number(passRate.toFixed(3)),
      drift_count: acc.drifts,
      last_updated: acc.latest || new Date().toISOString(),
      recent_run_count: acc.runs,
    });
  }
  modules.sort((a, b) => a.score - b.score); // weakest first
  return { version: 1, generated: new Date().toISOString(), modules };
}

function listRecentRuns(dir: string, limit: number): string[] {
  let dirents: Dirent[];
  try {
    dirents = readdirSync(dir, { withFileTypes: true, encoding: "utf8" });
  } catch {
    return [];
  }
  const dirs = dirents.filter((d) => d.isDirectory()).map((d) => d.name);
  dirs.sort((a, b) => {
    const sa = statSync(join(dir, a)).mtimeMs;
    const sb = statSync(join(dir, b)).mtimeMs;
    return sb - sa;
  });
  return dirs.slice(0, limit);
}

function readJsonIfExists<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}

function readYamlIfExists<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  try {
    return parseYaml(readFileSync(path, "utf8")) as T;
  } catch {
    return null;
  }
}
