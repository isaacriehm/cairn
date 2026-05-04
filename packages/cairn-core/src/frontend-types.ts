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
  /**
   * When true, the adapter notifies authorized operators (push, mention,
   * etc. — adapter-defined) so they see the run is paused. Used for
   * agent-initiated `harness_ask_operator`; routine confirmations leave
   * this false to avoid noise.
   */
  pingOperators?: boolean;
  /**
   * §3.4 win 1 — multi-step walks (per-question tightener resolution,
   * /oops branches) edit one message in place instead of posting N+1
   * messages. Set this to the previous step's `bundleId`; the adapter
   * looks it up in its dialog-message map and edits that message
   * (same channel, new prompt + buttons). When the bundleId is
   * unknown (gone, never registered) the adapter falls back to a
   * fresh send.
   */
  replaceBundleId?: string;
  /**
   * Terminal-dialog flag. When true (default), the adapter compacts
   * the message on click — strips buttons, appends an "Answered" line
   * — so the channel scrollback shows what was chosen. Walk steps
   * that intend to be replaced by a follow-on dialog (per-Q tightener)
   * MUST pass false: otherwise the compaction race-edits the message
   * the next step is about to overwrite, and either the answer
   * annotation or the next prompt loses depending on REST ordering.
   * Adapter still fires `deferUpdate` so the click acknowledges.
   */
  compactOnAnswer?: boolean;
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
  /**
   * Free-form body. ≤1024 chars renders as inline embed `details` field
   * (§3.3 win 3 — drops the live-status + content-message split). >1024
   * chars falls back to the chunked secondary-embed path.
   */
  body?: string;
  /**
   * Original task spec (the operator's verbatim ask). Replaces the
   * standalone `🆕 Task` drop card — the body lives on the same live
   * status embed as everything else, so the channel only ever shows
   * one self-updating message per task. Truncated at 1024 chars.
   */
  taskBody?: string;
  channelId?: string;
  /**
   * Tier-0 (Haiku) summary of what the agent is doing right now —
   * one-line, present-progressive ("Reading core/src/X", "Editing
   * platform/Y"). Surfaces inside the live status embed so the
   * operator sees ongoing activity instead of a static "running" badge.
   * Set on a throttled cadence by the orchestrator during the
   * implementer phase.
   */
  activity?: string;
  /**
   * Second-source visibility — extracted from claude stream-json events.
   * Independent of the Tier-0 summary; renders even when the Tier-0 call
   * fails. Each list capped + deduped at the source.
   */
  tools?: {
    files?: string[];
    bash?: string[];
    searches?: string[];
  };
  /**
   * Curated narrative tail from `.harness/runs/active/<run_id>/log.jsonl`
   * (§3.3 win 1) — last N transitions, pre-formatted. Renders inside the
   * live status embed's description so operator sees actual progress
   * instead of a static "phase: running" line.
   */
  recentEvents?: string[];
  /**
   * §3.4 win 3 — when status === "failed", the orchestrator classifies
   * which gate eject the run so the embed renders class-colored title +
   * emoji. Operator can route differently per class.
   */
  failureClass?: "sensor" | "reviewer" | "uat" | "hard" | "halt";
  /**
   * §3.4 win 2 — failure remediation guidance surfaced as a dedicated
   * embed field. `reason` is a one-liner; `suggestedActions` are the
   * operator's next moves (`/ship-anyway`, re-submit, open thread).
   */
  remediation?: {
    reason: string;
    suggestedActions: string[];
  };
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
   * Show a "typing" / activity indicator on the given channel until the
   * returned stop fn is called. Adapters without a native typing
   * indicator should no-op.
   */
  startTyping?(channelId: string): () => void;
  /**
   * Pre-flight check: is this channel still reachable + writable?
   * Adapters that maintain channels MUST return false when the channel
   * has been deleted or the adapter lacks access. The orchestrator uses
   * this to skip dispatching a queued task whose channel is gone.
   * Adapters without channels should leave this undefined; the
   * orchestrator treats undefined as "always alive".
   */
  isChannelAlive?(channelId: string): Promise<boolean>;
}
