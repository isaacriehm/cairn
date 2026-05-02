import { resolve } from "node:path";
import { logger } from "../logger.js";
import {
  normalizeProjectName,
  readMirrorRecord,
} from "../mirror/index.js";
import { startDaemon } from "../watch/index.js";

const log = logger("cli.watch");

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
    "Usage: harness watch --project <name> [--repo-root <path>] [--debounce-ms <n>]\n" +
      "  --project      project slug (matches `harness mirror init --project ...`)\n" +
      "  --repo-root    target dir to watch (default: mirror path from state)\n" +
      "  --debounce-ms  debounce window before regen fires (default: 500)",
  );
  process.exit(1);
}

export async function watchCli(argv: string[]): Promise<void> {
  const { flags } = parseArgs(argv);
  const project = typeof flags["project"] === "string" ? flags["project"] : undefined;
  if (project === undefined) usage();
  const projectName = normalizeProjectName(project);
  const debounceMs =
    typeof flags["debounce-ms"] === "string" ? Number.parseInt(flags["debounce-ms"], 10) : 500;

  let repoRoot: string | undefined;
  if (typeof flags["repo-root"] === "string") {
    repoRoot = resolve(flags["repo-root"]);
  } else {
    const record = readMirrorRecord(projectName);
    if (!record) {
      console.error(
        `No mirror record for "${projectName}". Run \`harness mirror init\` first or pass --repo-root explicitly.`,
      );
      process.exit(1);
    }
    repoRoot = record.mirrorPath;
  }

  const handle = await startDaemon({
    projectName,
    repoRoot,
    debounceMs: Number.isFinite(debounceMs) ? debounceMs : 500,
  });

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    log.info({ signal }, "shutdown signal received");
    await handle.stop();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  console.log(`harness watch: project=${projectName} root=${repoRoot} (Ctrl-C to stop)`);
  // Keep the event loop alive until a signal arrives.
  await new Promise<void>(() => {
    /* never resolves */
  });
}
