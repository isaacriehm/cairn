#!/usr/bin/env node
import { VERSION } from "../index.js";

const [, , subcommand] = process.argv;

switch (subcommand) {
  case "watch":
  case "run":
  case "init":
    console.error(`harness ${subcommand}: not implemented (Phase 0 scaffold).`);
    process.exit(2);
  case "--version":
  case "-v":
    console.log(VERSION);
    process.exit(0);
  default:
    console.error(
      "Usage: harness <watch | run | init>\n" +
        "  watch  long-lived grounding daemon\n" +
        "  run    orchestrator + frontend adapters\n" +
        "  init   adopt this harness into a project",
    );
    process.exit(subcommand ? 2 : 1);
}
