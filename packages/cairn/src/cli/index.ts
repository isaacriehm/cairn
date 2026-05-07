#!/usr/bin/env node
import { type CtxMeterInput, readStatusForCLI, VERSION } from "../index.js";
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

  const cw = parsed["context_window"];
  let ctx: CtxMeterInput | null = null;
  if (cw !== null && typeof cw === "object") {
    const w = cw as Record<string, unknown>;
    const remaining = w["remaining_percentage"];
    const total = w["total_tokens"];
    if (typeof remaining === "number" && typeof total === "number" && total > 0) {
      const usedPct = Math.max(0, Math.min(100, 100 - remaining));
      const usedTokens = Math.round((total * usedPct) / 100);
      ctx = { usedPct, usedTokens };
    }
  }
  return { sessionId, ctx };
}

async function readStatusLinePayload(): Promise<StatusLinePayload> {
  return new Promise((resolveP) => {
    const chunks: Buffer[] = [];
    let settled = false;
    const settle = (value: StatusLinePayload): void => {
      if (settled) return;
      settled = true;
      resolveP(value);
    };
    process.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on("end", () => {
      settle(decodePayload(Buffer.concat(chunks).toString("utf8").trim()));
    });
    process.stdin.on("error", () => settle({ sessionId: null, ctx: null }));
    setTimeout(() => settle({ sessionId: null, ctx: null }), 250);
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
      projectRoot = process.cwd();
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
        "  align      Layer C/D alignment commands\n" +
        "             (subcommands: drain — SessionStart drain, plan §4.3)\n" +
        "  baseline   re-run the synthetic-diff sensor sweep post-adoption\n" +
        "             (--force? --repo <path>?)\n" +
        "  hook       Claude Code hook runner (stdin = hook payload JSON)\n" +
        "             (subcommands: session-start | read-enrich | write-guard)\n" +
        "  sensor-run git-hook sensor sweep (--staged | --commit-msg <path>)\n" +
        "  tag        operator-driven retro-tagging — insert <!-- cairn:decision -->\n" +
        "             markers after lines matching a regex pattern\n" +
        "             (--insert-marker <pattern> <file-or-dir>\n" +
        "              [--force] [--force-pattern] [--repo <path>])\n" +
        "  trace      pretty-print the unified live-session trace log\n" +
        "             (--tail | --session <id> | --repo <path> | --source <name> |\n" +
        "              --kind <substr> | --errors-only | --wide | --json)\n" +
        "  status-line  print formatted status line\n" +
        "               (--project-root <path>? --session-id <id>?\n" +
        "                or pipe Claude Code status-line payload JSON on stdin)",
    );
    process.exit(subcommand ? 2 : 1);
}
