import { resolve } from "node:path";
import { logger, createContext, startMcpServer } from "@isaacriehm/cairn-core";

const log = logger("cli.mcp");

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
    "Usage: harness mcp serve [options]\n" +
      "  --repo-root <path>   adopted-project repo root (default: HARNESS_REPO_ROOT or cwd)\n" +
      "  --run-id <id>        scope telemetry to a run id (default: top-level)\n" +
      "\n" +
      "Speaks MCP over stdio. Register in .claude/settings.json mcpServers block.",
  );
  process.exit(1);
}

export async function mcpCli(argv: string[]): Promise<void> {
  const { positional, flags } = parseArgs(argv);
  if (positional[0] !== "serve") usage();

  const repoRoot =
    typeof flags["repo-root"] === "string"
      ? resolve(flags["repo-root"])
      : process.env["HARNESS_REPO_ROOT"]
        ? resolve(process.env["HARNESS_REPO_ROOT"])
        : process.cwd();
  const runId = typeof flags["run-id"] === "string" ? flags["run-id"] : undefined;

  const ctx = createContext({
    repoRoot,
    ...(runId !== undefined ? { runId } : {}),
  });
  const { close } = await startMcpServer({ ctx });

  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    log.info({ signal }, "shutdown signal received");
    await close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await new Promise<void>(() => {
    /* event loop kept alive by the stdio transport */
  });
}
