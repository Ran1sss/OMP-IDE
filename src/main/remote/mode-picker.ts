/**
 * Pending Solo/Team choices, one per (bot, chat). Pure state: no Telegram, no
 * Electron — the manager owns sending, editing and the actual task start.
 */

export interface PendingEntry<T> {
  id: string;
  chatKey: string;
  ownerUserId: number;
  payload: T;
  /** the picker message to edit; null until Telegram assigns an id */
  pickerMessageId: number | null;
  claimed: boolean;
}

export type ClaimResult<T> =
  | { ok: true; entry: PendingEntry<T> }
  | { ok: false; reason: "missing" | "foreign" };

type Timer = unknown;

export class PendingModeRegistry<T> {
  private entries = new Map<string, PendingEntry<T>>();
  private byChat = new Map<string, string>();
  private timers = new Map<string, Timer>();
  private seq = 0;
  private readonly schedule: (fn: () => void, ms: number) => Timer;
  private readonly unschedule: (timer: Timer) => void;

  constructor(schedule: (fn: () => void, ms: number) => Timer, unschedule: (timer: Timer) => void) {
    this.schedule = schedule;
    this.unschedule = unschedule;
  }

  /** Opens a choice, evicting an unclaimed one from the same chat. */
  open(chatKey: string, ownerUserId: number, payload: T): { entry: PendingEntry<T>; evicted: PendingEntry<T> | null } {
    const evicted = this.cancelByChat(chatKey);
    const entry: PendingEntry<T> = {
      id: `mode_${++this.seq}`,
      chatKey,
      ownerUserId,
      payload,
      pickerMessageId: null,
      claimed: false,
    };
    this.entries.set(entry.id, entry);
    this.byChat.set(chatKey, entry.id);
    return { entry, evicted };
  }

  get(id: string): PendingEntry<T> | null {
    return this.entries.get(id) ?? null;
  }

  setPickerMessageId(id: string, messageId: number): boolean {
    const entry = this.entries.get(id);
    if (!entry || entry.claimed) return false;
    entry.pickerMessageId = messageId;
    return true;
  }

  /** Arms the auto-choice; the callback only fires while still unclaimed. */
  arm(id: string, ms: number, onExpire: (entry: PendingEntry<T>) => void): void {
    const entry = this.entries.get(id);
    if (!entry || entry.claimed) return;
    this.disarm(id);
    this.timers.set(
      id,
      this.schedule(() => {
        const claim = this.claim(id);
        if (claim.ok) onExpire(claim.entry);
      }, ms),
    );
  }

  /** Pause an in-flight picker view (e.g. while enhancing) without claiming it. */
  pause(id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry || entry.claimed) return false;
    this.disarm(id);
    return true;
  }

  /** Takes ownership exactly once; a foreign user never claims someone's task. */
  claim(id: string, byUserId?: number): ClaimResult<T> {
    const entry = this.entries.get(id);
    if (!entry || entry.claimed) return { ok: false, reason: "missing" };
    if (byUserId !== undefined && byUserId !== entry.ownerUserId) return { ok: false, reason: "foreign" };
    entry.claimed = true;
    this.forget(entry);
    return { ok: true, entry };
  }

  cancelByChat(chatKey: string): PendingEntry<T> | null {
    const id = this.byChat.get(chatKey);
    if (!id) return null;
    const claim = this.claim(id);
    return claim.ok ? claim.entry : null;
  }

  /** Empties the registry — used when the IDE closes and nothing survives. */
  drain(): PendingEntry<T>[] {
    const out: PendingEntry<T>[] = [];
    for (const id of [...this.entries.keys()]) {
      const claim = this.claim(id);
      if (claim.ok) out.push(claim.entry);
    }
    return out;
  }

  private disarm(id: string): void {
    const timer = this.timers.get(id);
    if (timer !== undefined) this.unschedule(timer);
    this.timers.delete(id);
  }

  private forget(entry: PendingEntry<T>): void {
    this.disarm(entry.id);
    this.entries.delete(entry.id);
    if (this.byChat.get(entry.chatKey) === entry.id) this.byChat.delete(entry.chatKey);
  }
}
