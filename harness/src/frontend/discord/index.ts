import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
  EmbedBuilder,
  Events,
  GatewayIntentBits,
  Partials,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Guild,
  type Interaction,
  type Message,
  type MessageActionRowComponentBuilder,
  type TextChannel,
} from "discord.js";
import { randomBytes } from "node:crypto";
import { logger } from "../../logger.js";
import { writeInboxRow } from "../inbox.js";
import type {
  Approval,
  ApprovalBundle,
  DialogResponse,
  DialogSpec,
  FreeTextEvent,
  FrontendAdapter,
  FrontendTask,
  IngestHandler,
  InteractionEvent,
  NotifyLevel,
  PostUpdate,
  SlashEvent,
  VoiceMessage,
} from "../types.js";
import { classifyTier0 } from "../../tier0/index.js";
import type {
  ClassificationResult,
  Tier0ClassifyOptions,
} from "../../tier0/index.js";
import { transcribeUrl, whisperModelExists } from "../../voice/index.js";
import type { TranscriptionResult } from "../../voice/index.js";
import { isOwner, parseOwnerIds } from "./acl.js";
import {
  CATEGORY_NAMES,
  createTaskChannel,
  ensureCategories,
  moveChannelToCategory,
  slugifyForChannel,
  type CategoryKey,
} from "./channels.js";
import { registerSlashCommands, SLASH_COMMAND_NAMES } from "./slash.js";

const log = logger("frontend.discord");

const VOICE_MIME_PREFIXES = ["audio/", "video/ogg"];

export interface DiscordFrontendAdapterOptions {
  /** Repo root (mirror checkout in production; project root in dev/smoke). */
  repoRoot: string;
  /** Bot token from `harness/.env`. */
  token: string;
  /** Discord guild (server) id. */
  guildId: string;
  /**
   * Application id (bot's user-id). Optional — if omitted the adapter reads
   * `client.application.id` after login.
   */
  applicationId?: string;
  /** Comma-separated owner Discord user-ids env value. */
  ownerUserIdsEnv: string | undefined;
  /**
   * Skip slash-command registration on start. Useful for tests; production
   * always registers on every start to keep guild commands fresh.
   */
  skipSlashRegistration?: boolean;
  /**
   * Confidence floor for voice transcription. Below this, the bot posts a
   * "Heard: '...' — confirm?" prompt with 🟢/🔴 buttons before treating the
   * transcript as a real ingest. Default per L11/voice config: 0.85.
   */
  confidenceFloor?: number;
  /** Tier-0 classifier overrides (host, model, fallback). */
  tier0?: Tier0ClassifyOptions;
}

interface PendingApproval {
  resolve(value: Approval): void;
  bundleId: string;
  timeoutHandle: NodeJS.Timeout;
}

interface PendingDialog {
  resolve(value: DialogResponse): void;
  bundleId: string;
  choiceMap: Map<string, string>; // discord-buttonId → choiceId
  timeoutHandle: NodeJS.Timeout;
}

/**
 * Real Discord adapter. Implements `FrontendAdapter`. Phase 5 wires:
 *   - slash command surface per `WORKFLOW_GUIDE.md` §3
 *   - channel-per-task lifecycle in 📋/🟢/📦 categories
 *   - ACL on `DISCORD_OWNER_USER_IDS`
 *   - free-text → regex Tier-0 stub (real Ollama in Phase 6)
 *   - voice attachments → inbox row only (Whisper transcription Phase 6)
 *   - button interactions for approval / dialog round-trips
 *
 * Inbox rows are the only output Phase 5 produces — the orchestrator (Phase
 * 8) is the consumer. No code dispatch lives here.
 */
export class DiscordFrontendAdapter implements FrontendAdapter {
  public readonly name = "discord";
  private readonly opts: DiscordFrontendAdapterOptions;
  private readonly ownerIds: Set<string>;
  private readonly client: Client;
  private readonly confidenceFloor: number;
  private readonly tier0Opts: Tier0ClassifyOptions;

  private taskHandler: IngestHandler<FrontendTask> | undefined;
  private voiceHandler: IngestHandler<VoiceMessage> | undefined;
  private slashHandler: IngestHandler<SlashEvent> | undefined;
  private freeTextHandler: IngestHandler<FreeTextEvent> | undefined;
  private interactionHandler: IngestHandler<InteractionEvent> | undefined;

