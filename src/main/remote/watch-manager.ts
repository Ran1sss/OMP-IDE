/**
 * Chat-watch orchestration: discovery, JSONL logging, fast-path triggers,
 * listener batching against the smol oneshot, proposal queue with
 * dual-surface (DM + IDE) first-decision-wins approval, cooldowns,
 * expiry, and the `remote:*` watch IPC surface.
 *
 * The flow (spec §5):
 *   group message → watched? no → register `discovered`, drop
 *                 → yes → JSONL → fast path? → PROPOSE(raw)
 *                 → listener on + coverage full + not cooling → batch
 *                 → smol oneshot → "TASK: …" → PROPOSE(agent line)
 */

import { BrowserWindow } from "electron";
import { InlineKeyboard } from "grammy";
import type {
  ChatCoverage,
  RemoteChatInfo,
  RemoteChatLogEntry,
  RemoteProposal,
  RemoteWatchState,
} from "../../shared/types";
import { getAgentBridge, type AgentBridge } from "../omp-service";
import { readRoles, readOmpProfiles } from "../models/omp-config";
import { loadStore } from "./vault";
import {
  loadWatchStore,
  saveWatchStore,
  findChat,
  upsertChat,
  migrateStoredGroup,
  type WatchedChat,
  type StoredProposal,
} from "./watch-store";
import { appendChatLog, readChatLogPage, chatLogPath, deleteChatLog } from "./chat-log";
import { evaluateTranscript, oneshotAvailable, smolSelector } from "./oneshot";
import { routeIntent, answerQuestion, isSpecificsAsk, isOwnerAsk, ownersFor, pickRedirect } from "./dialogue";
import { tg, tgLangFor, type TgLang } from "./tg-i18n";
import { reportOneshotError } from "../models/manager";
import { escapeMd } from "./format";
import type { BotRuntime, GroupMessage } from "./bot-runtime";

const BATCH_DEBOUNCE_MS = 20_000;
const BATCH_MAX = 10;
const CONTEXT_MESSAGES = 15;
const MAX_PENDING_PER_BOT = 10;
const PROPOSAL_TTL_MS = 24 * 60 * 60 * 1000;
const TASK_PREFIX = "omp:";

interface ChatRuntimeState {
  batch: GroupMessage[];
  batchTimer: NodeJS.Timeout | null;
  evaluating: boolean;
  cooldownUntil: number | null;
  evalError: string | null;
}

/** host services the watch layer borrows from RemoteManager */
export interface WatchHost {
  runtime(botId: string): BotRuntime | undefined;
  log(botId: string, sender: string, detail: string, kind?: "watch" | "dialog" | "dialog-guard" | "blocked-unauthorized"): void;
}

export class WatchManager {
  private bridge: AgentBridge = getAgentBridge();
  /** `${botId}:${chatId}` -> volatile listener state */
  private volatile = new Map<string, ChatRuntimeState>();
  private expiryTimer: NodeJS.Timeout;
  /** bots that already got their one queue-overflow notice */
  private overflowNotified = new Set<string>();
  private disposed = false;

  constructor(private host: WatchHost) {
    this.expiryTimer = setInterval(() => this.expireProposals(), 60_000);
  }

  dispose(): void {
    this.disposed = true;
    clearInterval(this.expiryTimer);
    for (const st of this.volatile.values()) clearTimeout(st.batchTimer ?? undefined);
    this.volatile.clear();
  }

  private vol(botId: string, chatId: number): ChatRuntimeState {
    const key = `${botId}:${chatId}`;
    let st = this.volatile.get(key);
    if (!st) {
      st = { batch: [], batchTimer: null, evaluating: false, cooldownUntil: null, evalError: null };
      this.volatile.set(key, st);
    }
    return st;
  }

  // ================================================== inbound (BotDelegate hooks)

