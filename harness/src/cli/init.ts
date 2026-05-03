import { resolve } from "node:path";
import { runInit } from "../init/index.js";

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
    "Usage: harness init [target-dir] [options]\n" +
      "  [target-dir]      directory to adopt (default: cwd)\n" +
      "  --slug <name>     override the auto-derived project slug\n" +
      "  --force           overwrite existing .harness/ files\n" +
      "  --skip-mirror     do not clone the parallel mirror checkout\n" +
      "  --no-prompt       run non-interactively (uses defaults)\n" +
      "  --auto-e2e <v>    when --no-prompt, pick E2E setup answer (now|defer|skip)\n" +
      "\n" +
      "Detects stack signatures (typescript / python / ruby / go / rust /\n" +
      "elixir / unknown), proposes sensors, seeds .harness/ from the\n" +
      "harness package templates, writes .harness/config.yaml with the\n" +
      "project-specific overlay, and clones the parallel mirror at\n" +
      "~/.local/harness/repos/<slug>/. Two operator dialogs (proceed? +\n" +
      "E2E setup), under L44's 2-question cap.",
  );
  process.exit(1);
}

export async function initCli(argv: string[]): Promise<void> {
  const parsed = parseArgs(argv);
  if (parsed.flags["help"] === true || parsed.flags["h"] === true) usage();

  const targetArg = parsed.positional[0];
  const repoRoot = targetArg ? resolve(targetArg) : process.cwd();

  const slugOverride =
    typeof parsed.flags["slug"] === "string" ? parsed.flags["slug"] : undefined;
  const force = parsed.flags["force"] === true;
  const skipMirror = parsed.flags["skip-mirror"] === true;
  const noPrompt = parsed.flags["no-prompt"] === true;
  const autoE2eRaw =
    typeof parsed.flags["auto-e2e"] === "string"
      ? parsed.flags["auto-e2e"]
      : "defer";
  if (
    noPrompt &&
    autoE2eRaw !== "now" &&
    autoE2eRaw !== "defer" &&
    autoE2eRaw !== "skip"
  ) {
    console.error(`--auto-e2e must be one of: now | defer | skip (got ${autoE2eRaw})`);
    process.exit(1);
  }

  await runInit({
    repoRoot,
    ...(slugOverride !== undefined ? { slugOverride } : {}),
    mode: noPrompt ? "auto" : "interactive",
    force,
    skipMirror,
    ...(noPrompt ? { autoE2e: autoE2eRaw as "now" | "defer" | "skip" } : {}),
    ...(noPrompt ? { autoProceed: "a" as const } : {}),
  });
}
