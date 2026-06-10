
import { cairnDir } from "@isaacriehm/cairn-state";

/** `.cairn/events/` — invalidation event log directory. */
export function eventsDir(repoRoot: string): string {
  return cairnDir(repoRoot, "events");
}
