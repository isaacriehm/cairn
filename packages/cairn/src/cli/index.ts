#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type CtxMeterInput,
  readStatusForCLI,
  resolveAnchorRoot,
  VERSION,
} from "../index.js";
import { alignCli } from "./align.js";
import { attentionCli } from "./attention.js";
import { baselineCli } from "./baseline.js";
import { componentsCli } from "./components.js";
import { doctorCli } from "./doctor.js";
import { fixCli } from "./fix.js";
import { gcCli } from "./gc.js";
import { hookCli } from "./hook.js";
import { initCli } from "./init.js";
import { joinCli } from "./join.js";
import { mcpCli } from "./mcp.js";
import { migrateCli } from "./migrate.js";
import { missionCli } from "./mission.js";
import { scopeCli } from "./scope.js";
import { sensorRunCli } from "./sensor-run.js";
import { tagCli } from "./tag.js";
import { traceCli } from "./trace.js";
import { cairnDir } from "@isaacriehm/cairn-core";

interface StatusLinePayload {
  sessionId: string | null;
  ctx: CtxMeterInput | null;
  /** Raw stdin text — captured for the per-session diagnostic dump. */
  rawText: string;
  /** Why ctx parsing fell through; null when ctx parsed successfully. */
  ctxReason: CtxParseReason | null;
}

/**
 * Why `ctx` ended up null after decoding CC's statusline payload. Captured
 * to `statusline-last.json` so operators can see which branch fired without
 * having to instrument the CLI manually. Most fields exist because CC has
 * shipped multiple statusline payload shapes over time and we need to spot
 * which one is in play.
 */
type CtxParseReason =
  | "empty-stdin"
  | "json-parse-failed"
  | "context-window-missing"
  | "context-window-null"
  | "context-window-not-object"
  | "used-percentage-not-number"
  | "context-window-size-not-number"
  | "context-window-size-zero-or-negative";

function decodePayload(text: string): StatusLinePayload {
  const base = { rawText: text };
  if (text.length === 0) {
    return { sessionId: null, ctx: null, ctxReason: "empty-stdin", ...base };
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { sessionId: null, ctx: null, ctxReason: "json-parse-failed", ...base };
  }
  const sid = parsed["session_id"];
  const sessionId = typeof sid === "string" && sid.length > 0 ? sid : null;

  // Source of truth: Claude Code's `context_window` block as shipped
  // by CC v2.1.138+ — `context_window_size` is the model's window
  // (e.g. 200k Sonnet, 1M Opus-1m) and `used_percentage` is the
  // already-computed in-use share. Cairn trusts both verbatim — no
  // model-keyed fallback, no transcript parsing. If CC omits the
  // block, ctx stays null and the Stop hook + meter skip the
  // threshold check rather than firing on a guessed number. The
  // older `total_tokens`/`remaining_percentage`-only schema is not
  // supported — operators who need ctx telemetry update CC.
  let ctx: CtxMeterInput | null = null;
  let ctxReason: CtxParseReason | null = null;
  if (!("context_window" in parsed)) {
    ctxReason = "context-window-missing";
  } else {
    const cw = parsed["context_window"];
    if (cw === null) {
      ctxReason = "context-window-null";
    } else if (typeof cw !== "object") {
      ctxReason = "context-window-not-object";
    } else {
      const w = cw as Record<string, unknown>;
      const used = w["used_percentage"];
      const windowSize = w["context_window_size"];
      if (typeof used !== "number") {
        ctxReason = "used-percentage-not-number";
      } else if (typeof windowSize !== "number") {
        ctxReason = "context-window-size-not-number";
      } else if (windowSize <= 0) {
        ctxReason = "context-window-size-zero-or-negative";
      } else {
        const usedPct = Math.max(0, Math.min(100, used));
        const usedTokens = Math.round((windowSize * usedPct) / 100);
        ctx = { usedPct, usedTokens, windowTokens: windowSize };
      }
    }
  }
  return { sessionId, ctx, ctxReason, ...base };
}

/**
 * Per-session statusline diagnostic. Writes the raw stdin payload plus
 * the parse outcome to `.cairn/sessions/<id>/statusline-last.json` so
 * operators can see what CC actually shipped on the most-recent tick.
 * Resolves the long-running "ctx meter is missing for this session"
 * mystery: instead of guessing whether CC omitted the block, malformed
 * it, or the CLI rejected it, the file shows the raw + the rejection
 * reason. Overwritten every tick; no growth.
 *
 * Best-effort — swallow any I/O error since statusline must never
 * block the prompt. Caller passes the already-resolved `repoRoot` so
 * the diagnostic lands in the same `.cairn/` we'd use for ctx.json.
 */
