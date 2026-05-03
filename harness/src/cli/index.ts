#!/usr/bin/env node
import { VERSION } from "../index.js";
import { gcCli } from "./gc.js";
import { mcpCli } from "./mcp.js";
import { mirrorCli } from "./mirror.js";
import { runCli } from "./run.js";
import { watchCli } from "./watch.js";

const [, , subcommand, ...rest] = process.argv;

switch (subcommand) {
  case "init":
    console.error(`harness ${subcommand}: not implemented (Phase 16 scaffold).`);
    process.exit(2);
  case "run":
    await runCli(rest);
    break;
  case "watch":
    await watchCli(rest);
    break;
  case "mirror":
    await mirrorCli(rest);
    break;
  case "mcp":
    await mcpCli(rest);
    break;
  case "gc":
    await gcCli(rest);
    break;
  case "--version":
  case "-v":
    console.log(VERSION);
    process.exit(0);
  default:
    console.error(
      "Usage: harness <command>\n" +
        "  watch     long-lived grounding daemon\n" +
        "            (--project <slug> [--repo-root <path>])\n" +
        "  run       orchestrator + frontend adapters\n" +
        "  init      adopt this harness into a project\n" +
        "  mirror    manage the parallel mirror checkout\n" +
        "            (subcommands: init | sync | push | status)\n" +
        "  mcp       MCP server (stdio transport)\n" +
        "            (subcommands: serve)\n" +
        "  gc        garbage-collection passes against the canonical zone\n" +
        "            (subcommands: sweep | run)",
    );
    process.exit(subcommand ? 2 : 1);
}
