/**
 * `cairn hook <event>` — Claude Code hook runners (umbrella CLI form).
 *
 * The plugin manifest invokes the bin entrypoints in
 * `cairn-core/dist/hooks/<event>.js` directly; this CLI subcommand is
 * the equivalent path for adopters running the umbrella CLI without the
 * plugin (e.g. terminal-side debug). Both routes call the same runners.
 *
 *   cairn hook session-start
 *   cairn hook session-end    cleanup per-session state dir
 *   cairn hook stop           assistant turn end — drain events + heartbeat
 *   cairn hook read-enrich    PostToolUse on Read — citation legend
 *   cairn hook write-guard    PostToolUse on Write/Edit — copy-safety + scope reminder
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
    "Usage: cairn hook <event>\n" +
      "  session-start    SessionStart hook (default)\n" +
      "  session-end      SessionEnd cleanup of per-session state dir\n" +
      "  stop             Stop hook — drain events + status heartbeat\n" +
      "  read-enrich      PostToolUse on Read — citation legend enricher\n" +
      "  write-guard      PostToolUse on Write/Edit — copy-safety + scope reminder\n" +
      "\n" +
      "Reads the Claude Code hook payload JSON on stdin, emits the\n" +
      "Shape-B response on stdout. Wired by the Claude Code plugin's\n" +
      "hooks/hooks.json — adopted projects do not need their own\n" +
      "`.claude/settings.json` hook entries.\n",
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
      console.error(`cairn hook: unknown event "${sub}"`);
      usage();
  }
}
