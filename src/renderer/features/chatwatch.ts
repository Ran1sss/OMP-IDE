/**
 * Chat Listener UI: watched-chat sub-cards on bot cards, proposal cards,
 * log viewer overlay, beacon badge data. Consumes the remote watch IPC
 * surface only; remote.ts owns rendering order and calls into here.
 */

import { el, clear, svgIcon } from "../core/dom";
import { I } from "../core/icons";
import { toast, confirmDialog } from "../core/ui";
import { t } from "../core/i18n";
import type {
  RemoteBotInfo,
  RemoteChatInfo,
  RemoteChatLogEntry,
  RemoteProposal,
  RemoteWatchState,
} from "../../shared/types";

/** breathes only while an evaluation batch is live (ambient rule) */
const EAR_GLYPH = `<path d="M5.2 12.6c.3 1 1.1 1.6 2.1 1.6 1.6 0 2-1.3 2.6-2.5.8-1.6 1.8-2.3 1.8-4.3A4.2 4.2 0 0 0 7.5 3.2 4.2 4.2 0 0 0 3.3 7.4"/><path d="M6 7.4a1.9 1.9 0 0 1 3.8 0c0 1.2-1.1 1.7-1.7 2.8"/>`;

let watch: RemoteWatchState = {
  chats: [],
  proposals: [],
  oneshotUnavailable: null,
  smolWarning: null,
  cooldownMinutes: 10,
  approvers: {},
};
let onChange: (() => void) | null = null;

export function initChatWatch(cb: () => void): void {
  onChange = cb;
  void window.ide.remote.getWatchState().then((s) => {
    watch = s;
    cb();
  });
  window.ide.remote.onWatchState((s) => {
    watch = s;
    cb();
  });
}

export function pendingProposals(): RemoteProposal[] {
  return watch.proposals.filter((p) => p.status === "pending" || p.status === "no-approver");
}

/** pending proposals for ONE bot — powers the «Запросы» badge */
export function pendingProposalsFor(botId: string): RemoteProposal[] {
  return pendingProposals().filter((p) => p.botId === botId);
}

/** bots whose «Запросы» section is expanded (session-scoped UI state) */
const openRequests = new Set<string>();

export function requestsOpen(botId: string): boolean {
  return openRequests.has(botId);
}

export function toggleBotRequests(botId: string): void {
  if (!openRequests.delete(botId)) openRequests.add(botId);
  onChange?.();
}

// ---------------------------------------------------------------- helpers