  onChatMember(botId: string, ev: { chatId: number; title: string; kind: "group" | "supergroup"; present: boolean }): void {
    const existing = findChat(botId, ev.chatId);
    if (!ev.present) {
      if (existing && !existing.left) {
        existing.left = true;
        existing.watched = false;
        existing.listener = false;
        saveWatchStore();
        this.host.log(botId, "system", `left chat "${existing.title}" — watching stopped, log kept`);
        this.pushWatchState();
      }
      return;
    }
    if (existing) {
      // re-added: revive the card and re-probe coverage
      existing.left = false;
      existing.title = ev.title;
      saveWatchStore();
    } else {
      upsertChat(botId, {
        chatId: ev.chatId,
        title: ev.title,
        kind: ev.kind,
        coverage: "limited",
        watched: false,
        listener: false,
        left: false,
        discoveredAt: Date.now(),
        messageCount: 0,
        evalCount: 0,
        lastEvalAt: null,
        seq: 0,
        proposedIds: [],
      });
      this.host.log(botId, "system", `discovered chat "${ev.title}" — not watched`);
    }
    void this.refreshCoverage(botId, ev.chatId);
    this.pushWatchState();
  }

  onChatMigration(botId: string, fromChatId: number, toChatId: number): void {
    const oldKey = `${botId}:${fromChatId}`;
    const nextKey = `${botId}:${toChatId}`;
    const volatile = this.volatile.get(oldKey);
    if (volatile) {
      this.volatile.delete(oldKey);
      this.volatile.set(nextKey, volatile);
    }
    if (migrateStoredGroup(botId, fromChatId, toChatId)) {
      this.host.log(botId, "system", `group migrated ${fromChatId} → ${toChatId}`);
      this.pushWatchState();
    }
  }

  onGroupMessage(botId: string, gm: GroupMessage): void {
    let chat = findChat(botId, gm.chatId);
    if (!chat) {
      // first sighting without a my_chat_member update (e.g. added while offline)
      chat = {
        chatId: gm.chatId,
        title: gm.chatTitle,
        kind: gm.chatKind,
        coverage: "limited",
        watched: false,
        listener: false,
        left: false,
        discoveredAt: Date.now(),
        messageCount: 0,
        evalCount: 0,
        lastEvalAt: null,
        seq: 0,
        proposedIds: [],
      };
      upsertChat(botId, chat);
      this.host.log(botId, "system", `discovered chat "${gm.chatTitle}" — not watched`);
      void this.refreshCoverage(botId, gm.chatId);
      this.pushWatchState();
      return;
    }
    chat.title = gm.chatTitle; // titles drift
    if (chat.left) chat.left = false; // we're clearly still in the chat
    if (!chat.watched) {
      saveWatchStore();
      return; // opt-in only: nothing logged, nothing evaluated
    }

    // 1. log (independent of the listener); edits append, never rewrite
    const entry: RemoteChatLogEntry = {
      seq: ++chat.seq,
      time: gm.time,
      messageId: gm.messageId,
      authorId: gm.authorId,
      author: gm.author,
      text: gm.text,
      ...(gm.replyTo !== undefined ? { replyTo: gm.replyTo } : {}),
      ...(gm.edit ? { edit: true } : {}),
    };
    appendChatLog(botId, gm.chatId, entry);
    chat.messageCount++;
    saveWatchStore();
    if (gm.ownerHandled) {
      this.pushWatchState();
      return;
    }

    // 2. addressed / explicit-task path — `omp:` stays a deterministic task
    //    marker; mentions and replies-to-bot route through the Chat Dialogue
    //    intent router (question ≠ task). Edits never re-propose or re-answer.
    if (!gm.edit && !chat.proposedIds.includes(gm.messageId)) {
      const trimmed = gm.text.trim();
      if (trimmed && !trimmed.startsWith("/")) {
        if (trimmed.toLowerCase().startsWith(TASK_PREFIX)) {
          const headline = trimmed.slice(TASK_PREFIX.length).trim();
          if (headline) {
            this.propose(botId, chat, gm.messageId, gm.author, gm.text, headline, "prefix");
            this.pushWatchState();
            return;
          }
        } else if (gm.mentionsBot || gm.replyToBot) {
          void this.routeAddressed(botId, gm, gm.mentionsBot ? "mention" : "reply");
          this.pushWatchState();
          return;
        }
      }
    }

    // 3. listener path
    const st = this.vol(botId, gm.chatId);
    const cooling = st.cooldownUntil !== null && st.cooldownUntil > Date.now();
    if (!chat.listener || chat.coverage !== "full" || cooling || gm.edit) {
      this.pushWatchState();
      return;
    }
    if (chat.proposedIds.includes(gm.messageId)) return;
    st.batch.push(gm);
    if (st.batch.length >= BATCH_MAX) {
      this.flushBatch(botId, gm.chatId);
    } else if (!st.batchTimer) {
      st.batchTimer = setTimeout(() => this.flushBatch(botId, gm.chatId), BATCH_DEBOUNCE_MS);
    }
    this.pushWatchState();
  }

