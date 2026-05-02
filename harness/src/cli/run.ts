import { config as loadDotenv } from "dotenv";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { logger } from "../logger.js";
import {
  DiscordFrontendAdapter,
  StubFrontendAdapter,
  type FrontendAdapter,
} from "../frontend/index.js";
import { normalizeProjectName, readMirrorRecord } from "../mirror/index.js";

const log = logger("cli.run");

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
    "Usage: harness run --project <slug> [--frontend <name[,name...]>] [--repo-root <path>]\n" +
      "  --project    project slug (matches `harness mirror init --project ...`)\n" +
      "  --frontend   adapter name(s): discord | stub (default: discord)\n" +
      "  --repo-root  override repo root (default: mirror path from state, then cwd)\n" +
      "\n" +
      "Phase 5: brings up registered adapters and idles. Orchestrator (Phase 8)\n" +
      "is not yet wired — adapter events drop to .harness/inbox/<...>.json.",
  );
  process.exit(1);
}

function buildAdapter(args: { name: string; repoRoot: string }): FrontendAdapter {
  const { name, repoRoot } = args;
  switch (name) {
    case "discord": {
      const token = process.env["DISCORD_BOT_TOKEN"];
      const guildId = process.env["DISCORD_GUILD_ID"];
      if (!token || !guildId) {
        throw new Error(
          "discord adapter requires DISCORD_BOT_TOKEN and DISCORD_GUILD_ID in env (harness/.env)",
        );
      }
      return new DiscordFrontendAdapter({
        repoRoot,
        token,
        guildId,
        ownerUserIdsEnv: process.env["DISCORD_OWNER_USER_IDS"],
      });
    }
    case "stub":
      return new StubFrontendAdapter({ repoRoot });
    default:
      throw new Error(`unknown frontend adapter: ${name}`);
  }
}

function resolveRepoRoot(args: { flag?: string; project: string }): string {
  if (args.flag) return resolve(args.flag);
  const record = readMirrorRecord(args.project);
  if (record) return record.mirrorPath;
  return process.cwd();
}

function loadEnvFiles(): string[] {
  // Try, in order: explicit .env at cwd, harness/.env (when invoked from the
  // monorepo root above the package), then the pkg's own .env (npm-link dev).
  const here = dirname(fileURLToPath(import.meta.url));
  const pkgRoot = resolve(here, "..", "..");
  const candidates = Array.from(
    new Set([
      resolve(process.cwd(), ".env"),
      resolve(process.cwd(), "harness", ".env"),
      resolve(pkgRoot, ".env"),
    ]),
  );
  const loaded: string[] = [];
  for (const path of candidates) {
    if (existsSync(path)) {
      const result = loadDotenv({ path });
      if (!result.error) loaded.push(path);
    }
  }
  return loaded;
}

export async function runCli(argv: string[]): Promise<void> {
  const { flags } = parseArgs(argv);
  const envFiles = loadEnvFiles();
  if (envFiles.length === 0) {
    log.warn("no .env loaded — adapters needing secrets will fail");
  } else {
    log.info({ envFiles }, "loaded env files");
  }

  const project = typeof flags["project"] === "string" ? flags["project"] : undefined;
  if (!project) usage();
  const projectName = normalizeProjectName(project);

  const repoRoot = resolveRepoRoot({
    project: projectName,
    ...(typeof flags["repo-root"] === "string" ? { flag: flags["repo-root"] } : {}),
  });

  const frontendArg = typeof flags["frontend"] === "string" ? flags["frontend"] : "discord";
  const adapterNames = frontendArg
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const adapters = adapterNames.map((name) => buildAdapter({ name, repoRoot }));
  for (const adapter of adapters) {
    await adapter.start();
    log.info({ name: adapter.name }, "frontend adapter started");
  }

  console.log(
    `harness run: project=${projectName} repoRoot=${repoRoot} adapters=${adapterNames.join(",")} (Ctrl-C to stop)`,
  );

  let shuttingDown = false;
  const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, "shutdown signal received");
    for (const adapter of adapters) {
      try {
        await adapter.stop();
      } catch (err) {
        log.error({ err: String(err), adapter: adapter.name }, "adapter stop threw");
      }
    }
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await new Promise<void>(() => {
    /* idle until signal */
  });
}
