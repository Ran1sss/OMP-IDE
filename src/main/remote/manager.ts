/**
 * Remote Control Center backend: bot registry, pairing, inbound routing,
 * outbound broadcasting (digests / questions / summaries), activity feed,
 * and the `remote:*` IPC surface. One agent session, many remotes.
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
  approveTeamFromRemote,
  isTeamRunActive,
  teamDigestData,
} from "../omp-team/team-service";
import { SessionTracker } from "./session-tracker";
import { tg, tgLangFor } from "./tg-i18n";
import {
  escapeMd,
  mdToTelegram,
  chunkText,
  renderDigest,
  renderTeamDigest,
  renderTodoLines,
  renderDiffstat,
  diffstatLine,
  formatElapsed,
  formatElapsedRu,
  sanitizeOutbound,
  TG_LIMIT,
} from "./format";

const appStartedAt = Date.now();

interface ChatTarget {
  runtime: BotRuntime;
  bot: StoredBot;
  chatId: number;
  username: string;
  /** recipient's Telegram language_code — localizes fixed strings per chat */
  languageCode?: string;
}

interface DigestSlot {
  messageId: number;
  lastText: string;
}

class RemoteManager implements BotDelegate {
  private bridge: AgentBridge = getAgentBridge();
  private tracker = new SessionTracker(this.bridge);
  private runtimes = new Map<string, BotRuntime>();
  private pairing: (RemotePairing & { timer: NodeJS.Timeout }) | null = null;
  private activity: RemoteActivityEvent[] = [];
  /** digest message per `${botId}:${chatId}` for the current task */
  private digests = new Map<string, DigestSlot>();
  private digestTimer: NodeJS.Timeout | null = null;
  private digestDirty = false;
  /** a Team run is ONE Telegram task: digests/summaries span its lead turns */
  private teamTaskActive = false;
  private currentUi: BridgeUiRequest | null = null;
  /** pending /stop and /new confirmations by callback token */
  private confirms = new Map<string, { kind: "stop" | "new"; username: string }>();
  private confirmSeq = 0;
  /** /diff file index snapshot per request so button data stays tiny */
  private diffIndex: string[] = [];
  /** chat-watch layer (group listening, proposals) — deletable with the module */
  readonly watch = new WatchManager({
    runtime: (botId) => this.runtimes.get(botId),
    log: (botId, sender, detail) => {
      const bot = loadStore().bots.find((b) => b.id === botId);
      this.log(botId, bot?.username ?? botId, sender, "watch", detail);
    },
  });

  // ================================================== lifecycle

  async init(): Promise<void> {
    this.tracker.attach();
    this.bridge.onStatus(() => this.markDigestDirty());
    this.bridge.onEvent((e) => this.onAgentEvent(e));
    this.bridge.onUiRequest((req) => this.onAgentQuestion(req));

    const store = loadStore();
    if (store.globalEnabled) {
      for (const bot of store.bots) {
        if (bot.enabled) await this.spawnRuntime(bot);
      }
    }
    this.startDigestTimer();
    // auto-swap loudness: swaps and low-balance crossings reach Telegram too
    registerSwapRemoteNotifier((text) => {
      for (const t of this.targets()) t.runtime.sendMd(t.chatId, escapeMd(sanitizeOutbound(text)));
    });
    // Team plan gate: compact human summary — goal one line + short slice
    // bullets (message economy §4); the full technical plan lives behind
    // [Open in IDE]. First decision wins with the IDE button.
    registerTeamGateNotifier((packet) => {
      const lines = [
        `📋 ${sanitizeOutbound(packet.goal).split("\n")[0].slice(0, 180)}`,
        ...packet.slices.map((s) => `• ${s.title.slice(0, 90)}`),
      ];
      // button labels localize per recipient (fix 4)
      for (const t of this.targets()) {
        const L = tg(tgLangFor(t.languageCode));
        const kb = new InlineKeyboard()
          .text(L.approve, `team:${packet.runId}`)
          .text(L.openInIde, "team:open");
        t.runtime.sendMd(t.chatId, escapeMd(lines.join("\n")), kb);
      }
    });
    // Team run completion: THE one final answer — report text (already prose,
    // sanitized) + one inline diffstat line + elapsed. Never a separate meta
    // message (message economy §2).
    registerTeamEndNotifier((p) => {
      this.teamTaskActive = false;
      const stats = p.slices
        .filter((s) => s.add > 0 || s.del > 0)
        .map((s) => `${s.files?.[0]?.split("/").pop() ?? `slice ${s.id}`} +${s.add} −${s.del}`)
        .join(" · ");
      const meta = [stats, `⏱ ${formatElapsedRu(p.elapsedMs)}`].filter(Boolean).join(" · ");
      const body = sanitizeOutbound(p.report).trim();
      const text = (body ? mdToTelegram(body) + "\n\n" : "") + escapeMd(meta);
      const chunks = chunkText(text, TG_LIMIT - 100);
      for (const t of this.targets()) {
        if (chunks.length > 2) {
          t.runtime.sendMd(t.chatId, escapeMd(`✅ Готово — полный отчёт во вложении.\n${meta}`));
          t.runtime.sendDocument(t.chatId, "team-report.md", body);
        } else {
          for (const c of chunks) t.runtime.sendMd(t.chatId, c);
        }
      }
    });
  }

