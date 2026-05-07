/**
 * Browser-based DEC-draft triage GUI.
 *
 * Spawned by `cairn attention serve` (CLI) or
 * `cairn_attention_serve` (MCP). Operator drains the inbox in the
 * browser instead of through `AskUserQuestion` round-trips, then
 * clicks "I'm done" — the server writes a sentinel at
 * `.cairn/cache/attention-done.json` that the caller polls (via
 * `cairn_attention_wait` or by tailing the file).
 *
 * Why a GUI: at >15 drafts the inline `AskUserQuestion` flow burns
 * `cairn_decision_get` calls per draft and 4-cap-per-question batches
 * the operator through dozens of MCP turns. The browser does all the
 * I/O directly against `.cairn/`, dropping per-triage round-trips to
 * zero.
 *
 * Mechanics:
 *   - HTTP server on a free port (or operator-supplied), bound to
 *     127.0.0.1 so the surface is local-only.
 *   - JSON API mirrors the existing attention handlers (bulk-accept,
 *     dedup, resolve, restore) so all writes funnel through the same
 *     `withWriteLock` path the MCP tools use.
 *   - Static SPA bundle (vanilla HTML+JS+CSS) under
 *     `cairn-core/templates/attention-ui/` — no build step.
 *   - Idle timeout: 10 min default, reset by `/api/heartbeat`. Server
 *     shuts down when idle exceeds the timeout or on `/api/done`.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  existsSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { writeFileSafe } from "../../fs.js";
import { logger } from "../../logger.js";
import { handleApi } from "./api.js";

const log = logger("attention.serve");

const HERE = dirname(fileURLToPath(import.meta.url));
/**
 * dist/attention/serve/index.js → walk up to package root, then into
 * templates/attention-ui/. Bundled layout co-locates templates as a
 * sibling of dist/cli.mjs (mirrors the seed.ts pattern).
 */
const TEMPLATES_ROOT =
  typeof __CAIRN_BUNDLED__ !== "undefined" && __CAIRN_BUNDLED__
    ? join(HERE, "templates", "attention-ui")
    : join(HERE, "..", "..", "..", "templates", "attention-ui");

const DEFAULT_IDLE_TIMEOUT_MS = 10 * 60 * 1000;
const DONE_TIMEOUT_GRACE_MS = 500;

/**
 * Per-repoRoot live-server registry. The MCP server is a single
 * long-lived process; both `cairn_attention_serve` and
 * `cairn_attention_wait` share this map so wait can await the live
 * `done` promise instead of polling.
 */
const liveServers = new Map<string, AttentionServeHandle>();

/** Read-only accessor for `cairn_attention_wait` and tests. */
export function getActiveAttentionServer(
  repoRoot: string,
): AttentionServeHandle | undefined {
  return liveServers.get(repoRoot);
}

export interface AttentionServeOptions {
  repoRoot: string;
  /** Listen port. Pass 0 to let the OS pick. */
  port: number;
  /** Idle (no heartbeat / no API activity) before auto-shutdown. */
  idleTimeoutMs?: number;
  /** Optional caller-supplied abort signal. */
  signal?: AbortSignal;
}

export interface AttentionServeHandle {
  port: number;
  url: string;
  sentinelPath: string;
  /** Resolves once the server has shut down (operator clicked Done or idled out). */
  done: Promise<DoneState>;
  /** Force shutdown — typically wired to SIGINT / SIGTERM in CLI. */
  close: () => Promise<void>;
}

export interface DoneState {
  reason: "done" | "idle" | "abort";
  accepted: number;
  rejected: number;
  merged: number;
  edited: number;
  startedAt: string;
  endedAt: string;
}

/**
 * Boot the triage server. Returns once the listener is ready;
 * `handle.done` resolves when the operator finishes or the server
 * idles out.
 */
