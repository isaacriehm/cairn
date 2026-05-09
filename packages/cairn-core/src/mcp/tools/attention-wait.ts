/**
 * cairn_attention_wait — block until the browser triage GUI
 * signals "I'm done" (or the server idles out / the timeout expires).
 *
 * Two completion paths:
 *   1. In-process — if `cairn_attention_serve` was called from the
 *      same MCP server, the live `AttentionServeHandle.done` promise
 *      is awaited directly.
 *   2. Sentinel file — `.cairn/cache/attention-done.json`. Polled
 *      every second as a fallback so external `cairn attention serve`
 *      (CLI) sessions work too.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import {
  getActiveAttentionServer,
} from "../../attention/serve/index.js";
import type { McpContext } from "../context.js";
import { requireBootstrap } from "../bootstrap-guard.js";
import type { ToolDef } from "./types.js";

const DoneStateSchema = z.object({
  status: z.enum(["done", "idle", "abort"]),
  accepted: z.number(),
  rejected: z.number(),
  merged: z.number(),
  edited: z.number(),
}).passthrough();

const DEFAULT_TIMEOUT_SECONDS = 1800;
const POLL_INTERVAL_MS = 1000;

const inputShape = {
  timeout_seconds: z.number().int().min(1).max(7200).optional(),
};

interface Input {
  timeout_seconds?: number;
}

async function handler(ctx: McpContext, input: Input): Promise<unknown> {
  const block = requireBootstrap(ctx.repoRoot);
  if (block !== null) return block;

  const timeoutMs = (input.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS) * 1000;
  const sentinelPath = join(
    ctx.repoRoot,
    ".cairn",
    "cache",
    "attention-done.json",
  );

  const live = getActiveAttentionServer(ctx.repoRoot);
  if (live !== undefined) {
    const result = await Promise.race([
      live.done.then((s) => ({ kind: "done" as const, state: s })),
      new Promise<{ kind: "timeout" }>((resolve) =>
        setTimeout(() => resolve({ kind: "timeout" }), timeoutMs),
      ),
    ]);
    if (result.kind === "done") {
      return { ok: true, ...result.state };
    }
    return {
      ok: false,
      error: "TIMEOUT",
      timeout_seconds: input.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS,
    };
  }

  // Fallback — poll the sentinel file. CLI-launched servers route here.
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(sentinelPath)) {
      try {
        const raw = readFileSync(sentinelPath, "utf8");
        const parsed: unknown = JSON.parse(raw);
        const result = DoneStateSchema.safeParse(parsed);
        if (result.success) {
          return { ok: true, ...result.data };
        }
      } catch {
        // partial write — try again next tick
      }
    }
    await sleep(POLL_INTERVAL_MS);
  }

  return {
    ok: false,
    error: "TIMEOUT",
    timeout_seconds: input.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const attentionWaitTool: ToolDef<Input> = {
  name: "cairn_attention_wait",
  description:
    "Block until the browser triage GUI signals completion (`.cairn/cache/attention-done.json` written) or the timeout expires (default 1800s). Returns the DoneState payload — counts of accepted / rejected / merged / edited drafts plus the reason the server stopped (`done` | `idle` | `abort`). Pair with cairn_attention_serve.",
  inputSchema: inputShape,
  handler,
};
