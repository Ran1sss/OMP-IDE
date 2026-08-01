/**
 * One registered Telegram bot: grammY instance, hand-rolled long-poll loop
 * (own backoff + auth-error classification), per-chat rate-limited send
 * queues with 429 handling. Failures here never propagate to other bots.
 */

import { Bot, GrammyError, InlineKeyboard, InputFile, type Context } from "grammy";
import type { Message } from "grammy/types";
import type { RemoteBotState } from "../../shared/types";
import { currentProxyAgent } from "./proxy";

export interface InboundMessage {
  userId: number;
  username: string;
  firstName: string;
  chatId: number;
  text: string;
  /** Telegram from.language_code — per-recipient fixed-string locale */
  languageCode?: string;
}

export interface InboundCallback {
  userId: number;
  username: string;
  firstName: string;
  chatId: number;
  data: string;
  /** Telegram from.language_code — per-recipient fixed-string locale */
  languageCode?: string;
  /** answers the spinner on the client */
  ack(text?: string): void;
}


/** A message from a group/supergroup — any sender; watching never allowlists. */
export interface GroupMessage {
  chatId: number;
  chatTitle: string;
  chatKind: "group" | "supergroup";
  messageId: number;
  authorId: number;
  author: string;
  /** text, or a typed stub like "[photo]" (+ caption when present) */
  text: string;
  time: number;
  replyTo?: number;
  replyToBot: boolean;
  mentionsBot: boolean;
  edit: boolean;
}
/** Manager-provided behavior; runtime stays transport-only. */
export interface BotDelegate {
  isAuthorized(botId: string, userId: number): boolean;
  onMessage(botId: string, msg: InboundMessage): void;
  onCallback(botId: string, cb: InboundCallback): void;
  /** unauthorized traffic — silent to the sender, logged in the IDE */
  onBlocked(botId: string, userId: number, username: string, text: string): void;
  /** /start <code> from an unpaired user; returns true when pairing succeeded */
  tryPair(botId: string, msg: InboundMessage, code: string): boolean;
  /** every group/supergroup message, regardless of sender authorization */
  onGroupMessage(botId: string, gm: GroupMessage): void;
  /** bot's own membership changed in a group (added / kicked / left) */
  onChatMember(
    botId: string,
    ev: { chatId: number; title: string; kind: "group" | "supergroup"; present: boolean },
  ): void;
  onStateChange(botId: string): void;
}

const COMMANDS = [
  { command: "status", description: "Agent state, todo progress, workspace" },
  { command: "todo", description: "Live todo list" },
  { command: "stop", description: "Interrupt the running agent" },
  { command: "new", description: "Start a fresh agent session" },
  { command: "diff", description: "Diffstat of files touched this session" },
  { command: "files", description: "Files touched by the agent" },
  { command: "who", description: "Connected remote users" },
  { command: "think", description: "Show or set the thinking level" },
  { command: "help", description: "Command reference" },
];

const sleep = (ms: number) => {
  const { promise, resolve } = Promise.withResolvers<void>();
  setTimeout(resolve, ms);
  return promise;
};

interface QueueJob {
  run(): Promise<void>;
}

/** Serializes sends per chat: ≥1s between messages, obeys 429 retry_after. */
class ChatQueue {
  private jobs: QueueJob[] = [];
  private running = false;
  private lastSend = 0;

  push(job: QueueJob): void {
    this.jobs.push(job);
    if (!this.running) void this.drain();
  }

  private async drain(): Promise<void> {
    this.running = true;
    while (this.jobs.length) {
      const job = this.jobs.shift()!;
      const wait = this.lastSend + 1000 - Date.now();
      if (wait > 0) await sleep(wait);
      try {
        await job.run();
      } catch {
        // job.run handles its own retries; a final failure is dropped
      }
      this.lastSend = Date.now();
    }
    this.running = false;
  }
}

export class BotRuntime {
  readonly bot: Bot;
  state: RemoteBotState = "off";
  detail: string | undefined;
  lastActivity: number | null = null;
  sessionMessages = 0;

  private running = false;
  private abort: AbortController | null = null;
  private queues = new Map<number, ChatQueue>();
  private pollPromise: Promise<void> | null = null;

  constructor(
    readonly id: string,
    token: string,
    private delegate: BotDelegate,
  ) {
    // proxy for RF users: api.telegram.org is DPI-blocked for many; the agent
    // rides grammY's node-fetch via baseFetchConfig
    const agent = currentProxyAgent();
    this.bot = new Bot(token, agent ? { client: { baseFetchConfig: { agent, compress: true } } } : undefined);

    this.bot.on("message", (ctx) => this.routeMessage(ctx, false));
    this.bot.on("edited_message", (ctx) => this.routeMessage(ctx, true));
    this.bot.on("callback_query:data", (ctx) => this.routeCallback(ctx));
    this.bot.on("my_chat_member", (ctx) => {
      const upd = ctx.myChatMember;
      if (!upd) return;
      const chat = upd.chat;
      if (chat.type !== "group" && chat.type !== "supergroup") return;
      const status = upd.new_chat_member.status;
      this.delegate.onChatMember(this.id, {
        chatId: chat.id,
        title: chat.title,
        kind: chat.type,
        present: status !== "left" && status !== "kicked",
      });
    });
    this.bot.catch(() => {
      // middleware errors must never kill the poll loop
    });
  }

