import { resolve } from "node:path";
import {
  ensureMirror,
  normalizeProjectName,
  pushMirror,
  readMirrorRecord,
  syncMirror,
} from "../mirror/index.js";

interface ParsedFlags {
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedFlags {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i += 1;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function usage(): never {
  console.error(
    "Usage: harness mirror <subcommand> [options]\n" +
      "  init    --project <name> --origin <url> --user-tree <path> [--branch <name>]\n" +
      "  sync    --project <name> [--branch <name>]\n" +
      "  push    --project <name> [--branch <name>] [--force]\n" +
      "  status  --project <name>",
  );
  process.exit(1);
}

function require_(flags: ParsedFlags["flags"], key: string): string {
  const value = flags[key];
  if (typeof value !== "string" || value.length === 0) {
    console.error(`Missing required --${key}`);
    usage();
  }
  return value;
}

export async function mirrorCli(argv: string[]): Promise<void> {
  const { positional, flags } = parseArgs(argv);
  const sub = positional[0];

  switch (sub) {
    case "init": {
      const project = normalizeProjectName(require_(flags, "project"));
      const origin = require_(flags, "origin");
      const userTree = resolve(require_(flags, "user-tree"));
      const defaultBranch = typeof flags["branch"] === "string" ? flags["branch"] : undefined;
      const record = await ensureMirror({
        projectName: project,
        originUrl: origin,
        userTreePath: userTree,
        ...(defaultBranch !== undefined ? { defaultBranch } : {}),
      });
      console.log(JSON.stringify(record, null, 2));
      return;
    }
    case "sync": {
      const project = normalizeProjectName(require_(flags, "project"));
      const branch = typeof flags["branch"] === "string" ? flags["branch"] : undefined;
      const result = await syncMirror({
        projectName: project,
        ...(branch !== undefined ? { branch } : {}),
      });
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    case "push": {
      const project = normalizeProjectName(require_(flags, "project"));
      const branch = typeof flags["branch"] === "string" ? flags["branch"] : undefined;
      const force = flags["force"] === true;
      const result = await pushMirror({
        projectName: project,
        ...(branch !== undefined ? { branch } : {}),
        force,
      });
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    case "status": {
      const project = normalizeProjectName(require_(flags, "project"));
      const record = readMirrorRecord(project);
      if (!record) {
        console.log(JSON.stringify({ projectName: project, status: "not_adopted" }, null, 2));
        process.exit(0);
      }
      console.log(JSON.stringify({ status: "adopted", record }, null, 2));
      return;
    }
    default:
      usage();
  }
}
