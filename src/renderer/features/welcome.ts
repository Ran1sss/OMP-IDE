/**
 * Welcome — «Сплит герой/дело» (redesign §9): nebula hero on the left,
 * opaque working column on the right (recents list + Open Folder + resume-
 * session row). Keyboard: Up/Down over recents, Enter opens, Del removes.
 */

import { el, svgIcon } from "../core/dom";
import { I } from "../core/icons";
import { normPath } from "../core/state";
import { t, relTime } from "../core/i18n";
import { on } from "../core/bus";
import { startTour } from "./guide";
import type { RecentWorkspace } from "../../shared/types";

export async function showWelcome(
  container: HTMLElement,
  onOpen: (path: string, opts?: { resumeHistory?: boolean }) => void,
): Promise<HTMLElement> {
  const raw: RecentWorkspace[] = await window.ide.store.getRecents();

  // normalize + dedup: C:\x and C:/x are one entry (newest wins — list order).
  // Missing folders are switcher-only (dimmed, remove-only there) — the
  // welcome column shows only openable workspaces. Pins keep store order (first).
  const seen = new Set<string>();
  const recents: RecentWorkspace[] = [];
  for (const r of raw) {
    if (r.missing) continue;
    const n = normPath(r.path);
    if (seen.has(n)) continue;
    seen.add(n);
    recents.push({ ...r, path: n });
  }

  // relative age via the shared locale-aware helper (i18n audit Part B.4)
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
      title: t("wk.removeRecent"),
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
        el("div", { class: "wsc-name" },
          r.pinned ? el("span", { class: "wk-pin", text: "★ ", title: t("ws.pinnedTip") }) : null,
          r.name,
        ),
        el("div", { class: "wsc-path mono", text: r.path }),
      ),
      el("span", { class: "wk-age", text: relTime(r.openedAt) }),
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
          el("span", { text: t("wk.resumeSession") }),
        ),
      );
    }
  });

  const openBtn = el("button", {
    class: "btn btn-primary",
    text: t("wk.openFolder"),
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
    el("div", { class: "tagline", text: t("wk.tagline") }),
  );
  hero.addEventListener("mousemove", (e) => {
    const r = hero.getBoundingClientRect();
    glow.style.left = `${e.clientX - r.left}px`;
    glow.style.top = `${e.clientY - r.top}px`;
  });

  // working column (right): opaque bg-0 panel
  const tourLink = el("button", {
    class: "wk-tour",
    text: t("wk.tourLink"),
    onClick: () => startTour(),
  });
  const work = el(
    "div",
    { class: "wk-work" },
    el("div", { class: "wk-title", text: t("wk.workspaces") }),
    recents.length ? list : el("div", { class: "dimmer", text: t("wk.noRecents") }),
    openBtn,
    tourLink,
  );

  const screen = el("div", { class: "welcome wk-split" }, hero, work);
  container.append(screen);
  if (rows.length) select(0);

  // persistent surface: re-apply fixed strings on language switch; the
  // subscription drops itself once the welcome screen leaves the DOM
  const off = on("lang-changed", () => {
    if (!screen.isConnected) {
      off();
      return;
    }
    work.querySelector(".wk-title")!.textContent = t("wk.workspaces");
    const dim = work.querySelector(".dimmer");
    if (dim) dim.textContent = t("wk.noRecents");
    openBtn.textContent = t("wk.openFolder");
    tourLink.textContent = t("wk.tourLink");
    hero.querySelector(".tagline")!.textContent = t("wk.tagline");
    for (const b of list.querySelectorAll<HTMLElement>(".wsc-x")) b.title = t("wk.removeRecent");
    for (const s of list.querySelectorAll(".wk-resume span:last-child")) s.textContent = t("wk.resumeSession");
    recents.forEach((r, i) => {
      const age = rows[i]?.querySelector(".wk-age");
      if (age) age.textContent = relTime(r.openedAt);
    });
  });

  return screen;
}
