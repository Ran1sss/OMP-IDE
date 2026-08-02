/**
 * Remote Control Center backend: bot registry, pairing, final-only task
 * delivery, questions, transient typing liveness, and activity feed.
 */

import type { IpcMain } from "electron";
import { BrowserWindow } from "electron";
import { execFile } from "node:child_process";
import { randomInt } from "node:crypto";
import { basename } from "node:path";
import { request as httpsRequest } from "node:https";
import type { Agent } from "node:http";
import { Bot, InlineKeyboard } from "grammy";
import type {
  RemoteState,
  RemoteBotInfo,
  RemotePairing,
  RemoteActivityEvent,
  RemoteEventKind,
} from "../../shared/types";
import { getAgentBridge, getThinkingControl, type AgentBridge, type BridgeUiRequest } from "../omp-service";
import {
  loadStore,
  saveStore,
  putToken,
  getToken,
  dropToken,
  vaultAvailable,
  type StoredBot,
} from "./vault";
import { BotRuntime, type BotDelegate, type InboundMessage, type InboundCallback, type GroupMessage } from "./bot-runtime";
import { WatchManager } from "./watch-manager";
import { agentForUrl, currentProxyAgent, validateProxyUrl } from "./proxy";
import { registerSwapRemoteNotifier } from "../models/swap-engine";
import {
  registerTeamGateNotifier,
  registerTeamEndNotifier,
  isTeamRunActive,
  teamJournalData,
  startTeamFromRemote,
  steerTeamFromRemote,
  stopTeamFromRemote,
  teamRoster,
} from "../omp-team/team-service";
import { SessionTracker } from "./session-tracker";
import { tg, tgLangFor } from "./tg-i18n";
import { classifyTeamAgentEnd } from "../../shared/agent-end";
import { shouldRelayUnsolicitedNotice, shouldSendTyping } from "../../shared/remote-communication";
import { classifyTaskIntake, extractRosterMentions, parseModeCommand, parseSoloTask, renderTelegramStartNotice, renderTelegramTeamStatus, stripLeadingMentionsForIntent } from "../../shared/team-remote";
import {
  classifyGroupMessage,
  shouldHintPrivacyMode,
  shouldLogBlockedGroupUser,
} from "../../shared/telegram-group";
import {
  escapeMd,
  mdToTelegram,
  renderTodoLines,
  renderDiffstat,
  formatElapsed,
  sanitizeOutbound,
} from "./format";
import { routeIntent, answerQuestion, registerDialogueTracker } from "./dialogue";
import { PendingModeRegistry, type PendingEntry } from "./mode-picker";

const appStartedAt = Date.now();
/** the picker auto-starts Solo after this quiet period */
const PICKER_TIMEOUT_MS = 60_000;

interface ChatTarget {
  runtime: BotRuntime;
  bot: StoredBot;
  chatId: number;
  username: string;
  languageCode?: string;
  /** source message for threaded group replies */
  replyToMessageId?: number;
}

interface PendingModePayload {
  runtime: BotRuntime;
  bot: StoredBot;
  message: InboundMessage;
  text: string;
  mentions: string[];
}

interface TeamStartNotice {
  target: ChatTarget;
  editMessageId?: number;
}

class RemoteManager implements BotDelegate {
  private bridge: AgentBridge = getAgentBridge();
  private tracker = new SessionTracker(this.bridge);
  private runtimes = new Map<string, BotRuntime>();
  private pairing: (RemotePairing & { timer: NodeJS.Timeout }) | null = null;
  private activity: RemoteActivityEvent[] = [];
  /** Team run spans several lead turns; only its notifier sends the final. */
  private teamTaskActive = false;
  private taskFinalSent = false;
  private typingTimer: NodeJS.Timeout | null = null;
  private currentUi: BridgeUiRequest | null = null;
  /** pending /new confirmations by callback token */
  private confirms = new Map<string, { kind: "new"; username: string }>();
  private confirmSeq = 0;
  /** /diff file index snapshot per request so button data stays tiny */
  private diffIndex: string[] = [];
  /** group strangers are logged once per bot/user, never once per message */
  private blockedGroupUsers = new Set<string>();
  /** the privacy-mode explanation is owed once per group, not per message */
  private privacyHinted = new Set<string>();
  /** task origin controls typing, questions and the one final reply */
  private activeTaskTarget: ChatTarget | null = null;
  /** one pending Solo/Team choice per bot/chat; nothing survives an IDE restart */
  private pending = new PendingModeRegistry<PendingModePayload>(
    (fn, ms) => setTimeout(fn, ms),
    (timer) => clearTimeout(timer as NodeJS.Timeout),
  );
  /** Team notice waits for the router's real slice assignment. */
  private teamStartNotice: TeamStartNotice | null = null;
  /** chat-watch layer (group listening, proposals) — deletable with the module */
  readonly watch = new WatchManager({
    runtime: (botId) => this.runtimes.get(botId),
    log: (botId, sender, detail, kind) => {
      const bot = loadStore().bots.find((b) => b.id === botId);
      this.log(botId, bot?.username ?? botId, sender, kind ?? "watch", detail);
    },
  });

  private taskTarget(runtime: BotRuntime, bot: StoredBot, message: InboundMessage): ChatTarget {
    return {
      runtime,
      bot,
      chatId: message.chatId,
      username: message.username,
      ...(message.languageCode ? { languageCode: message.languageCode } : {}),
      ...(message.messageId !== undefined ? { replyToMessageId: message.messageId } : {}),
    };
  }

  private reply(runtime: BotRuntime, message: InboundMessage, text: string, keyboard?: InlineKeyboard): Promise<number | null> {
    return runtime.sendMd(message.chatId, text, keyboard, message.messageId);
  }

  private pendingChatKey(botId: string, chatId: number): string {
    return `${botId}:${chatId}`;
  }

  private async createModePicker(runtime: BotRuntime, bot: StoredBot, message: InboundMessage, text: string): Promise<void> {
    const payload: PendingModePayload = { runtime, bot, message, text, mentions: extractRosterMentions(text, teamRoster()) };
    const { entry, evicted } = this.pending.open(this.pendingChatKey(bot.id, message.chatId), message.userId, payload);
    if (evicted?.pickerMessageId !== null && evicted) {
      void evicted.payload.runtime.editMd(evicted.payload.message.chatId, evicted.pickerMessageId, escapeMd(tg(tgLangFor(evicted.payload.message.languageCode)).pickerCancelled));
    }
    this.pushRemoteAnswerToIde(message.username, bot.name, text);
    const L = tg(tgLangFor(message.languageCode));
    const keyboard = new InlineKeyboard().text(L.pickerSolo, `mode:${entry.id}:solo`).text(L.pickerTeam, `mode:${entry.id}:team`);
    const pickerId = await this.reply(runtime, message, escapeMd(L.modePicker), keyboard);
    if (pickerId === null) {
      this.pending.claim(entry.id);
      return;
    }
    if (!this.pending.setPickerMessageId(entry.id, pickerId)) return;
    this.pending.arm(entry.id, PICKER_TIMEOUT_MS, (expired) => void this.startPendingMode(expired, "solo", "timeout"));
  }

