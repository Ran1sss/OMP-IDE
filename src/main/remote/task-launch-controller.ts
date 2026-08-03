export type TelegramLaunchResult =
  | { status: "started"; id: string }
  | { status: "busy"; activeId: string }
  | { status: "rejected"; id: string };

export interface TelegramLaunchRequest {
  id: string;
  isBusy(): boolean;
  start(): Promise<boolean> | boolean;
  onAccepted?(): void;
}

/** Serializes Telegram-origin task starts and owns the single routed task id. */
export class TelegramLaunchArbiter {
  private activeId: string | null = null;
  private launchTail: Promise<void> = Promise.resolve();

  async tryLaunch(request: TelegramLaunchRequest): Promise<TelegramLaunchResult> {
    const prior = this.launchTail;
    const { promise: turn, resolve } = Promise.withResolvers<void>();
    this.launchTail = prior.then(() => turn, () => turn);
    await prior;
    try {
      if (this.activeId !== null || request.isBusy()) {
        return { status: "busy", activeId: this.activeId ?? "external" };
      }
      this.activeId = request.id;
      let started: boolean;
      try {
        started = await request.start();
      } catch {
        this.activeId = null;
        return { status: "rejected", id: request.id };
      }
      if (!started) {
        this.activeId = null;
        return { status: "rejected", id: request.id };
      }
      request.onAccepted?.();
      return { status: "started", id: request.id };
    } finally {
      resolve();
    }
  }

  handleStatus(state: string, onTerminal?: (id: string) => void): boolean {
    return state === "dead" || state === "unavailable" ? this.terminate(onTerminal) : false;
  }

  /** Atomically ends the active route; repeated terminal signals are no-ops. */
  terminate(onActive?: (id: string) => void): boolean {
    const id = this.activeId;
    if (id === null) return false;
    this.activeId = null;
    onActive?.(id);
    return true;
  }

  release(id?: string): void {
    if (id === undefined || this.activeId === id) this.activeId = null;
  }

  get active(): string | null {
    return this.activeId;
  }
}