function hhmm(t: number): string {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** listener toggle block reason; null = toggleable */
function listenerBlockReason(chat: RemoteChatInfo): string | null {
  if (chat.left) return t("rc.botLeft");
  if (!chat.watched) return t("rc.blockWatchFirst");
  if (chat.coverage === "limited") return chat.coverageHint || t("rc.blockLimited");
  if (watch.oneshotUnavailable) return watch.oneshotUnavailable;
  return null;
}

// ---------------------------------------------------------------- cooldown input (Control Center global row)

export function cooldownControl(): HTMLElement[] {
  const input = el("input", {
    class: "input mono cc-num",
    type: "number",
    value: String(watch.cooldownMinutes),
    title: t("rc.cooldownTitle"),
    onChange: (e) => {
      const v = parseInt((e.target as HTMLInputElement).value, 10);
      if (v >= 1 && v <= 120) void window.ide.remote.setCooldownMinutes(v);
    },
  });
  return [
    el("span", { class: "cc-note", text: t("rc.cooldownLbl") }),
    input,
    el("span", { class: "cc-note", text: t("rc.minSuffix") }),
  ];
}

// ---------------------------------------------------------------- chat sub-cards (inside a bot card)

export function watchChatsSection(bot: RemoteBotInfo): HTMLElement | null {
  const chats = watch.chats.filter((c) => c.botId === bot.id);
  if (!chats.length) return null;

  const wrap = el("div", { class: "wc-list" });
  wrap.append(el("div", { class: "wc-header", text: t("rc.groupChats") }));

  // approver picker: only meaningful with several paired users
  if (bot.paired.length > 1) {
    const sel = el("select", { class: "wc-approver-sel", title: t("rc.approverTitle") }) as HTMLSelectElement;
    const current = watch.approvers[bot.id] ?? bot.paired[0].telegramId;
    for (const u of bot.paired) {
      const opt = el("option", { text: `@${u.username}` }) as HTMLOptionElement;
      opt.value = String(u.telegramId);
      if (u.telegramId === current) opt.selected = true;
      sel.append(opt);
    }
    sel.addEventListener("change", () => {
      void window.ide.remote.setApprover(bot.id, parseInt(sel.value, 10));
    });
    wrap.append(el("div", { class: "wc-approver" }, el("span", { class: "cc-note", text: t("rc.approver") }), sel));
  }

  for (const chat of chats) wrap.append(chatCard(bot, chat));
  return wrap;
}

function chatCard(bot: RemoteBotInfo, chat: RemoteChatInfo): HTMLElement {
  const card = el("div", { class: chat.left ? "wc-card left" : "wc-card" });

  // head: ear glyph · title · coverage chip · watch switch
  const ear = el("span", {
    class:
      "wc-ear" +
      (chat.evaluating ? " evaluating" : "") +
      (chat.evalError ? " failing" : ""),
    title: chat.evalError
      ? t("rc.evalFailingTip", chat.evalError)
      : chat.listener
        ? chat.evaluating
          ? t("rc.evaluating")
          : t("rc.listenerOn")
        : t("rc.listenerOff"),
  });
  ear.innerHTML = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">${EAR_GLYPH}</svg>`;

  const coverage = el("span", {
    class: chat.coverage === "full" ? "wc-cov full" : "wc-cov limited",
    text: chat.coverage === "full" ? t("rc.covFull") : t("rc.covLimited"),
    title: chat.coverage === "limited" ? chat.coverageHint : t("rc.covFullTip"),
  });

  const watchSwitch = switchLike(chat.watched, !chat.left, chat.left ? t("rc.botLeft") : chat.watched ? t("rc.watchOff") : t("rc.watchOn"), (next) => {
    void window.ide.remote.setChatWatched(chat.botId, chat.chatId, next);
  });

  // inactive chats (left or unwatched) can be dropped from the registry
  const removable = chat.left || !chat.watched;
  const removeBtn = removable
    ? el("button", {
        class: "icon-btn wc-remove",
        title: chat.messageCount ? t("rc.removeChatAsksLog") : t("rc.removeChatTitle"),
        onClick: () => {
          void confirmDialog({
            title: t("rc.removeChatTitle"),
            message: chat.messageCount
              ? t("rc.removeChatMsgLog", chat.title, chat.messageCount)
              : t("rc.removeChatMsg", chat.title),
            confirmLabel: chat.messageCount ? t("rc.removeDeleteLog") : t("rc.remove"),
            danger: true,
          }).then((ok) => {
            if (!ok) return;
            void window.ide.remote.removeChat(chat.botId, chat.chatId, true).then((res) => {
              if (!res.ok) toast(res.error ?? t("rc.removeChatFailed"), { crit: true });
            });
          });
        },
      })
    : null;
  removeBtn?.append(svgIcon(I.close));

  card.append(
    el(
      "div",
      { class: "wc-head" },
      ear,
      el("span", { class: "wc-title", text: chat.title }),
      chat.left ? el("span", { class: "wc-left-tag", text: t("rc.leftTag") }) : coverage,
      el("span", { style: { flex: "1" } }),
      removeBtn,
      watchSwitch,
    ),
  );

  if (!chat.left && chat.coverage === "limited") {
    card.append(el("div", { class: "wc-note-limited", text: t("rc.limitedNote", chat.coverageHint ?? "") }));
  }

  // listener row
  const reason = listenerBlockReason(chat);
  const listenerSwitch = switchLike(chat.listener, reason === null, reason ?? (chat.listener ? t("rc.listenerDisable") : t("rc.listenerEnable")), (next) => {
    void window.ide.remote.setChatListener(chat.botId, chat.chatId, next).then((res) => {
      if (!res.ok && res.error) toast(res.error, { crit: true });
    });
  });
  const listenerRow = el(
    "div",
    { class: "wc-listener-row" },
    // one line: label (tooltip carries the mechanism) + optional states + toggle
    el("span", { class: "wc-listener-label", title: t("rc.listenerTip"), text: t("rc.listener") }),
    watch.oneshotUnavailable ? el("span", { class: "wc-oneshot-off", text: watch.oneshotUnavailable }) : null,
    el("span", { style: { flex: "1" } }),
    chat.cooldownUntil && chat.cooldownUntil > Date.now()
      ? el("span", { class: "wc-cooling", text: t("rc.cooling", Math.max(1, Math.ceil((chat.cooldownUntil - Date.now()) / 60_000))) })
      : null,
    listenerSwitch,
  );
  card.append(listenerRow);

  // Chat Dialogue: «отвечать участникам» — read-only answers for non-paired
  // members of THIS chat (default OFF; paired users need no toggle)
  const amEnabled = chat.watched && !chat.left;
  const amSwitch = switchLike(
    !!chat.answerMembers,
    amEnabled,
    amEnabled ? (chat.answerMembers ? t("rc.answerMembersOff") : t("rc.answerMembersOn")) : t("rc.answerMembersNeedsWatch"),
    (next) => {
      void window.ide.remote.setChatAnswerMembers(chat.botId, chat.chatId, next);
    },
  );
  card.append(
    el(
      "div",
      { class: "wc-listener-row" },
      el("span", { class: "wc-listener-label", title: t("rc.answerMembersTip"), text: t("rc.answerMembers") }),
      el("span", { style: { flex: "1" } }),
      amSwitch,
    ),
  );
  if (watch.smolWarning) card.append(el("div", { class: "wc-smol-warn", text: watch.smolWarning }));
  if (chat.evalError) card.append(el("div", { class: "wc-eval-err", text: t("rc.evalErrLine", chat.evalError.slice(0, 140)) }));

  // meta + log path + viewer
  const viewBtn = el("button", { class: "btn wc-viewlog", text: t("rc.viewLog"), onClick: () => void showLogViewer(chat) });
  card.append(
    el(
      "div",
      { class: "wc-meta" },
      el("span", {}, `${t("rc.msgs")}: `, el("span", { class: "mono", text: String(chat.messageCount) })),
      el("span", {}, `${t("rc.evals")}: `, el("span", { class: "mono", text: String(chat.evalCount) })),
      el("span", {}, `${t("rc.last")}: `, el("span", { class: "mono", text: chat.lastEvalAt ? hhmm(chat.lastEvalAt) : "—" })),
      el("span", { style: { flex: "1" } }),
      viewBtn,
    ),
  );
  // log path: ONE line, MIDDLE ellipsis (head shrinks with ellipsis, tail is
  // kept whole), full path in tooltip, click-to-copy
  const cut = Math.max(0, chat.logPath.length - 24);
  card.append(
    el("div", {
      class: "wc-logpath mono",
      title: `${chat.logPath}\n${t("rc.copyLogPath")}`,
      onClick: () => {
        void navigator.clipboard.writeText(chat.logPath);
        toast(t("rc.logPathCopied"));
      },
    },
      el("span", { class: "lp-head", text: chat.logPath.slice(0, cut) }),
      el("span", { class: "lp-tail", text: chat.logPath.slice(cut) }),
    ),
  );
  return card;
}

/** switch visual matching remote.ts switchEl, plus a disabled state with reason */
function switchLike(on: boolean, enabled: boolean, title: string, onToggle: (next: boolean) => void): HTMLElement {
  const sw = el("div", {
    class: `switch${on ? " on" : ""}${enabled ? "" : " disabled"}`,
    title,
    onClick: () => {
      if (!enabled) {
        toast(title, { crit: true });
        return;
      }
      const next = !sw.classList.contains("on");
      sw.classList.toggle("on", next);
      onToggle(next);
    },
  });
  sw.tabIndex = enabled ? 0 : -1;
  sw.addEventListener("keydown", (e) => {
    if (enabled && (e.key === "Enter" || e.key === " ")) {
      e.preventDefault();
      sw.click();
    }
  });
  return sw;
}

// ---------------------------------------------------------------- proposal cards (Control Center top)

export function proposalsSection(): HTMLElement | null {
  const pending = pendingProposals();
  if (!pending.length) return null;
  const wrap = el("div", { class: "pp-list" });
  wrap.append(el("div", { class: "panel-header", text: `${t("rc.proposals")} · ${pending.length}`, style: { padding: "6px 2px 2px" } }));
  for (const p of pending) wrap.append(proposalCard(p));
  return wrap;
}

/**
 * «Запросы» view (remote-fix 3): inline expanding section under the bot
 * card's action row — the permanent home for this bot's proposals.
 */
export function botRequestsSection(bot: RemoteBotInfo): HTMLElement | null {
  if (!openRequests.has(bot.id)) return null;
  const wrap = el("div", { class: "bc-requests materialize" });
  const relevant = watch.proposals.filter(
    (p) => p.botId === bot.id && (p.status === "pending" || p.status === "no-approver" || p.status === "expired"),
  );
  if (!relevant.length) {
    wrap.append(el("div", { class: "cc-empty", text: t("rc.noRequests") }));
    return wrap;
  }
  for (const p of relevant) wrap.append(proposalCard(p));
  return wrap;
}

function proposalCard(p: RemoteProposal): HTMLElement {
  const expired = p.status === "expired";
  const doBtn = el("button", { class: "btn btn-primary", text: t("rc.accept") }) as HTMLButtonElement;
  const skipBtn = el("button", { class: "btn pp-skip", text: t("rc.skip") }) as HTMLButtonElement;
  const actions = el("div", { class: "pp-actions" }, doBtn, skipBtn);
  const card = el(
    "div",
    { class: expired ? "pp-card expired" : "pp-card" },
    // header: sender + chat + time ONLY — the message renders once, below
    el(
      "div",
      { class: "pp-byline" },
      el("span", { class: "pp-author", text: `@${p.author}` }),
      el("span", { class: "pp-chat", text: `· ${p.chatTitle}` }),
      p.status === "no-approver" ? el("span", { class: "pp-noapprover", text: t("rc.noApprover") }) : null,
      expired ? el("span", { class: "pp-expired", text: t("rc.expired") }) : null,
      el("span", { style: { flex: "1" } }),
      el("span", { class: "pp-time", text: hhmm(p.createdAt) }),
    ),
    el("div", { class: "pp-quote mono", text: p.quote }),
    // the listener's imperative read — only when it adds information
    p.source === "listener" && p.headline.trim() && p.headline.trim() !== p.quote.trim()
      ? el("div", { class: "pp-headline", text: p.headline })
      : null,
  );
  if (!expired) card.append(actions);

  const decide = (approve: boolean) => {
    doBtn.disabled = skipBtn.disabled = true;
    void window.ide.remote.decideProposal(p.id, approve).then((res) => {
      // losing surface (first-decision-wins): show who got there first
      if (!res.ok && res.decidedBy) {
        actions.replaceWith(el("div", { class: "pp-decided dim", text: t("rc.decidedBy", res.decidedBy) }));
        toast(t("rc.alreadyDecided", res.decidedBy));
      } else if (!res.ok) {
        toast(t("rc.noLongerPending"));
        doBtn.disabled = skipBtn.disabled = false;
      }
    });
  };
  doBtn.addEventListener("click", () => decide(true));
  skipBtn.addEventListener("click", () => decide(false));
  return card;
}

// ---------------------------------------------------------------- log viewer

async function showLogViewer(chat: RemoteChatInfo): Promise<void> {
  const rows = el("div", { class: "lv-rows" });
  const search = el("input", { class: "input mono lv-search", placeholder: t("rc.lvSearchPh") }) as HTMLInputElement;
  const olderBtn = el("button", { class: "btn", text: t("rc.lvLoadOlder") }) as HTMLButtonElement;

  /** proposal status per trigger messageId for marker rendering */
  const markers = new Map<number, RemoteProposal>();
  for (const p of watch.proposals) {
    if (p.botId === chat.botId && p.chatId === chat.chatId) markers.set(p.messageId, p);
  }

  let loaded: RemoteChatLogEntry[] = [];

  const row = (e: RemoteChatLogEntry): HTMLElement => {
    const p = markers.get(e.messageId);
    const r = el(
      "div",
      { class: p ? `lv-row proposed ${p.status}` : "lv-row" },
      el("span", { class: "lv-time", text: hhmm(e.time) }),
      el("span", { class: "lv-sender", text: e.author }),
      p?.status === "approved" ? el("span", { class: "lv-chev", text: "›" }) : null,
      el("span", { class: "lv-text", text: e.edit ? `${e.text} ✎` : e.text, title: e.edit ? t("rc.lvEditOf", e.messageId) : undefined }),
      p ? el("span", { class: "lv-marker", text: t("rc.propStatus", p.status) }) : null,
    );
    return r;
  };

  const renderRows = () => {
    clear(rows);
    const q = search.value.trim().toLowerCase();
    for (const e of loaded) {
      if (q && !`${e.author} ${e.text}`.toLowerCase().includes(q)) continue;
      rows.append(row(e));
    }
    if (!rows.children.length) rows.append(el("div", { class: "cc-empty", text: q ? t("rc.lvNoMatches") : t("rc.lvEmpty") }));
  };

  const loadPage = async (beforeSeq?: number) => {
    olderBtn.disabled = true;
    const page = await window.ide.remote.readChatLog(chat.botId, chat.chatId, beforeSeq, 500);
    // API is newest-first; the transcript reads top-down oldest→newest
    const asc = [...page].reverse();
    loaded = beforeSeq === undefined ? asc : [...asc, ...loaded];
    olderBtn.disabled = page.length < 500;
    renderRows();
    if (beforeSeq === undefined) rows.scrollTop = rows.scrollHeight;
  };

  search.addEventListener("input", renderRows);
  olderBtn.addEventListener("click", () => {
    const oldest = loaded[0]?.seq;
    if (oldest !== undefined) void loadPage(oldest);
  });

  const overlay = el("div", { class: "overlay centered" });
  const close = () => {
    overlay.classList.remove("visible");
    setTimeout(() => overlay.remove(), 170);
  };
  const dialog = el(
    "div",
    { class: "dialog lv-dialog" },
    el("h2", { text: t("rc.lvTitle", chat.title) }),
    el("div", { class: "lv-toolbar" }, olderBtn, search),
    rows,
    el("div", { class: "dialog-actions" }, el("button", { class: "btn", text: t("rc.dlgClose"), onClick: close })),
  );
  overlay.append(dialog);
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) close();
  });
  document.body.append(overlay);
  requestAnimationFrame(() => overlay.classList.add("visible"));

  await loadPage();
}