  /** Starts a claimed pending task; the picker message becomes its receipt. */
  private async startPendingMode(entry: PendingEntry<PendingModePayload>, mode: "solo" | "team", by: string): Promise<boolean> {
    const { runtime, bot, message, text, mentions } = entry.payload;
    const lang = tgLangFor(message.languageCode);
    const editPicker = (body: string): Promise<boolean> =>
      entry.pickerMessageId === null ? Promise.resolve(false) : runtime.editMd(message.chatId, entry.pickerMessageId, escapeMd(body));
    this.activeTaskTarget = this.taskTarget(runtime, bot, message);
    this.taskFinalSent = false;
    if (mode === "solo") {
      await editPicker(tg(lang).soloStarted);
      if (!this.bridge.prompt(text, { username: message.username, botName: bot.name }, { echo: false })) {
        this.activeTaskTarget = null;
        await editPicker(tg(lang).agentNotRunning);
        return false;
      }
      this.log(bot.id, bot.username, `@${message.username}`, "task", `${by}: solo ${text}`.slice(0, 120));
      return true;
    }
    this.teamStartNotice = {
      target: this.activeTaskTarget,
      ...(entry.pickerMessageId !== null ? { editMessageId: entry.pickerMessageId } : {}),
    };
    if (!startTeamFromRemote({ goal: text, mentions, via: { username: message.username, botName: bot.name }, echo: false }).ok) {
      this.teamStartNotice = null;
      this.activeTaskTarget = null;
      await editPicker(tg(lang).teamStartFailed);
      return false;
    }
    this.log(bot.id, bot.username, `@${message.username}`, "task", `${by}: team ${text}`.slice(0, 120));
    return true;
  }

  private async startDirectTeam(runtime: BotRuntime, bot: StoredBot, message: InboundMessage, text: string, mentions: string[]): Promise<boolean> {
    const target = this.taskTarget(runtime, bot, message);
    this.activeTaskTarget = target;
    this.taskFinalSent = false;
    this.teamStartNotice = { target };
    if (!startTeamFromRemote({ goal: text, mentions, via: { username: message.username, botName: bot.name } }).ok) {
      this.activeTaskTarget = null;
      this.teamStartNotice = null;
      await this.reply(runtime, message, escapeMd(tg(tgLangFor(message.languageCode)).teamStartFailed));
      return false;
    }
    this.log(bot.id, bot.username, `@${message.username}`, "task", text.slice(0, 120));
    return true;
  }

  // ================================================== lifecycle

  async init(): Promise<void> {
    this.tracker.attach();
    // Chat Dialogue: the composer borrows the tracker's diffstat/elapsed/result
    registerDialogueTracker(this.tracker);
    this.bridge.onStatus(() => this.refreshTyping());
    this.bridge.onEvent((e) => this.onAgentEvent(e));
    this.bridge.onUiRequest((req) => this.onAgentQuestion(req));

    const store = loadStore();
    // owner migration (owner-fix spec): a bot with paired users but no owner
    // crowns its FIRST paired user, once, and says so in the feed
    for (const bot of store.bots) {
      if (bot.paired.length && !bot.paired.some((u) => u.owner)) {
        bot.paired[0].owner = true;
        saveStore();
        this.log(bot.id, bot.username, "system", "system", `owner auto-designated: @${bot.paired[0].username}`);
      }
    }
    if (store.globalEnabled) {
      for (const bot of store.bots) {
        if (bot.enabled) await this.spawnRuntime(bot);
      }
    }
    // auto-swap loudness: swaps and low-balance crossings reach Telegram too
    registerSwapRemoteNotifier((text) => {
      if (!shouldRelayUnsolicitedNotice(isTeamRunActive())) return;
      for (const t of this.targets()) t.runtime.sendMd(t.chatId, escapeMd(sanitizeOutbound(text)));
    });
    // Team dispatch is desktop-only: no plan/progress push to Telegram.
    registerTeamGateNotifier((packet) => {
      const notice = this.teamStartNotice;
      if (!notice) return;
      this.teamStartNotice = null;
      const text = escapeMd(renderTelegramStartNotice(packet.slices.map((slice) => ({ id: slice.id, worker: slice.worker, title: slice.title, deps: slice.deps })), tgLangFor(notice.target.languageCode)));
      if (notice.editMessageId !== undefined) void notice.target.runtime.editMd(notice.target.chatId, notice.editMessageId, text);
      else void notice.target.runtime.sendMd(notice.target.chatId, text, undefined, notice.target.replyToMessageId);
    });
    registerTeamEndNotifier((p) => {
      this.teamTaskActive = false;
      this.stopTyping();
      this.sendFinalOnce(sanitizeOutbound(p.report).trim(), p.elapsedMs);
    });
  }

  async dispose(): Promise<void> {
    registerSwapRemoteNotifier(null);
    registerTeamGateNotifier(null);
    registerTeamEndNotifier(null);
    registerDialogueTracker(null);
    for (const entry of this.pending.drain()) {
      if (entry.pickerMessageId === null) continue;
      const { runtime, message } = entry.payload;
      await runtime.editMd(message.chatId, entry.pickerMessageId, escapeMd(tg(tgLangFor(message.languageCode)).lostPendingTask));
    }
    this.watch.dispose();
    // Flush a final broadcast if a task is mid-flight.
    const st = this.bridge.getStatus();
    if (st && (st.state === "thinking" || st.state === "tool" || st.state === "awaiting-input")) {
      const phases = this.bridge.getTodoPhases();
      let done = 0, total = 0;
      for (const p of phases) for (const t of p.tasks) { total++; if (t.status === "completed") done++; }
      const text = escapeMd(`IDE closed, task interrupted at ${done}/${total} todos.`);
      const sends: Promise<unknown>[] = [];
      for (const t of this.targets()) sends.push(t.runtime.sendMd(t.chatId, text));
      // give queued sends a moment; don't hold app quit hostage
      await Promise.race([
        Promise.allSettled(sends),
        new Promise((r) => setTimeout(r, 2500)),
      ]);
    }
    this.stopTyping();
    this.cancelPairing();
    for (const rt of this.runtimes.values()) await rt.stop();
    this.runtimes.clear();
    this.tracker.detach();
  }

  /** per-bot lifecycle ops run strictly serialized — rapid toggling must not interleave spawn/kill */
  private botOps = new Map<string, Promise<void>>();

  private queueBotOp(botId: string, op: () => Promise<void>): Promise<void> {
    const prev = this.botOps.get(botId) ?? Promise.resolve();
    const next = prev.then(op, op);
    this.botOps.set(botId, next);
    return next;
  }

  private async spawnRuntime(bot: StoredBot): Promise<void> {
    // replace any existing runtime — a double spawn leaks a poller (Telegram 409)
    const existing = this.runtimes.get(bot.id);
    if (existing) {
      this.runtimes.delete(bot.id);
      await existing.stop();
    }
    const token = getToken(bot.id);
    if (!token) {
      this.log(bot.id, bot.username, "system", "system", "token missing from vault");
      return;
    }
    const rt = new BotRuntime(bot.id, token, this);
    this.runtimes.set(bot.id, rt);
    await rt.start();
    this.pushState();
  }

  private async killRuntime(botId: string): Promise<void> {
    const rt = this.runtimes.get(botId);
    this.runtimes.delete(botId);
    if (rt) await rt.stop();
    this.pushState();
  }

  // ================================================== registry ops

