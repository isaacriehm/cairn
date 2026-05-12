#!/usr/bin/env node
// One-off: backfill phase_progress.task_ids in mission state.json from
// the canonical task-anchor stamps in .cairn/tasks/active/<id>/status.yaml
// + .cairn/tasks/done/<id>/status.yaml.
//
// Before v0.13.0, linkage only fired on cairn_task_complete (via
// onTaskCompleted). Tasks created mid-flight + committed without an
// explicit task_complete call left the phase's task_ids array empty —
// causing `cairn_mission_advance choice=exit` to refuse with the
// "phase has no linked tasks" error. v0.13.0 fixed go-forward by
// linking at task_create time. This script repairs the legacy gap on
// already-adopted projects.
//
// Usage:
//   node tools/repair-mission-links.mjs <repo-root> [--dry-run]
//
// Idempotent. Safe to re-run.

import { readFileSync, writeFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const YAML_URL = pathToFileURL(
  join(HERE, "..", "packages", "cairn-state", "node_modules", "yaml", "dist", "index.js"),
).href;
const { parse: parseYaml } = await import(YAML_URL);

const args = process.argv.slice(2);
const repoRoot = args.find((a) => !a.startsWith("--"));
const dryRun = args.includes("--dry-run");

if (!repoRoot) {
  console.error("usage: node tools/repair-mission-links.mjs <repo-root> [--dry-run]");
  process.exit(2);
}

const missionsDir = join(repoRoot, ".cairn", "missions");
const activeDir = join(repoRoot, ".cairn", "tasks", "active");
const doneDir = join(repoRoot, ".cairn", "tasks", "done");

if (!existsSync(missionsDir)) {
  console.error(`no missions dir at ${missionsDir} — nothing to repair`);
  process.exit(0);
}

/**
 * Read every task status.yaml under .cairn/tasks/{active,done} and
 * collect the mission_id + phase_id anchor where set.
 *
 * @returns {Array<{task_id: string, mission_id: string, phase_id: string, terminal: boolean}>}
 */
function collectAnchoredTasks() {
  const out = [];
  for (const [root, terminal] of [[activeDir, false], [doneDir, true]]) {
    if (!existsSync(root)) continue;
    let entries;
    try {
      entries = readdirSync(root, { withFileTypes: true, encoding: "utf8" });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const yamlPath = join(root, e.name, "status.yaml");
      if (!existsSync(yamlPath)) continue;
      let parsed;
      try {
        parsed = parseYaml(readFileSync(yamlPath, "utf8"));
      } catch {
        continue;
      }
      if (parsed === null || typeof parsed !== "object") continue;
      const taskId = typeof parsed.id === "string" ? parsed.id : e.name;
      const missionId = typeof parsed.mission_id === "string" ? parsed.mission_id : null;
      const phaseId = typeof parsed.phase_id === "string" ? parsed.phase_id : null;
      if (missionId === null || phaseId === null) continue;
      if (missionId.length === 0) continue;
      out.push({ task_id: taskId, mission_id: missionId, phase_id: phaseId, terminal });
    }
  }
  return out;
}

const anchored = collectAnchoredTasks();
console.log(`\n=== ${dryRun ? "DRY RUN " : ""}repair-mission-links ===`);
console.log(`anchored tasks found: ${anchored.length}`);

let missions;
try {
  missions = readdirSync(missionsDir, { withFileTypes: true, encoding: "utf8" })
    .filter((d) => d.isDirectory() && d.name.startsWith("MIS-"))
    .map((d) => d.name);
} catch (err) {
  console.error(`failed to read ${missionsDir}: ${err?.message ?? err}`);
  process.exit(1);
}

const totalsByMission = [];

for (const missionId of missions) {
  const statePath = join(missionsDir, missionId, "state.json");
  if (!existsSync(statePath)) continue;
  let state;
  try {
    state = JSON.parse(readFileSync(statePath, "utf8"));
  } catch {
    continue;
  }
  if (!state || typeof state.phase_progress !== "object" || state.phase_progress === null) {
    state = state ?? {};
    state.phase_progress = state.phase_progress ?? {};
  }

  const tasksForThisMission = anchored.filter((a) => a.mission_id === missionId);
  let appended = 0;
  let alreadyLinked = 0;
  const perPhase = new Map();

  for (const t of tasksForThisMission) {
    const progress = state.phase_progress[t.phase_id] ?? { state: "in_progress", task_ids: [] };
    if (!Array.isArray(progress.task_ids)) progress.task_ids = [];
    if (progress.task_ids.includes(t.task_id)) {
      alreadyLinked += 1;
    } else {
      progress.task_ids = [...progress.task_ids, t.task_id];
      state.phase_progress[t.phase_id] = progress;
      appended += 1;
      perPhase.set(t.phase_id, (perPhase.get(t.phase_id) ?? 0) + 1);
    }
  }

  totalsByMission.push({ missionId, tasksForThisMission: tasksForThisMission.length, appended, alreadyLinked, perPhase });

  if (appended > 0 && !dryRun) {
    writeFileSync(statePath, JSON.stringify(state, null, 2) + "\n", "utf8");
  }
}

for (const t of totalsByMission) {
  console.log(`\n${t.missionId}`);
  console.log(`  anchored tasks for this mission: ${t.tasksForThisMission}`);
  console.log(`  already linked: ${t.alreadyLinked}`);
  console.log(`  appended:       ${t.appended}${dryRun ? " (not written)" : ""}`);
  if (t.perPhase.size > 0) {
    for (const [phase, n] of t.perPhase.entries()) {
      console.log(`    + ${phase}: +${n}`);
    }
  }
}