function persistStatuslineDiagnostic(
  repoRoot: string,
  sessionId: string,
  payload: StatusLinePayload,
): void {
  if (!existsSync(cairnDir(repoRoot))) return;
  try {
    const dir = cairnDir(repoRoot, "sessions", sessionId);
    mkdirSync(dir, { recursive: true });
    // Cap raw text to 8 KiB so a runaway CC payload can't blow the
    // file up; statusline payloads are typically <2 KiB in practice.
    const rawCapped =
      payload.rawText.length > 8192
        ? `${payload.rawText.slice(0, 8192)}…<truncated>`
        : payload.rawText;
    const snapshot = {
      ts: Date.now(),
      session_id: sessionId,
      ctx_parsed: payload.ctx !== null,
      ctx_reason: payload.ctxReason,
      ctx: payload.ctx,
      raw: rawCapped,
      raw_bytes: payload.rawText.length,
    };
    writeFileSync(
      join(dir, "statusline-last.json"),
      `${JSON.stringify(snapshot, null, 2)}\n`,
      "utf8",
    );
  } catch {
    // best-effort
  }
}

/**
 * Persist the latest ctx snapshot from the statusline payload to
 * `.cairn/sessions/<id>/ctx.json` so the Stop hook can read the real
 * context-window usage (Claude Code only passes `context_window` to
 * statusline hooks; Stop hooks see no token data). Best-effort —
 * swallow any I/O error since statusline must never block the prompt.
 */
function persistCtxSnapshot(
  projectRoot: string,
  sessionId: string,
  ctx: CtxMeterInput,
): void {
  // Bail on un-adopted projects so we never auto-create `.cairn/`
  // outside of `cairn init`. Statusline runs on every prompt across
  // every project Claude Code has the plugin configured for.
  if (!existsSync(cairnDir(projectRoot))) return;
  try {
    const dir = cairnDir(projectRoot, "sessions", sessionId);
    mkdirSync(dir, { recursive: true });
    const snapshot = {
      usedPct: ctx.usedPct,
      usedTokens: ctx.usedTokens,
      windowTokens: ctx.windowTokens,
      ts: Date.now(),
    };
    writeFileSync(join(dir, "ctx.json"), JSON.stringify(snapshot), "utf8");
  } catch {
    // best-effort
  }
}

async function readStatusLinePayload(): Promise<StatusLinePayload> {
  // Hard deadline: Claude Code re-runs statusline every ~10s, so a
  // 1.5s budget leaves plenty of headroom. The earlier 250ms cap was
  // racing CC's stdin write on the first prompt of a session — the
  // timeout would fire, we'd discard whatever had already buffered
  // in `chunks`, and the resulting null `ctx_window` would suppress
  // the meter even though CC had shipped the block correctly. Now
  // the timeout decodes whatever's buffered instead of throwing it
  // away, and the deadline auto-extends while bytes are still
  // arriving so a slow large payload still completes cleanly.
  return new Promise((resolveP) => {
    const chunks: Buffer[] = [];
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    const settle = (value: StatusLinePayload): void => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      resolveP(value);
    };
    const decodeBuffered = (): StatusLinePayload =>
      decodePayload(Buffer.concat(chunks).toString("utf8").trim());
    const resetDeadline = (): void => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => settle(decodeBuffered()), 1500);
    };
    process.stdin.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      // CC writes the payload then closes stdin, but on slow boxes
      // the close event can lag the last data event. Re-arm so the
      // deadline starts from "last byte seen", not from spawn.
      resetDeadline();
    });
    process.stdin.on("end", () => settle(decodeBuffered()));
    process.stdin.on("error", () => settle(decodeBuffered()));
    resetDeadline();
  });
}

const [, , subcommand, ...rest] = process.argv;

