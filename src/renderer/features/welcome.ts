/** Welcome screen — the poster shot. Shown when no folder is open. */

import { el } from "../core/dom";
import type { RecentWorkspace } from "../../shared/types";

export async function showWelcome(container: HTMLElement, onOpen: (path: string) => void): Promise<HTMLElement> {
  const recents: RecentWorkspace[] = await window.ide.store.getRecents();

  const grid = el("div", { class: "recent-grid" });
  for (const r of recents) {
    grid.append(
      el(
        "button",
        { class: "ws-card", onClick: () => onOpen(r.path) },
        el("div", { class: "wsc-name", text: r.name }),
        el("div", { class: "wsc-path", text: r.path }),
      ),
    );
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
