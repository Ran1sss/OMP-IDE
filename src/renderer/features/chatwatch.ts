/**
 * Chat Listener UI: watched-chat sub-cards on bot cards, proposal cards,
 * log viewer overlay, beacon badge data. Consumes the remote watch IPC
 * surface only; remote.ts owns rendering order and calls into here.
 */

import { el, clear, svgIcon } from "../core/dom";
import { I } from "../core/icons";
import { toast, confirmDialog } from "../core/ui";
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

// ---------------------------------------------------------------- helpers

function hhmm(t: number): string {
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** listener toggle block reason; null = toggleable */
function listenerBlockReason(chat: RemoteChatInfo): string | null {
  if (chat.left) return "Bot left this chat";
  if (!chat.watched) return "Watch the chat first — the listener needs the log";
  if (chat.coverage === "limited") return chat.coverageHint || "Limited coverage — the listener can't hear ordinary messages";
  if (watch.oneshotUnavailable) return watch.oneshotUnavailable;
  return null;
}

// ---------------------------------------------------------------- cooldown input (Control Center global row)

export function cooldownControl(): HTMLElement[] {
  const input = el("input", {
    class: "input mono",
    type: "number",
    value: String(watch.cooldownMinutes),
    title: "Listener cooldown after a proposal, minutes",
    style: { width: "58px" },
    onChange: (e) => {
      const v = parseInt((e.target as HTMLInputElement).value, 10);
      if (v >= 1 && v <= 120) void window.ide.remote.setCooldownMinutes(v);
    },
  });
  return [
    el("span", { class: "cc-note", text: "cooldown" }),
    input,
    el("span", { class: "cc-note", text: "m" }),
  ];
}

// ---------------------------------------------------------------- chat sub-cards (inside a bot card)

export function watchChatsSection(bot: RemoteBotInfo): HTMLElement | null {
  const chats = watch.chats.filter((c) => c.botId === bot.id);
  if (!chats.length) return null;

  const wrap = el("div", { class: "wc-list" });
  wrap.append(el("div", { class: "wc-header", text: "Group chats" }));

  // approver picker: only meaningful with several paired users
  if (bot.paired.length > 1) {
    const sel = el("select", { class: "wc-approver-sel", title: "Who approves proposals from this bot's chats" }) as HTMLSelectElement;
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
    wrap.append(el("div", { class: "wc-approver" }, el("span", { class: "cc-note", text: "approver" }), sel));
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
      ? `Evaluation failing: ${chat.evalError}`
      : chat.listener
        ? chat.evaluating
          ? "Evaluating…"
          : "Listener on"
        : "Listener off",
  });
  ear.innerHTML = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">${EAR_GLYPH}</svg>`;

  const coverage = el("span", {
    class: chat.coverage === "full" ? "wc-cov full" : "wc-cov limited",
    text: chat.coverage,
    title: chat.coverage === "limited" ? chat.coverageHint : "Bot receives all group messages",
  });

  const watchSwitch = switchLike(chat.watched, !chat.left, chat.left ? "Bot left this chat" : chat.watched ? "Stop watching (logging stops; log kept)" : "Watch this chat (starts logging)", (next) => {
    void window.ide.remote.setChatWatched(chat.botId, chat.chatId, next);
  });

  // inactive chats (left or unwatched) can be dropped from the registry
  const removable = chat.left || !chat.watched;
  const removeBtn = removable
    ? el("button", {
        class: "icon-btn wc-remove",
        title: chat.messageCount ? "Remove chat (asks about the log)" : "Remove chat",
        onClick: () => {
          void confirmDialog({
            title: "Remove chat",
            message: chat.messageCount
              ? `Remove "${chat.title}" from the registry AND delete its ${chat.messageCount}-message log? Cancel keeps everything.`
              : `Remove "${chat.title}" from the registry?`,
            confirmLabel: chat.messageCount ? "Remove + delete log" : "Remove",
            danger: true,
          }).then((ok) => {
            if (!ok) return;
            void window.ide.remote.removeChat(chat.botId, chat.chatId, true).then((res) => {
              if (!res.ok) toast(res.error ?? "Failed to remove chat", { crit: true });
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
      chat.left ? el("span", { class: "wc-left-tag", text: "left chat" }) : coverage,
      el("span", { style: { flex: "1" } }),
      removeBtn,
      watchSwitch,
    ),
  );

  if (!chat.left && chat.coverage === "limited") {
    card.append(el("div", { class: "wc-note-limited", text: `Listening is meaningless at limited coverage — ${chat.coverageHint}` }));
  }

  // listener row
  const reason = listenerBlockReason(chat);
  const listenerSwitch = switchLike(chat.listener, reason === null, reason ?? (chat.listener ? "Disable smart listening" : "Enable smart listening"), (next) => {
    void window.ide.remote.setChatListener(chat.botId, chat.chatId, next).then((res) => {
      if (!res.ok && res.error) toast(res.error, { crit: true });
    });
  });
  const listenerRow = el(
    "div",
    { class: "wc-listener-row" },
    el("span", { class: "wc-listener-label", text: "listener" }),
    el("span", { class: "cc-note", text: "· smol oneshot per batch" }),
    watch.oneshotUnavailable ? el("span", { class: "wc-oneshot-off", text: watch.oneshotUnavailable }) : null,
    el("span", { style: { flex: "1" } }),
    chat.cooldownUntil && chat.cooldownUntil > Date.now()
      ? el("span", { class: "wc-cooling", text: `cooling · ${Math.max(1, Math.ceil((chat.cooldownUntil - Date.now()) / 60_000))}m` })
      : null,
    listenerSwitch,
  );
  card.append(listenerRow);
  if (watch.smolWarning) card.append(el("div", { class: "wc-smol-warn", text: watch.smolWarning }));
  if (chat.evalError) card.append(el("div", { class: "wc-eval-err", text: `evaluation failing: ${chat.evalError.slice(0, 140)}` }));

  // meta + log path + viewer
  const viewBtn = el("button", { class: "btn wc-viewlog", text: "View log", onClick: () => void showLogViewer(chat) });
  card.append(
    el(
      "div",
      { class: "wc-meta" },
      el("span", {}, "msgs: ", el("span", { class: "mono", text: String(chat.messageCount) })),
      el("span", {}, "evals: ", el("span", { class: "mono", text: String(chat.evalCount) })),
      el("span", {}, "last eval: ", el("span", { class: "mono", text: chat.lastEvalAt ? hhmm(chat.lastEvalAt) : "—" })),
      el("span", { style: { flex: "1" } }),
      viewBtn,
    ),
  );
  card.append(
    el("div", {
      class: "wc-logpath mono",
      text: chat.logPath,
      title: "Click to copy log path",
      onClick: () => {
        void navigator.clipboard.writeText(chat.logPath);
        toast("Log path copied");
      },
    }),
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
  wrap.append(el("div", { class: "panel-header", text: `Proposals (${pending.length})`, style: { padding: "6px 2px 2px" } }));
  for (const p of pending) wrap.append(proposalCard(p));
  return wrap;
}

function proposalCard(p: RemoteProposal): HTMLElement {
  const doBtn = el("button", { class: "btn btn-primary", text: "Do it" }) as HTMLButtonElement;
  const skipBtn = el("button", { class: "btn pp-skip", text: "Skip" }) as HTMLButtonElement;
  const decide = (approve: boolean) => {
    doBtn.disabled = skipBtn.disabled = true;
    void window.ide.remote.decideProposal(p.id, approve).then((res) => {
      // losing surface: someone on Telegram got there first
      if (!res.ok && res.decidedBy) toast(`Already decided by ${res.decidedBy}`);
      else if (!res.ok) {
        toast("Proposal is no longer pending");
        doBtn.disabled = skipBtn.disabled = false;
      }
    });
  };
  doBtn.addEventListener("click", () => decide(true));
  skipBtn.addEventListener("click", () => decide(false));

  return el(
    "div",
    { class: "pp-card" },
    el("div", { class: "pp-headline", text: p.headline }),
    el("div", { class: "pp-quote mono", text: p.quote }),
    el(
      "div",
      { class: "pp-byline" },
      el("span", { text: `@${p.author}` }),
      el("span", { class: "pp-chat", text: `· ${p.chatTitle}` }),
      p.status === "no-approver" ? el("span", { class: "pp-noapprover", text: "no approver — pair a user" }) : null,
      el("span", { style: { flex: "1" } }),
      el("span", { class: "pp-time", text: hhmm(p.createdAt) }),
    ),
    el("div", { class: "pp-actions" }, doBtn, skipBtn),
  );
}

// ---------------------------------------------------------------- log viewer

async function showLogViewer(chat: RemoteChatInfo): Promise<void> {
  const rows = el("div", { class: "lv-rows" });
  const search = el("input", { class: "input mono lv-search", placeholder: "search loaded window…" }) as HTMLInputElement;
  const olderBtn = el("button", { class: "btn", text: "Load older" }) as HTMLButtonElement;

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
      el("span", { class: "lv-text", text: e.edit ? `${e.text} ✎` : e.text, title: e.edit ? `edit of #${e.messageId}` : undefined }),
      p ? el("span", { class: "lv-marker", text: p.status }) : null,
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
    if (!rows.children.length) rows.append(el("div", { class: "cc-empty", text: q ? "No matches in the loaded window." : "Log is empty." }));
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
    el("h2", { text: `Chat log — ${chat.title}` }),
    el("div", { class: "lv-toolbar" }, olderBtn, search),
    rows,
    el("div", { class: "dialog-actions" }, el("button", { class: "btn", text: "Close", onClick: close })),
  );
  overlay.append(dialog);
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) close();
  });
  document.body.append(overlay);
  requestAnimationFrame(() => overlay.classList.add("visible"));

  await loadPage();
}
