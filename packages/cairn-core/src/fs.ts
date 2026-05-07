import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Write `data` to `path`, creating parent directories as needed.
 * Encoding is always UTF-8.
 */
export function writeFileSafe(path: string, data: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, data, "utf8");
}
