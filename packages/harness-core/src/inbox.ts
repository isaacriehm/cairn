import { mkdir, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { InboxKind } from "./frontend-types.js";

/**
 * Append a normalized event row to `.harness/inbox/`.
 *
 * The orchestrator (Phase 8) tails this directory and acts on each row.
 * Phase 5 just lands rows — no orchestrator yet. Inbox is a write-allowed
 * path per `harness/src/mcp/path-allowlist.ts` (`APPEND_ALLOWLIST`).
 *
 * Filename pattern: `<ts>-<source>-<kind>-<slug>.json`. Sortable, scannable,
 * collision-resistant under concurrent writers.
 */
export async function writeInboxRow(args: {
  repoRoot: string;
  source: string;
  kind: InboxKind;
  payload: object;
}): Promise<string> {
  const { repoRoot, source, kind, payload } = args;
  const dir = join(repoRoot, ".harness", "inbox");
  await mkdir(dir, { recursive: true });
  const ts = Date.now();
  const slug = randomBytes(4).toString("hex");
  const file = join(dir, `${ts}-${source}-${kind}-${slug}.json`);
  const row = {
    kind,
    source,
    received_at: new Date().toISOString(),
    ...payload,
  };
  await writeFile(file, `${JSON.stringify(row, null, 2)}\n`, "utf8");
  return file;
}
