import { resolve } from "node:path";
import { runJoin } from "@isaacriehm/cairn-core";

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
    "Usage: cairn join [target-dir] [options]\n" +
      "  [target-dir]      directory to bootstrap (default: cwd)\n" +
      "  --dry-run         report detection only — no fs / git side-effects\n" +
      "  --strict          exit non-zero on any warning (e.g. version mismatch)\n" +
      "  --json            print the structured result as JSON\n" +
      "\n" +
      "Per PLUGIN_ARCHITECTURE §17 Layer 2. Idempotent — safe to re-run on\n" +
      "every install. Configures git core.hooksPath, chmods the seeded git\n" +
      "hooks, and ensures the per-clone session-state directory exists.",
  );
  process.exit(1);
}

const STATUS_GLYPH: Record<string, string> = {
  ok: "✓",
  skipped: "○",
  warn: "⚠",
  error: "✗",
};

export async function joinCli(argv: string[]): Promise<void> {
  const parsed = parseArgs(argv);
  if (parsed.flags["help"] === true || parsed.flags["h"] === true) usage();

  const target = parsed.positional[0];
  const repoRoot = target ? resolve(target) : undefined;

  const result = runJoin({
    cwd: process.cwd(),
    ...(repoRoot !== undefined ? { repoRoot } : {}),
    dryRun: parsed.flags["dry-run"] === true,
    strict: parsed.flags["strict"] === true,
  });

  if (parsed.flags["json"] === true) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    if (result.repoRoot !== null) {
      console.log(`cairn join — ${result.repoRoot}`);
      console.log(
        `  cli=${result.cliVersion} project=${result.projectCairnVersion ?? "(unset)"}`,
      );
    }
    for (const step of result.steps) {
      const statusValue: string = step.status;
      const glyph = STATUS_GLYPH[statusValue] ?? "·";
      console.log(`  ${glyph} ${step.step.padEnd(20)}  ${step.detail}`);
    }
    if (result.bootstrapped) {
      console.log("\ncairn join: bootstrapped");
    } else {
      console.log("\ncairn join: incomplete — see errors above");
    }
  }

  const hasError = result.steps.some((s) => s.status === "error");
  const hasWarn = result.steps.some((s) => s.status === "warn");
  if (hasError) process.exit(1);
  if (parsed.flags["strict"] === true && hasWarn) process.exit(2);
  process.exit(0);
}
