import { join } from "node:path";

/** `.harness/events/` — invalidation event log directory. */
export function eventsDir(repoRoot: string): string {
  return join(repoRoot, ".harness", "events");
}