  private setState(state: RemoteBotState, detail?: string): void {
    if (this.state === state && this.detail === detail) return;
    this.state = state;
    this.detail = detail;
    this.delegate.onStateChange(this.id);
  }

  /** typed stub for non-text content, with caption appended when present */
  private static stubFor(m: Message): string {
    const kind = m.photo
      ? "[photo]"
      : m.voice
        ? "[voice]"
        : m.sticker
          ? "[sticker]"
          : m.video
            ? "[video]"
            : m.document
              ? "[document]"
              : m.audio
                ? "[audio]"
                : m.location
                  ? "[location]"
                  : m.poll
                    ? "[poll]"
                    : "[unsupported]";
    return m.caption ? `${kind} ${m.caption}` : kind;
  }

  private routeMessage(ctx: Context, edit: boolean): void {
    const m = edit ? ctx.editedMessage : ctx.message;
    const from = m?.from;
    const chat = m?.chat;
    if (!m || !from || !chat || from.is_bot) return;
    this.lastActivity = Date.now();

    // groups: everything (any sender, any content type) flows to the watch
    // layer; commands from members execute nothing and get no reply.
    if (chat.type === "group" || chat.type === "supergroup") {
      const me = this.bot.botInfo?.username;
      const text = m.text ?? BotRuntime.stubFor(m);
      const mentionsBot =
        !!me &&
        (m.entities ?? []).some(
          (e) => e.type === "mention" && m.text?.slice(e.offset, e.offset + e.length).toLowerCase() === `@${me.toLowerCase()}`,
        );
      this.delegate.onGroupMessage(this.id, {
        chatId: chat.id,
        chatTitle: chat.title,
        chatKind: chat.type,
        messageId: m.message_id,
        authorId: from.id,
        author: from.username ?? from.first_name,
        text,
        time: (edit ? m.edit_date ?? m.date : m.date) * 1000,
        replyTo: m.reply_to_message?.message_id,
        replyToBot: m.reply_to_message?.from?.id === this.bot.botInfo?.id,
        mentionsBot,
        edit,
      });
      return;
    }

    // private chats: EXACT pre-existing behavior (edits never re-route tasks)
    if (chat.type !== "private" || edit) return;
    const text = m.text;
    if (!text) return;
    const msg: InboundMessage = {
      userId: from.id,
      username: from.username ?? String(from.id),
      firstName: from.first_name,
      chatId: chat.id,
      text,
      languageCode: from.language_code,
    };
    if (!this.delegate.isAuthorized(this.id, from.id)) {
      const pair = text.match(/^\/start\s+(\d{6})\s*$/);
      if (pair && this.delegate.tryPair(this.id, msg, pair[1])) return;
      this.delegate.onBlocked(this.id, from.id, msg.username, text);
      return;
    }
    this.sessionMessages++;
    this.delegate.onMessage(this.id, msg);
  }

  private routeCallback(ctx: Context): void {
    const from = ctx.from;
    const data = ctx.callbackQuery?.data;
    const chatId = ctx.chat?.id ?? ctx.callbackQuery?.message?.chat.id;
    if (!from || !data || chatId === undefined) return;
    if (!this.delegate.isAuthorized(this.id, from.id)) {
      void ctx.answerCallbackQuery().catch(() => {});
      this.delegate.onBlocked(this.id, from.id, from.username ?? String(from.id), `[button] ${data}`);
      return;
    }
    this.lastActivity = Date.now();
    this.sessionMessages++;
    this.delegate.onCallback(this.id, {
      userId: from.id,
      username: from.username ?? String(from.id),
      firstName: from.first_name,
      chatId,
      data,
      languageCode: from.language_code,
      ack: (text) => void ctx.answerCallbackQuery(text ? { text } : undefined).catch(() => {}),
    });
  }

  /**
   * Privacy-mode honesty: "full" only when the bot receives ordinary group
   * messages — privacy mode off (getMe.can_read_all_group_messages) or the
   * bot is an admin of that chat. Anything else is "limited".
   */
  async probeCoverage(chatId: number): Promise<"full" | "limited"> {
    try {
      const me = await this.bot.api.getMe();
      if (me.can_read_all_group_messages) return "full";
      const member = await this.bot.api.getChatMember(chatId, me.id);
      return member.status === "administrator" || member.status === "creator" ? "full" : "limited";
    } catch {
      return "limited";
    }
  }

  // -------------------------------------------------- lifecycle

