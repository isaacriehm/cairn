import {
  REST,
  Routes,
  SlashCommandBuilder,
  type APIApplicationCommand,
  type SlashCommandOptionsOnlyBuilder,
} from "discord.js";

type AnySlashBuilder = SlashCommandBuilder | SlashCommandOptionsOnlyBuilder;

/**
 * Slash command surface per `docs/WORKFLOW_GUIDE.md` §3.
 *
 * Phase 5 lands the registration; dispatch is stubbed — every command drops
 * a normalized row to `.harness/inbox/` and the orchestrator (Phase 8)
 * processes from there.
 */
export const SLASH_COMMAND_NAMES = [
  "status",
  "task",
  "run",
  "halt",
  "oops",
  "direction",
  "eval",
  "ship-anyway",
  "agent",
  "queue",
  "resume",
  "archive",
  "unpause",
  "help",
] as const;

export type SlashCommandName = (typeof SLASH_COMMAND_NAMES)[number];

export function buildSlashCommands(): AnySlashBuilder[] {
  return [
    new SlashCommandBuilder()
      .setName("status")
      .setDescription("Running task, queue depth, recent runs, weakest module"),
    new SlashCommandBuilder()
      .setName("task")
      .setDescription("Submit a new task")
      .addStringOption((opt) =>
        opt.setName("body").setDescription("Task description").setRequired(true),
      ),
    new SlashCommandBuilder()
      .setName("run")
      .setDescription("Dispatch a queued task")
      .addStringOption((opt) =>
        opt.setName("task-id").setDescription("Task id to dispatch").setRequired(true),
      ),
    new SlashCommandBuilder()
      .setName("halt")
      .setDescription("Kill active run")
      .addStringOption((opt) =>
        opt.setName("run-id").setDescription("Run id (default: active)").setRequired(false),
      ),
    new SlashCommandBuilder()
      .setName("oops")
      .setDescription("What went wrong? Conversational dialog"),
    new SlashCommandBuilder()
      .setName("direction")
      .setDescription("Capture a binding direction change as candidate decision")
      .addStringOption((opt) =>
        opt.setName("text").setDescription("Direction text").setRequired(true),
      ),
    new SlashCommandBuilder()
      .setName("eval")
      .setDescription("Run sensors on demand")
      .addStringOption((opt) =>
        opt.setName("scope").setDescription("Glob scope (optional)").setRequired(false),
      ),
    new SlashCommandBuilder()
      .setName("ship-anyway")
      .setDescription("Override spec-tightener gate or sensor false-positive (logged)"),
    new SlashCommandBuilder()
      .setName("agent")
      .setDescription("List subagents or reload definitions")
      .addStringOption((opt) =>
        opt
          .setName("sub")
          .setDescription("list | reload")
          .setRequired(true)
          .addChoices({ name: "list", value: "list" }, { name: "reload", value: "reload" }),
      ),
    new SlashCommandBuilder().setName("queue").setDescription("Show task FIFO queue"),
    new SlashCommandBuilder()
      .setName("resume")
      .setDescription("Revive an abandoned UAT run")
      .addStringOption((opt) =>
        opt.setName("run-id").setDescription("Run id to resume").setRequired(true),
      ),
    new SlashCommandBuilder()
      .setName("archive")
      .setDescription("Quarantine a file")
      .addStringOption((opt) =>
        opt.setName("path").setDescription("Repo-relative path").setRequired(true),
      ),
    new SlashCommandBuilder()
      .setName("unpause")
      .setDescription("Clear a quota-triggered dispatch pause"),
    new SlashCommandBuilder()
      .setName("help")
      .setDescription("List available commands with examples"),
  ];
}

export async function registerSlashCommands(args: {
  token: string;
  appId: string;
  guildId: string;
}): Promise<APIApplicationCommand[]> {
  const { token, appId, guildId } = args;
  const rest = new REST({ version: "10" }).setToken(token);
  const body = buildSlashCommands().map((b) => b.toJSON());
  const result = (await rest.put(Routes.applicationGuildCommands(appId, guildId), {
    body,
  })) as APIApplicationCommand[];
  return result;
}
