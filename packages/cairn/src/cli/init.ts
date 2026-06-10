import { resolve } from "node:path";
import { runInit } from "@isaacriehm/cairn-core";

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
    "Usage: cairn init [target-dir] [options]\n" +
      "  [target-dir]      directory to adopt (default: cwd)\n" +
      "  --slug <name>     override the auto-derived project slug\n" +
      "  --force           overwrite existing .cairn/ files\n" +
      "  --skip-mirror     do not clone the parallel mirror checkout\n" +
      "  --skip-mapper     skip the Tier-2 mapper (project_globs left empty)\n" +
      "  --ghost           private, local-only adoption — nothing Cairn-shaped\n" +
      "                    touches this repo or its history (state lives out-of-repo)\n" +
      "  --no-prompt       run non-interactively (uses defaults; mapper skipped)\n" +
      "  --auto-e2e <v>    when --no-prompt, pick E2E setup answer (now|defer|skip)\n" +
      "\n" +
      "Detects stack signatures (typescript / python / ruby / go / rust /\n" +
      "elixir / unknown), proposes sensors, dispatches a one-time Tier-2\n" +
      "mapper to fill route_handler_globs / dto_globs / generator_source_globs\n" +
      "/ high_stakes_globs, seeds .cairn/ from the cairn\n" +
      "package templates, writes .cairn/config.yaml with the project-specific\n" +
      "overlay (mapper output baked in), patches the `<slug>:` block in\n" +
      ".cairn/config/workflow.md, and clones the parallel mirror at\n" +
      "~/.cairn/repos/<slug>/.",
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
  const skipMapper = parsed.flags["skip-mapper"] === true;
  const ghost = parsed.flags["ghost"] === true;
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

  let autoE2e: "now" | "defer" | "skip" | undefined;
  if (noPrompt) {
    if (autoE2eRaw === "now" || autoE2eRaw === "defer" || autoE2eRaw === "skip") {
      autoE2e = autoE2eRaw;
    } else {
      autoE2e = "defer";
    }
  }

  await runInit({
    repoRoot,
    ...(slugOverride !== undefined ? { slugOverride } : {}),
    mode: noPrompt ? "auto" : "interactive",
    force,
    skipMapper,
    ghost,
    ...(autoE2e !== undefined ? { autoE2e } : {}),
    ...(noPrompt ? { autoProceed: "a" as const } : {}),
  });
}