  async dispose(): Promise<void> {
    registerSwapRemoteNotifier(null);
    registerTeamGateNotifier(null);
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
    if (this.digestTimer) clearInterval(this.digestTimer);
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

  setDigestInterval(ms: number): void {
    const store = loadStore();
    store.digestIntervalMs = Math.max(1000, Math.min(30_000, ms));
    saveStore();
    this.startDigestTimer();
    this.pushState();
  }

  /**
   * Set the telegram proxy and restart live runtimes so it takes effect
   * immediately. When a proxy is set, probe api.telegram.org through it with
   * a bogus token: ANY HTTP reply (401/404) proves the transport works;
   * timeout/reset = the proxy itself is dead — reported instead of leaving
   * bots to flap in `degraded`.
   */
  async setProxyUrl(url: string): Promise<{ ok: boolean; error?: string; probe?: string }> {
    const err = validateProxyUrl(url);
    if (err) return { ok: false, error: err };
    const store = loadStore();
    const trimmed = url.trim();
    // probe BEFORE committing: a dead proxy must not silently kill all bots
    let probe: string | undefined;
    if (trimmed) {
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
    this.log("", "", "system", "system", store.proxyUrl ? `telegram proxy set: ${store.proxyUrl.replace(/\/\/[^@]*@/, "//***@")}` : "telegram proxy cleared");
    this.pushState();
    // bounce every enabled runtime — the agent is captured at Bot construction
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
    return { ok: true, probe };
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
    this.watch.onGroupMessage(botId, gm);
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

    if (!this.bridge.getRoot()) {
      rt.sendMd(msg.chatId, escapeMd("No workspace open in OMP IDE."));
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
      } else if (res.already) {
        rt.sendMd(
          msg.chatId,
          escapeMd(`Already answered by ${res.already.by} (their answer: ${res.already.answer.slice(0, 80)})`),
        );
      }
      return;
    }

    const running = state === "thinking" || state === "tool";
    const ok = this.bridge.prompt(msg.text, { username: msg.username, botName: bot.name });
    if (!ok) {
      rt.sendMd(msg.chatId, escapeMd("Agent is not running in OMP IDE."));
      return;
    }
    this.log(botId, bot.username, `@${msg.username}`, running ? "steer" : "task", msg.text.slice(0, 120));
    this.echoToOthers(botId, msg, running ? "steer" : "task");
  }

  onCallback(botId: string, cb: InboundCallback): void {
    this.relayPulse(botId);
    const bot = loadStore().bots.find((b) => b.id === botId);
    const rt = this.runtimes.get(botId);
    if (!bot || !rt) return;

    // proposal decisions from the approver's DM: pp:<id>:do|skip
    if (this.watch.handleCallback(botId, cb.data, cb.username, cb.ack)) return;
    // team plan approval: team:<runId> | team:open (informational)
    if (cb.data.startsWith("team:")) {
      const arg = cb.data.slice(5);
      if (arg === "open") {
        cb.ack("Open OMP IDE on the desktop to edit the plan");
        return;
      }
      const res = approveTeamFromRemote(arg, `@${cb.username} via Telegram`);
      if (res.ok) {
        cb.ack("Approved — team is building");
        this.log(botId, bot.username, `@${cb.username}`, "answer", "team plan approved");
        this.broadcastMd(escapeMd(`🧩 @${cb.username} approved the team plan.`), botId, cb.chatId);
      } else {
        cb.ack(res.error ?? "That plan is no longer active");
      }
      return;
    }
    // agent question buttons: ui:<reqId>:<optIndex|yes|no>
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
        this.broadcastMd(escapeMd(`@${cb.username} answered: ${label}`), botId, cb.chatId);
        this.pushRemoteAnswerToIde(cb.username, bot.name, label);
      } else if (res.already) {
        cb.ack(`Already answered by ${res.already.by}`);
        rt.sendMd(
          cb.chatId,
          escapeMd(`Already answered by ${res.already.by} (their answer: ${res.already.answer.slice(0, 80)})`),
        );
      } else {
        cb.ack("Question expired");
      }
      return;
    }

