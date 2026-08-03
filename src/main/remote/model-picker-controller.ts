export type ModelPickerPhase = "browse" | "selected" | "queued" | "switching" | "terminal";
export type ModelPickerCloseReason = "replaced" | "expired" | "cancelled" | "completed" | "disposed";

type Timer = unknown;

interface ModelPickerRecord {
  id: string;
  chatKey: string;
  phase: ModelPickerPhase;
  timer: Timer | null;
}

export interface ModelPickerLifecycleOptions {
  schedule(fn: () => void, ms: number): Timer;
  cancel(timer: Timer): void;
  onClose(id: string, reason: ModelPickerCloseReason): void;
}

/** Owns model-picker correlation, replaceability, and browse-only expiry. */
export class ModelPickerLifecycle {
  private readonly records = new Map<string, ModelPickerRecord>();
  private readonly options: ModelPickerLifecycleOptions;
  private readonly byChat = new Map<string, string>();

  constructor(options: ModelPickerLifecycleOptions) {
    this.options = options;
  }

  open(id: string, chatKey: string): { ok: true; replacedId: string | null } | { ok: false; activeId: string } {
    const currentId = this.byChat.get(chatKey);
    if (currentId) {
      const current = this.records.get(currentId);
      if (current && (current.phase === "queued" || current.phase === "switching")) {
        return { ok: false, activeId: current.id };
      }
      if (current) this.close(current.id, "replaced");
    }
    this.records.set(id, { id, chatKey, phase: "browse", timer: null });
    this.byChat.set(chatKey, id);
    return { ok: true, replacedId: currentId ?? null };
  }

  browse(id: string, timeoutMs: number): boolean {
    const record = this.records.get(id);
    if (!record || record.phase !== "browse") return false;
    this.disarm(record);
    record.timer = this.options.schedule(() => this.close(id, "expired"), timeoutMs);
    return true;
  }

  setPhase(id: string, phase: ModelPickerPhase): boolean {
    const record = this.records.get(id);
    if (!record) return false;
    record.phase = phase;
    if (phase !== "browse") this.disarm(record);
    return true;
  }

  getPhase(id: string): ModelPickerPhase | null {
    return this.records.get(id)?.phase ?? null;
  }

  activeForChat(chatKey: string): string | null {
    return this.byChat.get(chatKey) ?? null;
  }

  close(id: string, reason: ModelPickerCloseReason): boolean {
    const record = this.records.get(id);
    if (!record) return false;
    this.disarm(record);
    record.phase = "terminal";
    this.records.delete(id);
    if (this.byChat.get(record.chatKey) === id) this.byChat.delete(record.chatKey);
    this.options.onClose(id, reason);
    return true;
  }

  dispose(): void {
    for (const id of [...this.records.keys()]) this.close(id, "disposed");
  }

  private disarm(record: ModelPickerRecord): void {
    if (record.timer !== null) this.options.cancel(record.timer);
    record.timer = null;
  }
}

interface ModelSwitchWork {
  controller: AbortController;
  promise: Promise<void>;
}

/** Serializes Telegram model switches through their same-message confirmation. */
export class ModelSwitchWorkQueue {
  private tail: Promise<void> = Promise.resolve();
  private readonly active = new Map<string, ModelSwitchWork>();
  private disposed = false;

  run(id: string, operation: (signal: AbortSignal) => Promise<void>): Promise<void> {
    if (this.disposed) return Promise.resolve();
    const existing = this.active.get(id);
    if (existing) return existing.promise;
    const controller = new AbortController();
    const execute = () =>
      this.disposed || controller.signal.aborted ? Promise.resolve() : operation(controller.signal);
    const result = this.tail.then(execute, execute);
    const work: ModelSwitchWork = { controller, promise: result };
    const tracked = result.finally(() => {
      if (this.active.get(id) === work) this.active.delete(id);
    });
    work.promise = tracked;
    this.active.set(id, work);
    this.tail = tracked.then(
      () => undefined,
      () => undefined,
    );
    return tracked;
  }

  dispose(): void {
    this.disposed = true;
    for (const work of this.active.values()) work.controller.abort();
    this.active.clear();
  }
}


export interface PickerMessageTransport<Keyboard> {
  send(text: string, keyboard: Keyboard | undefined, replyToMessageId: number | undefined): Promise<number | null>;
  edit(messageId: number, text: string, keyboard: Keyboard | undefined): Promise<boolean>;
}

/** Owns the one Telegram picker message: one initial send, then in-place edits. */
export class PickerMessageController<Keyboard = unknown> {
  private readonly chatId: number;
  private readonly replyToMessageId: number | undefined;
  private readonly transport: PickerMessageTransport<Keyboard>;
  private messageId: number | null = null;
  private sendPromise: Promise<number | null> | null = null;

  constructor(
    chatId: number,
    replyToMessageId: number | undefined,
    transport: PickerMessageTransport<Keyboard>,
  ) {
    this.chatId = chatId;
    this.replyToMessageId = replyToMessageId;
    this.transport = transport;
  }

  send(text: string, keyboard?: Keyboard): Promise<number | null> {
    if (this.messageId !== null) return Promise.resolve(this.messageId);
    if (this.sendPromise) return this.sendPromise;
    this.sendPromise = this.transport.send(text, keyboard, this.replyToMessageId).then((messageId) => {
      this.messageId = messageId;
      return messageId;
    });
    return this.sendPromise;
  }

  edit(text: string, keyboard?: Keyboard): Promise<boolean> {
    return this.messageId === null
      ? Promise.resolve(false)
      : this.transport.edit(this.messageId, text, keyboard);
  }

  matches(chatId: number, messageId: number | undefined): boolean {
    return this.messageId !== null && this.chatId === chatId && this.messageId === messageId;
  }

  get id(): number | null {
    return this.messageId;
  }
}
