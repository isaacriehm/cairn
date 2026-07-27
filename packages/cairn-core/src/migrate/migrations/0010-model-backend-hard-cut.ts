/**
 * 0010 — cut legacy Claude/Haiku-derived state over to the shared model
 * backend contract.
 *
 * Session status is cosmetic runtime state, but preserving its current value
 * avoids a misleading badge immediately after upgrade. Legacy model-cache
 * entries are both derived and unreadable by the new provider-keyed cache, so
 * they are deleted instead of translated.
 */

import {
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { cairnDir } from "@isaacriehm/cairn-state";
import { sessionsDir } from "../../paths/index.js";
import type { Migration, MigrationResult } from "../types.js";

type JsonRecord = Record<string, unknown>;

function asRecord(value: unknown): JsonRecord | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function statusPaths(repoRoot: string): string[] {
  const root = sessionsDir(repoRoot);
  if (!existsSync(root)) return [];
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => join(root, entry.name, "status.json"))
      .filter((path) => existsSync(path));
  } catch {
    return [];
  }
}

function readStatus(path: string): JsonRecord | null {
  try {
    return asRecord(JSON.parse(readFileSync(path, "utf8")) as unknown);
  } catch {
    return null;
  }
}

function hasLegacyEvent(value: unknown): boolean {
  return asRecord(value)?.["kind"] === "haiku-offline";
}

function needsStatusCutover(status: JsonRecord): boolean {
  if ("haiku_unavailable" in status) return true;
  if (hasLegacyEvent(status["current_event"])) return true;
  const recent = status["recent_events"];
  return Array.isArray(recent) && recent.some(hasLegacyEvent);
}

function migrateEvent(value: unknown): void {
  const event = asRecord(value);
  if (event?.["kind"] === "haiku-offline") {
    event["kind"] = "model-offline";
  }
}

function migrateStatus(status: JsonRecord): void {
  if (
    typeof status["model_unavailable"] !== "boolean" &&
    typeof status["haiku_unavailable"] === "boolean"
  ) {
    status["model_unavailable"] = status["haiku_unavailable"];
  }
  delete status["haiku_unavailable"];
  migrateEvent(status["current_event"]);
  const recent = status["recent_events"];
  if (Array.isArray(recent)) {
    for (const event of recent) migrateEvent(event);
  }
}

function writeStatusAtomic(path: string, status: JsonRecord): void {
  const temp = `${path}.migrate-${process.pid}`;
  try {
    writeFileSync(temp, `${JSON.stringify(status, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    renameSync(temp, path);
  } catch (err) {
    try {
      unlinkSync(temp);
    } catch {
      // Nothing to clean.
    }
    throw err;
  }
}

function legacyCacheDir(repoRoot: string): string {
  return cairnDir(repoRoot, "cache", "haiku");
}

export const modelBackendHardCut: Migration = {
  id: "0010-model-backend-hard-cut",
  introducedIn: "0.33.0",
  describe:
    "Migrate legacy Haiku status fields/events and delete the obsolete Claude-only model cache",
  class: "safe",
  detect(repoRoot: string): boolean {
    if (existsSync(legacyCacheDir(repoRoot))) return true;
    return statusPaths(repoRoot).some((path) => {
      const status = readStatus(path);
      return status !== null && needsStatusCutover(status);
    });
  },
  apply(repoRoot: string): MigrationResult {
    let statusesChanged = 0;
    for (const path of statusPaths(repoRoot)) {
      const status = readStatus(path);
      if (status === null || !needsStatusCutover(status)) continue;
      migrateStatus(status);
      writeStatusAtomic(path, status);
      statusesChanged += 1;
    }

    const cacheDir = legacyCacheDir(repoRoot);
    const removedCache = existsSync(cacheDir);
    if (removedCache) rmSync(cacheDir, { recursive: true, force: true });

    return {
      changed: statusesChanged > 0 || removedCache,
      detail:
        `migrated ${statusesChanged} legacy status file(s)` +
        (removedCache ? " and removed cache/haiku" : ""),
    };
  },
};
