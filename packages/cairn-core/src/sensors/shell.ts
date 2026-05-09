import { spawnSync } from "node:child_process";

/**
 * Returns true if `command` is available on the system PATH.
 */
export function which(command: string): boolean {
  try {
    const result = spawnSync(process.platform === "win32" ? "where" : "which", [command], {
      encoding: "utf8",
    });
    return result.status === 0;
  } catch {
    return false;
  }
}
