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

/**
 * Decision-direction inbox row shape — produced by the Discord adapter when
 * the operator submits `/direction <text>` OR free-texts a message that
 * Tier-0 classifies as `direction`. Both routes land here for the
 * orchestrator's decision-capture step.
 */
export interface InboxDirectionRow {
  kind: "slash" | "free_text";
  source: string;
  received_at: string;
  /** Slash-only — the slash event with options.text. */
  slash?: {
    command: string;
    options: Record<string, string | number | boolean>;
    authorId: string;
    channelId?: string;
    guildId?: string;
    messageId?: string;
    receivedAt: string;
  };
  /** Free-text-only — the classified message body. */
  free_text?: {
    intent: string;
    rawText: string;
    authorId: string;
    channelId?: string;
    guildId?: string;
    messageId?: string;
    receivedAt: string;
  };
}

/**
 * True iff the row is a Decision-capture trigger:
 *   - kind=slash, slash.command === "direction"
 *   - kind=free_text, free_text.intent === "direction"
 */
export function isDirectionRow(row: unknown): row is InboxDirectionRow {
  if (typeof row !== "object" || row === null) return false;
  const r = row as Record<string, unknown>;
  if (r["kind"] === "slash") {
    const s = r["slash"];
    if (typeof s !== "object" || s === null) return false;
    const ss = s as Record<string, unknown>;
    return ss["command"] === "direction" && typeof ss["authorId"] === "string";
  }
  if (r["kind"] === "free_text") {
    const f = r["free_text"];
    if (typeof f !== "object" || f === null) return false;
    const ff = f as Record<string, unknown>;
    return (
      ff["intent"] === "direction" &&
      typeof ff["rawText"] === "string" &&
      typeof ff["authorId"] === "string"
    );
  }
  return false;
}

/** Pull the raw direction text out of a direction row. */
export function directionTextOf(row: InboxDirectionRow): string {
  if (row.kind === "slash") {
    const text = row.slash?.options["text"];
    return typeof text === "string" ? text : "";
  }
  return row.free_text?.rawText ?? "";
}

/** Pull the author id out of a direction row. */
export function directionAuthorOf(row: InboxDirectionRow): string {
  if (row.kind === "slash") return row.slash?.authorId ?? "";
  return row.free_text?.authorId ?? "";
}

/** Pull channel id out of a direction row, when present. */
export function directionChannelOf(row: InboxDirectionRow): string | undefined {
  if (row.kind === "slash") return row.slash?.channelId;
  return row.free_text?.channelId;
}

/**
 * Generic slash-event inbox row — covers /halt, /status, /queue, /eval,
 * /resume, /oops, /help, /agent, /ship-anyway. The orchestrator routes by
 * `slash.command`. /direction is intercepted earlier by `isDirectionRow`
 * so it never reaches this guard's handler chain.
 */
export interface InboxSlashRow {
  kind: "slash";
  source: string;
  received_at: string;
  slash: {
    command: string;
    options: Record<string, string | number | boolean>;
    authorId: string;
    channelId?: string;
    guildId?: string;
    messageId?: string;
    receivedAt: string;
  };
}

export function isSlashRow(row: unknown): row is InboxSlashRow {
  if (typeof row !== "object" || row === null) return false;
  const r = row as Record<string, unknown>;
  if (r["kind"] !== "slash") return false;
  const s = r["slash"];
  if (typeof s !== "object" || s === null) return false;
  const ss = s as Record<string, unknown>;
  return (
    typeof ss["command"] === "string" && typeof ss["authorId"] === "string"
  );
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