  async addBot(token: string): Promise<{ ok: true; bot: RemoteBotInfo } | { ok: false; error: string }> {
    if (!vaultAvailable()) return { ok: false, error: "OS secure storage is unavailable on this system" };
    const trimmed = token.trim();
    if (!/^\d+:[\w-]+$/.test(trimmed)) return { ok: false, error: "That does not look like a bot token" };
    // Live validation via direct getMe fetch: precise errors (DNS/timeout/reset/
    // HTTP status) and one retry — Telegram API access can flap under DPI.
    const res = await validateBotToken(trimmed);
    if (!res.ok) return { ok: false, error: res.error };
    const me = res.me;
    const store = loadStore();
    if (store.bots.some((b) => b.username === me.username))
      return { ok: false, error: `@${me.username} is already registered` };
    const bot: StoredBot = {
      id: `bot_${me.id}`,
      name: me.first_name,
      username: me.username,
      enabled: false,
      paired: [],
    };
    putToken(bot.id, trimmed);
    store.bots.push(bot);
    saveStore();
    this.log(bot.id, bot.username, "system", "system", "bot registered");
    this.pushState();
    return { ok: true, bot: this.botInfo(bot) };
  }

  async removeBot(botId: string): Promise<void> {
    const store = loadStore();
    const bot = store.bots.find((b) => b.id === botId);
    // remove from the registry first so a queued spawn can't resurrect it
    store.bots = store.bots.filter((b) => b.id !== botId);
    saveStore();
    if (this.pairing?.botId === botId) this.cancelPairing();
    await this.queueBotOp(botId, async () => {
      const rt = this.runtimes.get(botId);
      if (rt) {
        await rt.cleanupCommands();
        await this.killRuntime(botId);
      } else if (bot) {
        // best-effort command cleanup even when not running
        const token = getToken(botId);
        if (token) {
          try {
            const agent = currentProxyAgent();
            await new Bot(token, agent ? { client: { baseFetchConfig: { agent, compress: true } } } : undefined).api.deleteMyCommands();
          } catch {}
        }
      }
    });
    this.botOps.delete(botId);
    dropToken(botId);
    if (bot) this.log(botId, bot.username, "system", "system", "bot removed");
    this.pushState();
  }

  async setBotEnabled(botId: string, enabled: boolean): Promise<void> {
    // persist intent immediately — the UI reflects it even while ops queue
    const store = loadStore();
    const bot = store.bots.find((b) => b.id === botId);
    if (!bot) return;
    bot.enabled = enabled;
    saveStore();
    if (!enabled && this.pairing?.botId === botId) this.cancelPairing();
    this.pushState();
    await this.queueBotOp(botId, async () => {
      // act on the LATEST stored intent, not the captured arg — a rapid
      // on→off→on burst must converge on the final state
      const cur = loadStore();
      const b = cur.bots.find((x) => x.id === botId);
      if (!b) return;
      if (b.enabled && cur.globalEnabled) await this.spawnRuntime(b);
      else await this.killRuntime(botId);
    });
  }

  async setGlobalEnabled(enabled: boolean): Promise<void> {
    const store = loadStore();
    store.globalEnabled = enabled;
    saveStore();
    if (!enabled) this.cancelPairing();
    this.pushState();
    const ids = new Set<string>([...store.bots.map((b) => b.id), ...this.runtimes.keys()]);
    const ops: Promise<void>[] = [];
    for (const id of ids) {
      ops.push(
        this.queueBotOp(id, async () => {
          const cur = loadStore();
          const b = cur.bots.find((x) => x.id === id);
          if (b && b.enabled && cur.globalEnabled) await this.spawnRuntime(b);
          else await this.killRuntime(id);
        }),
      );
    }
    await Promise.all(ops);
  }


  /** Restart every live runtime; the proxy agent is captured at Bot construction. */
  private async bounceRuntimes(): Promise<void> {
    const ids = [...this.runtimes.keys()];
    await Promise.all(
      ids.map((id) =>
        this.queueBotOp(id, async () => {
          const cur = loadStore();
          const b = cur.bots.find((x) => x.id === id);
          if (b && b.enabled && cur.globalEnabled) await this.spawnRuntime(b);
        }),
      ),
    );
  }

  private maskProxy(url: string): string {
    return url.replace(/\/\/[^@]*@/, "//***@");
  }

  /**
   * Save the proxy URL. Reconnecting only matters while the proxy is ON: with
   * the toggle off this is pure persistence, so the address survives for later.
   * A live probe still guards an enabled proxy — a dead one must not silently
   * kill every bot.
   */
  async setProxyUrl(url: string): Promise<{ ok: boolean; error?: string; probe?: string }> {
    const err = validateProxyUrl(url);
    if (err) return { ok: false, error: err };
    const store = loadStore();
    const trimmed = url.trim();
    let probe: string | undefined;
    if (trimmed && store.proxyEnabled) {
      const prev = store.proxyUrl;
      store.proxyUrl = trimmed; // currentProxyAgent() reads the store
      try {
        const res = await probeGetMe("0:probe");
        probe = `proxy OK — api.telegram.org answered ${res.status}`;
      } catch (e) {
        store.proxyUrl = prev;
        const msg = e instanceof Error && e.name === "TimeoutError"
          ? "proxy did not answer within 15s"
          : e instanceof Error ? e.message : String(e);
        return { ok: false, error: `Proxy unreachable: ${msg}. Check scheme (http vs https vs socks5), host, port and credentials.` };
      }
    }
    store.proxyUrl = trimmed;
    saveStore();
    this.log("", "", "system", "system", trimmed ? `telegram proxy url saved: ${this.maskProxy(trimmed)}` : "telegram proxy url cleared");
    this.pushState();
    if (store.proxyEnabled) await this.bounceRuntimes();
    return { ok: true, probe };
  }

  /**
   * Flip the proxy on/off without touching the saved URL. Enabling without a
   * usable address is refused so the UI never shows a half-broken state; the
   * caller snaps its toggle back on `ok: false`.
   */
  async setProxyEnabled(enabled: boolean): Promise<{ ok: boolean; error?: string }> {
    const store = loadStore();
    if (enabled) {
      const url = store.proxyUrl.trim();
      if (!url) return { ok: false, error: "Proxy URL is empty — enter an address first" };
      const invalid = validateProxyUrl(url);
      if (invalid) return { ok: false, error: invalid };
    }
    if (store.proxyEnabled === enabled) return { ok: true };
    store.proxyEnabled = enabled;
    saveStore();
    this.log(
      "",
      "",
      "system",
      "system",
      enabled ? `telegram proxy enabled: ${this.maskProxy(store.proxyUrl)}` : "telegram proxy disabled — connecting directly",
    );
    this.pushState();
    await this.bounceRuntimes();
    return { ok: true };
  }

  /**
   * Probe api.telegram.org through an arbitrary proxy URL WITHOUT touching the
   * stored config or bouncing bots. Empty url = test the direct connection.
   * Powers the CC "Test" affordance for diagnosing an already-set proxy that
   * died after being committed (commit-time probing can't catch that).
   */
  async testProxy(url: string): Promise<{ ok: boolean; detail: string }> {
    const trimmed = url.trim();
    const err = validateProxyUrl(trimmed);
    if (err) return { ok: false, detail: err };
    const started = Date.now();
    try {
      const res = await probeGetMe("0:probe", trimmed ? agentForUrl(trimmed) : undefined);
      const via = trimmed ? "proxy OK" : "direct connection OK";
      return { ok: true, detail: `${via} — api.telegram.org answered ${res.status} in ${Date.now() - started} ms` };
    } catch (e) {
      const msg = e instanceof Error && e.name === "TimeoutError"
        ? "no answer within 15s"
        : e instanceof Error ? e.message : String(e);
      return { ok: false, detail: trimmed ? `Proxy failed: ${msg}` : `Direct connection failed: ${msg}` };
    }
  }

  revokeUser(botId: string, telegramId: number): void {
    const store = loadStore();
    const bot = store.bots.find((b) => b.id === botId);
    if (!bot) return;
    const user = bot.paired.find((p) => p.telegramId === telegramId);
    bot.paired = bot.paired.filter((p) => p.telegramId !== telegramId);
    saveStore();
    if (user) this.log(botId, bot.username, `@${user.username}`, "system", "user revoked");
    this.pushState();
  }

