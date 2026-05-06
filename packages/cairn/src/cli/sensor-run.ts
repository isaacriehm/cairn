/**
 * `cairn sensor-run` — invoked by the cairn git hooks (pre-commit,
 * commit-msg).
 *
 * Parses the trigger flag, loads `.cairn/config/sensors.yaml`, and
 * exits cleanly. Pre-commit / commit-msg sensor execution is not yet
 * wired; the canonical sweep runs at adoption (phase 8 baseline) and
 * the Stop-hook bypass-tracker (post-commit).
 *
 * Exits 0 unless the repo is misconfigured (no `.cairn/` at all).
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

interface SensorEntry {
  id: string;
  triggers?: string[];
}

interface SensorsConfig {
  sensors?: SensorEntry[];
}

type Trigger = "pre-commit" | "commit-msg";

function findRepoRoot(start: string): string | null {
  let cur = resolve(start);
  for (let i = 0; i < 80; i++) {
    if (existsSync(join(cur, ".cairn"))) return cur;
    const parent = resolve(cur, "..");
    if (parent === cur) return null;
    cur = parent;
  }
  return null;
}

function loadSensors(repoRoot: string): SensorsConfig | null {
  const path = join(repoRoot, ".cairn", "config", "sensors.yaml");
  if (!existsSync(path)) return null;
  try {
    const parsed = parseYaml(readFileSync(path, "utf8")) as SensorsConfig;
    return parsed;
  } catch {
    return null;
  }
}

function sensorsForTrigger(cfg: SensorsConfig | null, trigger: Trigger): SensorEntry[] {
  if (cfg === null || !Array.isArray(cfg.sensors)) return [];
  return cfg.sensors.filter((s) => Array.isArray(s.triggers) && s.triggers.includes(trigger));
}

function parseFlags(argv: string[]): {
  trigger: Trigger;
  commitMsgPath: string | null;
} | null {
  let trigger: Trigger | null = null;
  let commitMsgPath: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--staged") {
      trigger = "pre-commit";
    } else if (a === "--commit-msg") {
      trigger = "commit-msg";
      const next = argv[i + 1];
      if (typeof next === "string" && !next.startsWith("--")) {
        commitMsgPath = next;
        i += 1;
      }
    }
  }
  if (trigger === null) return null;
  return { trigger, commitMsgPath };
}

export async function sensorRunCli(argv: string[]): Promise<void> {
  const flags = parseFlags(argv);
  if (flags === null) {
    console.error(
      "Usage: cairn sensor-run --staged | --commit-msg <path>\n" +
        "Invoked by the cairn pre-commit / commit-msg git hooks.",
    );
    process.exit(2);
  }

  const repoRoot = findRepoRoot(process.cwd());
  if (repoRoot === null) {
    // Not a cairn-adopted repo — hooks call us defensively, exit clean.
    process.exit(0);
  }

  const cfg = loadSensors(repoRoot);
  const matched = sensorsForTrigger(cfg, flags.trigger);

  if (matched.length === 0) {
    // No sensors configured for this trigger — silent pass.
    process.exit(0);
  }

  // Pre-commit / commit-msg sensor execution is not yet wired.
  // The canonical sweep runs at adoption (phase 8 baseline); the Stop hook
  // bypass-tracker (post-commit) catches `--no-verify` after the fact.
  // Surface a one-line note so operators with active triggers know
  // their sensors are pending hookup.
  const ids = matched.map((s) => s.id).join(", ");
  console.error(
    `cairn: ${flags.trigger} sensors configured (${ids}) but execution not yet wired for this trigger`,
  );
  process.exit(0);
}