    // /stop, /new confirmations: cfm:<token>:<yes|no>
    if (cb.data.startsWith("cfm:")) {
      const [, token, choice] = cb.data.split(":");
      const pending = this.confirms.get(token);
      this.confirms.delete(token);
      if (!pending || choice !== "yes") {
        cb.ack(pending ? "Cancelled" : "Expired");
        return;
      }
      cb.ack("Confirmed");
      if (pending.kind === "stop") {
        this.bridge.abort();
        this.log(botId, bot.username, `@${cb.username}`, "command", "/stop confirmed");
        this.broadcastMd(escapeMd(`⏹ @${cb.username} stopped the agent.`));
      } else {
        this.bridge.newSession();
        this.tracker.reset();
        this.digests.clear();
        this.log(botId, bot.username, `@${cb.username}`, "command", "/new confirmed");
        this.broadcastMd(escapeMd(`🔄 @${cb.username} started a new session.`));
      }
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
      case "/status": {
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
            d.boost ? `boost armed: ${d.boost} (one send)` : "",
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
        const st = this.bridge.getStatus();
        if (!st || st.state === "idle" || st.state === "dead" || st.state === "unavailable") {
          rt.sendMd(msg.chatId, escapeMd("Agent is not running."));
          return;
        }
        const token = String(++this.confirmSeq);
        this.confirms.set(token, { kind: "stop", username: msg.username });
        const kb = new InlineKeyboard().text("Yes, stop", `cfm:${token}:yes`).text("Cancel", `cfm:${token}:no`);
        rt.sendMd(msg.chatId, escapeMd("Interrupt the running agent?"), kb);
        return;
      }
      case "/new": {
        const st = this.bridge.getStatus();
        const busy = st && (st.state === "thinking" || st.state === "tool" || st.state === "awaiting-input");
        if (!busy) {
          this.bridge.newSession();
          this.tracker.reset();
          this.digests.clear();
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
  private echoToOthers(botId: string, msg: InboundMessage, kind: "task" | "steer" | "answer"): void {
    const glyph = kind === "task" ? "▷" : kind === "steer" ? "↪" : "✎";
    this.broadcastMd(escapeMd(`${glyph} @${msg.username}: ${sanitizeOutbound(msg.text).slice(0, 500)}`), botId, msg.chatId);
  }

  private onAgentEvent(e: { kind: string }): void {
    if (e.kind === "agent-start") {
      // message economy §1: one digest message per TASK. A team run spans
      // several lead turns — only the FIRST turn opens a fresh digest.
      if (isTeamRunActive()) {
        if (!this.teamTaskActive) {
          this.teamTaskActive = true;
          this.digests.clear();
        }
      } else {
        this.teamTaskActive = false;
        this.digests.clear();
      }
      this.markDigestDirty();
    } else if (e.kind === "agent-end") {
      this.currentUi = null;
      // message economy §2: during a team run intermediate lead turns end
      // (deliberation → gate) — no summary; the ONE final answer arrives
      // via the team end notifier. Narration/standalone-elapsed sends die here.
      if (!this.teamTaskActive) void this.sendCompletionSummary();
    } else if (e.kind === "tool-start" || e.kind === "tool-end" || e.kind === "todos") {
      this.markDigestDirty();
    }
    // dead-agent alerting rides on status, handled below
  }

  private lastStatusState = "";

  private markDigestDirty(): void {
    this.digestDirty = true;
    const st = this.bridge.getStatus();
    if (st && st.state !== this.lastStatusState) {
      const prev = this.lastStatusState;
      this.lastStatusState = st.state;
      if (st.state === "dead" && prev !== "" && prev !== "dead") {
        const detail = st.detail ? `\n${sanitizeOutbound(st.detail).slice(-400)}` : "";
        for (const t of this.targets()) {
          const kb = new InlineKeyboard().text(tg(tgLangFor(t.languageCode)).restartSession, "restart");
          t.runtime.sendMd(t.chatId, escapeMd(`⚠ Agent process died.${detail}`), kb);
        }
        this.log("", "", "system", "system", "agent died — alert broadcast");
      }
    }
  }

  private startDigestTimer(): void {
    if (this.digestTimer) clearInterval(this.digestTimer);
    this.digestTimer = setInterval(() => void this.flushDigests(), loadStore().digestIntervalMs);
  }

  private async flushDigests(): Promise<void> {
    // team runs: the digest mirrors live team state (workers run in their own
    // processes — lead status alone would go stale); recomputed every tick,
    // edits deduped via lastText
    const team = teamDigestData();
    let text: string | null = null;
    if (team) {
      text = renderTeamDigest(team);
    } else {
      if (!this.digestDirty) return;
      this.digestDirty = false;
      const st = this.bridge.getStatus();
      if (!st || (st.state !== "thinking" && st.state !== "tool" && st.state !== "awaiting-input")) return;
      const totals = this.tracker.totals();
      text = renderDigest({
        status: st,
        phases: this.bridge.getTodoPhases(),
        filesTouched: totals.files,
        add: totals.add,
        del: totals.del,
      });
    }
    for (const t of this.targets()) {
      const key = `${t.bot.id}:${t.chatId}`;
      const slot = this.digests.get(key);
      if (!slot) {
        const id = await t.runtime.sendMd(t.chatId, text);
        if (id !== null) this.digests.set(key, { messageId: id, lastText: text });
      } else if (slot.lastText !== text) {
        slot.lastText = text;
        t.runtime.editMd(t.chatId, slot.messageId, text);
      }
    }
  }

  private async sendCompletionSummary(): Promise<void> {
    const targets = this.targets();
    if (!targets.length) return;
    const final = sanitizeOutbound(this.tracker.lastFinalText).trim();
    // message economy §2: ONE final answer — text + one inline diffstat line
    // + elapsed. Never a separate telemetry/meta message.
    const meta = [diffstatLine(this.tracker.stats()), `⏱ ${formatElapsedRu(this.tracker.elapsedMs)}`]
      .filter(Boolean)
      .join(" · ");
    const body = (final ? mdToTelegram(final) : escapeMd("(нет финального ответа)")) + "\n\n" + escapeMd(meta);
    const chunks = chunkText(body, TG_LIMIT - 100);

    for (const t of targets) {
      if (chunks.length > 2) {
        t.runtime.sendMd(t.chatId, escapeMd(`✅ Готово — полный ответ во вложении.\n${meta}`));
        t.runtime.sendDocument(t.chatId, "result.md", final);
      } else {
        for (const c of chunks) t.runtime.sendMd(t.chatId, c);
      }
    }
  }

  private onAgentQuestion(req: BridgeUiRequest): void {
    this.currentUi = req;
    const targets = this.targets();
    if (!targets.length) return;
    const kb = new InlineKeyboard();
    if (req.method === "confirm") {
      // Yes/No get localized per target below; the shared kb covers select
    } else if (req.method === "select" && req.options?.length) {
      req.options.forEach((opt, i) => kb.text(opt.slice(0, 48), `ui:${req.id}:${i}`).row());
    }
    const parts = [
      `❓ ${req.title ?? "Agent asks"}`,
      sanitizeOutbound(req.message ?? ""),
      req.method === "input" || req.method === "editor" ? "(reply with a plain message)" : "",
    ].filter(Boolean);
    const text = escapeMd(parts.join("\n"));
    for (const t of targets) {
      if (req.method === "confirm") {
        const L = tg(tgLangFor(t.languageCode));
        const confirmKb = new InlineKeyboard().text(L.yes, `ui:${req.id}:yes`).text(L.no, `ui:${req.id}:no`);
        t.runtime.sendMd(t.chatId, text, confirmKb);
      } else {
        t.runtime.sendMd(t.chatId, text, req.method === "select" ? kb : undefined);
      }
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
      digestIntervalMs: store.digestIntervalMs,
      proxyUrl: store.proxyUrl,
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
  ipc.handle("remote:setDigestInterval", async (_e, ms: number) => m.setDigestInterval(ms));
  ipc.handle("remote:setProxyUrl", async (_e, url: string) => m.setProxyUrl(url));
  ipc.handle("remote:testProxy", async (_e, url: string) => m.testProxy(url));
  ipc.handle("remote:startPairing", async (_e, botId: string) => m.startPairing(botId));
  ipc.handle("remote:cancelPairing", async () => m.cancelPairing());
  ipc.handle("remote:revokeUser", async (_e, botId: string, telegramId: number) =>
    m.revokeUser(botId, telegramId),
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