  /** crown/uncrown a paired user (IDE-only). ≥1 owner stays while users are paired. */
  setUserOwner(botId: string, telegramId: number, owner: boolean): { ok: boolean; error?: string } {
    const store = loadStore();
    const bot = store.bots.find((b) => b.id === botId);
    const user = bot?.paired.find((p) => p.telegramId === telegramId);
    if (!bot || !user) return { ok: false, error: "User is not paired" };
    if (!owner && user.owner && !bot.paired.some((p) => p.owner && p.telegramId !== telegramId) && bot.paired.length > 1)
      return { ok: false, error: "last-owner" }; // renderer shows the localized hint
    user.owner = owner;
    saveStore();
    this.log(botId, bot.username, "system", "system", `${owner ? "owner designated" : "owner removed"}: @${user.username}`);
    this.pushState();
    return { ok: true };
  }

  // ================================================== pairing

  startPairing(botId: string): RemotePairing {
    this.cancelPairing();
    const code = String(randomInt(100000, 1000000));
    const expiresAt = Date.now() + 5 * 60_000;
    const timer = setTimeout(() => {
      this.pairing = null;
      this.pushState();
    }, 5 * 60_000);
    this.pairing = { botId, code, expiresAt, timer };
    this.pushState();
    return { botId, code, expiresAt };
  }

  cancelPairing(): void {
    if (this.pairing) {
      clearTimeout(this.pairing.timer);
      this.pairing = null;
      this.pushState();
    }
  }

  tryPair(botId: string, msg: InboundMessage, code: string): boolean {
    const p = this.pairing;
    if (!p || p.botId !== botId || p.code !== code || Date.now() > p.expiresAt) return false;
    const store = loadStore();
    const bot = store.bots.find((b) => b.id === botId);
    if (!bot) return false;
    if (!bot.paired.some((u) => u.telegramId === msg.userId)) {
      bot.paired.push({
        telegramId: msg.userId,
        username: msg.username,
        firstName: msg.firstName,
        chatId: msg.chatId,
        pairedAt: Date.now(),
        ...(msg.languageCode ? { languageCode: msg.languageCode } : {}),
      });
      saveStore();
    }
    this.cancelPairing();
    this.log(botId, bot.username, `@${msg.username}`, "system", "paired");
    const rt = this.runtimes.get(botId);
    rt?.sendMd(
      msg.chatId,
      escapeMd(tg(tgLangFor(msg.languageCode)).paired(bot.username)),
    );
    this.pushState();
    return true;
  }

  // ================================================== BotDelegate (auth + inbound)

  isAuthorized(botId: string, userId: number): boolean {
    const bot = loadStore().bots.find((b) => b.id === botId);
    return !!bot && bot.paired.some((u) => u.telegramId === userId);
  }

  onBlocked(botId: string, _userId: number, username: string, text: string): void {
    const bot = loadStore().bots.find((b) => b.id === botId);
    this.log(botId, bot?.username ?? botId, `@${username}`, "blocked-unauthorized", text.slice(0, 120));
  }

  onGroupMessage(botId: string, gm: GroupMessage): void {
    this.relayPulse(botId);
    const bot = loadStore().bots.find((candidate) => candidate.id === botId);
    if (!bot) return;
    const intake = classifyGroupMessage({
      authorId: gm.authorId,
      ownerIds: bot.paired.filter((user) => user.owner).map((user) => user.telegramId),
      chatId: gm.chatId,
      edit: gm.edit,
      text: gm.text,
      botUsername: gm.botUsername ?? bot.username,
      mentionsBot: gm.mentionsBot,
      replyToBot: gm.replyToBot,
      ...(gm.migrateToChatId !== undefined ? { migrateToChatId: gm.migrateToChatId } : {}),
    });
    if (intake.action === "migrate") {
      this.watch.onChatMigration(botId, gm.chatId, intake.toChatId);
      return;
    }
    this.watch.onGroupMessage(botId, { ...gm, ownerHandled: intake.action === "route" });
    if (intake.action === "blocked") {
      if (shouldLogBlockedGroupUser(this.blockedGroupUsers, `${botId}:${gm.authorId}`)) {
        this.log(botId, bot.username, `@${gm.author}`, "blocked-unauthorized", "group command ignored");
      }
      return;
    }
    if (intake.action === "ignore") return;
    const rt = this.runtimes.get(botId);
    if (
      rt &&
      shouldHintPrivacyMode({
        coverage: this.watch.coverageFor(botId, gm.chatId),
        addressed: intake.addressed,
        hinted: this.privacyHinted,
        key: `${botId}:${gm.chatId}`,
      })
    ) {
      void rt.sendMd(gm.chatId, escapeMd(tg(tgLangFor(gm.languageCode)).privacyModeHint), undefined, gm.messageId);
    }
    this.onMessage(botId, {
      userId: gm.authorId,
      username: gm.author,
      firstName: gm.author,
      chatId: gm.chatId,
      text: intake.text,
      messageId: gm.messageId,
      chatKind: gm.chatKind,
      ...(gm.languageCode ? { languageCode: gm.languageCode } : {}),
    });
  }

  onChatMember(botId: string, ev: { chatId: number; title: string; kind: "group" | "supergroup"; present: boolean }): void {
    this.watch.onChatMember(botId, ev);
  }

  onMessage(botId: string, msg: InboundMessage): void {
    this.relayPulse(botId);
    const bot = loadStore().bots.find((b) => b.id === botId);
    if (!bot) return;
    // keep the stored locale fresh — the user may switch Telegram language
    const paired = bot.paired.find((u) => u.telegramId === msg.userId);
    if (paired && msg.languageCode && paired.languageCode !== msg.languageCode) {
      paired.languageCode = msg.languageCode;
      saveStore();
    }
    const rt = this.runtimes.get(botId);
    if (!rt) return;

    if (msg.text.startsWith("/")) {
      const cmd = msg.text.split(/[\s@]/)[0].toLowerCase();
      this.log(botId, bot.username, `@${msg.username}`, "command", msg.text.slice(0, 120));
      void this.handleCommand(cmd, rt, bot, msg);
      return;
    }

    const status = this.bridge.getStatus();
    const state = status?.state ?? "idle";

    if (state === "awaiting-input" && this.currentUi) {
      const res = this.bridge.answerUi(
        this.currentUi.id,
        { value: msg.text },
        `@${msg.username}`,
        msg.text,
      );
      if (res.applied) {
        this.log(botId, bot.username, `@${msg.username}`, "answer", msg.text.slice(0, 120));
        this.currentUi = null;
        this.echoToOthers(botId, msg, "answer");
        this.pushRemoteAnswerToIde(msg.username, bot.name, msg.text);
        this.startTyping();
      } else if (res.already) {
        rt.sendMd(
          msg.chatId,
          escapeMd(`Already answered by ${res.already.by} (their answer: ${res.already.answer.slice(0, 80)})`),
        );
      }
      return;
    }

    // Chat Dialogue (spec addendum): a plain paired-DM message is classified
    // BEFORE anything executes — question ≠ task. Deterministic pre-checks
    // short-circuit the obvious, so the common task message pays no latency.
    void this.routeDm(botId, rt, bot, msg);
  }

