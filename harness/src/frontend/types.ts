/**
 * Frontend adapter contract per `docs/WORKFLOW_GUIDE.md` §0.1.
 *
 * The orchestrator + grounding daemon + MCP server are frontend-agnostic.
 * The operator console is a swappable adapter that consumes a uniform
 * task/run/UAT bundle and renders/listens via its native primitive.
 *
 * Adapters live in `harness/src/frontend/<name>/`. Each implements
 * `FrontendAdapter`. The `harness run --frontend <name>` CLI loads + starts
 * registered adapters; on operator events, adapters drop normalized JSON rows
 * to `.harness/inbox/<ts>-<source>-<slug>.json`. The orchestrator (Phase 8)
 * picks them up. Phase 5 lands ingress-only — no orchestrator yet.
 */

export type NotifyLevel = "info" | "warn" | "error";

/**
 * A normalized inbox entry kind. Adapters drop one of these to
 * `.harness/inbox/`. The orchestrator multiplexes on `kind`.
 */
export type InboxKind =
  | "task" // operator submitted a new task (slash `/task` or free text routed)
  | "slash" // any other slash command (status/halt/oops/etc) — orchestrator dispatches
  | "free_text" // unrouted free-text message; classifier picked an intent
  | "voice" // voice attachment; transcription happens in Phase 6
  | "interaction"; // button/select interaction tied to a prior outbound bundle

export interface FrontendTask {
  source: string;
  intent: string;
  rawText: string;
  authorId: string;
  channelId?: string;
  guildId?: string;
  messageId?: string;
  receivedAt: string;
}

export interface VoiceMessage {
  source: string;
  attachmentUrl: string;
  mime?: string;
  authorId: string;
  channelId: string;
  guildId?: string;
  messageId: string;
  receivedAt: string;
}

export interface SlashEvent {
  source: string;
  command: string;
  options: Record<string, string | number | boolean>;
  authorId: string;
  channelId?: string;
  guildId?: string;
  messageId?: string;
  receivedAt: string;
}

export interface FreeTextEvent {
  source: string;
  intent: string;
  rawText: string;
  authorId: string;
  channelId?: string;
  guildId?: string;
  messageId?: string;
  receivedAt: string;
}

export interface InteractionEvent {
  source: string;
  bundleId: string;
  choiceId: string;
  freeText?: string;
  authorId: string;
  channelId?: string;
  guildId?: string;
  messageId?: string;
  receivedAt: string;
}

export interface DialogChoice {
  /** Stable id ("a" | "b" | ... | "e_other"). */
  id: string;
  label: string;
}

export interface DialogSpec {
  /** Origin run / task id used to correlate adapter responses. */
  bundleId: string;
  prompt: string;
  /**
   * 2-5 choices. Last MUST be `E) Other` per WORKFLOW_GUIDE §1.4.
   * If more than 4 orthogonal questions arise, caller MUST collapse to a
   * single tightened-spec proposal per §1.0 (cap = 2 questions/turn).
   */
  choices: DialogChoice[];
  channelId?: string;
  timeoutMs?: number;
}

export interface DialogResponse {
  bundleId: string;
  choiceId: string;
  /** Populated only when `choiceId` is the `E) Other` option. */
  freeText?: string;
  timedOut?: boolean;
}

export interface ApprovalArtifact {
  kind: "gif" | "screenshot" | "table" | "diff" | "log" | "url" | "text";
  label?: string;
  path?: string;
  url?: string;
  content?: string;
}

export interface ApprovalBundle {
  bundleId: string;
  runId: string;
  taskId?: string;
  goal: string;
  diffSummary?: string;
  acceptance?: { id: string; status: "pass" | "fail" | "pending"; note?: string }[];
  artifacts?: ApprovalArtifact[];
  channelId?: string;
  timeoutMs?: number;
}

export interface Approval {
  bundleId: string;
  decision: "approve" | "reject" | "ask";
  reason?: string;
  timedOut?: boolean;
}

export interface PostUpdate {
  taskId: string;
  runId?: string;
  status: string;
  body?: string;
  channelId?: string;
  /**
   * Tier-0 (Ollama) summary of what the agent is doing right now —
   * one-line, present-progressive ("Reading core/src/X", "Editing
   * platform/Y"). Surfaces inside the live status embed so the
   * operator sees ongoing activity instead of a static "running" badge.
   * Set on a throttled cadence by the orchestrator during the
   * implementer phase.
   */
  activity?: string;
}

export type IngestHandler<T> = (item: T) => void | Promise<void>;

export interface FrontendAdapter {
  readonly name: string;
  /** Connects, registers commands, prepares to ingest events. */
  start(): Promise<void>;
  /** Disconnects + cleans up. Idempotent. */
  stop(): Promise<void>;

  onTask(handler: IngestHandler<FrontendTask>): void;
  onVoice(handler: IngestHandler<VoiceMessage>): void;
  onSlash(handler: IngestHandler<SlashEvent>): void;
  onFreeText(handler: IngestHandler<FreeTextEvent>): void;
  onInteraction(handler: IngestHandler<InteractionEvent>): void;

  postTaskUpdate(update: PostUpdate): Promise<void>;
  requestApproval(bundle: ApprovalBundle): Promise<Approval>;
  requestDialog(spec: DialogSpec): Promise<DialogResponse>;
  notify(level: NotifyLevel, message: string): Promise<void>;
  /**
   * Show "typing" / activity indicator on the given channel until the
   * returned stop fn is called. Adapters that don't support a native
   * typing indicator (CLI, stub) should no-op. Discord refreshes every
   * ~8 seconds since the native indicator decays after 10s.
   */
  startTyping?(channelId: string): () => void;
  /**
   * Pre-flight check: is this channel still reachable + writable?
   * Adapters that can answer (Discord) MUST return false when the
   * channel has been deleted or the bot lacks access. The orchestrator
   * uses this to skip dispatching a queued task whose per-task channel
   * is gone — typical when the operator deletes a stale `🟢 active`
   * channel between runs and the queue shadow restored the entry.
   * Adapters without channels (CLI / stub) should leave this undefined;
   * the orchestrator treats undefined as "always alive."
   */
  isChannelAlive?(channelId: string): Promise<boolean>;
}