switch (subcommand) {
  case "init":
    await initCli(rest);
    break;
  case "join":
    await joinCli(rest);
    break;
  case "mcp":
    await mcpCli(rest);
    break;
  case "gc":
    await gcCli(rest);
    break;
  case "scope":
    await scopeCli(rest);
    break;
  case "doctor":
    await doctorCli(rest);
    break;
  case "fix":
    await fixCli(rest);
    break;
  case "migrate":
    await migrateCli(rest);
    break;
  case "attention":
    await attentionCli(rest);
    break;
  case "align":
    await alignCli(rest);
    break;
  case "baseline":
    await baselineCli(rest);
    break;
  case "hook":
    await hookCli(rest);
    break;
  case "sensor-run":
    await sensorRunCli(rest);
    break;
  case "components":
    await componentsCli(rest);
    break;
  case "tag":
    await tagCli(rest);
    break;
  case "trace":
    await traceCli(rest);
    break;
  case "mission":
    await missionCli(rest);
    break;
  case "status-line": {
    const projectRootIdx = rest.indexOf("--project-root");
    let projectRoot: string;
    if (projectRootIdx !== -1 && projectRootIdx + 1 < rest.length) {
      const candidate = rest[projectRootIdx + 1];
      if (candidate === undefined) {
        console.error("--project-root requires a path argument");
        process.exit(2);
      }
      projectRoot = candidate;
    } else {
      // Claude Code spawns the statusline hook with cwd = wherever the
      // operator opened the session. Sessions opened in a subdirectory
      // of an adopted repo would default to that subdir, miss the
      // `.cairn/` lookup, and render an empty status — the "statusline
      // disappears intermittently" symptom. Anchor at the adopted root
      // (or the git repo root), the same single `.cairn/` the hooks use.
      projectRoot = resolveAnchorRoot(process.cwd());
    }
    const sessionIdIdx = rest.indexOf("--session-id");
    let sessionId: string | null = null;
    let ctx: CtxMeterInput | null = null;
    let payload: StatusLinePayload | null = null;
    if (sessionIdIdx !== -1 && sessionIdIdx + 1 < rest.length) {
      const candidate = rest[sessionIdIdx + 1];
      if (candidate === undefined) {
        console.error("--session-id requires a value");
        process.exit(2);
      }
      sessionId = candidate;
    } else if (!process.stdin.isTTY) {
      payload = await readStatusLinePayload();
      sessionId = payload.sessionId;
      ctx = payload.ctx;
    }
    if (sessionId !== null && ctx !== null) {
      persistCtxSnapshot(projectRoot, sessionId, ctx);
    }
    // Diagnostic dump — captures the raw CC stdin payload + parse outcome
    // so an operator who sees "no ctx meter" can read the snapshot at
    // `.cairn/sessions/<id>/statusline-last.json` and learn whether CC
    // shipped the `context_window` block at all, what fields it carried,
    // and which decode branch rejected it. Only writes when a payload was
    // actually received via stdin (skipped on --session-id-only calls).
    if (sessionId !== null && payload !== null) {
      persistStatuslineDiagnostic(projectRoot, sessionId, payload);
    }
    process.stdout.write(`${readStatusForCLI(projectRoot, sessionId, ctx ?? undefined)}\n`);
    process.exit(0);
  }
  case "--version":
  case "-v":
    console.log(VERSION);
    process.exit(0);
  default:
    console.error(
      "Usage: cairn <command>\n" +
        "  init       adopt this cairn into a project\n" +
        "  join       per-clone bootstrap (set core.hooksPath, chmod hooks)\n" +
        "  mcp        MCP server (stdio transport)\n" +
        "             (subcommands: serve)\n" +
        "  gc         garbage-collection passes against the canonical zone\n" +
        "             (subcommands: sweep | run)\n" +
        "  scope      scope-index commands\n" +
        "             (subcommands: rebuild [--repo <path>])\n" +
        "  doctor     verify the adoption is healthy (checks core, ground, sensors)\n" +
        "             (--repo <path>? --strict?  — warnings exit 0 unless --strict)\n" +
        "  fix        auto-resolve doctor warnings where possible\n" +
        "             (--repo <path>?)\n" +
        "  migrate    bring .cairn/ state up to the current cairn version\n" +
        "             (--dry-run | --all | --repo <path>)\n" +
        "  attention  list pending DEC drafts + baseline sensor findings\n" +
        "             (--repo <path>?)\n" +
        "  align      alignment commands\n" +
        "             (subcommands: drain — SessionStart drain, plan §4.3)\n" +
        "  baseline   re-run the synthetic-diff sensor sweep post-adoption\n" +
        "             (--force? --repo <path>?)\n" +
        "  sensor-run git-hook sensor sweep (--staged | --commit-msg <path>)\n" +
        "  components component registry tooling\n" +
        "             (subcommands: index | check | audit; --repo <path>?)\n" +
        "  tag        operator-driven retro-tagging — insert <!-- cairn:decision -->\n" +
        "             markers after lines matching a regex pattern\n" +
        "             (--insert-marker <pattern> <file-or-dir>\n" +
        "              [--force] [--force-pattern] [--repo <path>])\n" +
        "  trace      pretty-print the unified live-session trace log\n" +
        "             (--tail | --session <id> | --repo <path> | --source <name> |\n" +
        "              --kind <substr> | --errors-only | --wide | --json)\n" +
        "  mission    mission lifecycle commands\n" +
        "             (subcommands: start | accept | get | list | advance | close | reopen)\n" +
        "  status-line  print formatted status line\n" +
        "               (--project-root <path>? --session-id <id>?\n" +
        "                or pipe Claude Code status-line payload JSON on stdin)",
    );
    process.exit(subcommand ? 2 : 1);
}
