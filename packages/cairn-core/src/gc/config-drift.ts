/**
 * GC pass — config-drift.
 *
 * Surfaces drift between the project's DECLARED config (`.cairn/config.yaml`:
 * `off_limits` + `components.workspaces[].componentDirs` / `extensions`) and
 * the current source tree — the gap `scope-coverage` (file-vs-DEC/INV) does
 * NOT cover. Deterministic, no LLM. Surface-only: every finding is a nudge the
 * operator (or a future `cairn resync`) acts on; this pass never mutates
 * committed config (locked rule — sensors surface, never auto-apply).
 *
 * Finding kinds (high-precision subset; tight thresholds per the noise budget):
 *   - `config_orphan_path`    (Q20) — a declared componentDir that no longer
 *                                     exists in the tree.
 *   - `config_gitignore_drift`(Q14) — a repo `.gitignore` entry not covered by
 *                                     `off_limits`, so the walk + capture still
 *                                     descend into a now-ignored area.
 *   - `config_uncovered_dir`  (Q4)  — a dir of >= MIN component-typed files
 *                                     sitting outside every declared
 *                                     componentDir (a grown, unscoped area).
 *   - `config_uncovered_ext`  (Q5)  — a UI/code file type present under a
 *                                     componentDir but absent from its
 *                                     configured `extensions` (silently
 *                                     unindexed).
 *
 * Deferred (no clean deterministic data source in the current adoption schema):
 *   - `config_unmapped_domain` (Q6) — naming a "new domain" is an LLM / resync
 *     call, not a deterministic sensor signal; flagging raw subdirs is noise.
 *   - `workflow_command_missing` (Q24) — `workflow.md` carries `off_limits` +
 *     trust posture only; there is no build/test/lint command set to diff.
 *   - `sensor_coverage_gap` (Q25) — `sensors.yaml` ships a generic,
 *     non-language-keyed set; no per-language "active sensor" map to compare.
 *
 * Runs in the 24h GC sweep (never SessionStart). Findings cap at 50/kind and
 * dedup per path. When the sweep is autotriggered, `writeConfigDriftBaseline`
 * persists them to `.cairn/baseline/config-drift-<ISO>.yaml`, which the
 * cairn-attention surface reads as `baseline_finding` items (one "your project
 * grew" group, Q21) and `runtime-prune` reaps like every other snapshot family.
 */

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  UI_EXTENSIONS,
  cairnDir,
  loadCairnConfig,
  loadComponentsConfig,
  matchGlob,
  writeFileSafe,
} from "@isaacriehm/cairn-state";
import { stringify as stringifyYaml } from "yaml";
import type { GcFinding } from "./types.js";
import { walkSourceTree } from "./walk-source.js";

const PASS_ID = "config-drift" as const;
const MAX_FINDINGS_PER_KIND = 50;
/** A dir needs at least this many component-typed files to read as a grown area. */
const MIN_UNCOVERED_FILES = 3;

export interface ConfigDriftOptions {
  repoRoot: string;
}

export interface ConfigDriftResult {
  findings: GcFinding[];
}

/** Lowercased extension including the leading dot, or "" when none. */
function extOf(rel: string): string {
  const slash = rel.lastIndexOf("/");
  const base = slash >= 0 ? rel.slice(slash + 1) : rel;
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot).toLowerCase() : "";
}

function normExt(e: string): string {
  const t = e.trim().toLowerCase();
  return t.startsWith(".") ? t : `.${t}`;
}

/** off_limits matcher: anchored glob OR gitignore-style dir prefix (`foo/`). */
function isOffLimits(rel: string, globs: readonly string[]): boolean {
  for (const g of globs) {
    if (g.length === 0) continue;
    if (matchGlob(rel, g)) return true;
    const dir = g.endsWith("/") ? g.slice(0, -1) : g;
    if (dir.length > 0 && !dir.includes("*") && (rel === dir || rel.startsWith(`${dir}/`))) {
      return true;
    }
  }
  return false;
}

/** True when `rel` is one of `dirs` or nested under it. */
function underAny(rel: string, dirs: readonly string[]): boolean {
  return dirs.some((d) => {
    const n = d.endsWith("/") ? d.slice(0, -1) : d;
    return n.length > 0 && (rel === n || rel.startsWith(`${n}/`));
  });
}

/** Active (non-comment, non-negation) entries of the repo-root `.gitignore`. */
function readRepoGitignore(repoRoot: string): string[] {
  const p = join(repoRoot, ".gitignore");
  if (!existsSync(p)) return [];
  try {
    return readFileSync(p, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("#") && !l.startsWith("!"));
  } catch {
    return [];
  }
}

