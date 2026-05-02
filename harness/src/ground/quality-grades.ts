import { type Dirent, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { logger } from "../logger.js";
import { qualityGradesPath, runsTerminalDir } from "./paths.js";
import { type QualityGrade, type QualityGrades } from "./schemas.js";

const log = logger("ground.quality-grades");

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
  const moduleAccum = new Map<string, { passes: number; total: number; drifts: number; latest: string }>();

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
      };
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
      recent_run_count: acc.total === 0 ? 0 : Math.ceil(acc.total / 10), // rough run count proxy
    });
  }
  modules.sort((a, b) => a.score - b.score); // weakest first
  return { version: 1, generated: new Date().toISOString(), modules };
}

export function writeQualityGrades(opts: QualityGradesOptions): {
  grades: QualityGrades;
  path: string;
} {
  const grades = buildQualityGrades(opts);
  const path = qualityGradesPath(opts.repoRoot);
  mkdirSync(resolve(path, ".."), { recursive: true });
  writeFileSync(path, stringifyYaml(grades), "utf8");
  log.debug({ path, modules: grades.modules.length }, "wrote quality grades");
  return { grades, path };
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