  private pendingApprovals = new Map<string, PendingApproval>();
  private pendingDialogs = new Map<string, PendingDialog>();
  /**
   * In-memory map of taskId → live status messageId. The live status
   * message is one embed per task that gets edited in place on each
   * postTaskUpdate call (instead of spamming the channel with a new
   * message per phase). Restart loses the mapping; a fresh run posts a
   * new live status message.
   */
  private liveStatusMessages = new Map<string, string>();
  /**
   * Channels that have responded with Unknown Channel (Discord error
   * 10003). Once flagged dead, subsequent postTaskUpdate / sendTyping
   * / requestDialog calls bail without hitting Discord. This stops the
   * 8s typing heartbeat from spamming logs after the operator deletes
   * a per-task channel mid-run.
   */
  private deadChannels = new Set<string>();

  private started = false;

  constructor(opts: DiscordFrontendAdapterOptions) {
    this.opts = opts;
    this.confidenceFloor = opts.confidenceFloor ?? 0.85;
    this.tier0Opts = opts.tier0 ?? {};
    this.ownerIds = parseOwnerIds(opts.ownerUserIdsEnv);
    if (this.ownerIds.size === 0) {
      log.warn(
        "DISCORD_OWNER_USER_IDS empty — no commands will be accepted; configure before live use",
      );
    }
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildMessageReactions,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.DirectMessageReactions,
      ],
      partials: [Partials.Channel, Partials.Message, Partials.Reaction],
    });
  }

  async start(): Promise<void> {
    if (this.started) return;

    this.client.on(Events.InteractionCreate, (i) => {
      void this.handleInteraction(i);
    });
    this.client.on(Events.MessageCreate, (m) => {
      void this.handleMessage(m);
    });
    this.client.once(Events.ClientReady, (c) => {
      log.info({ user: c.user.tag, guildId: this.opts.guildId }, "discord client ready");
    });

    await this.client.login(this.opts.token);

    if (!this.opts.skipSlashRegistration) {
      const appId = this.opts.applicationId ?? this.client.application?.id;
      if (!appId) {
        await this.client.destroy();
        throw new Error("could not resolve application id for slash registration");
      }
      const registered = await registerSlashCommands({
        token: this.opts.token,
        appId,
        guildId: this.opts.guildId,
      });
      log.info({ count: registered.length }, "slash commands registered");
    }

    const guild = await this.requireGuild();
    await ensureCategories(guild);
    log.info({ categories: Object.values(CATEGORY_NAMES) }, "categories ensured");

    this.started = true;
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    for (const pending of this.pendingApprovals.values()) {
      clearTimeout(pending.timeoutHandle);
      pending.resolve({
        bundleId: pending.bundleId,
        decision: "ask",
        timedOut: true,
        reason: "adapter stopped",
      });
    }
    this.pendingApprovals.clear();
    for (const pending of this.pendingDialogs.values()) {
      clearTimeout(pending.timeoutHandle);
      pending.resolve({
        bundleId: pending.bundleId,
        choiceId: "e_other",
        timedOut: true,
        freeText: "(adapter stopped before reply)",
      });
    }
    this.pendingDialogs.clear();
    await this.client.destroy();
    this.started = false;
    log.info("discord adapter stopped");
  }

  onTask(handler: IngestHandler<FrontendTask>): void {
    this.taskHandler = handler;
  }
  onVoice(handler: IngestHandler<VoiceMessage>): void {
    this.voiceHandler = handler;
  }
  onSlash(handler: IngestHandler<SlashEvent>): void {
    this.slashHandler = handler;
  }
  onFreeText(handler: IngestHandler<FreeTextEvent>): void {
    this.freeTextHandler = handler;
  }
  onInteraction(handler: IngestHandler<InteractionEvent>): void {
    this.interactionHandler = handler;
  }

  async postTaskUpdate(update: PostUpdate): Promise<void> {
    const channelId = update.channelId;
    if (!channelId) {
      log.warn({ taskId: update.taskId }, "postTaskUpdate without channelId; dropping");
      return;
    }
    if (this.isChannelDead(channelId)) return;
    let channel;
    try {
      channel = await this.client.channels.fetch(channelId);
    } catch (err) {
      if (isUnknownChannelError(err)) {
        this.markChannelDead(channelId);
        return;
      }
      throw err;
    }
    if (!channel || !channel.isTextBased() || !("send" in channel)) {
      log.warn({ channelId }, "postTaskUpdate target channel not text-based");
      return;
    }
    const text = channel as TextChannel;
    const embed = buildPhaseEmbed(update);

    // Try to edit the existing live status message; if it's gone (e.g.
    // operator deleted it, or this is the first call for this taskId),
    // create a new one and remember its id.
    const existingMsgId = this.liveStatusMessages.get(update.taskId);
    if (existingMsgId !== undefined) {
      try {
        const msg = await text.messages.fetch(existingMsgId);
        await msg.edit({ embeds: [embed] });
        if (update.body && update.body.length > 0) {
          await text.send({ content: update.body });
        }
        return;
      } catch (err) {
        log.warn(
          { err: String(err), taskId: update.taskId },
          "live status edit failed; recreating",
        );
        this.liveStatusMessages.delete(update.taskId);
      }
    }

    try {
      const sent = await text.send({ embeds: [embed] });
      this.liveStatusMessages.set(update.taskId, sent.id);
    } catch (err) {
      log.warn({ err: String(err), taskId: update.taskId }, "live status send failed");
    }
    if (update.body && update.body.length > 0) {
      await text.send({ content: update.body });
    }
  }

  async requestApproval(bundle: ApprovalBundle): Promise<Approval> {
    const channelId = bundle.channelId;
    if (!channelId) {
      throw new Error("requestApproval requires bundle.channelId");
    }
    if (this.isChannelDead(channelId)) {
      // Same dead-channel sentinel as requestDialog — orchestrator
      // treats timeout as ask/abandon.
      return { bundleId: bundle.bundleId, decision: "ask", timedOut: true };
    }
    let channel;
    try {
      channel = await this.client.channels.fetch(channelId);
    } catch (err) {
      if (isUnknownChannelError(err)) {
        this.markChannelDead(channelId);
        return { bundleId: bundle.bundleId, decision: "ask", timedOut: true };
      }
      throw err;
    }
    if (!channel || !("send" in channel) || !channel.isTextBased()) {
      throw new Error(`approval target channel not text-based: ${channelId}`);
    }
    const buttonIds = {
      approve: `harness:approve:${bundle.bundleId}`,
      reject: `harness:reject:${bundle.bundleId}`,
      ask: `harness:ask:${bundle.bundleId}`,
    };
    const row = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(buttonIds.approve)
        .setStyle(ButtonStyle.Success)
        .setLabel("Approve & Push")
        .setEmoji("🟢"),
      new ButtonBuilder()
        .setCustomId(buttonIds.reject)
        .setStyle(ButtonStyle.Danger)
        .setLabel("Reject + tell me why")
        .setEmoji("🔴"),
      new ButtonBuilder()
        .setCustomId(buttonIds.ask)
        .setStyle(ButtonStyle.Secondary)
        .setLabel("Ask follow-up")
        .setEmoji("❓"),
    );

    const embed = new EmbedBuilder()
      .setTitle(`🎬 UAT — ${bundle.runId}`)
      .setColor(0x1abc9c)
      .setDescription(bundle.goal)
      .setTimestamp(new Date());
    if (bundle.diffSummary) {
      embed.addFields({ name: "diff", value: bundle.diffSummary.slice(0, 1024) });
    }
    if (bundle.acceptance && bundle.acceptance.length > 0) {
      const acText = bundle.acceptance
        .map((ac) => {
          const mark = ac.status === "pass" ? "✓" : ac.status === "fail" ? "✗" : "○";
          return `${mark} ${ac.id}${ac.note ? ` — ${ac.note}` : ""}`;
        })
        .join("\n");
      embed.addFields({ name: "acceptance", value: acText.slice(0, 1024) });
    }
    const sentApproval = await (channel as TextChannel).send({
      embeds: [embed],
      components: [row],
    });
    try {
      await sentApproval.react("👀");
    } catch (err) {
      log.warn({ err: String(err) }, "approval 👀 react failed");
    }

    const timeoutMs = bundle.timeoutMs ?? 24 * 60 * 60 * 1000;
    return new Promise<Approval>((resolve) => {
      const timeoutHandle = setTimeout(() => {
        this.pendingApprovals.delete(bundle.bundleId);
        resolve({ bundleId: bundle.bundleId, decision: "ask", timedOut: true });
      }, timeoutMs);
      this.pendingApprovals.set(bundle.bundleId, {
        bundleId: bundle.bundleId,
        resolve,
        timeoutHandle,
      });
    });
  }

  async requestDialog(spec: DialogSpec): Promise<DialogResponse> {
    const channelId = spec.channelId;
    if (!channelId) {
      throw new Error("requestDialog requires spec.channelId");
    }
    if (this.isChannelDead(channelId)) {
      // Operator can't see the prompt — return a dead-channel sentinel
      // (timed-out so the orchestrator's existing timeout-handling
      // branch fires).
      return { bundleId: spec.bundleId, choiceId: "e_other", timedOut: true };
    }
    let channel;
    try {
      channel = await this.client.channels.fetch(channelId);
    } catch (err) {
      if (isUnknownChannelError(err)) {
        this.markChannelDead(channelId);
        return { bundleId: spec.bundleId, choiceId: "e_other", timedOut: true };
      }
      throw err;
    }
    if (!channel || !("send" in channel) || !channel.isTextBased()) {
      throw new Error(`dialog target channel not text-based: ${channelId}`);
    }
    const choiceMap = new Map<string, string>();
    const builders: ButtonBuilder[] = [];
    for (const choice of spec.choices.slice(0, 5)) {
      const buttonId = `harness:dialog:${spec.bundleId}:${choice.id}`;
      choiceMap.set(buttonId, choice.id);
      builders.push(
        new ButtonBuilder()
          .setCustomId(buttonId)
          .setStyle(ButtonStyle.Secondary)
          .setLabel(choice.label.slice(0, 80)),
      );
    }
    const row = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(...builders);
    const sentMessage = await (channel as TextChannel).send({
      content: spec.prompt,
      components: [row],
    });
    // Bot signals "we're waiting on you" with 👀 reaction.
    try {
      await sentMessage.react("👀");
    } catch (err) {
      log.warn({ err: String(err), bundleId: spec.bundleId }, "dialog 👀 react failed");
    }

    const timeoutMs = spec.timeoutMs ?? 5 * 60 * 1000;
    return new Promise<DialogResponse>((resolve) => {
      const timeoutHandle = setTimeout(() => {
        this.pendingDialogs.delete(spec.bundleId);
        resolve({ bundleId: spec.bundleId, choiceId: "e_other", timedOut: true });
      }, timeoutMs);
      this.pendingDialogs.set(spec.bundleId, {
        bundleId: spec.bundleId,
        resolve,
        choiceMap,
        timeoutHandle,
      });
    });
  }

  startTyping(channelId: string): () => void {
    let stopped = false;
    const ping = async () => {
      if (stopped) return;
      if (this.isChannelDead(channelId)) {
        stopped = true;
        return;
      }
      try {
        const channel = await this.client.channels.fetch(channelId);
        if (channel && channel.isTextBased() && "sendTyping" in channel) {
          await (channel as TextChannel).sendTyping();
        }
      } catch (err) {
        if (isUnknownChannelError(err)) {
          this.markChannelDead(channelId);
          stopped = true;
          return;
        }
        log.warn({ err: String(err), channelId }, "sendTyping failed");
      }
    };
    void ping();
    // Discord's typing indicator decays after ~10s; refresh every 8s.
    const handle = setInterval(() => void ping(), 8_000);
    return () => {
      stopped = true;
      clearInterval(handle);
    };
  }

  async notify(level: NotifyLevel, message: string): Promise<void> {
    log[level === "warn" ? "warn" : level === "error" ? "error" : "info"](
      { message },
      "frontend notify",
    );
    // No default channel for ad-hoc notifications. Discord-side surfacing
    // belongs to per-run channels (postTaskUpdate). This is a logging
    // fallback — Phase 5 has no system channel concept.
  }

  // ── private ────────────────────────────────────────────────────────────

  /**
   * Discord error 10003 = Unknown Channel. Operator deleted the
   * per-task channel after the harness recorded its id. Once flagged,
   * silently no-op on every subsequent send/edit/typing call so we
   * don't spam logs while the orchestrator winds the run down.
   */
  private isChannelDead(channelId: string): boolean {
    return this.deadChannels.has(channelId);
  }
  private markChannelDead(channelId: string): void {
    if (!this.deadChannels.has(channelId)) {
      this.deadChannels.add(channelId);
      log.warn(
        { channelId },
        "channel marked dead — operator likely deleted it; further posts/typing/dialogs will no-op",
      );
    }
  }

  private async requireGuild(): Promise<Guild> {
    const guild = await this.client.guilds.fetch(this.opts.guildId);
    if (!guild) {
      throw new Error(`guild not accessible: ${this.opts.guildId}`);
    }
    return guild;
  }

  private async handleInteraction(interaction: Interaction): Promise<void> {
    try {
      if (interaction.isChatInputCommand()) {
        await this.handleSlash(interaction);
        return;
      }
      if (interaction.isButton()) {
        await this.handleButton(interaction);
        return;
      }
    } catch (err) {
      log.error({ err: String(err) }, "interaction handler threw");
    }
  }

  private async handleSlash(interaction: ChatInputCommandInteraction): Promise<void> {
    const command = interaction.commandName;
    const userId = interaction.user.id;
    if (!isOwner(this.ownerIds, userId)) {
      await interaction.reply({
        content: "Not authorized.",
        ephemeral: true,
      });
      return;
    }
    if (!(SLASH_COMMAND_NAMES as readonly string[]).includes(command)) {
      await interaction.reply({ content: `Unknown command: ${command}`, ephemeral: true });
      return;
    }

    const options: Record<string, string | number | boolean> = {};
    for (const opt of interaction.options.data) {
      if (opt.value !== undefined && opt.value !== null) options[opt.name] = opt.value;
    }

    const slashEvent: SlashEvent = {
      source: this.name,
      command,
      options,
      authorId: userId,
      receivedAt: new Date().toISOString(),
      ...(interaction.channelId ? { channelId: interaction.channelId } : {}),
      ...(interaction.guildId ? { guildId: interaction.guildId } : {}),
      messageId: interaction.id,
    };

    if (command === "task") {
      await this.handleTaskCommand(interaction, slashEvent);
      return;
    }

    await writeInboxRow({
      repoRoot: this.opts.repoRoot,
      source: this.name,
      kind: "slash",
      payload: { slash: slashEvent },
    });
    if (this.slashHandler) await this.slashHandler(slashEvent);
    await interaction.reply({
      content: `Queued \`/${command}\` (run-id pending).`,
      ephemeral: true,
    });
  }

  private async handleTaskCommand(
    interaction: ChatInputCommandInteraction,
    slashEvent: SlashEvent,
  ): Promise<void> {
    const body =
      typeof slashEvent.options["body"] === "string" ? slashEvent.options["body"] : "";
    const taskId = newTaskId();
    const bodySlug = slugifyForChannel(body);

    let createdChannelId: string | undefined;
    if (interaction.guild) {
      try {
        const categories = await ensureCategories(interaction.guild);
        const channel = await createTaskChannel({
          guild: interaction.guild,
          category: categories.active,
          taskId,
          bodySlug,
        });
        createdChannelId = channel.id;
        await channel.send(
          [
            `**Task ${taskId} dropped.**`,
            `> ${body.slice(0, 1000)}`,
            "",
            "_orchestrator picking up — tightener → mirror → agent → sensors → reviewer → UAT → backprop._",
          ].join("\n"),
        );
      } catch (err) {
        log.error({ err: String(err) }, "failed to create task channel");
      }
    }

    const task: FrontendTask = {
      source: this.name,
      intent: "code_task",
      rawText: body,
      authorId: slashEvent.authorId,
      receivedAt: slashEvent.receivedAt,
      ...(createdChannelId ? { channelId: createdChannelId } : {}),
      ...(slashEvent.guildId ? { guildId: slashEvent.guildId } : {}),
      messageId: slashEvent.messageId ?? "",
    };

    await writeInboxRow({
      repoRoot: this.opts.repoRoot,
      source: this.name,
      kind: "task",
      payload: { task, slash: slashEvent, task_id: taskId },
    });
    if (this.taskHandler) await this.taskHandler(task);

    const replyLines = [`📋 Task ${taskId} queued.`];
    if (createdChannelId) replyLines.push(`Channel: <#${createdChannelId}>`);
    await interaction.reply({ content: replyLines.join("\n"), ephemeral: true });
  }

  private async handleButton(interaction: ButtonInteraction): Promise<void> {
    const userId = interaction.user.id;
    if (!isOwner(this.ownerIds, userId)) {
      await interaction.reply({ content: "Not authorized.", ephemeral: true });
      return;
    }

    const customId = interaction.customId;
    const parts = customId.split(":");
    const namespace = parts[0];
    const kind = parts[1];
    if (namespace !== "harness") {
      await interaction.reply({ content: "Unknown button.", ephemeral: true });
      return;
    }

    if (kind === "approve" || kind === "reject" || kind === "ask") {
      const bundleId = parts.slice(2).join(":");
      const pending = this.pendingApprovals.get(bundleId);
      if (pending) {
        clearTimeout(pending.timeoutHandle);
        this.pendingApprovals.delete(bundleId);
        pending.resolve({ bundleId, decision: kind });
      }
      const interactionEvent: InteractionEvent = {
        source: this.name,
        bundleId,
        choiceId: kind,
        authorId: userId,
        receivedAt: new Date().toISOString(),
        ...(interaction.channelId ? { channelId: interaction.channelId } : {}),
        ...(interaction.guildId ? { guildId: interaction.guildId } : {}),
        messageId: interaction.id,
      };
      await writeInboxRow({
        repoRoot: this.opts.repoRoot,
        source: this.name,
        kind: "interaction",
        payload: { interaction: interactionEvent },
      });
      if (this.interactionHandler) await this.interactionHandler(interactionEvent);
      await interaction.reply({ content: `Recorded: ${kind}.`, ephemeral: true });
      await this.ackReact(interaction, kind);
      return;
    }

    if (kind === "voice-confirm") {
      const transcriptId = parts[2] ?? "";
      const choiceId = parts[3] ?? "";
      const interactionEvent: InteractionEvent = {
        source: this.name,
        bundleId: transcriptId,
        choiceId,
        authorId: userId,
        receivedAt: new Date().toISOString(),
        ...(interaction.channelId ? { channelId: interaction.channelId } : {}),
        ...(interaction.guildId ? { guildId: interaction.guildId } : {}),
        messageId: interaction.id,
      };
      await writeInboxRow({
        repoRoot: this.opts.repoRoot,
        source: this.name,
        kind: "interaction",
        payload: { interaction: interactionEvent, voice_transcript_id: transcriptId },
      });
      if (this.interactionHandler) await this.interactionHandler(interactionEvent);
      await interaction.reply({
        content: choiceId === "yes" ? "Confirmed." : "Will re-record.",
        ephemeral: true,
      });
      await this.ackReact(interaction, choiceId);
      return;
    }

    if (kind === "dialog") {
      // bundleId may contain colons (e.g. `TSK-XXX:Q1` from the
      // tightener per-question walk), so the choiceId is always the
      // LAST segment and bundleId is everything between `dialog:` and
      // the last `:`.
      const choiceId = parts[parts.length - 1] ?? "";
      const bundleId = parts.slice(2, -1).join(":");
      const pending = this.pendingDialogs.get(bundleId);
      if (pending) {
        clearTimeout(pending.timeoutHandle);
        this.pendingDialogs.delete(bundleId);
        pending.resolve({ bundleId, choiceId });
      }
      const interactionEvent: InteractionEvent = {
        source: this.name,
        bundleId,
        choiceId,
        authorId: userId,
        receivedAt: new Date().toISOString(),
        ...(interaction.channelId ? { channelId: interaction.channelId } : {}),
        ...(interaction.guildId ? { guildId: interaction.guildId } : {}),
        messageId: interaction.id,
      };
      await writeInboxRow({
        repoRoot: this.opts.repoRoot,
        source: this.name,
        kind: "interaction",
        payload: { interaction: interactionEvent },
      });
      if (this.interactionHandler) await this.interactionHandler(interactionEvent);
      await interaction.reply({ content: `Recorded: ${choiceId}.`, ephemeral: true });
      await this.ackReact(interaction, choiceId);
      return;
    }

    await interaction.reply({ content: "Unhandled button kind.", ephemeral: true });
  }

  /**
   * Stamp the bot's processing on the message: success → ✅, decline →
   * ❌, ask → ❓. Best-effort; reaction failures don't bubble.
   */
  private async ackReact(
    interaction: ButtonInteraction,
    decision: string,
  ): Promise<void> {
    let emoji = "✅";
    if (
      decision === "reject" ||
      decision === "cancel" ||
      decision === "no" ||
      decision === "edit"
    ) {
      emoji = "❌";
    } else if (decision === "ask" || decision === "ship_anyway") {
      emoji = "⚡";
    }
    try {
      await interaction.message.react(emoji);
    } catch (err) {
      log.warn(
        { err: String(err), choice: decision },
        "ackReact failed",
      );
    }
  }

  private async handleMessage(message: Message): Promise<void> {
    if (message.author.bot) return;
    const userId = message.author.id;
    if (!isOwner(this.ownerIds, userId)) return;

    // Voice attachments take precedence — bypass text classification path.
    const voiceAttachments = message.attachments.filter((a) => {
      const mime = a.contentType ?? "";
      return VOICE_MIME_PREFIXES.some((p) => mime.startsWith(p));
    });
    if (voiceAttachments.size > 0) {
      for (const attachment of voiceAttachments.values()) {
        await this.handleVoiceAttachment(message, userId, attachment);
      }
      return;
    }

    const text = message.content?.trim() ?? "";
    if (text.length === 0) return;

    const classification = await classifyTier0(text, this.tier0Opts);
    const event: FreeTextEvent = {
      source: this.name,
      intent: classification.intent,
      rawText: text,
      authorId: userId,
      receivedAt: new Date().toISOString(),
      channelId: message.channelId,
      messageId: message.id,
      ...(message.guildId ? { guildId: message.guildId } : {}),
    };

    if (classification.intent === "code_task") {
      const taskId = newTaskId();
      const task: FrontendTask = {
        source: this.name,
        intent: "code_task",
        rawText: text,
        authorId: userId,
        receivedAt: event.receivedAt,
        channelId: message.channelId,
        messageId: message.id,
        ...(message.guildId ? { guildId: message.guildId } : {}),
      };
      await writeInboxRow({
        repoRoot: this.opts.repoRoot,
        source: this.name,
        kind: "task",
        payload: { task, free_text: event, task_id: taskId, classification },
      });
      if (this.taskHandler) await this.taskHandler(task);
      try {
        await message.react("📋");
      } catch {
        // permission optional
      }
      return;
    }

    await writeInboxRow({
      repoRoot: this.opts.repoRoot,
      source: this.name,
      kind: "free_text",
      payload: { free_text: event, classification },
    });
    if (this.freeTextHandler) await this.freeTextHandler(event);
    try {
      await message.react(classification.intent === "unknown" ? "❓" : "✅");
    } catch {
      // optional
    }
  }

  private async handleVoiceAttachment(
    message: Message,
    userId: string,
    attachment: { url: string; contentType: string | null },
  ): Promise<void> {
    const transcriptId = `VTX-${Date.now().toString(36)}-${randomBytes(2).toString("hex")}`;
    let transcript: TranscriptionResult | null = null;
    let transcribeError: string | null = null;

    if (!whisperModelExists()) {
      transcribeError = "whisper model not installed (Phase 16 init or manual download)";
    } else {
      try {
        transcript = await transcribeUrl(attachment.url, { language: "en" });
      } catch (err) {
        transcribeError = err instanceof Error ? err.message : String(err);
      }
    }

    let classification: ClassificationResult | null = null;
    if (transcript && transcript.text.length > 0) {
      try {
        classification = await classifyTier0(transcript.text, this.tier0Opts);
      } catch (err) {
        log.warn({ err: String(err) }, "tier0 classify on transcript failed");
      }
    }

    const voice: VoiceMessage = {
      source: this.name,
      attachmentUrl: attachment.url,
      authorId: userId,
      channelId: message.channelId,
      messageId: message.id,
      receivedAt: new Date().toISOString(),
      ...(attachment.contentType ? { mime: attachment.contentType } : {}),
      ...(message.guildId ? { guildId: message.guildId } : {}),
    };

    const belowFloor =
      transcript !== null && transcript.avgLogprob < this.confidenceFloor;
    const transcriptPayload = transcript
      ? {
          id: transcriptId,
          text: transcript.text,
          avg_logprob: transcript.avgLogprob,
          language: transcript.language,
          duration_ms: transcript.durationMs,
          segments: transcript.segments.length,
          confidence_floor: this.confidenceFloor,
          below_floor: belowFloor,
        }
      : null;

    await writeInboxRow({
      repoRoot: this.opts.repoRoot,
      source: this.name,
      kind: "voice",
      payload: {
        voice,
        transcript: transcriptPayload,
        transcribe_error: transcribeError,
        classification,
      },
    });
    if (this.voiceHandler) await this.voiceHandler(voice);

    if (transcribeError !== null) {
      try {
        await message.react("⚠️");
      } catch {
        // optional
      }
      try {
        await message.reply(
          `Transcription failed: \`${transcribeError.slice(0, 200)}\`. Inbox row dropped without transcript.`,
        );
      } catch {
        // optional
      }
      return;
    }

    if (transcript && belowFloor) {
      try {
        const row = new ActionRowBuilder<MessageActionRowComponentBuilder>().addComponents(
          new ButtonBuilder()
            .setCustomId(`harness:voice-confirm:${transcriptId}:yes`)
            .setStyle(ButtonStyle.Success)
            .setLabel("Confirm")
            .setEmoji("🟢"),
          new ButtonBuilder()
            .setCustomId(`harness:voice-confirm:${transcriptId}:no`)
            .setStyle(ButtonStyle.Danger)
            .setLabel("Re-record")
            .setEmoji("🔴"),
        );
        const pct = (transcript.avgLogprob * 100).toFixed(0);
        const summary =
          transcript.text.length > 220
            ? `${transcript.text.slice(0, 217)}...`
            : transcript.text;
        await message.reply({
          content: `Heard: "${summary}" (confidence ${pct}%) — confirm?`,
          components: [row],
        });
      } catch (err) {
        log.warn({ err: String(err) }, "voice confirm prompt failed");
      }
      return;
    }

    try {
      await message.react("👂");
    } catch {
      // optional
    }
  }
}

