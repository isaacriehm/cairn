/**
 * `harness task` — terminal-native task submit.
 *
 * Drops a `task` inbox row to the running daemon's mirror checkout. The
 * orchestrator picks it up via chokidar (or the periodic poll). No
 * Discord interaction required.
 *
 * Project resolution order:
 *   1. --project <slug> flag
 *   2. `.harness/config.yaml` in the current working directory
 *   3. error out
 *
 * Operator workflow:
 *   cd ~/myapp
 *   harness task "build feature X" --acceptance "must do Y" --acceptance "must not Z"
 *   # daemon picks up; status visible via /status in Discord
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { writeInboxRow } from "../frontend/index.js";
import {
  normalizeProjectName,
  readMirrorRecord,
} from "../mirror/index.js";

interface ParsedFlags {
  positional: string[];
  flags: Record<string, string | string[] | boolean>;
}

function parseArgs(argv: string[]): ParsedFlags {
  const positional: string[] = [];
  const flags: Record<string, string | string[] | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === undefined) continue;
    if (arg.startsWith("--")) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        const existing = flags[key];
        if (Array.isArray(existing)) {
          existing.push(next);
        } else if (typeof existing === "string") {
          flags[key] = [existing, next];
        } else {
          flags[key] = next;
        }
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
    "Usage: harness task <body> [options]\n" +
      "  <body>                  task description (free text)\n" +
      "  --project <slug>        project slug (default: read .harness/config.yaml in cwd)\n" +
      "  --title <s>             override title (default: first 80 chars of body)\n" +
      "  --acceptance <s>        acceptance criterion (repeat for multiple)\n" +
      "  --ship-anyway           bypass spec-tightener gate (logged)\n" +
      "  --target <glob>         target path glob (repeat for multiple)\n" +
      "\n" +
      "Drops a task inbox row to the daemon's mirror. Orchestrator picks it\n" +
      "up automatically (no Discord required). Watch progress via Discord\n" +
      "/status or `tail -F .harness/runs/active/<run-id>/log.jsonl`.",
  );
  process.exit(1);
}

function readProjectFromCwd(): string | undefined {
  const configPath = resolve(process.cwd(), ".harness", "config.yaml");
  if (!existsSync(configPath)) return undefined;
  try {
    const text = readFileSync(configPath, "utf8");
    const parsed = parseYaml(text) as Record<string, unknown>;
    const slug = parsed["slug"];
    return typeof slug === "string" ? slug : undefined;
  } catch {
    return undefined;
  }
}

function asStringArray(v: string | string[] | boolean | undefined): string[] {
  if (Array.isArray(v)) return v;
  if (typeof v === "string") return [v];
  return [];
}

export async function taskCli(argv: string[]): Promise<void> {
  const { positional, flags } = parseArgs(argv);
  if (flags["help"] === true || flags["h"] === true) usage();
  const body = positional.join(" ").trim();
  if (body.length === 0) {
    console.error("harness task: <body> is required\n");
    usage();
  }

  const slugRaw =
    typeof flags["project"] === "string"
      ? flags["project"]
      : readProjectFromCwd();
  if (slugRaw === undefined || slugRaw.length === 0) {
    console.error(
      "harness task: --project required (no .harness/config.yaml in cwd)",
    );
    process.exit(2);
  }
  const project = normalizeProjectName(slugRaw);

  const record = readMirrorRecord(project);
  if (record === null) {
    console.error(
      `harness task: no mirror record for project "${project}". Run "harness init" + "harness mirror init --project ${project}" first.`,
    );
    process.exit(2);
  }

  const titleRaw =
    typeof flags["title"] === "string" ? flags["title"] : undefined;
  const title = titleRaw ?? body.slice(0, 80);
  const acceptance = asStringArray(flags["acceptance"]);
  const targetGlobs = asStringArray(flags["target"]);
  const shipAnyway = flags["ship-anyway"] === true;

  const taskPayload: Record<string, unknown> = {
    task: {
      rawText: body,
      intent: "code_task",
      authorId: "cli",
      receivedAt: new Date().toISOString(),
    },
    title,
    ...(acceptance.length > 0 ? { acceptance_criteria: acceptance } : {}),
    ...(targetGlobs.length > 0 ? { target_path_globs: targetGlobs } : {}),
    ...(shipAnyway ? { ship_anyway: true } : {}),
  };

  const file = await writeInboxRow({
    repoRoot: record.mirrorPath,
    source: "cli",
    kind: "task",
    payload: taskPayload,
  });

  process.stdout.write(
    `task queued for project "${project}"\n  inbox: ${file}\n  title: ${title}\n  body:  ${body.slice(0, 200)}${body.length > 200 ? "…" : ""}\n  acceptance: ${acceptance.length}\n  ship-anyway: ${shipAnyway}\n`,
  );
}
