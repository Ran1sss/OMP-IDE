/** Welcome screen — the poster shot. Shown when no folder is open. */

import { el, svgIcon } from "../core/dom";
import { I } from "../core/icons";
import type { RecentWorkspace } from "../../shared/types";

export async function showWelcome(container: HTMLElement, onOpen: (path: string) => void): Promise<HTMLElement> {
  const recents: RecentWorkspace[] = await window.ide.store.getRecents();

  const grid = el("div", { class: "recent-grid" });
  for (const r of recents) {
    // div, not button: the card hosts a nested remove control
    const card = el(
      "div",
      { class: "ws-card", onClick: () => onOpen(r.path) },
      el("div", { class: "wsc-name", text: r.name }),
      el("div", { class: "wsc-path", text: r.path }),
    );
    card.tabIndex = 0;
    card.addEventListener("keydown", (e) => {
      if (e.key === "Enter") onOpen(r.path);
    });
    const x = el("button", {
      class: "icon-btn wsc-x",
      title: "Remove from recents",
      onClick: (e) => {
        e.stopPropagation();
        void window.ide.store.removeRecent(r.path).then(() => {
          card.remove();
          if (!grid.children.length) grid.remove();
        });
      },
    });
    x.append(svgIcon(I.close));
    card.append(x);
    grid.append(card);
  }

  const openBtn = el("button", {
    class: "btn btn-primary",
    text: "Open Folder…",
    style: { padding: "9px 26px", fontSize: "13.5px" },
    onClick: () => {
      void window.ide.dialog.openFolder().then((path) => {
        if (path) onOpen(path);
      });
    },
  });

  const screen = el(
    "div",
    { class: "welcome" },
    el("div", { class: "wordmark" }, "OMP ", el("span", { class: "wm-ide", text: "IDE" })),
    el("div", { class: "tagline", text: "reactor online · agent standing by" }),
    el(
      "div",
      { class: "welcome-actions" },
      openBtn,
      recents.length ? grid : null,
    ),
  );
  container.append(screen);
  return screen;
}
