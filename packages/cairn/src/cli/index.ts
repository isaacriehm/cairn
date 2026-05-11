#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type CtxMeterInput,
  readStatusForCLI,
  resolveRepoRoot,
  VERSION,
} from "../index.js";
import { alignCli } from "./align.js";
import { attentionCli } from "./attention.js";
import { baselineCli } from "./baseline.js";
import { doctorCli } from "./doctor.js";
import { fixCli } from "./fix.js";
import { gcCli } from "./gc.js";
import { hookCli } from "./hook.js";
import { initCli } from "./init.js";
import { joinCli } from "./join.js";
import { mcpCli } from "./mcp.js";
import { missionCli } from "./mission.js";
import { scopeCli } from "./scope.js";
import { sensorRunCli } from "./sensor-run.js";
import { tagCli } from "./tag.js";
import { traceCli } from "./trace.js";

interface StatusLinePayload {
  sessionId: string | null;
  ctx: CtxMeterInput | null;
}

function decodePayload(text: string): StatusLinePayload {
  if (text.length === 0) return { sessionId: null, ctx: null };
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { sessionId: null, ctx: null };
  }
  const sid = parsed["session_id"];
  const sessionId = typeof sid === "string" && sid.length > 0 ? sid : null;

  // Single source of truth: Claude Code's `context_window` block with
  // `remaining_percentage` + `total_tokens`. CC sets `total_tokens` to
  // the active model's window (e.g. 200k Sonnet, 1M Opus-1m) so we
  // trust it verbatim — no model-keyed fallback, no transcript parsing.
  // If CC omits the block, ctx stays null and the Stop hook + meter
  // skip the threshold check rather than firing on a guessed number.
  const cw = parsed["context_window"];
  let ctx: CtxMeterInput | null = null;
  if (cw !== null && typeof cw === "object") {
    const w = cw as Record<string, unknown>;
    const remaining = w["remaining_percentage"];
    const total = w["total_tokens"];
    if (typeof remaining === "number" && typeof total === "number" && total > 0) {
      const usedPct = Math.max(0, Math.min(100, 100 - remaining));
      const usedTokens = Math.round((total * usedPct) / 100);
      ctx = { usedPct, usedTokens, windowTokens: total };
    }
  }
  return { sessionId, ctx };
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
  if (!existsSync(join(projectRoot, ".cairn"))) return;
  try {
    const dir = join(projectRoot, ".cairn", "sessions", sessionId);
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
      // disappears intermittently" symptom. Walk up the same way the
      // SessionStart / Stop / UserPromptSubmit hooks do.
      const cwd = process.cwd();
      projectRoot = resolveRepoRoot(cwd) ?? cwd;
    }
    const sessionIdIdx = rest.indexOf("--session-id");
    let sessionId: string | null = null;
    let ctx: CtxMeterInput | null = null;
    if (sessionIdIdx !== -1 && sessionIdIdx + 1 < rest.length) {
      const candidate = rest[sessionIdIdx + 1];
      if (candidate === undefined) {
        console.error("--session-id requires a value");
        process.exit(2);
      }
      sessionId = candidate;
    } else if (!process.stdin.isTTY) {
      const payload = await readStatusLinePayload();
      sessionId = payload.sessionId;
      ctx = payload.ctx;
    }
    if (sessionId !== null && ctx !== null) {
      persistCtxSnapshot(projectRoot, sessionId, ctx);
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
        "             (--repo <path>?)\n" +
        "  fix        auto-resolve doctor warnings where possible\n" +
        "             (--repo <path>?)\n" +
        "  attention  list pending DEC drafts + baseline sensor findings\n" +
        "             (--repo <path>?)\n" +
        "  align      alignment commands\n" +
        "             (subcommands: drain — SessionStart drain, plan §4.3)\n" +
        "  baseline   re-run the synthetic-diff sensor sweep post-adoption\n" +
        "             (--force? --repo <path>?)\n" +
        "  sensor-run git-hook sensor sweep (--staged | --commit-msg <path>)\n" +
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