export async function startAttentionServer(
  opts: AttentionServeOptions,
): Promise<AttentionServeHandle> {
  const idleTimeoutMs = opts.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const sentinelPath = join(opts.repoRoot, ".cairn", "cache", "attention-done.json");
  // Pre-clear any stale sentinel so the caller's wait loop isn't
  // tricked by a previous run's payload.
  try {
    rmSync(sentinelPath, { force: true });
  } catch {
    /* best-effort */
  }

  const counters = { accepted: 0, rejected: 0, merged: 0, edited: 0 };
  const startedAt = new Date().toISOString();

  let lastActivity = Date.now();
  const touch = (): void => {
    lastActivity = Date.now();
  };

  let resolveDone!: (state: DoneState) => void;
  const donePromise = new Promise<DoneState>((resolve) => {
    resolveDone = resolve;
  });

  let server: Server;
  let idleTimer: NodeJS.Timeout;
  let shutdownStarted = false;

  const writeSentinel = (reason: DoneState["reason"]): DoneState => {
    const state: DoneState = {
      reason,
      ...counters,
      startedAt,
      endedAt: new Date().toISOString(),
    };
    try {
      writeFileSafe(sentinelPath, JSON.stringify(state, null, 2));
    } catch (err) {
      log.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "failed to write sentinel",
      );
    }
    return state;
  };

  const beginShutdown = (reason: DoneState["reason"]): void => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    clearInterval(idleTimer);
    const state = writeSentinel(reason);
    setTimeout(() => {
      server.close(() => {
        resolveDone(state);
      });
    }, DONE_TIMEOUT_GRACE_MS);
  };

  server = createServer((req, res) => {
    void handleRequest(req, res, {
      repoRoot: opts.repoRoot,
      counters,
      touch,
      onDone: () => beginShutdown("done"),
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(opts.port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const addr = server.address();
  const port =
    typeof addr === "object" && addr !== null ? addr.port : opts.port;
  const url = `http://127.0.0.1:${port}/`;

  idleTimer = setInterval(() => {
    if (Date.now() - lastActivity >= idleTimeoutMs) {
      log.info({ idleTimeoutMs }, "attention server idle — shutting down");
      beginShutdown("idle");
    }
  }, 30_000);

  if (opts.signal !== undefined) {
    if (opts.signal.aborted) {
      beginShutdown("abort");
    } else {
      opts.signal.addEventListener("abort", () => beginShutdown("abort"), {
        once: true,
      });
    }
  }

  log.info({ port, url, sentinelPath }, "attention server listening");

  const handle: AttentionServeHandle = {
    port,
    url,
    sentinelPath,
    done: donePromise,
    close: async () => {
      beginShutdown("abort");
      await donePromise;
    },
  };
  liveServers.set(opts.repoRoot, handle);
  void donePromise.finally(() => liveServers.delete(opts.repoRoot));
  return handle;
}

interface HandleRequestCtx {
  repoRoot: string;
  counters: { accepted: number; rejected: number; merged: number; edited: number };
  touch: () => void;
  onDone: () => void;
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  ctx: HandleRequestCtx,
): Promise<void> {
  ctx.touch();
  const url = req.url ?? "/";

  if (url === "/" || url === "/index.html") {
    return serveStatic(res, "index.html", "text/html; charset=utf-8");
  }
  if (url === "/static/app.js") {
    return serveStatic(res, "app.js", "application/javascript; charset=utf-8");
  }
  if (url === "/static/app.css") {
    return serveStatic(res, "app.css", "text/css; charset=utf-8");
  }
  if (url.startsWith("/api/")) {
    return handleApi(req, res, ctx);
  }
  res.statusCode = 404;
  res.setHeader("content-type", "text/plain");
  res.end("not found");
}

function serveStatic(
  res: ServerResponse,
  filename: string,
  contentType: string,
): void {
  const path = join(TEMPLATES_ROOT, filename);
  if (!existsSync(path)) {
    res.statusCode = 500;
    res.setHeader("content-type", "text/plain");
    res.end(`attention-ui template missing: ${filename}`);
    return;
  }
  let body: string;
  try {
    body = readFileSync(path, "utf8");
  } catch (err) {
    res.statusCode = 500;
    res.setHeader("content-type", "text/plain");
    res.end(
      `attention-ui template read failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }
  res.statusCode = 200;
  res.setHeader("content-type", contentType);
  res.setHeader("cache-control", "no-store");
  res.end(body);
}
