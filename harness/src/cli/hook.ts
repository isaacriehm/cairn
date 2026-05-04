/**
 * `harness hook <event>` — Claude Code hook runners.
 *
 * Each subcommand reads the hook event JSON payload from stdin per
 * Claude Code's hook contract and emits a Shape-B JSON response on
 * stdout (`{ continue, hookSpecificOutput: { hookEventName,
 * additionalContext } }`).
 *
 *   harness hook session-start
 *   harness hook read-enrich    PostToolUse on Read — citation legend
 *   harness hook write-guard    PostToolUse on Write/Edit — copy-safety + scope reminder
 *
 * Future events (locked direction, not yet implemented):
 *   harness hook user-prompt-submit
 *   harness hook stop
 *
 * PreToolUse is intentionally NOT supported (locked decision per
 * RESUME §2 — soft enforcement via SessionStart instruction +
 * harness_query_history MCP tool).
 */

import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  buildSessionStartContext,
  resolveRepoRoot,
  runReadEnricher,
  runWriteGuardian,
} from "@devplusllc/harness-core";

const HARNESS_HOOK_VERSION = "0.0.0";

interface ClaudeHookPayload {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  source?: string;
}

interface SessionStartShapeBOutput {
  continue: boolean;
  hookSpecificOutput: {
    hookEventName: "SessionStart";
    additionalContext: string;
  };
}

function readStdin(): Promise<string> {
  return new Promise((resolveP) => {
    const chunks: Buffer[] = [];
    process.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on("end", () => {
      resolveP(Buffer.concat(chunks).toString("utf8"));
    });
    process.stdin.on("error", () => {
      resolveP("");
    });
    if (process.stdin.isTTY) {
      // No piped input — Claude Code always pipes; this only matters in
      // dev/test invocations. Resolve empty so callers can still see the
      // empty-payload behavior.
      resolveP("");
    }
  });
}

function parseHookPayload(text: string): ClaudeHookPayload {
  if (text.trim().length === 0) return {};
  try {
    const parsed = JSON.parse(text) as ClaudeHookPayload;
    return typeof parsed === "object" && parsed !== null ? parsed : {};
  } catch {
    return {};
  }
}

function emitShapeB(output: SessionStartShapeBOutput): void {
  process.stdout.write(JSON.stringify(output));
  process.stdout.write("\n");
}

function recordTelemetry(args: {
  repoRoot: string | null;
  sessionId: string | null;
  source: string | null;
  sectionsRendered: string[];
  sectionsDropped: string[];
  totalChars: number;
  durationMs: number;
  warnings: string[];
}): void {
  try {
    const dir = resolve(homedir(), ".local", "harness", "state");
    if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
    const path = join(dir, "session-start.jsonl");
    const row = {
      ts: new Date().toISOString(),
      hook_version: HARNESS_HOOK_VERSION,
      ...(args.sessionId !== null ? { session_id: args.sessionId } : {}),
      ...(args.source !== null ? { source: args.source } : {}),
      ...(args.repoRoot !== null ? { repo_root: args.repoRoot } : {}),
      sections_rendered: args.sectionsRendered,
      sections_dropped: args.sectionsDropped,
      total_chars: args.totalChars,
      duration_ms: args.durationMs,
      warnings: args.warnings,
    };
    appendFileSync(path, `${JSON.stringify(row)}\n`, "utf8");
  } catch {
    // Telemetry must never block the hook.
  }
}

async function sessionStartHook(): Promise<void> {
  const startedAt = Date.now();
  const raw = await readStdin();
  const payload = parseHookPayload(raw);
  const sessionId = typeof payload.session_id === "string" ? payload.session_id : null;
  const source = typeof payload.source === "string" ? payload.source : null;
  const cwdInput = typeof payload.cwd === "string" ? payload.cwd : process.cwd();
  const repoRoot = resolveRepoRoot(cwdInput);

  if (repoRoot === null) {
    emitShapeB({
      continue: true,
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: "",
      },
    });
    recordTelemetry({
      repoRoot: null,
      sessionId,
      source,
      sectionsRendered: [],
      sectionsDropped: [],
      totalChars: 0,
      durationMs: Date.now() - startedAt,
      warnings: ["no_harness_dir_found"],
    });
    return;
  }

  // Adapter heuristic: when source === "resume" the prior session's
  // transcript is restored, so a thin payload (header + reminder + tools
  // + current task) is plenty.
  const isResume = source === "resume";

  const buildArgs: Parameters<typeof buildSessionStartContext>[0] = {
    repoRoot,
  };
  if (isResume) buildArgs.maxChars = 4_000;
  if (source !== null) buildArgs.source = source;
  if (cwdInput !== repoRoot && cwdInput.startsWith(repoRoot)) {
    buildArgs.scopeRelPath = cwdInput.slice(repoRoot.length + 1);
  }
  const result = await buildSessionStartContext(buildArgs);

  emitShapeB({
    continue: true,
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: result.additionalContext,
    },
  });

  recordTelemetry({
    repoRoot,
    sessionId,
    source,
    sectionsRendered: result.sectionsRendered,
    sectionsDropped: result.sectionsDropped,
    totalChars: result.totalChars,
    durationMs: Date.now() - startedAt,
    warnings: result.warnings,
  });
}

function usage(): never {
  console.error(
    "Usage: harness hook <event>\n" +
      "  session-start    SessionStart hook (default)\n" +
      "  read-enrich      PostToolUse on Read — citation legend enricher\n" +
      "  write-guard      PostToolUse on Write/Edit — copy-safety + scope reminder\n" +
      "\n" +
      "Reads the Claude Code hook payload JSON on stdin, emits the\n" +
      "Shape-B response on stdout. Designed to be wired in\n" +
      "`.claude/settings.json` under `hooks.SessionStart` / `hooks.PostToolUse`.\n",
  );
  process.exit(1);
}

export async function hookCli(argv: string[]): Promise<void> {
  const sub = argv[0];
  switch (sub) {
    case undefined:
    case "session-start":
      await sessionStartHook();
      return;
    case "read-enrich":
      await runReadEnricher();
      return;
    case "write-guard":
      await runWriteGuardian();
      return;
    default:
      console.error(`harness hook: unknown event "${sub}"`);
      usage();
  }
}
