import { join } from "node:path";

/** `.cairn/events/` — invalidation event log directory. */
export function eventsDir(repoRoot: string): string {
  return join(repoRoot, ".cairn", "events");
}