function newTaskId(): string {
  return `TSK-${Date.now().toString(36)}-${randomBytes(2).toString("hex")}`;
}

/**
 * True when the error is a discord.js DiscordAPIError with code 10003
 * (Unknown Channel). The harness flags the channel dead and silently
 * no-ops every subsequent post against it.
 */
function isUnknownChannelError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as Record<string, unknown>;
  return e["code"] === 10003;
}

/**
 * Map orchestrator phase names → embed colors. Mirrors the harness
 * pipeline: tighten → prep → run → sense → review → uat → done.
 */
const PHASE_COLOR: Record<string, number> = {
  queued: 0x607d8b,
  tightening: 0x3498db,
  blocked: 0xf39c12,
  prepping: 0x95a5a6,
  running: 0xf1c40f,
  sensing: 0xe67e22,
  reviewing: 0x9b59b6,
  uat: 0x1abc9c,
  backpropping: 0x6f42c1,
  succeeded: 0x2ecc71,
  failed: 0xe74c3c,
};

const PHASE_EMOJI: Record<string, string> = {
  queued: "🟦",
  tightening: "🪛",
  blocked: "🟧",
  prepping: "🧰",
  running: "🟡",
  sensing: "🔎",
  reviewing: "🔬",
  uat: "🧪",
  backpropping: "📐",
  succeeded: "🟢",
  failed: "🔴",
};

function buildPhaseEmbed(update: PostUpdate): EmbedBuilder {
  const color = PHASE_COLOR[update.status] ?? 0x808080;
  const emoji = PHASE_EMOJI[update.status] ?? "•";
  const embed = new EmbedBuilder()
    .setTitle(`${emoji} ${update.taskId}`)
    .setColor(color)
    .setDescription(`**phase:** \`${update.status}\``);
  if (update.runId) {
    embed.addFields({ name: "run", value: `\`${update.runId}\``, inline: true });
  }
  embed.setTimestamp(new Date());
  return embed;
}

// re-export utilities for callers (orchestrator, smoke)
export {
  CATEGORY_NAMES,
  ensureCategories,
  moveChannelToCategory,
  slugifyForChannel,
  type CategoryKey,
};