  /** proposal decision buttons from the approver's DM: pp:<id>:do|skip */
  handleCallback(botId: string, data: string, username: string, ack: (t?: string) => void): boolean {
    if (!data.startsWith("pp:")) return false;
    const [, id, verb] = data.split(":");
    const res = this.decide(id, verb === "do", `@${username}`);
    ack(res.ok ? (verb === "do" ? "Started" : "Skipped") : res.decidedBy ? `Already decided by ${res.decidedBy}` : "No longer pending");
    return true;
  }

  // ================================================== chat dialogue (addressed messages)

  /** pairing is the identity check (spec §2) */
  private isPaired(botId: string, userId: number): boolean {
    const bot = loadStore().bots.find((b) => b.id === botId);
    return !!bot?.paired.some((u) => u.telegramId === userId);
  }

  /** fixed-string locale for a group member: paired → stored code, else script of their message */
  private memberLang(botId: string, userId: number, sample: string): TgLang {
    const bot = loadStore().bots.find((b) => b.id === botId);
    const paired = bot?.paired.find((u) => u.telegramId === userId);
    // paired user without a stored language_code (older pairing): fall back to script too
    if (paired?.languageCode) return tgLangFor(paired.languageCode);
    return /[А-Яа-яЁё]/.test(sample) ? "ru" : "en";
  }

