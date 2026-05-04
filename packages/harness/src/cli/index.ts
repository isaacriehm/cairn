#!/usr/bin/env node
import { readStatusForCLI, VERSION } from "../index.js";
import { attentionCli } from "./attention.js";
import { doctorCli, fixCli } from "./doctor.js";
import { gcCli } from "./gc.js";
import { hookCli } from "./hook.js";
import { initCli } from "./init.js";
import { mcpCli } from "./mcp.js";
import { scopeCli } from "./scope.js";

const [, , subcommand, ...rest] = process.argv;

switch (subcommand) {
  case "init":
    await initCli(rest);
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
    process.stdout.write(`${readStatusForCLI(projectRoot)}\n`);
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
        "               (--project-root <path>?)",
    );
    process.exit(subcommand ? 2 : 1);
}
