import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { logger } from "../logger.js";
import { stalenessCurrentPath, stalenessDir, stalenessLogPath } from "./paths.js";
import { DriftEvent } from "./schemas.js";

const log = logger("ground.drift");

export interface DriftSnapshot {
  generated: string;
  /** Open drift events at the time of the snapshot. */
  events: DriftEvent[];
}

export function recordDriftEvent(repoRoot: string, event: DriftEvent): void {
  const validated = DriftEvent.parse(event);
  mkdirSync(stalenessDir(repoRoot), { recursive: true });
  const line = `${JSON.stringify(validated)}\n`;
  appendFileSync(stalenessLogPath(repoRoot), line, "utf8");
  log.info({ kind: validated.kind, path: validated.path, severity: validated.severity }, "drift");
}

export function writeDriftSnapshot(repoRoot: string, events: DriftEvent[]): string {
  mkdirSync(stalenessDir(repoRoot), { recursive: true });
  const snapshot: DriftSnapshot = {
    generated: new Date().toISOString(),
    events,
  };
  const path = stalenessCurrentPath(repoRoot);
  writeFileSync(path, JSON.stringify(snapshot, null, 2), "utf8");
  return path;
}