  /**
   * An addressed group message (mention / reply-to-bot): classify first
   * (spec §2 — question ≠ task), then answer / propose / both / ignore.
   * The approval gate NEVER weakens: a task from a group member is always
   * a proposal, and classification errors fall back to pre-dialogue
   * behavior (propose as-is).
   */
  private async routeAddressed(botId: string, gm: GroupMessage, source: "mention" | "reply"): Promise<void> {
    const botUsername = loadStore().bots.find((b) => b.id === botId)?.username;
    const context = readChatLogPage(botId, gm.chatId, undefined, 5)
      .reverse()
      .map((e) => `${e.author}: ${e.text.slice(0, 150)}`);
    const verdict = await routeIntent(gm.text, context, botUsername);
    const chat = findChat(botId, gm.chatId);
    if (!chat || this.disposed) return;

    if (verdict.intent === "error") {
      this.host.log(botId, "system", `intent routing failed — proposing as-is: ${verdict.error.slice(0, 100)}`);
      this.propose(botId, chat, gm.messageId, gm.author, gm.text, gm.text.trim().slice(0, 200), source);
      this.pushWatchState();
      return;
    }
    if (verdict.intent === "other") return; // group noise → silence (spec §2)

    if (verdict.intent === "task" || verdict.intent === "mixed") {
      const headline = verdict.intent === "mixed" ? verdict.taskLine : gm.text.trim().slice(0, 200);
      this.propose(botId, chat, gm.messageId, gm.author, gm.text, headline, source);
    }
    if (verdict.intent === "question" || verdict.intent === "mixed") {
      // group = PUBLIC space (privacy split): small talk only; specifics get a
      // deterministic playful redirect; the per-chat toggle governs non-paired
      // members, the paired owner may always small-talk
      const allowed = this.isPaired(botId, gm.authorId) || !!chat.answerMembers;
      if (!allowed) {
        // silent to the chat; visible to the operator (acceptance 7)
        this.host.log(botId, `@${gm.author}`, `dialog blocked (member answers off): ${gm.text.slice(0, 90)}`, "blocked-unauthorized");
      } else {
        const rt = this.host.runtime(botId);
        const lang = this.memberLang(botId, gm.authorId, gm.text);
        const cur = findChat(botId, gm.chatId);
        const title = cur?.title ?? gm.chatTitle;
        if (isOwnerAsk(gm.text, botUsername)) {
          // deterministic owner answer — the redirect target by name, zero model calls
          const owners = ownersFor(botId);
          const L = tg(lang);
          const line =
            owners.length === 0 ? L.ownerAnswerNone
            : owners.length === 1 ? L.ownerAnswerOne(owners[0].name, owners[0].username)
            : L.ownerAnswerMany(owners.map((o) => `${o.name} (@${o.username})`).join(L.ownerListAnd));
          rt?.sendMd(gm.chatId, escapeMd(line));
          this.host.log(botId, `@${gm.author}`, `[public] #${title} «${gm.text.slice(0, 70)}» → owners: ${line.slice(0, 70)}`, "dialog");
        } else if (isSpecificsAsk(gm.text, botUsername)) {
          const owners = ownersFor(botId);
          const line = owners.length
            ? pickRedirect(tg(lang).dialogRedirectsOwner)(`@${owners[0].username}`)
            : pickRedirect(tg(lang).dialogRedirects);
          rt?.sendMd(gm.chatId, escapeMd(line));
          this.host.log(botId, `@${gm.author}`, `[public] #${title} «${gm.text.slice(0, 70)}» → redirect: ${line.slice(0, 60)}`, "dialog");
        } else {
          const res = await answerQuestion({ botId, chatId: gm.chatId, question: gm.text, asker: gm.author, disclosure: "public" });
          if (res.guardTrips > 0)
            this.host.log(botId, "system", `public no-leak guard ×${res.guardTrips} on «${gm.text.slice(0, 60)}»${res.ok ? " — regenerated clean" : " — stock line sent"}`, "dialog-guard");
          if (res.ok) {
            rt?.sendMd(gm.chatId, escapeMd(res.answer));
            this.host.log(botId, `@${gm.author}`, `[public] #${title} «${gm.text.slice(0, 70)}» → ${res.answer.slice(0, 90)}`, "dialog");
          } else if (res.error.startsWith("guard:")) {
            const line = tg(lang).dialogStock;
            rt?.sendMd(gm.chatId, escapeMd(line));
            this.host.log(botId, `@${gm.author}`, `[public] #${title} «${gm.text.slice(0, 70)}» → stock: ${line.slice(0, 60)}`, "dialog");
          } else {
            rt?.sendMd(gm.chatId, escapeMd(tg(lang).dialogFailed));
            this.host.log(botId, "system", `dialog answer failed: ${res.error.slice(0, 120)}`);
          }
        }
      }
    }
    this.pushWatchState();
  }

  // ================================================== listener batching

