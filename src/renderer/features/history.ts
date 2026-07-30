/**
 * Session history browser — read-only viewer over OMP's on-disk transcripts.
 * List view (this workspace's past sessions) → transcript view. Renders with
 * the live chat's classes (chat-user / chat-agent) so history reads exactly
 * like the conversation did. Nothing here can mutate a session.
 */

import { marked } from "marked";
import { el, clear } from "../core/dom";
import { state } from "../core/state";
import { toast } from "../core/ui";
import type { OmpSessionMeta, OmpSessionEntry } from "../../shared/types";

let historyClose: (() => void) | null = null;

/** calendar-day label; midnight boundaries, not rolling 24h windows */
function dayLabel(t: number): string {
  const d = new Date(t);
  const startOf = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const diffDays = Math.round((startOf(new Date()) - startOf(d)) / 86_400_000);
  if (diffDays === 0) return "Today";
  if (diffDays === 1) return "Yesterday";
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function timeLabel(t: number): string {
  const d = new Date(t);
  const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
  return `${dayLabel(t).toLowerCase()} ${hhmm}`;
}

export function openSessionHistory(): void {
  if (!state.root) {
    toast("Open a workspace first");
    return;
  }
  historyClose?.();
  const overlay = el("div", { class: "overlay centered" });
  const close = () => {
    if (historyClose === close) historyClose = null;
    overlay.classList.remove("visible");
    setTimeout(() => overlay.remove(), 170);
  };
  historyClose = close;

  const head = el("div", { class: "hd-head" }, el("h2", { text: "Session History" }));
  const filterInput = el("input", {
    class: "input hd-filter",
    placeholder: "Filter sessions… (title, prompt, model)",
  }) as HTMLInputElement;
  const body = el("div", { class: "hd-scroll" });
  const backBtn = el("button", { class: "btn", text: "Back", style: { display: "none" }, onClick: () => void renderList() });
  const dialog = el(
    "div",
    { class: "dialog history-dialog" },
    head,
    filterInput,
    body,
    el("div", { class: "dialog-actions" }, backBtn, el("span", { style: { flex: "1" } }), el("button", { class: "btn", text: "Close", onClick: close })),
  );
  overlay.append(dialog);
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) close();
  });
  overlay.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
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
    body.append(el("div", { class: "dimmer", text: "Loading…", style: { padding: "12px" } }));
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
          el("div", { text: "No previous sessions for this workspace." }),
          el("div", { class: "dimmer", text: "Conversations appear here after the agent has run at least once." }),
        ),
      );
      return;
    }
    if (!sessions.length) {
      body.append(el("div", { class: "hd-empty" }, el("div", { text: `No sessions match "${q}".` })));
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
    const label = s.title || s.firstPrompt || "(no prompt)";
    const d = new Date(s.startedAt);
    const hhmm = `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
    return el(
      "div",
      { class: "hd-row", onClick: () => void renderTranscript(s) },
      el("div", { class: "hd-row-main" },
        el("div", { class: "hd-label", text: label.slice(0, 120) }),
        el("div", { class: "hd-meta" },
          el("span", { class: "mono", text: hhmm }),
          s.model ? el("span", { class: "hd-model", text: s.model.split("/").pop() ?? s.model }) : null,
          el("span", { class: "dimmer mono", text: `${s.sizeKb} KB` }),
        ),
      ),
    );
  }

  async function renderTranscript(s: OmpSessionMeta) {
    filterInput.style.display = "none";
    clear(body);
    body.append(el("div", { class: "dimmer", text: "Loading…", style: { padding: "12px" } }));
    let entries: OmpSessionEntry[];
    try {
      entries = await window.ide.omp.readSession(s.file);
    } catch (err) {
      clear(body);
      body.append(el("div", { class: "hd-empty crit", text: `Can't read session: ${err instanceof Error ? err.message : err}` }));
      backBtn.style.display = "";
      return;
    }
    clear(body);
    backBtn.style.display = "";
    body.append(el("div", { class: "hd-banner", text: `read-only · ${timeLabel(s.startedAt)}` }));
    if (!entries.length) {
      body.append(el("div", { class: "hd-empty", text: "This session has no messages." }));
      return;
    }
    for (const e of entries) {
      if (e.kind === "user") {
        body.append(el("div", { class: "chat-user", text: e.text }));
      } else if (e.kind === "assistant") {
        const div = el("div", { class: "chat-agent md" });
        div.innerHTML = marked.parse(e.text, { async: false });
        // history is inert: neutralize links' default nav, keep them readable
        for (const a of div.querySelectorAll("a")) {
          a.addEventListener("click", (ev) => ev.preventDefault());
        }
        body.append(div);
      } else if (e.kind === "tool") {
        body.append(el("div", { class: "hd-tool mono", text: `⚙ ${e.name}` }));
      } else if (e.kind === "model") {
        body.append(el("div", { class: "turn-marker", text: `· model: ${e.model} ·` }));
      } else {
        body.append(el("div", { class: "turn-marker", text: `· ${e.text} ·` }));
      }
    }
  }

  void renderList();
}
