import type { EnhanceLaunchChoice } from "../../shared/telegram-enhance";

export type PromptImproveState =
  | { kind: "picker"; rounds: number; canImprove: boolean }
  | { kind: "enhancing"; rounds: number }
  | { kind: "enhanced"; rounds: number; improvedText: string };

export type PromptImproveAction =
  | { kind: "enhance" }
  | { kind: "cancel" }
  | { kind: "launch"; choice: EnhanceLaunchChoice; improvedText?: string }
  | { kind: "invalid" };

export interface PickerCallbackBinding {
  ownerUserId: number;
  chatId: number;
  messageId: number | null;
}

export interface PickerCallbackIdentity {
  userId: number;
  chatId: number;
  messageId?: number;
}

export function matchesPickerCallback(binding: PickerCallbackBinding, callback: PickerCallbackIdentity): boolean {
  return (
    callback.userId === binding.ownerUserId &&
    callback.chatId === binding.chatId &&
    binding.messageId !== null &&
    callback.messageId === binding.messageId
  );
}

export function initialPromptImproveState(): PromptImproveState {
  return { kind: "picker", rounds: 0, canImprove: true };
}

export function beginPromptEnhance(state: PromptImproveState): Extract<PromptImproveState, { kind: "enhancing" }> | null {
  if (state.kind === "enhancing" || state.rounds >= 3) return null;
  if (state.kind === "picker" && !state.canImprove) return null;
  return { kind: "enhancing", rounds: state.rounds + 1 };
}

export function completePromptEnhance(
  state: PromptImproveState,
  improvedText: string,
): Extract<PromptImproveState, { kind: "enhanced" }> | null {
  if (state.kind !== "enhancing") return null;
  return { kind: "enhanced", rounds: state.rounds, improvedText };
}

export function failPromptEnhance(
  state: PromptImproveState,
): Extract<PromptImproveState, { kind: "picker" }> | null {
  if (state.kind !== "enhancing") return null;
  return { kind: "picker", rounds: state.rounds, canImprove: false };
}

export function resolvePromptImproveAction(state: PromptImproveState, action: string): PromptImproveAction {
  if (action === "cancel") return { kind: "cancel" };
  if (state.kind === "enhancing") return { kind: "invalid" };
  if (state.kind === "picker") {
    if (action === "enhance" && state.canImprove && state.rounds < 3) return { kind: "enhance" };
    if (action === "solo") return { kind: "launch", choice: "original-solo" };
    if (action === "team") return { kind: "launch", choice: "original-team" };
    return { kind: "invalid" };
  }
  if (action === "regenerate" && state.rounds < 3) return { kind: "enhance" };
  if (
    action === "improved-solo" ||
    action === "improved-team" ||
    action === "original-solo" ||
    action === "original-team"
  ) {
    return { kind: "launch", choice: action, improvedText: state.improvedText };
  }
  return { kind: "invalid" };
}

/** Single owner for one pending Prompt Improve view and its valid transitions. */
export class PromptImproveController {
  private state: PromptImproveState = initialPromptImproveState();

  resolve(action: string): PromptImproveAction {
    return resolvePromptImproveAction(this.state, action);
  }

  beginEnhance(): boolean {
    const next = beginPromptEnhance(this.state);
    if (!next) return false;
    this.state = next;
    return true;
  }

  complete(improvedText: string): boolean {
    const next = completePromptEnhance(this.state, improvedText);
    if (!next) return false;
    this.state = next;
    return true;
  }

  fail(): boolean {
    const next = failPromptEnhance(this.state);
    if (!next) return false;
    this.state = next;
    return true;
  }

  snapshot(): PromptImproveState {
    return this.state;
  }
}

export interface PromptEnhancementRunOptions<Result> {
  showEnhancing(): Promise<unknown>;
  isActive(): boolean;
  typing: Pick<TypingPulse, "start" | "stop">;
  enhance(): Promise<Result>;
}

/** Keeps edits, typing, and canonical enhancement behind the pending-entry lifetime. */
export async function runPromptEnhancement<Result>(
  options: PromptEnhancementRunOptions<Result>,
): Promise<{ status: "cancelled" } | { status: "completed"; result: Result }> {
  await options.showEnhancing();
  if (!options.isActive()) return { status: "cancelled" };
  options.typing.start();
  let result: Result;
  try {
    result = await options.enhance();
  } finally {
    options.typing.stop();
  }
  return options.isActive() ? { status: "completed", result } : { status: "cancelled" };
}

type Timer = unknown;

/** Owns Telegram's transient typing refresh so cancellation cannot leak a timer. */
export class TypingPulse {
  private timer: Timer | null = null;
  private readonly send: () => void;
  private readonly schedule: (fn: () => void, ms: number) => Timer;
  private readonly cancel: (timer: Timer) => void;

  constructor(
    send: () => void,
    schedule: (fn: () => void, ms: number) => Timer,
    cancel: (timer: Timer) => void,
  ) {
    this.send = send;
    this.schedule = schedule;
    this.cancel = cancel;
  }

  start(): void {
    this.stop();
    this.send();
    this.timer = this.schedule(this.send, 4_000);
  }

  stop(): void {
    if (this.timer !== null) this.cancel(this.timer);
    this.timer = null;
  }
}