  private flushBatch(botId: string, chatId: number): void {
    const st = this.vol(botId, chatId);
    clearTimeout(st.batchTimer ?? undefined);
    st.batchTimer = null;
    if (!st.batch.length || st.evaluating || this.disposed) return;
    const chat = findChat(botId, chatId);
    if (!chat || !chat.listener || chat.coverage !== "full") {
      st.batch = [];
      return;
    }
    const batch = st.batch;
    st.batch = [];
    st.evaluating = true;
    chat.evalCount++;
    chat.lastEvalAt = Date.now();
    saveWatchStore();
    this.pushWatchState(); // heartbeat on

    // context: the last 15 logged messages (includes the batch itself)
    const context = readChatLogPage(botId, chatId, undefined, CONTEXT_MESSAGES).reverse();
    const transcript =
      "chat transcript:\n" +
      context
        .map((e) => {
          const d = new Date(e.time);
          const hh = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
          return `[${hh}] ${e.author}: ${e.text}`;
        })
        .join("\n");

    void evaluateTranscript(transcript).then((res) => {
      st.evaluating = false;
      if (this.disposed) return;
      const cur = findChat(botId, chatId);
      if (!cur) return;
      if (res.kind === "error") {
        st.evalError = res.error;
        this.host.log(botId, "system", `evaluation failed for "${cur.title}": ${res.error.slice(0, 120)}`);
        // quota failures on the smol profile swap by the same engine as turns
        const status = res.error.match(/\b(4\d\d|5\d\d)\b/);
        void reportOneshotError(status ? parseInt(status[1], 10) : null, res.error);
      } else {
        st.evalError = null;
        this.host.log(botId, "system", `evaluated "${cur.title}" (${batch.length} msgs): ${res.kind === "task" ? `task — ${res.line.slice(0, 80)}` : "no task"}`);
        if (res.kind === "task") {
          // quote = most recent non-bot message of the batch (they're all human here)
          const key = batch[batch.length - 1];
          const already = key ? cur.proposedIds.includes(key.messageId) : true;
          if (key && !already) this.propose(botId, cur, key.messageId, key.author, key.text, res.line, "listener");
        }
      }
      this.pushWatchState();
    });
  }

  // ================================================== proposals