  /** network calls in start() must never wedge the toggle — hard cap */
  private withTimeout<T>(p: Promise<T>, ms = 15_000): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`Telegram API timeout after ${ms / 1000}s`)), ms);
      p.then(
        (v) => { clearTimeout(t); resolve(v); },
        (e) => { clearTimeout(t); reject(e); },
      );
    });
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.abort = new AbortController();
    try {
      await this.withTimeout(this.bot.init());
      await this.withTimeout(this.bot.api.setMyCommands(COMMANDS, undefined));
      if (!this.running) return; // stopped while initializing — stay stopped
    } catch (err) {
      if (!this.running) return; // stopped while initializing — stay stopped
      if (err instanceof GrammyError && (err.error_code === 401 || err.error_code === 404)) {
        this.running = false;
        this.setState("auth-error", err.description);
        return;
      }
      this.setState("degraded", err instanceof Error ? err.message : String(err));
      // still try to poll; the loop owns the retry policy
    }
    this.setState("polling");
    this.pollPromise = this.pollLoop();
  }

  private async pollLoop(): Promise<void> {
    let offset = 0;
    let backoff = 1000;
    while (this.running) {
      try {
        // grammY types signals against the abort-controller shim; the runtime
        // accepts a standard AbortSignal, so bridge the nominal mismatch.
        const signal = this.abort?.signal as unknown as Parameters<typeof this.bot.api.getUpdates>[1];
        const updates = await this.bot.api.getUpdates(
          { offset, timeout: 25, allowed_updates: ["message", "edited_message", "callback_query", "my_chat_member"] },
          signal,
        );
        if (!this.running) break;
        if (this.state !== "polling") this.setState("polling");
        backoff = 1000;
        for (const u of updates) {
          offset = u.update_id + 1;
          try {
            await this.bot.handleUpdate(u);
          } catch {
            // one bad update must not stall the loop
          }
        }
      } catch (err) {
        if (!this.running) break;
        if (err instanceof GrammyError && (err.error_code === 401 || err.error_code === 404)) {
          this.setState("auth-error", err.description);
          this.running = false;
          break;
        }
        this.setState("degraded", err instanceof Error ? err.message : String(err));
        await sleep(backoff);
        backoff = Math.min(backoff * 2, 60_000);
      }
    }
    if (this.state !== "auth-error") this.setState("off");
  }

  async stop(): Promise<void> {
    this.running = false;
    this.abort?.abort();
    this.abort = null;
    try {
      await this.pollPromise;
    } catch {}
    this.pollPromise = null;
    if (this.state !== "auth-error") this.setState("off");
  }

  get isRunning(): boolean {
    return this.running;
  }

  // -------------------------------------------------- outbound

  private queue(chatId: number): ChatQueue {
    let q = this.queues.get(chatId);
    if (!q) {
      q = new ChatQueue();
      this.queues.set(chatId, q);
    }
    return q;
  }

  /** Run a telegram call with one 429-obeying retry chain. */
  private async withRetry<T>(call: () => Promise<T>): Promise<T> {
    for (;;) {
      try {
        return await call();
      } catch (err) {
        if (err instanceof GrammyError && err.error_code === 429) {
          const retryAfter = err.parameters?.retry_after ?? 3;
          await sleep(retryAfter * 1000 + 200);
          continue;
        }
        throw err;
      }
    }
  }

  /** Queued markdown send; resolves with message id or null on failure. */
  sendMd(chatId: number, text: string, keyboard?: InlineKeyboard): Promise<number | null> {
    const { promise, resolve } = Promise.withResolvers<number | null>();
    this.queue(chatId).push({
      run: async () => {
        try {
          const msg = await this.withRetry(() =>
            this.bot.api.sendMessage(chatId, text, {
              parse_mode: "MarkdownV2",
              ...(keyboard ? { reply_markup: keyboard } : {}),
            }),
          );
          this.sessionMessages++;
          resolve(msg.message_id);
        } catch {
          // fallback: plain text (escaping failure must not lose content)
          try {
            const msg = await this.withRetry(() =>
              this.bot.api.sendMessage(chatId, text.replace(/\\([_*[\]()~`>#+\-=|{}.!\\])/g, "$1"), {
                ...(keyboard ? { reply_markup: keyboard } : {}),
              }),
            );
            this.sessionMessages++;
            resolve(msg.message_id);
          } catch {
            resolve(null);
          }
        }
      },
    });
    return promise;
  }

  /** Queued in-place edit; failures are silent (message may be unchanged). */
  editMd(chatId: number, messageId: number, text: string): void {
    this.queue(chatId).push({
      run: async () => {
        try {
          await this.withRetry(() =>
            this.bot.api.editMessageText(chatId, messageId, text, { parse_mode: "MarkdownV2" }),
          );
        } catch {
          // "message is not modified" and friends — ignore
        }
      },
    });
  }

  sendDocument(chatId: number, filename: string, content: string): void {
    this.queue(chatId).push({
      run: async () => {
        try {
          await this.withRetry(() =>
            this.bot.api.sendDocument(chatId, new InputFile(Buffer.from(content, "utf-8"), filename)),
          );
          this.sessionMessages++;
        } catch {}
      },
    });
  }

  async cleanupCommands(): Promise<void> {
    try {
      await this.bot.api.deleteMyCommands();
    } catch {}
  }
}
