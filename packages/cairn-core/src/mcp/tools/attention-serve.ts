/**
 * cairn_attention_serve — launch the browser triage GUI from inside
 * the MCP server process.
 *
 * Why in-process (not spawn): the MCP server is already a long-lived
 * Node process. Running the HTTP server alongside it means writes
 * route through the same `withWriteLock` path as MCP tool calls and
 * we don't need to know the CLI bundle path at runtime. Browser
 * open is best-effort (`open` / `xdg-open` / `start`).
 *
 * Pairs with `cairn_attention_wait` — the calling skill drives:
 *   1. cairn_attention_serve → URL + sentinel path
 *   2. (operator triages in browser, clicks "I'm done")
 *   3. cairn_attention_wait → unblocks when sentinel arrives
 */

import { spawn } from "node:child_process";
import { z } from "zod";
import {
  getActiveAttentionServer,
  startAttentionServer,
} from "../../attention/serve/index.js";
import type { McpContext } from "../context.js";
import { requireBootstrap } from "../bootstrap-guard.js";
import type { ToolDef } from "./types.js";

const inputShape = {
  port: z.number().int().min(0).max(65535).optional(),
  idle_timeout_min: z.number().int().min(1).max(180).optional(),
  no_open: z.boolean().optional(),
};

interface Input {
  port?: number;
  idle_timeout_min?: number;
  no_open?: boolean;
}

async function handler(ctx: McpContext, input: Input): Promise<unknown> {
  const block = requireBootstrap(ctx.repoRoot);
  if (block !== null) return block;

  const existing = getActiveAttentionServer(ctx.repoRoot);
  if (existing !== undefined) {
    return {
      ok: true,
      url: existing.url,
      port: existing.port,
      sentinel_path: existing.sentinelPath,
      reused: true,
    };
  }

  const port = input.port ?? 0;
  const idleTimeoutMs =
    input.idle_timeout_min !== undefined
      ? input.idle_timeout_min * 60_000
      : undefined;

  const handle = await startAttentionServer({
    repoRoot: ctx.repoRoot,
    port,
    ...(idleTimeoutMs !== undefined ? { idleTimeoutMs } : {}),
  });

  if (input.no_open !== true) {
    try {
      if (process.platform === "win32") {
        // `start` is a cmd.exe builtin, not an exe on PATH; the empty
        // "" is the window-title arg so the URL is not consumed as a title.
        spawn("cmd", ["/c", "start", "", handle.url], {
          stdio: "ignore",
          detached: true,
        }).unref();
      } else {
        const opener = process.platform === "darwin" ? "open" : "xdg-open";
        spawn(opener, [handle.url], {
          stdio: "ignore",
          detached: true,
        }).unref();
      }
    } catch {
      // operator clicks the printed URL manually
    }
  }

  return {
    ok: true,
    url: handle.url,
    port: handle.port,
    sentinel_path: handle.sentinelPath,
    reused: false,
  };
}

export const attentionServeTool: ToolDef<Input> = {
  name: "cairn_attention_serve",
  description:
    "Launch the browser triage GUI on a free local port (127.0.0.1). Pairs with cairn_attention_wait — the skill calls this, prints the URL to chat, then blocks on cairn_attention_wait until the operator clicks 'I'm done' in the browser. The GUI handles accept / reject / edit / merge / bulk-accept directly against `.cairn/ground/decisions/`, so MCP round-trips drop to zero during triage. Use when attention_count > 15 — below that, the inline AskUserQuestion flow is more efficient.",
  inputSchema: inputShape,
  handler,
};