  private propose(
    botId: string,
    chat: WatchedChat,
    messageId: number,
    author: string,
    quote: string,
    headline: string,
    source: RemoteProposal["source"],
  ): void {
    const store = loadWatchStore();
    chat.proposedIds.push(messageId);
    // any proposal cools the listener for this chat; fast path stays hot
    this.vol(botId, chat.chatId).cooldownUntil = Date.now() + store.cooldownMinutes * 60_000;

    const bots = loadStore().bots;
    const bot = bots.find((b) => b.id === botId);
    const botUsername = bot?.username ?? botId;

    const pendingCount = store.proposals.filter((p) => p.botId === botId && p.status === "pending").length;
    const approver = this.approverFor(botId);

    const proposal: StoredProposal = {
      id: `pp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      botId,
      botUsername,
      chatId: chat.chatId,
      chatTitle: chat.title,
      messageId,
      author,
      quote: quote.slice(0, 400),
      headline: headline.slice(0, 200),
      source,
      createdAt: Date.now(),
      expiresAt: Date.now() + PROPOSAL_TTL_MS,
      status: "pending",
    };

    if (pendingCount >= MAX_PENDING_PER_BOT) {
      proposal.status = "dropped";
      store.proposals.push(proposal);
      saveWatchStore();
      this.host.log(botId, `@${author}`, `proposal dropped (queue full): ${headline.slice(0, 80)}`);
      // one notice per overflow episode, not one per drop
      if (!this.overflowNotified.has(botId) && approver) {
        this.overflowNotified.add(botId);
        this.host.runtime(botId)?.sendMd(
          approver.chatId,
          escapeMd(`⚠ Proposal queue full (${MAX_PENDING_PER_BOT}) — new proposals are being dropped until you decide some.`),
        );
      }
      return;
    }

    if (!approver) {
      proposal.status = "no-approver";
      store.proposals.push(proposal);
      saveWatchStore();
      this.host.log(botId, `@${author}`, `proposal frozen (no approver): ${headline.slice(0, 80)}`);
      return;
    }

    store.proposals.push(proposal);
    saveWatchStore();
    this.host.log(botId, `@${author}`, `proposal (${source}): ${headline.slice(0, 100)}`);
    this.deliverDm(proposal, approver.chatId);
  }

  private approverFor(botId: string): { chatId: number; username: string; lang: TgLang } | null {
    const bot = loadStore().bots.find((b) => b.id === botId);
    if (!bot || !bot.paired.length) return null;
    const designated = loadWatchStore().approvers[botId];
    const user = bot.paired.find((u) => u.telegramId === designated) ?? bot.paired[0];
    return { chatId: user.chatId, username: user.username, lang: tgLangFor(user.languageCode) };
  }

  /** locale of the paired user behind a DM chat id (fixed strings only) */
  private langForDm(botId: string, dmChatId: number): TgLang {
    const bot = loadStore().bots.find((b) => b.id === botId);
    const user = bot?.paired.find((u) => u.chatId === dmChatId);
    return tgLangFor(user?.languageCode);
  }

  /** Telegram skeleton (spec §4): ▸ proposal · #chat / → headline / @author: «quote» */
  private deliverDm(p: StoredProposal, dmChatId: number): void {
    const rt = this.host.runtime(p.botId);
    if (!rt) return;
    const L = tg(this.langForDm(p.botId, dmChatId));
    const kb = new InlineKeyboard().text(L.doIt, `pp:${p.id}:do`).text(L.skip, `pp:${p.id}:skip`);
    const text = escapeMd(`▸ proposal · #${p.chatTitle}\n→ ${p.headline}\n@${p.author}: «${p.quote}»`);
    void rt.sendMd(dmChatId, text, kb).then((messageId) => {
      if (messageId === null) return;
      const stored = loadWatchStore().proposals.find((x) => x.id === p.id);
      if (stored) {
        stored.dmChatId = dmChatId;
        stored.dmMessageId = messageId;
        saveWatchStore();
      }
    });
  }

  /** first decision wins across DM buttons and IDE cards */
  decide(id: string, approve: boolean, by: string): { ok: boolean; decidedBy?: string } {
    const store = loadWatchStore();
    const p = store.proposals.find((x) => x.id === id);
    if (!p) return { ok: false };
    if (p.status !== "pending") return { ok: false, decidedBy: p.decidedBy };
    p.status = approve ? "approved" : "skipped";
    p.decidedBy = by;
    p.decidedAt = Date.now();
    saveWatchStore();
    this.overflowNotified.delete(p.botId); // queue drained below cap — re-arm the notice

    const rt = this.host.runtime(p.botId);
    // losing surface: rewrite the DM so stale buttons vanish
    if (rt && p.dmChatId !== undefined && p.dmMessageId !== undefined) {
      const L = tg(this.langForDm(p.botId, p.dmChatId));
      rt.editMd(
        p.dmChatId,
        p.dmMessageId,
        escapeMd(`▸ proposal · #${p.chatTitle}\n→ ${p.headline}\n${approve ? L.approvedBy(by) : L.skippedBy(by)}`),
      );
    }

    if (approve) {
      const approver = this.approverFor(p.botId);
      const attribution = `[remote/telegram-chat "${p.chatTitle}" @${p.author}, approved by ${by}]`;
      const ok = this.bridge.prompt(p.headline, {
        username: p.author,
        botName: p.botUsername,
        attribution,
      });
      this.host.log(p.botId, by, `approved: ${p.headline.slice(0, 100)}`);
      // exactly one group message, ever: the acknowledgment
      const ackLang = approver?.lang ?? "en";
      if (ok && rt) rt.sendMd(p.chatId, escapeMd(tg(ackLang).onIt));
      if (!ok && rt && approver) rt.sendMd(approver.chatId, escapeMd(tg(approver.lang).agentNotRunning));
    } else {
      this.host.log(p.botId, by, `skipped: ${p.headline.slice(0, 100)}`);
    }
    this.pushWatchState();
    return { ok: true };
  }

  private expireProposals(): void {
    const store = loadWatchStore();
    const now = Date.now();
    let changed = false;
    for (const p of store.proposals) {
      if ((p.status === "pending" || p.status === "no-approver") && now > p.expiresAt) {
        p.status = "expired";
        changed = true;
        this.host.log(p.botId, "system", `proposal expired: ${p.headline.slice(0, 80)}`);
        const rt = this.host.runtime(p.botId);
        if (rt && p.dmChatId !== undefined && p.dmMessageId !== undefined) {
          rt.editMd(p.dmChatId, p.dmMessageId, escapeMd(`▸ proposal · #${p.chatTitle}\n→ ${p.headline}\n· expired`));
        }
      }
    }
    if (changed) {
      saveWatchStore();
      this.pushWatchState();
    }
  }

  /** unfrozen when an approver appears: deliver DMs for revived proposals */
  reviveFrozen(botId: string): void {
    const approver = this.approverFor(botId);
    if (!approver) return;
    const store = loadWatchStore();
    let changed = false;
    for (const p of store.proposals) {
      if (p.botId === botId && p.status === "no-approver" && Date.now() < p.expiresAt) {
        p.status = "pending";
        changed = true;
        this.deliverDm(p, approver.chatId);
      }
    }
    if (changed) {
      saveWatchStore();
      this.host.log(botId, "system", "frozen proposals revived — approver designated");
      this.pushWatchState();
    }
  }

  /** coverage as last probed; "limited" until proven otherwise */
  coverageFor(botId: string, chatId: number): ChatCoverage {
    return findChat(botId, chatId)?.coverage ?? "limited";
  }

  // ================================================== coverage

  async refreshCoverage(botId: string, chatId: number): Promise<void> {
    const rt = this.host.runtime(botId);
    const chat = findChat(botId, chatId);
    if (!rt || !chat || chat.left) return;
    const coverage = await rt.probeCoverage(chatId);
    if (coverage === chat.coverage) return;
    chat.coverage = coverage;
    if (coverage === "limited" && chat.listener) {
      // auto-pause: listening is meaningless without full coverage
      chat.listener = false;
      this.host.log(botId, "system", `coverage dropped to limited in "${chat.title}" — listener paused`);
    } else {
      this.host.log(botId, "system", `coverage in "${chat.title}": ${coverage}`);
    }
    saveWatchStore();
    this.pushWatchState();
  }

  // ================================================== IPC surface

  async setChatWatched(botId: string, chatId: number, watched: boolean): Promise<void> {
    const chat = findChat(botId, chatId);
    if (!chat || chat.left) return;
    chat.watched = watched;
    if (!watched) chat.listener = false;
    saveWatchStore();
    this.host.log(botId, "system", `${watched ? "watching" : "stopped watching"} "${chat.title}"`);
    this.pushWatchState();
    if (watched) await this.refreshCoverage(botId, chatId);
  }

  async setChatListener(botId: string, chatId: number, listener: boolean): Promise<{ ok: boolean; error?: string }> {
    const chat = findChat(botId, chatId);
    if (!chat || chat.left) return { ok: false, error: "Chat is unavailable" };
    if (listener) {
      if (!chat.watched) return { ok: false, error: "Watch the chat first — the listener needs the log" };
      if (chat.coverage !== "full")
        return { ok: false, error: "Limited coverage — disable privacy mode or make the bot an admin first" };
      if (!(await oneshotAvailable())) return { ok: false, error: "requires OMP oneshot support" };
    }
    chat.listener = listener;
    saveWatchStore();
    this.host.log(botId, "system", `listener ${listener ? "on" : "off"} in "${chat.title}"`);
    this.pushWatchState();
    return { ok: true };
  }

  /** Chat Dialogue: «отвечать участникам» — read-only answers for non-paired members */
  setChatAnswerMembers(botId: string, chatId: number, enabled: boolean): void {
    const chat = findChat(botId, chatId);
    if (!chat || chat.left) return;
    chat.answerMembers = enabled;
    saveWatchStore();
    this.host.log(botId, "system", `member answers ${enabled ? "on" : "off"} in "${chat.title}"`);
    this.pushWatchState();
  }

  /**
   * Drop a chat card from the registry. Guarded to inactive chats (left or
   * unwatched) — actively watched chats must be unwatched first so a stray
   * click can't kill logging. Proposals stay: they're history, not registry.
   */
  removeChat(botId: string, chatId: number, deleteLog: boolean): { ok: boolean; error?: string } {
    const store = loadWatchStore();
    const list = store.chats[botId];
    const chat = list?.find((c) => c.chatId === chatId);
    if (!list || !chat) return { ok: false, error: "Chat not found" };
    if (chat.watched && !chat.left)
      return { ok: false, error: "Chat is being watched — flip the watch toggle off first" };
    store.chats[botId] = list.filter((c) => c.chatId !== chatId);
    saveWatchStore();
    const key = `${botId}:${chatId}`;
    const st = this.volatile.get(key);
    if (st) {
      clearTimeout(st.batchTimer ?? undefined);
      this.volatile.delete(key);
    }
    if (deleteLog) deleteChatLog(botId, chatId);
    this.host.log(botId, "system", `chat "${chat.title}" removed${deleteLog ? " (log deleted)" : " (log kept)"}`);
    this.pushWatchState();
    return { ok: true };
  }

  setApprover(botId: string, telegramId: number): void {
    const store = loadWatchStore();
    store.approvers[botId] = telegramId;
    saveWatchStore();
    this.host.log(botId, "system", `approver designated: ${telegramId}`);
    this.reviveFrozen(botId);
    this.pushWatchState();
  }

  setCooldownMinutes(minutes: number): void {
    const store = loadWatchStore();
    store.cooldownMinutes = Math.max(1, Math.min(120, minutes));
    saveWatchStore();
    this.pushWatchState();
  }

  readLog(botId: string, chatId: number, beforeSeq?: number, limit?: number): RemoteChatLogEntry[] {
    return readChatLogPage(botId, chatId, beforeSeq, Math.min(limit ?? 500, 1000));
  }

  // ================================================== state

  /**
   * Designed warning when the smol binding is off: the role is unassigned or
   * points at a model no configured profile actually lists.
   */
  private computeSmolWarning(): string | null {
    const selector = smolSelector();
    const warning = "smol role model not assigned — listener will use whatever `smol` resolves to";
    if (!selector) return warning;
    const slash = selector.indexOf("/");
    if (slash === -1) return warning;
    const profileName = selector.slice(0, slash);
    const modelId = selector.slice(slash + 1);
    const profile = readOmpProfiles().find((p) => p.name === profileName);
    if (!profile || !profile.models.some((m) => m.id === modelId)) return warning;
    return null;
  }

  private oneshotOk: boolean | null = null;

  getWatchState(): RemoteWatchState {
    const store = loadWatchStore();
    const chats: RemoteChatInfo[] = [];
    for (const [botId, list] of Object.entries(store.chats)) {
      for (const c of list) {
        const st = this.vol(botId, c.chatId);
        chats.push({
          botId,
          chatId: c.chatId,
          title: c.title,
          kind: c.kind,
          coverage: c.coverage,
          coverageHint:
            c.coverage === "limited"
              ? "Disable privacy mode via @BotFather → /setprivacy, or make the bot a group admin, then re-add it to the group"
              : "",
          watched: c.watched,
          listener: c.listener,
          answerMembers: !!c.answerMembers,
          left: c.left,
          discoveredAt: c.discoveredAt,
          messageCount: c.messageCount,
          evalCount: c.evalCount,
          lastEvalAt: c.lastEvalAt,
          evaluating: st.evaluating,
          evalError: st.evalError,
          cooldownUntil: st.cooldownUntil,
          logPath: chatLogPath(botId, c.chatId),
        });
      }
    }
    const proposals: RemoteProposal[] = store.proposals
      .filter((p) => p.status !== "dropped")
      .map(({ dmChatId: _c, dmMessageId: _m, ...pub }) => pub);
    return {
      chats,
      proposals,
      oneshotUnavailable: this.oneshotOk === false ? "requires OMP oneshot support" : null,
      smolWarning: this.computeSmolWarning(),
      cooldownMinutes: store.cooldownMinutes,
      approvers: { ...store.approvers },
    };
  }

  pushWatchState(): void {
    // refresh oneshot availability opportunistically; the push itself is sync
    void oneshotAvailable().then((ok) => {
      if (ok === this.oneshotOk) return;
      this.oneshotOk = ok;
      const state = this.getWatchState();
      for (const w of BrowserWindow.getAllWindows()) w.webContents.send("remote:watchState", state);
    });
    const state = this.getWatchState();
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send("remote:watchState", state);
  }
}
