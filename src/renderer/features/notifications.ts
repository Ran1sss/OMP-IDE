/**
 * Status-bar notifications bell — re-surfaces transient toasts after they
 * fade. The log itself lives in core/ui (every toast() call records there);
 * this module renders the bell, an unseen-count dot, and an anchored popover
 * with the recent entries.
 */

import { el, clear, svgIcon } from "../core/dom";
import { I } from "../core/icons";
import { on } from "../core/bus";
import { t, relTime } from "../core/i18n";
import { notificationLog, clearNotificationLog, onNotificationLogChange } from "../core/ui";

let bellEl: HTMLElement | null = null;
let dotEl: HTMLElement | null = null;
let openPop: HTMLElement | null = null;
/** entries at-or-before this timestamp have been seen (popover was opened) */
let seenUpTo = 0;

function closePop(): void {
  openPop?.remove();
  openPop = null;
}

function refreshDot(): void {
  if (!dotEl) return;
  const unseen = notificationLog().filter((n) => n.at > seenUpTo).length;
  dotEl.style.display = unseen > 0 ? "" : "none";
  dotEl.textContent = unseen > 9 ? "9+" : String(unseen);
}

function showPopover(anchor: HTMLElement): void {
  closePop();
  seenUpTo = Date.now();
  refreshDot();

  const pop = el("div", { class: "notif-pop" });
  const entries = notificationLog();
  pop.append(el("div", { class: "mp-section", text: t("notif.title") }));

  if (!entries.length) {
    pop.append(el("div", { class: "mp-empty", text: t("notif.empty") }));
  } else {
    const list = el("div", { class: "notif-list" });
    for (const n of entries) {
      list.append(
        el(
          "div",
          { class: n.crit ? "notif-row crit" : "notif-row" },
          el("span", { class: "notif-time mono", text: relTime(n.at) }),
          el("span", { class: "notif-msg", text: n.message }),
        ),
      );
    }
    pop.append(list);
    pop.append(
      el(
        "div",
        { class: "mp-foot" },
        el("button", { class: "btn", text: t("notif.clear"), onClick: () => { clearNotificationLog(); closePop(); } }),
      ),
    );
  }

  document.body.append(pop);
  const r = anchor.getBoundingClientRect();
  const pr = pop.getBoundingClientRect();
  pop.style.left = `${Math.min(r.left, window.innerWidth - pr.width - 8)}px`;
  pop.style.top = `${r.top - pr.height - 8}px`;
  openPop = pop;
  setTimeout(() => {
    const onDown = (e: MouseEvent) => {
      if (openPop && !openPop.contains(e.target as Node)) {
        closePop();
        window.removeEventListener("mousedown", onDown, { capture: true });
      }
    };
    window.addEventListener("mousedown", onDown, { capture: true });
  });
}

export function createNotificationBell(): HTMLElement {
  dotEl = el("span", { class: "notif-dot", style: { display: "none" } });
  bellEl = el(
    "span",
    {
      class: "sb-item notif-bell",
      title: t("notif.title"),
      onClick: () => (openPop ? closePop() : showPopover(bellEl!)),
    },
    svgIcon(I.bell),
    dotEl,
  );
  onNotificationLogChange(() => {
    refreshDot();
    // live update while open: re-anchor a fresh popover
    if (openPop && bellEl) showPopover(bellEl);
  });
  // persistent status-bar item: tooltip re-applied on language switch
  on("lang-changed", () => { if (bellEl) bellEl.title = t("notif.title"); });
  return bellEl;
}
