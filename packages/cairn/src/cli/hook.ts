/**
 * `cairn hook <event>` — shared agent-host hook runners (umbrella CLI form).
 *
 * The plugin manifest invokes the bin entrypoints in
 * `cairn-core/dist/hooks/<event>.js` directly; this CLI subcommand is
 * the equivalent path for adopters running the umbrella CLI without the
 * plugin (e.g. terminal-side debug). Every host route calls the same runners.
 *
 *   cairn hook session-start
 *   cairn hook session-end         cleanup per-session state dir
 *   cairn hook stop                assistant turn end — drain events + heartbeat
 *   cairn hook user-prompt-submit  resolves @-attached file citations
 *   cairn hook read-enrich         PostToolUse on Read — citation legend
 *   cairn hook write-guard         PostToolUse on Write/Edit — copy-safety + scope reminder
 *   cairn hook sot-align           PostToolUse on Write/Edit — Layer A alignment + DEC creation
 *   cairn hook pre-commit-align    git pre-commit — Layer B detection-only drift log
 *
 * PreToolUse is intentionally NOT supported — bricks the session if the hook fails.
 * `pre-commit-align` is invoked from the bundled `.cairn/git-hooks/pre-commit`
 * shell hook (different mechanism from agent lifecycle hooks) and is
 * detection-only — never modifies the commit, never blocks.
 */

import {
  AGENT_HOSTS,
  runAskUserBlockedHook,
  runPostWriteHook,
  runPreCommitAlign,
  runReadEnricher,
  runSessionEndHook,
  runSessionStartHook,
  runSotAlign,
  runStopHook,
  runUserPromptSubmitHook,
  runWriteGuardian,
  resolveAgentHost,
  type AgentHost,
} from "@isaacriehm/cairn-core";

function usage(): never {
  console.error(
    "Usage: cairn hook <event>\n" +
      "  session-start         SessionStart hook (default)\n" +
      "  session-end           SessionEnd cleanup of per-session state dir\n" +
      "  stop                  Stop hook — drain events + status heartbeat\n" +
      "  user-prompt-submit    UserPromptSubmit — resolve citations in @-attached files\n" +
      "  read-enrich           PostToolUse on Read — citation legend enricher\n" +
      "  write-guard           PostToolUse on Write/Edit — copy-safety + scope reminder\n" +
      "  sot-align             PostToolUse on Write/Edit — Layer A alignment + DEC creation\n" +
      "  post-write            Combined Write/Edit hook (Write Guardian + Layer A)\n" +
      "  ask-user-blocked      PostToolUse on AskUserQuestion — auto-stamp blocked_on: operator\n" +
      "  pre-commit-align      git pre-commit — Layer B detection-only drift log\n" +
      "\n" +
      "Options:\n" +
      "  --host <host>         claude-code | cursor | codex (auto-detected when omitted)\n" +
      "\n" +
      "Agent hooks read a JSON payload on stdin and emit the host-native\n" +
      "response on stdout (wired by the installed plugin manifest).\n" +
      "The git pre-commit-align variant is invoked by the bundled\n" +
      "`.cairn/git-hooks/pre-commit` shell hook with no payload and\n" +
      "always exits 0.\n",
  );
  process.exit(1);
}

export async function hookCli(argv: string[]): Promise<void> {
  const hostFlag = argv.indexOf("--host");
  let explicitHost: AgentHost | undefined;
  const args = [...argv];
  if (hostFlag >= 0) {
    const value = args[hostFlag + 1];
    if (!AGENT_HOSTS.includes(value as AgentHost)) {
      console.error(`cairn hook: invalid host "${value ?? ""}"`);
      usage();
    }
    explicitHost = value as AgentHost;
    args.splice(hostFlag, 2);
  }
  const host = resolveAgentHost(explicitHost);
  const options = { host };
  const sub = args[0];
  switch (sub) {
    case undefined:
    case "session-start":
      await runSessionStartHook(options);
      return;
    case "session-end":
      await runSessionEndHook(options);
      return;
    case "stop":
      await runStopHook(options);
      return;
    case "user-prompt-submit":
      await runUserPromptSubmitHook(options);
      return;
    case "read-enrich":
      await runReadEnricher(options);
      return;
    case "write-guard":
      await runWriteGuardian(options);
      return;
    case "sot-align":
      await runSotAlign(options);
      return;
    case "post-write":
      await runPostWriteHook(options);
      return;
    case "ask-user-blocked":
      await runAskUserBlockedHook(options);
      return;
    case "pre-commit-align":
      await runPreCommitAlign();
      return;
    default:
      console.error(`cairn hook: unknown event "${sub}"`);
      usage();
  }
}
