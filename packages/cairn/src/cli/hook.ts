/**
 * `harness hook <event>` — Claude Code hook runners (umbrella CLI form).
 *
 * The plugin manifest invokes the bin entrypoints in
 * `harness-core/dist/hooks/<event>.js` directly; this CLI subcommand is
 * the equivalent path for adopters running the umbrella CLI without the
 * plugin (e.g. terminal-side debug). Both routes call the same runners.
 *
 *   harness hook session-start
 *   harness hook session-end    cleanup per-session state dir
 *   harness hook stop           assistant turn end — drain events + heartbeat
 *   harness hook read-enrich    PostToolUse on Read — citation legend
 *   harness hook write-guard    PostToolUse on Write/Edit — copy-safety + scope reminder
 *
 * PreToolUse is intentionally NOT supported (locked decision per
 * RESUME §2 — bricks the session if the hook fails).
 */

import {
  runReadEnricher,
  runSessionEndHook,
  runSessionStartHook,
  runStopHook,
  runWriteGuardian,
} from "@isaacriehm/cairn-core";

function usage(): never {
  console.error(
    "Usage: harness hook <event>\n" +
      "  session-start    SessionStart hook (default)\n" +
      "  session-end      SessionEnd cleanup of per-session state dir\n" +
      "  stop             Stop hook — drain events + status heartbeat\n" +
      "  read-enrich      PostToolUse on Read — citation legend enricher\n" +
      "  write-guard      PostToolUse on Write/Edit — copy-safety + scope reminder\n" +
      "\n" +
      "Reads the Claude Code hook payload JSON on stdin, emits the\n" +
      "Shape-B response on stdout. Designed to be wired in\n" +
      "`.claude/settings.json` under `hooks.SessionStart` /\n" +
      "`hooks.PostToolUse` / `hooks.Stop` / `hooks.SessionEnd`.\n",
  );
  process.exit(1);
}

export async function hookCli(argv: string[]): Promise<void> {
  const sub = argv[0];
  switch (sub) {
    case undefined:
    case "session-start":
      await runSessionStartHook();
      return;
    case "session-end":
      await runSessionEndHook();
      return;
    case "stop":
      await runStopHook();
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