  /** classify a paired-DM message, then answer / run / nudge / both */
  private async routeDm(botId: string, rt: BotRuntime, bot: StoredBot, msg: InboundMessage): Promise<void> {
    const verdict = await routeIntent(stripLeadingMentionsForIntent(msg.text), [], bot.username);
    const lang = tgLangFor(msg.languageCode);
    if (verdict.intent === "other") {
      // one-line nudge (spec §2) — never a task, never silence in a paired DM
      rt.sendMd(msg.chatId, escapeMd(tg(lang).dialogNudge));
      this.log(botId, bot.username, `@${msg.username}`, "dialog", `nudge: ${msg.text.slice(0, 80)}`);
      return;
    }
    if (verdict.intent === "question" || verdict.intent === "mixed") {
      // paired DM = the ONE private surface: full grounded status/history
      const res = await answerQuestion({ botId, chatId: msg.chatId, question: msg.text, asker: msg.username, disclosure: "private" });
      if (res.ok) {
        rt.sendMd(msg.chatId, escapeMd(res.answer));
        this.log(botId, bot.username, `@${msg.username}`, "dialog", `[private] «${msg.text.slice(0, 70)}» → ${res.answer.slice(0, 90)}`);
      } else {
        rt.sendMd(msg.chatId, escapeMd(tg(lang).dialogFailed));
        this.log(botId, bot.username, "system", "dialog", `answer failed: ${res.error.slice(0, 120)}`);
      }
    }
    if (verdict.intent === "error")
      this.log(botId, bot.username, "system", "system", `intent routing failed — treating as task: ${verdict.error.slice(0, 100)}`);
    if (verdict.intent === "task" || verdict.intent === "mixed" || verdict.intent === "error") {
      this.runDmTask(botId, rt, bot, msg, verdict.intent === "mixed" ? verdict.taskLine : msg.text);
    }
  }

  /** Telegram tasks pick Solo/Team unless roster mentions already decide. */
  private runDmTask(botId: string, rt: BotRuntime, bot: StoredBot, msg: InboundMessage, text: string): void {
    if (!this.bridge.getRoot()) {
      void this.reply(rt, msg, escapeMd(tg(tgLangFor(msg.languageCode)).agentNotRunning));
      return;
    }
    const intake = classifyTaskIntake({
      text,
      roster: teamRoster(),
      teamRunActive: isTeamRunActive(),
      ...(this.bridge.getStatus()?.state ? { agentState: this.bridge.getStatus()!.state } : {}),
    });
    if (intake.kind === "steer") {
      const ok = isTeamRunActive() ? steerTeamFromRemote(text) : this.bridge.prompt(text, { username: msg.username, botName: bot.name });
      if (!ok) void this.reply(rt, msg, escapeMd(tg(tgLangFor(msg.languageCode)).agentNotRunning));
      else this.log(botId, bot.username, `@${msg.username}`, "steer", text.slice(0, 120));
      return;
    }
    if (intake.kind === "team") {
      this.pushRemoteAnswerToIde(msg.username, bot.name, text);
      void this.startDirectTeam(rt, bot, msg, text, intake.mentions);
      return;
    }
    void this.createModePicker(rt, bot, msg, text);
  }

