#!/usr/bin/env node
import { readStatusForCLI, VERSION } from "../index.js";
import { attentionCli } from "./attention.js";
import { doctorCli, fixCli } from "./doctor.js";
import { gcCli } from "./gc.js";
import { hookCli } from "./hook.js";
import { initCli } from "./init.js";
import { joinCli } from "./join.js";
import { mcpCli } from "./mcp.js";
import { scopeCli } from "./scope.js";

async function readSessionIdFromStdin(): Promise<string | null> {
  return new Promise((resolveP) => {
    const chunks: Buffer[] = [];
    let settled = false;
    const settle = (value: string | null): void => {
      if (settled) return;
      settled = true;
      resolveP(value);
    };
    process.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (text.length === 0) return settle(null);
      try {
        const parsed = JSON.parse(text) as { session_id?: unknown };
        if (typeof parsed?.session_id === "string" && parsed.session_id.length > 0) {
          return settle(parsed.session_id);
        }
      } catch {
        // fall through to null
      }
      settle(null);
    });
    process.stdin.on("error", () => settle(null));
    setTimeout(() => settle(null), 250);
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
  case "hook":
    await hookCli(rest);
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
    if (sessionIdIdx !== -1 && sessionIdIdx + 1 < rest.length) {
      const candidate = rest[sessionIdIdx + 1];
      if (candidate === undefined) {
        console.error("--session-id requires a value");
        process.exit(2);
      }
      sessionId = candidate;
    } else if (!process.stdin.isTTY) {
      sessionId = await readSessionIdFromStdin();
    }
    process.stdout.write(`${readStatusForCLI(projectRoot, sessionId)}\n`);
    process.exit(0);
  }
  case "--version":
  case "-v":
    console.log(VERSION);
    process.exit(0);
  default:
    console.error(
      "Usage: harness <command>\n" +
        "  init       adopt this harness into a project\n" +
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
        "  hook       Claude Code hook runner (stdin = hook payload JSON)\n" +
        "             (subcommands: session-start | read-enrich | write-guard)\n" +
        "  status-line  print formatted status line\n" +
        "               (--project-root <path>? --session-id <id>?\n" +
        "                or pipe Claude Code status-line payload JSON on stdin)",
    );
    process.exit(subcommand ? 2 : 1);
}
