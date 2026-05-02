import { mkdir, readFile, readdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "../logger.js";
import type { InboxTaskRow } from "./types.js";

const log = logger("orchestrator.inbox");

export const INBOX_DIR_REL = ".harness/inbox";
export const INBOX_PROCESSED_REL = ".harness/inbox/processed";

/** Ensure the inbox + processed directories exist. */
export async function ensureInboxDirs(repoRoot: string): Promise<void> {
  await mkdir(join(repoRoot, INBOX_DIR_REL), { recursive: true });
  await mkdir(join(repoRoot, INBOX_PROCESSED_REL), { recursive: true });
}

/**
 * List unprocessed inbox files (sorted by filename, which encodes timestamp).
 * Skips directories — `processed/` is the only known subdir.
 */
export async function listInboxFiles(repoRoot: string): Promise<string[]> {
  const dir = join(repoRoot, INBOX_DIR_REL);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return entries
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => join(dir, name));
}

export async function readInboxRow(file: string): Promise<unknown> {
  const text = await readFile(file, "utf8");
  return JSON.parse(text);
}

/** True iff the row's `kind === "task"` and the inner `task` looks valid. */
export function isTaskRow(row: unknown): row is InboxTaskRow {
  if (typeof row !== "object" || row === null) return false;
  const r = row as Record<string, unknown>;
  if (r["kind"] !== "task") return false;
  const t = r["task"];
  if (typeof t !== "object" || t === null) return false;
  const tt = t as Record<string, unknown>;
  return typeof tt["rawText"] === "string" && typeof tt["authorId"] === "string";
}

export async function moveToProcessed(
  repoRoot: string,
  file: string,
  outcome: "succeeded" | "failed" | "ignored",
): Promise<string> {
  const base = file.split("/").pop() ?? "";
  const dest = join(
    repoRoot,
    INBOX_PROCESSED_REL,
    `${base.replace(/\.json$/, "")}.${outcome}.json`,
  );
  await rename(file, dest);
  log.debug({ from: file, to: dest }, "inbox row moved to processed");
  return dest;
}