export function runConfigDrift(opts: ConfigDriftOptions): ConfigDriftResult {
  const findings: GcFinding[] = [];
  const cfg = loadCairnConfig(opts.repoRoot);
  const offRaw = cfg["off_limits"];
  const offLimits = Array.isArray(offRaw)
    ? offRaw.filter((x): x is string => typeof x === "string")
    : [];
  const comps = loadComponentsConfig(opts.repoRoot);
  const workspaces = comps.workspaces.filter((w) => w.componentDirs.length > 0);
  const allComponentDirs = workspaces.flatMap((w) => w.componentDirs);

  // ── Q20 — a declared componentDir that no longer exists ────────────
  {
    let n = 0;
    const seen = new Set<string>();
    for (const ws of workspaces) {
      for (const dir of ws.componentDirs) {
        if (n >= MAX_FINDINGS_PER_KIND) break;
        if (seen.has(dir)) continue;
        seen.add(dir);
        if (!existsSync(join(opts.repoRoot, dir))) {
          findings.push({
            pass: PASS_ID,
            kind: "config_orphan_path",
            path: dir,
            detail: `declared componentDir \`${dir}\`${ws.name ? ` (workspace ${ws.name})` : ""} no longer exists — drop it from .cairn/config.yaml`,
            severity: "warn",
          });
          n++;
        }
      }
    }
  }

  // ── Q14 — a repo .gitignore entry not covered by off_limits ────────
  {
    let n = 0;
    const seen = new Set<string>();
    for (const entry of readRepoGitignore(opts.repoRoot)) {
      if (n >= MAX_FINDINGS_PER_KIND) break;
      if (seen.has(entry)) continue;
      seen.add(entry);
      const probe = entry.replace(/^\/+/, "").replace(/\/+$/, "");
      if (probe.length === 0) continue;
      const sample = probe.includes("*") ? probe : `${probe}/x`;
      const covered =
        offLimits.some((g) => g === entry || g === probe || g === `${probe}/`) ||
        isOffLimits(probe, offLimits) ||
        isOffLimits(sample, offLimits);
      if (!covered) {
        findings.push({
          pass: PASS_ID,
          kind: "config_gitignore_drift",
          path: entry,
          detail: `.gitignore ignores \`${entry}\` but off_limits doesn't — Cairn still walks/captures it; add it to off_limits in .cairn/config.yaml`,
          severity: "warn",
        });
        n++;
      }
    }
  }

  // The remaining kinds key off componentDirs. Skip when no component config
  // exists — every dir would read as "uncovered", which is pure noise.
  if (workspaces.length === 0) return { findings };

  const files = walkSourceTree(opts.repoRoot).filter(
    (rel) => !isOffLimits(rel, offLimits),
  );

  // The project's own declared component file types (union across workspaces).
  const declaredExts = new Set<string>();
  for (const ws of workspaces) for (const e of ws.extensions) declaredExts.add(normExt(e));

  // ── Q4 — a grown dir of component-typed files outside every componentDir ─
  {
    const byDir = new Map<string, number>();
    for (const rel of files) {
      if (underAny(rel, allComponentDirs)) continue;
      if (!declaredExts.has(extOf(rel))) continue;
      const d = dirname(rel);
      if (d === ".") continue; // repo-root loose files aren't a "dir"
      byDir.set(d, (byDir.get(d) ?? 0) + 1);
    }
    let n = 0;
    for (const [d, count] of [...byDir.entries()].sort()) {
      if (n >= MAX_FINDINGS_PER_KIND) break;
      if (count < MIN_UNCOVERED_FILES) continue;
      findings.push({
        pass: PASS_ID,
        kind: "config_uncovered_dir",
        path: d,
        detail: `${count} component-typed files in \`${d}\` sit outside every declared componentDir — add it to components.*.componentDirs (or off_limits)`,
        severity: "warn",
      });
      n++;
    }
  }

  // ── Q5 — a UI/code ext under a componentDir that isn't configured ──
  {
    const uiExts = new Set<string>(UI_EXTENSIONS.map(normExt));
    let n = 0;
    const seen = new Set<string>();
    for (const ws of workspaces) {
      const cfgExts = new Set(ws.extensions.map(normExt));
      for (const rel of files) {
        if (n >= MAX_FINDINGS_PER_KIND) break;
        if (!underAny(rel, ws.componentDirs)) continue;
        const ext = extOf(rel);
        if (ext.length === 0 || cfgExts.has(ext) || !uiExts.has(ext)) continue;
        const key = `${ws.name} ${ext}`;
        if (seen.has(key)) continue;
        seen.add(key);
        findings.push({
          pass: PASS_ID,
          kind: "config_uncovered_ext",
          path: rel,
          detail: `\`${ext}\` files exist under ${ws.name ? `workspace ${ws.name}'s ` : ""}componentDirs but aren't in the configured extensions — they go unindexed; add \`${ext}\` to components.*.extensions`,
          severity: "warn",
        });
        n++;
      }
    }
  }

  return { findings };
}

export interface ConfigDriftBaselineResult {
  /** Repo-relative path of the written baseline, or null when no findings. */
  path: string | null;
  total: number;
}

/**
 * Persist this pass's findings to `.cairn/baseline/config-drift-<ISO>.yaml`,
 * sharing the sensor-audit payload shape so the cairn-attention surface parses
 * it identically (as `baseline_finding` items). Findings are written `hard` so
 * they roll into `attention_count` and actually surface the nudge — config
 * drift is actionable (add a dir/ext to config), not soft inventory. Returns
 * `{ path: null }` (writes nothing) when there are no config-drift findings.
 */
export function writeConfigDriftBaseline(
  repoRoot: string,
  findings: readonly GcFinding[],
  nowIso: string = new Date().toISOString(),
): ConfigDriftBaselineResult {
  const mine = findings.filter((f) => f.pass === PASS_ID);
  if (mine.length === 0) return { path: null, total: 0 };
  const dir = cairnDir(repoRoot, "baseline");
  mkdirSync(dir, { recursive: true });
  const filename = `config-drift-${nowIso.replace(/[:.]/g, "-")}.yaml`;
  const payload = {
    run_at: nowIso,
    total_findings: mine.length,
    sensors: [
      {
        sensor_id: PASS_ID,
        findings: mine.map((f) => ({
          path: f.path,
          line: f.line ?? 0,
          severity: "hard" as const,
          message: f.detail,
        })),
      },
    ],
  };
  writeFileSafe(join(dir, filename), stringifyYaml(payload));
  return { path: join(".cairn", "baseline", filename), total: mine.length };
}
