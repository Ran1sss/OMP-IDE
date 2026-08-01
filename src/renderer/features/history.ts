/**
 * Session history browser — read-only viewer over OMP's on-disk transcripts.
 * List view (this workspace's past sessions) → transcript view. Renders with
 * the live chat's classes (chat-user / chat-agent) so history reads exactly
 * like the conversation did. Nothing here can mutate a session.
 */

import { marked } from "marked";
import { el, clear } from "../core/dom";
import { on } from "../core/bus";
import { state } from "../core/state";
import { toast, errorText } from "../core/ui";
import type { OmpSessionMeta, OmpSessionEntry } from "../../shared/types";
import { stripTeamMarkers } from "./team";
import { t } from "../core/i18n";

let historyClose: (() => void) | null = null;

/** calendar-day label; midnight boundaries, not rolling 24h windows */
function dayLabel(ts: number): string {
  const d = new Date(ts);
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOf(new Date()) - startOf(d)) / 86_400_000);
  if (diffDays === 0) return t("hist.today");
  if (diffDays === 1) return t("hist.yesterday");
  return t("hist.dayDate", ts);
}

function timeLabel(ts: number): string {
  const d = new Date(ts);
  const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return `${dayLabel(ts).toLowerCase()} ${hhmm}`;
}

export function openSessionHistory(): void {
  if (!state.root) {
    toast(t("hist.openWorkspaceFirst"));
    return;
  }
  historyClose?.();
  const overlay = el("div", { class: "overlay centered" });
  const close = () => {
    if (historyClose === close) historyClose = null;
    offLang();
    overlay.classList.remove("visible");
    setTimeout(() => overlay.remove(), 170);
  };
  historyClose = close;

  const titleEl = el("h2", { text: t("hist.title") });
  const head = el("div", { class: "hd-head" }, titleEl);
  const filterInput = el("input", {
    class: "input hd-filter",
    placeholder: t("hist.filterPlaceholder"),
  }) as HTMLInputElement;
  const body = el("div", { class: "hd-scroll" });
  const backBtn = el("button", { class: "btn", text: t("hist.back"), style: { display: "none" }, onClick: () => void renderList() });
  const closeBtn = el("button", { class: "btn", text: t("hist.close"), onClick: close });
  const dialogActions = el("div", { class: "dialog-actions" }, backBtn, el("span", { style: { flex: "1" } }), closeBtn);
  const dialog = el(
    "div",
    { class: "dialog history-dialog" },
    head,
    filterInput,
    body,
    dialogActions,
  );
  overlay.append(dialog);
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) close();
  });
  overlay.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });
  // dialog persists while open: re-apply fixed strings on language switch;
  // list view re-renders so day headers (Today/Yesterday) follow the locale
  const offLang = on("lang-changed", () => {
    titleEl.textContent = t("hist.title");
    filterInput.placeholder = t("hist.filterPlaceholder");
    backBtn.textContent = t("hist.back");
    closeBtn.textContent = t("hist.close");
    if (backBtn.style.display === "none") applyFilter();
  });
  let allSessions: OmpSessionMeta[] = [];
  const applyFilter = () => {
    const q = filterInput.value.trim().toLowerCase();
    const hits = !q
      ? allSessions
      : allSessions.filter((s) =>
          (s.title + " " + s.firstPrompt + " " + s.model).toLowerCase().includes(q));
    renderRows(hits, q);
  };
  filterInput.addEventListener("input", applyFilter);
  filterInput.addEventListener("keydown", (e) => {
    e.stopPropagation(); // dialog Escape handler stays; registry keys must not fire
    if (e.key === "Escape") close();
    if (e.key === "Enter") {
      const first = body.querySelector<HTMLElement>(".hd-row");
      first?.click();
    }
  });
  document.body.append(overlay);
  overlay.tabIndex = -1;
  overlay.focus();
  requestAnimationFrame(() => overlay.classList.add("visible"));

  async function renderList() {
    backBtn.style.display = "none";
    filterInput.style.display = "";
    clear(body);
    body.append(el("div", { class: "dimmer", text: t("hist.loading"), style: { padding: "12px" } }));
    allSessions = await window.ide.omp.listSessions(state.root!);
    applyFilter();
    if (allSessions.length) filterInput.focus();
  }

  function renderRows(sessions: OmpSessionMeta[], q: string) {
    clear(body);
    if (!allSessions.length) {
      filterInput.style.display = "none";
      body.append(
        el(
          "div",
          { class: "hd-empty" },
          el("div", { text: t("hist.emptyTitle") }),
          el("div", { class: "dimmer", text: t("hist.emptyHint") }),
        ),
      );
      return;
    }
    if (!sessions.length) {
      body.append(el("div", { class: "hd-empty" }, el("div", { text: t("hist.noFilterMatch", q) })));
      return;
    }
    // rows group under dim day headers; row meta then shows time only
    let lastDay = "";
    for (const s of sessions) {
      const day = dayLabel(s.startedAt);
      if (day !== lastDay) {
        lastDay = day;
        body.append(el("div", { class: "hd-day", text: day }));
      }
      body.append(sessionRow(s));
    }
  }

  function sessionRow(s: OmpSessionMeta): HTMLElement {
    const label = s.title || s.firstPrompt || t("hist.noPrompt");
    const d = new Date(s.startedAt);
    const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    return el(
      "div",
      { class: "hd-row", onClick: () => void renderTranscript(s, filterInput.value.trim()) },
      el("div", { class: "hd-row-main" },
        el("div", { class: "hd-label", text: label.slice(0, 120) }),
        el("div", { class: "hd-meta" },
          el("span", { class: "mono", text: hhmm }),
          s.model ? el("span", { class: "hd-model", text: s.model.split("/").pop() ?? s.model }) : null,
          el("span", { class: "dimmer mono", text: t("hist.sizeKb", s.sizeKb) }),
        ),
      ),
    );
  }

  async function renderTranscript(s: OmpSessionMeta, query = "") {
    filterInput.style.display = "none";
    clear(body);
    body.append(el("div", { class: "dimmer", text: t("hist.loading"), style: { padding: "12px" } }));
    let entries: OmpSessionEntry[];
    try {
      entries = await window.ide.omp.readSession(s.file);
    } catch (err) {
      clear(body);
      body.append(el("div", { class: "hd-empty crit", text: t("hist.readError", errorText(err)) }));
      backBtn.style.display = "";
      return;
    }
    clear(body);
    backBtn.style.display = "";
    body.append(el("div", { class: "hd-banner", text: t("hist.readOnly", timeLabel(s.startedAt)) }));
    if (!entries.length) {
      body.append(el("div", { class: "hd-empty", text: t("hist.noMessages") }));
      return;
    }
    // A-2 follow-through: when the list was filtered, land on the first
    // message that contains the query instead of the transcript top.
    // Meta-only hits (title/model) match nothing here and stay at the top.
    const q = query.toLowerCase();
    let jumpTo: HTMLElement | null = null;
    for (const e of entries) {
      let node: HTMLElement;
      if (e.kind === "user") {
        node = el("div", { class: "chat-user", text: e.text });
      } else if (e.kind === "assistant") {
        node = el("div", { class: "chat-agent md" });
        // historical transcripts render clean too: protocol marker lines are
        // stripped at render time (the live board consumed them long ago)
        const cleaned = stripTeamMarkers(e.text);
        if (e.text.length > 0 && cleaned.trim().length === 0) node.classList.add("md-empty");
        node.innerHTML = marked.parse(cleaned, { async: false });
        // history is inert: neutralize links' default nav, keep them readable
        for (const a of node.querySelectorAll("a")) {
          a.addEventListener("click", (ev) => ev.preventDefault());
        }
      } else if (e.kind === "tool") {
        node = el("div", { class: "hd-tool mono", text: `⚙ ${e.name}` });
      } else if (e.kind === "model") {
        node = el("div", { class: "turn-marker", text: t("hist.modelMarker", e.model) });
      } else {
        node = el("div", { class: "turn-marker", text: `· ${e.text} ·` });
      }
      body.append(node);
      if (!jumpTo && q && (e.kind === "user" || e.kind === "assistant") && e.text.toLowerCase().includes(q)) {
        jumpTo = node;
      }
    }
    if (jumpTo) {
      jumpTo.classList.add("hd-match");
      // after layout: banner + rows must have heights before scrollIntoView
      requestAnimationFrame(() => jumpTo!.scrollIntoView({ block: "center" }));
    }
  }

  void renderList();
}
