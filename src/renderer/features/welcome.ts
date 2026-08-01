/**
 * Welcome — «Сплит герой/дело» (redesign §9): nebula hero on the left,
 * opaque working column on the right (recents list + Open Folder + resume-
 * session row). Keyboard: Up/Down over recents, Enter opens, Del removes.
 */

import { el, svgIcon } from "../core/dom";
import { I } from "../core/icons";
import { normPath } from "../core/state";
import type { RecentWorkspace } from "../../shared/types";

export async function showWelcome(
  container: HTMLElement,
  onOpen: (path: string, opts?: { resumeHistory?: boolean }) => void,
): Promise<HTMLElement> {
  const raw: RecentWorkspace[] = await window.ide.store.getRecents();

  // normalize + dedup: C:\x and C:/x are one entry (newest wins — list order)
  const seen = new Set<string>();
  const recents: RecentWorkspace[] = [];
  for (const r of raw) {
    const n = normPath(r.path);
    if (seen.has(n)) continue;
    seen.add(n);
    recents.push({ ...r, path: n });
  }

  const fmtAge = (at: number): string => {
    const d = Date.now() - at;
    const h = Math.floor(d / 3600000);
    if (h < 1) return "недавно";
    if (h < 24) return `${h}ч назад`;
    const days = Math.floor(h / 24);
    return days === 1 ? "вчера" : `${days}д назад`;
  };

  // which recents have a previous agent session? (drives the resume row)
  const sessionsByWs = new Map<string, boolean>();
  await Promise.all(
    recents.slice(0, 8).map(async (r) => {
      try {
        const list = await window.ide.omp.listSessions(r.path);
        sessionsByWs.set(r.path, list.length > 0);
      } catch {
        sessionsByWs.set(r.path, false);
      }
    }),
  );

  const list = el("div", { class: "wk-recents" });
  const rows: HTMLElement[] = [];
  let sel = -1;

  const select = (i: number) => {
    sel = Math.max(0, Math.min(i, rows.length - 1));
    rows.forEach((row, j) => row.classList.toggle("selected", j === sel));
    rows[sel]?.focus();
  };

  recents.forEach((r, i) => {
    const x = el("button", {
      class: "icon-btn wsc-x",
      title: "Remove from recents",
      onClick: (e) => {
        e.stopPropagation();
        void window.ide.store.removeRecent(r.path).then(() => {
          row.remove();
          const idx = rows.indexOf(row);
          if (idx >= 0) rows.splice(idx, 1);
        });
      },
    });
    x.append(svgIcon(I.close));
    const row = el(
      "div",
      {
        class: "ws-card wk-row",
        tabIndex: 0,
        onClick: () => onOpen(r.path),
        onKeyDown: (e) => {
          if (e.key === "Enter") onOpen(r.path);
          else if (e.key === "Delete") x.click();
          else if (e.key === "ArrowDown") { e.preventDefault(); select(i + 1); }
          else if (e.key === "ArrowUp") { e.preventDefault(); select(i - 1); }
        },
      },
      el("div", { class: "wk-main" },
        el("div", { class: "wsc-name", text: r.name }),
        el("div", { class: "wsc-path mono", text: r.path }),
      ),
      el("span", { class: "wk-age", text: fmtAge(r.openedAt) }),
      x,
    );
    rows.push(row);
    list.append(row);
    // resume-session row: only when a previous agent session exists
    if (sessionsByWs.get(r.path)) {
      list.append(
        el(
          "div",
          {
            class: "wk-resume",
            tabIndex: 0,
            onClick: () => onOpen(r.path, { resumeHistory: true }),
            onKeyDown: (e) => {
              if (e.key === "Enter") onOpen(r.path, { resumeHistory: true });
            },
          },
          el("span", { class: "wk-resume-ico", text: "↻" }),
          el("span", { text: "продолжить сессию агента" }),
        ),
      );
    }
  });

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

  // hero (left): nebula ambient pair + grain + wordmark (motion.css gates)
  const glow = el("div", { class: "cursor-glow" });
  const hero = el(
    "div",
    { class: "wk-hero" },
    el("div", { class: "grain-layer" }),
    glow,
    el("div", { class: "wordmark" }, "OMP ", el("span", { class: "wm-ide", text: "IDE" })),
    el("div", { class: "tagline", text: "reactor online · agent standing by" }),
  );
  hero.addEventListener("mousemove", (e) => {
    const r = hero.getBoundingClientRect();
    glow.style.left = `${e.clientX - r.left}px`;
    glow.style.top = `${e.clientY - r.top}px`;
  });

  // working column (right): opaque bg-0 panel
  const work = el(
    "div",
    { class: "wk-work" },
    el("div", { class: "wk-title", text: "Рабочие области" }),
    recents.length ? list : el("div", { class: "dimmer", text: "Нет недавних рабочих областей" }),
    openBtn,
  );

  const screen = el("div", { class: "welcome wk-split" }, hero, work);
  container.append(screen);
  if (rows.length) select(0);
  return screen;
}
