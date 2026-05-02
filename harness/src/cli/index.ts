#!/usr/bin/env node
import { VERSION } from "../index.js";
import { mcpCli } from "./mcp.js";
import { mirrorCli } from "./mirror.js";
import { watchCli } from "./watch.js";

const [, , subcommand, ...rest] = process.argv;

switch (subcommand) {
  case "run":
  case "init":
    console.error(`harness ${subcommand}: not implemented (Phase 0 scaffold).`);
    process.exit(2);
  case "watch":
    await watchCli(rest);
    break;
  case "mirror":
    await mirrorCli(rest);
    break;
  case "mcp":
    await mcpCli(rest);
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
        "            (subcommands: serve)",
    );
    process.exit(subcommand ? 2 : 1);
}
