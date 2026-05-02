#!/usr/bin/env node
import { VERSION } from "../index.js";
import { mirrorCli } from "./mirror.js";

const [, , subcommand, ...rest] = process.argv;

switch (subcommand) {
  case "watch":
  case "run":
  case "init":
    console.error(`harness ${subcommand}: not implemented (Phase 0 scaffold).`);
    process.exit(2);
  case "mirror":
    await mirrorCli(rest);
    break;
  case "--version":
  case "-v":
    console.log(VERSION);
    process.exit(0);
  default:
    console.error(
      "Usage: harness <command>\n" +
        "  watch     long-lived grounding daemon\n" +
        "  run       orchestrator + frontend adapters\n" +
        "  init      adopt this harness into a project\n" +
        "  mirror    manage the parallel mirror checkout\n" +
        "            (subcommands: init | sync | push | status)",
    );
    process.exit(subcommand ? 2 : 1);
}
