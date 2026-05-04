import { logger } from "@isaacriehm/cairn-core";
import { writeInboxRow } from "@isaacriehm/cairn-core";
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
} from "@isaacriehm/cairn-core";

const log = logger("frontend.stub");

/**
 * In-memory adapter for smoke tests + dry-runs.
 *
 * Programmable: tests inject events via `pushTask()` / `pushVoice()` etc;
 * `postTaskUpdate` / `requestApproval` / `requestDialog` / `notify` calls
 * are recorded in arrays and resolved with the configured responses.
 *
 * Inbox JSON drops happen the same way as real adapters — `repoRoot` must
 * be set for the adapter to write rows.
 */
export interface StubFrontendAdapterOptions {
  name?: string;
  repoRoot: string;
  approvalResponse?: Approval;
  dialogResponse?: DialogResponse;
}

export class StubFrontendAdapter implements FrontendAdapter {
  public readonly name: string;
  private readonly repoRoot: string;
  private readonly approvalResponse: Approval | undefined;
  private readonly dialogResponse: DialogResponse | undefined;

  private taskHandler: IngestHandler<FrontendTask> | undefined;
  private voiceHandler: IngestHandler<VoiceMessage> | undefined;
  private slashHandler: IngestHandler<SlashEvent> | undefined;
  private freeTextHandler: IngestHandler<FreeTextEvent> | undefined;
  private interactionHandler: IngestHandler<InteractionEvent> | undefined;

  public readonly recorded: {
    taskUpdates: PostUpdate[];
    approvals: ApprovalBundle[];
    dialogs: DialogSpec[];
    notifications: { level: NotifyLevel; message: string }[];
    inboxFiles: string[];
  } = {
    taskUpdates: [],
    approvals: [],
    dialogs: [],
    notifications: [],
    inboxFiles: [],
  };

  private started = false;

  constructor(opts: StubFrontendAdapterOptions) {
    this.name = opts.name ?? "stub";
    this.repoRoot = opts.repoRoot;
    this.approvalResponse = opts.approvalResponse;
    this.dialogResponse = opts.dialogResponse;
  }

  async start(): Promise<void> {
    this.started = true;
    log.info({ name: this.name }, "stub adapter started");
  }

  async stop(): Promise<void> {
    this.started = false;
    log.info({ name: this.name }, "stub adapter stopped");
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

  /** Drive a task event into the adapter. */
  async pushTask(task: FrontendTask): Promise<string> {
    this.requireStarted();
    const file = await writeInboxRow({
      repoRoot: this.repoRoot,
      source: this.name,
      kind: "task",
      payload: { task },
    });
    this.recorded.inboxFiles.push(file);
    if (this.taskHandler) await this.taskHandler(task);
    return file;
  }

  async pushVoice(voice: VoiceMessage): Promise<string> {
    this.requireStarted();
    const file = await writeInboxRow({
      repoRoot: this.repoRoot,
      source: this.name,
      kind: "voice",
      payload: { voice },
    });
    this.recorded.inboxFiles.push(file);
    if (this.voiceHandler) await this.voiceHandler(voice);
    return file;
  }

  async pushSlash(event: SlashEvent): Promise<string> {
    this.requireStarted();
    const file = await writeInboxRow({
      repoRoot: this.repoRoot,
      source: this.name,
      kind: "slash",
      payload: { slash: event },
    });
    this.recorded.inboxFiles.push(file);
    if (this.slashHandler) await this.slashHandler(event);
    return file;
  }

  async pushFreeText(event: FreeTextEvent): Promise<string> {
    this.requireStarted();
    const file = await writeInboxRow({
      repoRoot: this.repoRoot,
      source: this.name,
      kind: "free_text",
      payload: { free_text: event },
    });
    this.recorded.inboxFiles.push(file);
    if (this.freeTextHandler) await this.freeTextHandler(event);
    return file;
  }

  async pushInteraction(event: InteractionEvent): Promise<string> {
    this.requireStarted();
    const file = await writeInboxRow({
      repoRoot: this.repoRoot,
      source: this.name,
      kind: "interaction",
      payload: { interaction: event },
    });
    this.recorded.inboxFiles.push(file);
    if (this.interactionHandler) await this.interactionHandler(event);
    return file;
  }

  async postTaskUpdate(update: PostUpdate): Promise<void> {
    this.recorded.taskUpdates.push(update);
  }

  async requestApproval(bundle: ApprovalBundle): Promise<Approval> {
    this.recorded.approvals.push(bundle);
    if (this.approvalResponse !== undefined) return this.approvalResponse;
    return { bundleId: bundle.bundleId, decision: "approve" };
  }

  async requestDialog(spec: DialogSpec): Promise<DialogResponse> {
    this.recorded.dialogs.push(spec);
    if (this.dialogResponse !== undefined) return this.dialogResponse;
    const first = spec.choices[0];
    if (!first) {
      return { bundleId: spec.bundleId, choiceId: "e_other", freeText: "(empty choices)" };
    }
    return { bundleId: spec.bundleId, choiceId: first.id };
  }

  async notify(level: NotifyLevel, message: string): Promise<void> {
    this.recorded.notifications.push({ level, message });
  }

  private requireStarted(): void {
    if (!this.started) throw new Error("stub adapter not started");
  }
}