  onCallback(botId: string, cb: InboundCallback): void {
    this.relayPulse(botId);
    const bot = loadStore().bots.find((b) => b.id === botId);
    const rt = this.runtimes.get(botId);
    if (!bot || !rt) return;

    // proposal decisions from the approver's DM: pp:<id>:do|skip
    if (this.watch.handleCallback(botId, cb.data, cb.username, cb.ack)) return;
    // team plan approval: team:<runId> | team:open (informational)
    // agent question buttons: ui:<reqId>:<optIndex|yes|no>
    // Solo/Team picker: mode:<taskId>:solo|team
    if (cb.data.startsWith("mode:")) {
      const [, id, choice] = cb.data.split(":");
      const L = tg(tgLangFor(cb.languageCode));
      const claim = this.pending.claim(id, cb.userId);
      if (!claim.ok) {
        cb.ack(claim.reason === "foreign" ? L.pickerNotYours : L.pickerExpired);
        if (claim.reason === "missing" && cb.messageId !== undefined) void rt.editMd(cb.chatId, cb.messageId, escapeMd(L.lostPendingTask));
        return;
      }
      cb.ack();
      void this.startPendingMode(claim.entry, choice === "team" ? "team" : "solo", `@${cb.username}`);
      return;
    }
    if (cb.data.startsWith("ui:")) {
      const [, reqId, choice] = cb.data.split(":");
      if (!this.currentUi || this.currentUi.id !== reqId) {
        cb.ack("This question is no longer active");
        return;
      }
      let payload: Record<string, unknown>;
      let label: string;
      if (choice === "yes" || choice === "no") {
        payload = { confirmed: choice === "yes" };
        label = choice === "yes" ? "Yes" : "No";
      } else {
        const idx = parseInt(choice, 10);
        const opt = this.currentUi.options?.[idx];
        if (opt === undefined) {
          cb.ack("Unknown option");
          return;
        }
        payload = { value: opt };
        label = opt;
      }
      const res = this.bridge.answerUi(reqId, payload, `@${cb.username}`, label);
      if (res.applied) {
        cb.ack("Answered");
        this.currentUi = null;
        this.log(botId, bot.username, `@${cb.username}`, "answer", label);
        this.pushRemoteAnswerToIde(cb.username, bot.name, label);
        this.startTyping();
      } else if (res.already) {
        cb.ack(`Already answered by ${res.already.by}`);
        rt.sendMd(cb.chatId, escapeMd(`Already answered by ${res.already.by} (their answer: ${res.already.answer.slice(0, 80)})`));
      } else {
        cb.ack("Question expired");
      }
      return;
    }

    // /new confirmations: cfm:<token>:<yes|no>
    if (cb.data.startsWith("cfm:")) {
      const [, token, choice] = cb.data.split(":");
      const pending = this.confirms.get(token);
      this.confirms.delete(token);
      if (!pending || choice !== "yes") {
        cb.ack(pending ? "Cancelled" : "Expired");
        return;
      }
      cb.ack("Confirmed");
      this.bridge.newSession();
      this.tracker.reset();
      this.log(botId, bot.username, `@${cb.username}`, "command", "/new confirmed");
      this.broadcastMd(escapeMd(`🔄 @${cb.username} started a new session.`));
      return;
    }

    // /diff file buttons: df:<index>
    if (cb.data.startsWith("df:")) {
      const idx = parseInt(cb.data.slice(3), 10);
      const path = this.diffIndex[idx];
      const patch = path ? this.tracker.patchFor(path) : null;
      if (!patch) {
        cb.ack("No diff for that file");
        return;
      }
      cb.ack();
      if (patch.length > 3500) {
        rt.sendDocument(cb.chatId, `${basename(path)}.patch`, patch);
      } else {
        rt.sendMd(cb.chatId, "```diff\n" + patch.replace(/[`\\]/g, (c) => `\\${c}`) + "\n```");
      }
      return;
    }

    // failure alert: restart session
    if (cb.data === "restart") {
      cb.ack("Restarting…");
      void this.bridge.restartSession().then((ok) => {
        this.broadcastMd(escapeMd(ok ? `@${cb.username} restarted the agent session.` : "Restart failed — no window to restart in."));
      });
      this.log(botId, bot.username, `@${cb.username}`, "command", "restart session");
      return;
    }

    cb.ack();
  }

  onStateChange(botId: string): void {
    const bot = loadStore().bots.find((b) => b.id === botId);
    const rt = this.runtimes.get(botId);
    if (bot && rt && (rt.state === "auth-error" || rt.state === "degraded"))
      this.log(botId, bot.username, "system", "system", `${rt.state}: ${rt.detail ?? ""}`.slice(0, 140));
    this.pushState();
  }

  // ================================================== commands

  private async handleCommand(cmd: string, rt: BotRuntime, bot: StoredBot, msg: InboundMessage): Promise<void> {
    switch (cmd) {
      case "/start":
        rt.sendMd(msg.chatId, escapeMd(tg(tgLangFor(msg.languageCode)).alreadyPaired));
        return;
      case "/help":
        rt.sendMd(msg.chatId, escapeMd(tg(tgLangFor(msg.languageCode)).help));
        return;
      case "/solo": {
        const L = tg(tgLangFor(msg.languageCode));
        const parsed = parseSoloTask(msg.text);
        if (!parsed.ok) {
          void this.reply(rt, msg, escapeMd(L.soloUsage));
          return;
        }
        if (isTeamRunActive()) {
          void this.reply(rt, msg, escapeMd(L.teamAlreadyActive));
          return;
        }
        this.activeTaskTarget = this.taskTarget(rt, bot, msg);
        this.taskFinalSent = false;
        const ok = this.bridge.prompt(parsed.task, { username: msg.username, botName: bot.name });
        if (!ok) {
          this.activeTaskTarget = null;
          void this.reply(rt, msg, escapeMd(L.agentNotRunning));
          return;
        }
        this.log(bot.id, bot.username, `@${msg.username}`, "task", `/solo ${parsed.task}`.slice(0, 120));
        void this.reply(rt, msg, escapeMd(L.soloStarted));
        return;
      }
      case "/team": {
        const L = tg(tgLangFor(msg.languageCode));
        const parsed = parseModeCommand(msg.text, "team");
        if (!parsed.ok) {
          void this.reply(rt, msg, escapeMd(L.teamUsage));
          return;
        }
        if (isTeamRunActive()) {
          void this.reply(rt, msg, escapeMd(L.teamAlreadyActive));
          return;
        }
        void this.startDirectTeam(rt, bot, msg, parsed.task, extractRosterMentions(parsed.task, teamRoster()));
        return;
      }
      case "/status": {
        const team = teamJournalData();
        if (team && isTeamRunActive()) {
          const text = renderTelegramTeamStatus(team, tgLangFor(msg.languageCode));
          rt.sendMd(msg.chatId, "```\n" + text.replace(/[`\\]/g, (c) => `\\${c}`) + "\n```");
          return;
        }
        const st = this.bridge.getStatus();
        const root = this.bridge.getRoot();
        const phases = this.bridge.getTodoPhases();
        let done = 0, total = 0;
        for (const p of phases) for (const t of p.tasks) { total++; if (t.status === "completed") done++; }
        const branch = root ? await gitBranch(root) : "";
        const stateLine = !st ? "no session" :
          st.state === "tool" && st.tool ? `running · ${st.tool}` : st.state;
        const lines = [
          `state: ${stateLine}`,
          total ? `todo: ${done}/${total}` : "todo: none",
          `workspace: ${root ? basename(root) : "none open"}`,
          branch ? `branch: ${branch}` : "",
          `uptime: ${formatElapsed(Date.now() - appStartedAt)}`,
          `remotes: ${this.targets().length} connected`,
        ].filter(Boolean);
        rt.sendMd(msg.chatId, "```\n" + lines.join("\n").replace(/[`\\]/g, (c) => `\\${c}`) + "\n```");
        return;
      }
      case "/todo":
        rt.sendMd(msg.chatId, escapeMd(renderTodoLines(this.bridge.getTodoPhases())));
        return;
      case "/files": {
        const paths = this.tracker.touchedPaths();
        rt.sendMd(msg.chatId, escapeMd(paths.length ? paths.join("\n") : "No files touched this session."));
        return;
      }
      case "/diff": {
        const stats = this.tracker.stats();
        if (!stats.length) {
          rt.sendMd(msg.chatId, escapeMd("No files touched this session."));
          return;
        }
        this.diffIndex = stats.map((s) => s.path);
        const kb = new InlineKeyboard();
        stats.forEach((s, i) => {
          kb.text(`${basename(s.path)} +${s.add} −${s.del}`, `df:${i}`).row();
        });
        rt.sendMd(msg.chatId, escapeMd(renderDiffstat(stats)), kb);
        return;
      }
      case "/who": {
        const lines: string[] = [];
        for (const b of loadStore().bots) {
          if (!b.enabled) continue;
          for (const u of b.paired) lines.push(`${u.firstName} @${u.username} · via @${b.username}`);
        }
        rt.sendMd(msg.chatId, escapeMd(lines.length ? lines.join("\n") : "No remotes connected."));
        return;
      }
      case "/think": {
        const tc = getThinkingControl();
        if (!tc) {
          rt.sendMd(msg.chatId, escapeMd("Thinking control is not available in this build."));
          return;
        }
        const arg = msg.text.trim().split(/\s+/)[1]?.toLowerCase();
        if (!arg) {
          const d = tc.describe();
          const lines = [
            `level: ${d.effective}`,
            d.override ? `session override: ${d.override}` : "",
            `capability: ${d.capability}`,
          ].filter(Boolean);
          rt.sendMd(msg.chatId, "```\n" + lines.join("\n").replace(/[`\\]/g, (c) => `\\${c}`) + "\n```");
          return;
        }
        const res = tc.setSession(arg, `tg:@${msg.username}`);
        if (!res.ok) {
          rt.sendMd(msg.chatId, escapeMd(res.error ?? "Failed to set level."));
          return;
        }
        this.log(bot.id, bot.username, `@${msg.username}`, "command", `/think ${arg}`);
        rt.sendMd(
          msg.chatId,
          escapeMd(
            res.pending
              ? `Thinking → ${arg} for this session (queued — applies when the current run finishes).`
              : `Thinking → ${arg} for this session.`,
          ),
        );
        return;
      }
      case "/stop": {
        const L = tg(tgLangFor(msg.languageCode));
        const pending = this.pending.cancelByChat(this.pendingChatKey(bot.id, msg.chatId));
        if (pending) {
          if (pending.pickerMessageId !== null) await rt.editMd(msg.chatId, pending.pickerMessageId, escapeMd(L.pickerCancelled));
          this.log(bot.id, bot.username, `@${msg.username}`, "command", "/stop pending");
          void this.reply(rt, msg, escapeMd(L.taskStopped));
          return;
        }
        if (stopTeamFromRemote()) {
          this.teamTaskActive = false;
          this.stopTyping();
          this.taskFinalSent = true;
          this.activeTaskTarget = null;
          this.log(bot.id, bot.username, `@${msg.username}`, "command", "/stop team");
          void this.reply(rt, msg, escapeMd(L.teamStopped));
          return;
        }
        const st = this.bridge.getStatus();
        const busy = st && (st.state === "thinking" || st.state === "tool" || st.state === "awaiting-input");
        if (!busy || !this.bridge.abort()) {
          void this.reply(rt, msg, escapeMd(L.nothingToStop));
          return;
        }
        this.stopTyping();
        this.taskFinalSent = true;
        this.activeTaskTarget = null;
        this.log(bot.id, bot.username, `@${msg.username}`, "command", "/stop");
        void this.reply(rt, msg, escapeMd(L.taskStopped));
        return;
      }
      case "/new": {
        const st = this.bridge.getStatus();
        const busy = st && (st.state === "thinking" || st.state === "tool" || st.state === "awaiting-input");
        if (!busy) {
          this.bridge.newSession();
          this.tracker.reset();
          this.log(bot.id, bot.username, `@${msg.username}`, "command", "/new");
          this.broadcastMd(escapeMd(`🔄 @${msg.username} started a new session.`));
          return;
        }
        const token = String(++this.confirmSeq);
        this.confirms.set(token, { kind: "new", username: msg.username });
        const kb = new InlineKeyboard().text("Yes, new session", `cfm:${token}:yes`).text("Cancel", `cfm:${token}:no`);
        rt.sendMd(msg.chatId, escapeMd("A task is running. Drop it and start a new session?"), kb);
        return;
      }
      default:
        rt.sendMd(msg.chatId, escapeMd(tg(tgLangFor(msg.languageCode)).unknownCommand));
    }
  }

  // ================================================== outbound

  /** all (runtime, chat) pairs across enabled, live bots */
  private targets(): ChatTarget[] {
    const out: ChatTarget[] = [];
    for (const bot of loadStore().bots) {
      if (!bot.enabled) continue;
      const runtime = this.runtimes.get(bot.id);
      if (!runtime || !runtime.isRunning) continue;
      for (const u of bot.paired) {
        out.push({ runtime, bot, chatId: u.chatId, username: u.username, ...(u.languageCode ? { languageCode: u.languageCode } : {}) });
      }
    }
    return out;
  }

  /** broadcast MarkdownV2 to every chat; optionally skip the origin chat */
  private broadcastMd(text: string, skipBotId?: string, skipChatId?: number): void {
    for (const t of this.targets()) {
      if (skipBotId && t.bot.id === skipBotId && t.chatId === skipChatId) continue;
      t.runtime.sendMd(t.chatId, text);
    }
  }

  /** mirror an inbound remote message to the other remotes */
  /** Tasks/steering/answers are visible in the shared IDE transcript only;
   *  Telegram task pushes remain final-only. */
  private echoToOthers(_botId: string, _msg: InboundMessage, _kind: "task" | "steer" | "answer"): void {}

  private onAgentEvent(e: { kind: string; failed?: boolean }): void {
    if (e.kind === "agent-start") {
      if (!this.teamTaskActive) this.taskFinalSent = false;
      this.teamTaskActive = isTeamRunActive();
      this.startTyping();
    } else if (e.kind === "agent-end") {
      this.currentUi = null;
      if (this.teamTaskActive) {
        queueMicrotask(() => {
          const decision = classifyTeamAgentEnd(teamJournalData()?.phase ?? null);
          if (decision === "continue") return;
          this.teamTaskActive = false;
          this.stopTyping();
          if (decision === "error") this.sendErrorOnce();
        });
      } else if (!this.teamTaskActive) {
        this.stopTyping();
        if (e.failed) this.sendErrorOnce();
        else this.sendCompletionSummary();
      }
    } else if (e.kind === "tool-start" || e.kind === "tool-end" || e.kind === "todos" || e.kind === "text-delta") {
      this.refreshTyping();
    }
  }

  private startTyping(): void {
    this.refreshTyping();
    if (this.typingTimer) clearInterval(this.typingTimer);
    this.typingTimer = setInterval(() => this.refreshTyping(), 4000);
  }

  private stopTyping(): void {
    if (this.typingTimer) clearInterval(this.typingTimer);
    this.typingTimer = null;
  }

  private refreshTyping(): void {
    const st = this.bridge.getStatus();
    if (!shouldSendTyping(st?.state, isTeamRunActive())) return;
    const targets = this.activeTaskTarget ? [this.activeTaskTarget] : this.targets();
    for (const target of targets) target.runtime.sendTyping(target.chatId);
  }

  private sendFinalOnce(final: string, elapsedMs = this.tracker.elapsedMs): void {
    if (this.taskFinalSent) return;
    this.taskFinalSent = true;
    const files = this.tracker.totals().files;
    const minutes = Math.max(1, Math.round(elapsedMs / 60000));
    const targets = this.activeTaskTarget ? [this.activeTaskTarget] : this.targets();
    for (const target of targets) {
      const L = tg(tgLangFor(target.languageCode));
      const meta = [files ? `✓ ${L.files(files)}` : "✓", this.tracker.lastPassedCount ? L.passed(this.tracker.lastPassedCount) : "", L.minutes(minutes)].filter(Boolean).join(" · ");
      const text = `${mdToTelegram(final || L.taskDoneFallback)}\n\n\`${escapeMd(meta)}\``;
      target.runtime.sendMd(target.chatId, text, undefined, target.replyToMessageId);
    }
    this.activeTaskTarget = null;
  }

  private sendCompletionSummary(): void {
    this.sendFinalOnce(sanitizeOutbound(this.tracker.lastFinalText).trim());
  }

  private sendErrorOnce(): void {
    if (this.taskFinalSent) return;
    this.taskFinalSent = true;
    const targets = this.activeTaskTarget ? [this.activeTaskTarget] : this.targets();
    for (const target of targets) {
      const L = tg(tgLangFor(target.languageCode));
      target.runtime.sendMd(target.chatId, escapeMd(L.agentError), undefined, target.replyToMessageId);
    }
    this.activeTaskTarget = null;
  }

  private onAgentQuestion(req: BridgeUiRequest): void {
    this.currentUi = req;
    this.stopTyping();
    const targets = this.activeTaskTarget ? [this.activeTaskTarget] : this.targets();
    for (const target of targets) {
      const L = tg(tgLangFor(target.languageCode));
      const kb = new InlineKeyboard();
      if (req.method === "confirm") kb.text(L.yes, `ui:${req.id}:yes`).text(L.no, `ui:${req.id}:no`);
      else if (req.method === "select") (req.options ?? []).forEach((opt, i) => kb.text(opt.slice(0, 48), `ui:${req.id}:${i}`).row());
      const parts = [req.title ?? "Agent asks", sanitizeOutbound(req.message ?? ""), req.method === "input" || req.method === "editor" ? L.freeTextReply : ""].filter(Boolean);
      target.runtime.sendMd(target.chatId, escapeMd(parts.join("\n")), req.method === "confirm" || req.method === "select" ? kb : undefined, target.replyToMessageId);
    }
  }

  // ================================================== IDE push

  private log(botId: string, botUsername: string, sender: string, kind: RemoteEventKind, detail: string): void {
    const ev: RemoteActivityEvent = { time: Date.now(), botId, botUsername, sender, kind, detail };
    this.activity.push(ev);
    if (this.activity.length > 100) this.activity.shift();
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send("remote:activity", ev);
  }

  private relayPulse(botId: string): void {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send("remote:relay", botId);
  }

  private pushRemoteAnswerToIde(username: string, botName: string, text: string): void {
    for (const w of BrowserWindow.getAllWindows())
      w.webContents.send("omp:event", { kind: "user-message", text, via: { username, botName } });
  }

  private botInfo(bot: StoredBot): RemoteBotInfo {
    const rt = this.runtimes.get(bot.id);
    return {
      id: bot.id,
      name: bot.name,
      username: bot.username,
      enabled: bot.enabled,
      state: rt?.state ?? "off",
      detail: rt?.detail,
      paired: bot.paired,
      lastActivity: rt?.lastActivity ?? null,
      sessionMessages: rt?.sessionMessages ?? 0,
    };
  }

  getState(): RemoteState {
    const store = loadStore();
    return {
      globalEnabled: store.globalEnabled,
      proxyUrl: store.proxyUrl,
      proxyEnabled: store.proxyEnabled,
      bots: store.bots.map((b) => this.botInfo(b)),
      pairing: this.pairing
        ? { botId: this.pairing.botId, code: this.pairing.code, expiresAt: this.pairing.expiresAt }
        : null,
    };
  }

  getActivity(): RemoteActivityEvent[] {
    return [...this.activity];
  }

  pushState(): void {
    const state = this.getState();
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send("remote:state", state);
  }
}

interface BotIdentity {
  id: number;
  first_name: string;
  username: string;
}

/**
 * Direct getMe validation. grammY's wrapper collapses every transport failure
 * into "Network request for 'getMe' failed!"; this surfaces the real cause
 * (DNS, timeout, reset, HTTP status) and retries once on transient errors.
 * Runs over node:https (not global fetch) so the Telegram proxy agent —
 * http(s) or socks — applies to the probe exactly as it does to polling.
 */
function probeGetMe(
  token: string,
  agent: Agent | undefined = currentProxyAgent(),
): Promise<{ status: number; statusText: string; body: unknown }> {
  const { promise, resolve, reject } = Promise.withResolvers<{ status: number; statusText: string; body: unknown }>();
  const req = httpsRequest(
    `https://api.telegram.org/bot${token}/getMe`,
    { agent, timeout: 15_000 },
    (res) => {
      let raw = "";
      res.setEncoding("utf-8");
      res.on("data", (c: string) => (raw += c));
      res.on("end", () => {
        let body: unknown = null;
        try {
          body = JSON.parse(raw);
        } catch {}
        resolve({ status: res.statusCode ?? 0, statusText: res.statusMessage ?? "", body });
      });
    },
  );
  req.on("timeout", () => req.destroy(Object.assign(new Error("timed out"), { name: "TimeoutError" })));
  req.on("error", reject);
  req.end();
  // A proxy agent stuck in its own CONNECT/TLS phase holds the request
  // without a socket; req.destroy() then emits NOTHING and the promise
  // would never settle. The race guarantees settlement; destroy is
  // best-effort cleanup for the half-open proxy socket.
  const deadline = new Promise<never>((_, rej) => {
    setTimeout(() => {
      try {
        req.destroy();
      } catch {}
      rej(Object.assign(new Error("timed out"), { name: "TimeoutError" }));
    }, 15_000).unref();
  });
  return Promise.race([promise, deadline]);
}

async function validateBotToken(
  token: string,
): Promise<{ ok: true; me: BotIdentity } | { ok: false; error: string }> {
  let lastError = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await probeGetMe(token);
      const body: unknown = res.body;
      if (
        body &&
        typeof body === "object" &&
        "ok" in body &&
        body.ok === true &&
        "result" in body &&
        body.result &&
        typeof body.result === "object"
      ) {
        const r = body.result as Record<string, unknown>;
        if (typeof r.id === "number" && typeof r.username === "string") {
          return {
            ok: true,
            me: {
              id: r.id,
              username: r.username,
              first_name: typeof r.first_name === "string" ? r.first_name : r.username,
            },
          };
        }
      }
      const desc =
        body && typeof body === "object" && "description" in body && typeof body.description === "string"
          ? body.description
          : res.statusText;
      // HTTP-level rejection (401 etc.) is definitive — no retry
      return { ok: false, error: `${res.status}: ${desc}` };
    } catch (err) {
      const cause = err instanceof Error && err.cause instanceof Error ? ` (${err.cause.message})` : "";
      lastError =
        err instanceof Error && err.name === "TimeoutError"
          ? "api.telegram.org timed out after 15s — check connectivity/VPN"
          : `${err instanceof Error ? err.message : String(err)}${cause} — api.telegram.org unreachable`;
      if (attempt === 0) await new Promise((r) => setTimeout(r, 1200));
    }
  }
  return { ok: false, error: lastError };
}

function gitBranch(root: string): Promise<string> {
  const { promise, resolve } = Promise.withResolvers<string>();
  execFile(
    "git",
    ["branch", "--show-current"],
    { cwd: root, windowsHide: true, encoding: "utf-8" },
    (err, stdout) => resolve(err ? "" : stdout.trim()),
  );
  return promise;
}

// ================================================== module surface

let manager: RemoteManager | null = null;

export function registerRemoteHandlers(ipc: IpcMain): void {
  manager = new RemoteManager();
  void manager.init();
  const m = manager;

  ipc.handle("remote:getState", async () => m.getState());
  // live getMe probe without registering — the add-bot confirm step (D5)
  ipc.handle("remote:checkToken", async (_e, token: string) => {
    const trimmed = token.trim();
    if (!/^\d+:[\w-]+$/.test(trimmed))
      return { ok: false as const, error: "That does not look like a bot token" };
    const res = await validateBotToken(trimmed);
    return res.ok
      ? { ok: true as const, name: res.me.first_name, username: res.me.username }
      : res;
  });
  ipc.handle("remote:addBot", async (_e, token: string) => m.addBot(token));
  ipc.handle("remote:removeBot", async (_e, botId: string) => m.removeBot(botId));
  ipc.handle("remote:setBotEnabled", async (_e, botId: string, enabled: boolean) =>
    m.setBotEnabled(botId, enabled),
  );
  ipc.handle("remote:setGlobalEnabled", async (_e, enabled: boolean) => m.setGlobalEnabled(enabled));
  ipc.handle("remote:setProxyUrl", async (_e, url: string) => m.setProxyUrl(url));
  ipc.handle("remote:setProxyEnabled", async (_e, enabled: boolean) => m.setProxyEnabled(enabled));
  ipc.handle("remote:testProxy", async (_e, url: string) => m.testProxy(url));
  ipc.handle("remote:startPairing", async (_e, botId: string) => m.startPairing(botId));
  ipc.handle("remote:cancelPairing", async () => m.cancelPairing());
  ipc.handle("remote:revokeUser", async (_e, botId: string, telegramId: number) =>
    m.revokeUser(botId, telegramId),
  );
  ipc.handle("remote:setUserOwner", async (_e, botId: string, telegramId: number, owner: boolean) =>
    m.setUserOwner(botId, telegramId, owner),
  );
  ipc.handle("remote:getActivity", async () => m.getActivity());

  // ---- chat watch (group listener)
  ipc.handle("remote:getWatchState", async () => m.watch.getWatchState());
  ipc.handle("remote:setChatWatched", async (_e, botId: string, chatId: number, watched: boolean) =>
    m.watch.setChatWatched(botId, chatId, watched),
  );
  ipc.handle("remote:setChatListener", async (_e, botId: string, chatId: number, listener: boolean) =>
    m.watch.setChatListener(botId, chatId, listener),
  );
  ipc.handle("remote:setChatAnswerMembers", async (_e, botId: string, chatId: number, enabled: boolean) =>
    m.watch.setChatAnswerMembers(botId, chatId, enabled),
  );
  ipc.handle("remote:removeChat", async (_e, botId: string, chatId: number, deleteLog: boolean) =>
    m.watch.removeChat(botId, chatId, deleteLog),
  );
  ipc.handle("remote:setApprover", async (_e, botId: string, telegramId: number) =>
    m.watch.setApprover(botId, telegramId),
  );
  ipc.handle("remote:setCooldownMinutes", async (_e, minutes: number) =>
    m.watch.setCooldownMinutes(minutes),
  );
  ipc.handle("remote:readChatLog", async (_e, botId: string, chatId: number, beforeSeq?: number, limit?: number) =>
    m.watch.readLog(botId, chatId, beforeSeq, limit),
  );
  ipc.handle("remote:decideProposal", async (_e, id: string, approve: boolean) =>
    m.watch.decide(id, approve, "IDE"),
  );
}

export async function disposeRemote(): Promise<void> {
  await manager?.dispose();
  manager = null;
}
