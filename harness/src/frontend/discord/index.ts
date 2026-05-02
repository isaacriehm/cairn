import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Client,
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
    const channel = await this.client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased() || !("send" in channel)) {
      log.warn({ channelId }, "postTaskUpdate target channel not text-based");
      return;
    }
    const lines = [`**${update.taskId}** — ${update.status}`];
    if (update.body) lines.push(update.body);
    if (update.runId) lines.push(`run \`${update.runId}\``);
    await (channel as TextChannel).send(lines.join("\n"));
  }

  async requestApproval(bundle: ApprovalBundle): Promise<Approval> {
    const channelId = bundle.channelId;
    if (!channelId) {
      throw new Error("requestApproval requires bundle.channelId");
    }
    const channel = await this.client.channels.fetch(channelId);
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

    const lines = [
      `🎬 UAT for ${bundle.runId}`,
      `Goal: ${bundle.goal}`,
    ];
    if (bundle.diffSummary) lines.push(`Diff: ${bundle.diffSummary}`);
    if (bundle.acceptance && bundle.acceptance.length > 0) {
      lines.push("Acceptance:");
      for (const ac of bundle.acceptance) {
        const mark = ac.status === "pass" ? "✓" : ac.status === "fail" ? "✗" : "○";
        lines.push(`  ${mark} ${ac.id}${ac.note ? ` — ${ac.note}` : ""}`);
      }
    }

    await (channel as TextChannel).send({ content: lines.join("\n"), components: [row] });

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
    const channel = await this.client.channels.fetch(channelId);
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
    await (channel as TextChannel).send({ content: spec.prompt, components: [row] });

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
            "Spec tightener will run when the orchestrator picks this up (Phase 8 — not wired yet).",
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
      return;
    }

    if (kind === "dialog") {
      const bundleId = parts[2] ?? "";
      const choiceId = parts.slice(3).join(":");
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
      return;
    }

    await interaction.reply({ content: "Unhandled button kind.", ephemeral: true });
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

// re-export utilities for callers (orchestrator, smoke)
export {
  CATEGORY_NAMES,
  ensureCategories,
  moveChannelToCategory,
  slugifyForChannel,
  type CategoryKey,
};
