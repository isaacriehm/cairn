import { appendFileSync, mkdirSync } from "node:fs";
import { getLogger } from "./logger.js";
import { stalenessDir, stalenessLogPath } from "./paths.js";
import { DriftEvent } from "./schemas.js";

const log = getLogger();

export function recordDriftEvent(repoRoot: string, event: DriftEvent): void {
  const validated = DriftEvent.parse(event);
  mkdirSync(stalenessDir(repoRoot), { recursive: true });
  const line = `${JSON.stringify(validated)}\n`;
  appendFileSync(stalenessLogPath(repoRoot), line, "utf8");
  log.info({ kind: validated.kind, path: validated.path, severity: validated.severity }, "drift");
}
