/**
 * Workspace switcher — title-bar chip + glass dropdown (approved variant 2).
 * The chip replaces the static «— folder» text; the dropdown lists the current
 * workspace, pinned/recent folders (gold «agent session» badges, dimmed
 * missing entries) and the open-folder / new-window actions. Switching itself
 * (guards + teardown) lives in the shell (index.ts) — this module only decides
 * WHAT to open and delegates through the handlers it was created with.
 */

import { el } from "../core/dom";
import { state, normPath, baseName } from "../core/state";
import { t } from "../core/i18n";
import { on } from "../core/bus";
import { fuzzyMatch } from "../core/fuzzy";
import type { RecentWorkspace } from "../../shared/types";

interface SwitchHandlers {
  onSwitch: (path: string, opts?: { resumeHistory?: boolean }) => void;
}

let handlers: SwitchHandlers | null = null;
let chipEl: HTMLButtonElement | null = null;
let chipName: HTMLElement | null = null;

// ---------------------------------------------------------------- chip

export function createWorkspaceChip(h: SwitchHandlers): HTMLElement {
  handlers = h;
  chipName = el("span", { class: "wsc-name" });
  chipEl = el(
    "button",
    { class: "ws-chip", onClick: () => (dd ? closeDropdown() : void openWorkspaceDropdown()) },
    chipName,
    el("span", { class: "wsc-chev", text: "▾" }),
  ) as HTMLButtonElement;
  refreshWorkspaceChip();
  // transient popover: a live language switch rebuilds fixed strings — close it
  on("lang-changed", () => {
    closeDropdown();
    refreshWorkspaceChip();
  });
  return chipEl;
}

/** Re-label the chip from state (workspace open/switch + language change). */
export function refreshWorkspaceChip(): void {
  if (!chipEl || !chipName) return;
  chipName.textContent = state.root ? baseName(state.root) : t("ws.chipNoFolder");
  chipEl.title = t("ws.chipTip");
}

// ---------------------------------------------------------------- dropdown

let dd: HTMLElement | null = null;
let listEl: HTMLElement | null = null;
let filterEl: HTMLElement | null = null;
let filter = "";
let rows: HTMLElement[] = [];
let focusIdx = -1;
let recents: RecentWorkspace[] = [];
/** workspace path → has at least one saved agent session (gold badge) */
let sessionsByWs = new Map<string, boolean>();

function samePath(a: string, b: string): boolean {
  return normPath(a).toLowerCase() === normPath(b).toLowerCase();
}

/** middle-truncate long paths for the right-aligned column */
function midTrunc(s: string, max = 34): string {
  if (s.length <= max) return s;
  const head = Math.ceil((max - 1) * 0.55);
  const tail = max - 1 - head;
  return `${s.slice(0, head)}…${s.slice(s.length - tail)}`;
}

function onOutsideDown(e: MouseEvent): void {
  if (dd && !dd.contains(e.target as Node) && !chipEl?.contains(e.target as Node)) closeDropdown();
}

export function closeDropdown(): void {
  if (!dd) return;
  const node = dd;
  dd = null;
  listEl = null;
  filterEl = null;
  rows = [];
  filter = "";
  focusIdx = -1;
  window.removeEventListener("mousedown", onOutsideDown, { capture: true });
  chipEl?.classList.remove("open");
  node.classList.remove("visible");
  setTimeout(() => node.remove(), 170);
  chipEl?.focus();
}

export async function openWorkspaceDropdown(): Promise<void> {
  if (!chipEl || !handlers || dd) return;

  // data: pinned-first recents (missing included) + session badges for the top rows
  recents = (await window.ide.store.getRecents()).map((r) => ({ ...r, path: normPath(r.path) }));
  sessionsByWs = new Map();
  await Promise.all(
    recents.slice(0, 8).map(async (r) => {
      if (r.missing) {
        sessionsByWs.set(r.path, false);
        return;
      }
      try {
        const list = await window.ide.omp.listSessions(r.path);
        sessionsByWs.set(r.path, list.length > 0);
      } catch {
        sessionsByWs.set(r.path, false);
      }
    }),
  );

  filterEl = el("div", { class: "wsd-filter mono", style: { display: "none" } });
  listEl = el("div", { class: "wsd-list" });
  const openBtn = el("button", {
    class: "btn btn-primary wsd-btn",
    text: t("wk.openFolder"),
    onClick: () => {
      void window.ide.dialog.openFolder().then((p) => {
        if (!p) return;
        closeDropdown();
        handlers?.onSwitch(p);
      });
    },
  });
  const newWinBtn = el("button", {
    class: "btn wsd-btn",
    text: t("ws.newWindow"),
    onClick: () => {
      const focused = rows[focusIdx]?.dataset.path;
      const target = focused ?? state.root;
      if (target) {
        window.ide.win.openWorkspaceWindow(target);
        closeDropdown();
      } else {
        void window.ide.dialog.openFolder().then((p) => {
          if (p) window.ide.win.openWorkspaceWindow(p);
          closeDropdown();
        });
      }
    },
  });
  dd = el(
    "div",
    { class: "ws-dd", tabIndex: -1 },
    filterEl,
    listEl,
    el("div", { class: "wsd-sep" }),
    el("div", { class: "wsd-actions" }, openBtn, newWinBtn),
    el("div", { class: "wsd-hint mono", text: t("ws.keysHint") }),
  );
  dd.addEventListener("keydown", onDropdownKey);
  document.body.append(dd);

  // anchored under the chip, clamped to the viewport
  const r = chipEl.getBoundingClientRect();
  const width = 330;
  dd.style.left = `${Math.max(8, Math.min(r.left, window.innerWidth - width - 8))}px`;
  dd.style.top = `${r.bottom + 6}px`;
  dd.style.width = `${width}px`;

  renderList();
  chipEl.classList.add("open");
  window.addEventListener("mousedown", onOutsideDown, { capture: true });
  requestAnimationFrame(() => dd?.classList.add("visible"));
  focusRow(0);
}

/** rows visible under the current filter (current workspace excluded) */
function visibleRecents(): RecentWorkspace[] {
  let out = recents.filter((r) => !state.root || !samePath(r.path, state.root));
  if (filter) out = out.filter((r) => fuzzyMatch(filter, `${r.name} ${r.path}`) !== null);
  return out;
}

function renderList(): void {
  if (!listEl || !filterEl) return;
  listEl.textContent = "";
  rows = [];

  filterEl.style.display = filter ? "" : "none";
  filterEl.textContent = filter ? `⌕ ${filter}` : "";

  // current workspace row — highlighted, non-clickable (lab: gradient fill)
  if (state.root) {
    listEl.append(
      el(
        "div",
        { class: "wsd-row cur" },
        el("span", { class: "wsd-mark", text: "▣" }),
        el("span", { class: "wsd-name", text: baseName(state.root) }),
        el("span", { class: "wsd-path mono", title: state.root, text: midTrunc(state.root) }),
      ),
      el("div", { class: "wsd-sep" }),
    );
  }

  const vis = visibleRecents();
  if (vis.length === 0) {
    listEl.append(el("div", { class: "wsd-empty", text: filter ? t("ws.noFilterMatch") : t("wk.noRecents") }));
    return;
  }

  for (const r of vis) {
    const pin = el("span", {
      class: `wsd-pin${r.pinned ? " pinned" : ""}`,
      text: "★",
      title: t(r.pinned ? "ws.unpinTip" : "ws.pinTip"),
      onClick: (e) => {
        e.stopPropagation();
        void togglePin(r.path);
      },
    });
    const row = el(
      "div",
      {
        class: `wsd-row${r.missing ? " missing" : ""}`,
        tabIndex: -1,
        dataset: { path: r.path, ...(sessionsByWs.get(r.path) ? { resume: "1" } : {}) },
        onClick: () => {
          if (r.missing) return;
          activateRow(r.path);
        },
      },
      r.missing ? el("span", { class: "wsd-pin", text: "★", style: { visibility: "hidden" } }) : pin,
      el("span", { class: "wsd-name", text: r.name }),
      el("span", { class: "wsd-path mono", title: r.path, text: midTrunc(r.path) }),
      r.missing
        ? el("span", { class: "wsd-badge missing-label", text: t("ws.missing") })
        : sessionsByWs.get(r.path)
          ? el("span", { class: "wsd-badge session", text: t("ws.badgeSession") })
          : null,
      r.missing
        ? el("button", {
            class: "icon-btn wsd-x",
            title: t("ws.removeFromList"),
            text: "✕",
            onClick: (e) => {
              e.stopPropagation();
              void removeRecent(r.path);
            },
          })
        : null,
    );
    rows.push(row);
    listEl.append(row);
  }
}

function activateRow(path: string): void {
  const resume = sessionsByWs.get(path) === true;
  closeDropdown();
  handlers?.onSwitch(path, resume ? { resumeHistory: true } : undefined);
}

async function togglePin(path: string): Promise<void> {
  await window.ide.store.togglePin(path);
  const r = recents.find((x) => samePath(x.path, path));
  if (r) r.pinned = !r.pinned;
  // re-sort pinned-first (stable, mirrors the store)
  recents = [...recents.filter((x) => x.pinned), ...recents.filter((x) => !x.pinned)];
  renderList();
  // focus follows the toggled row to its new slot
  const idx = rows.findIndex((row) => row.dataset.path && samePath(row.dataset.path, path));
  focusRow(idx >= 0 ? idx : 0);
}

async function removeRecent(path: string): Promise<void> {
  await window.ide.store.removeRecent(path);
  recents = recents.filter((x) => !samePath(x.path, path));
  const keep = focusIdx;
  renderList();
  focusRow(Math.min(keep, rows.length - 1));
}

function focusRow(i: number): void {
  if (!rows.length) {
    focusIdx = -1;
    dd?.focus();
    return;
  }
  focusIdx = Math.max(0, Math.min(i, rows.length - 1));
  rows[focusIdx].focus();
}

function onDropdownKey(e: KeyboardEvent): void {
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    closeDropdown();
    return;
  }
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    focusRow(focusIdx + (e.key === "ArrowDown" ? 1 : -1));
    return;
  }
  if (e.key === "Enter") {
    const row = rows[focusIdx];
    if (row && document.activeElement === row) {
      e.preventDefault();
      const path = row.dataset.path;
      if (path && !row.classList.contains("missing")) activateRow(path);
    }
    return; // focused buttons keep their native Enter
  }
  if (e.key === "Delete") {
    const path = rows[focusIdx]?.dataset.path;
    if (path) {
      e.preventDefault();
      void removeRecent(path);
    }
    return;
  }
  // `p` with an empty filter = pin toggle (spec); with a filter it types
  if (e.key === "p" && !filter && !e.ctrlKey && !e.altKey && !e.metaKey) {
    const path = rows[focusIdx]?.dataset.path;
    if (path) {
      e.preventDefault();
      void togglePin(path);
    }
    return;
  }
  if (e.key === "Backspace") {
    if (filter) {
      filter = filter.slice(0, -1);
      renderList();
      focusRow(0);
    }
    return;
  }
  // type-to-filter: printable characters narrow recents live
  if (e.key.length === 1 && !e.ctrlKey && !e.altKey && !e.metaKey) {
    filter += e.key;
    renderList();
    focusRow(0);
  }
}
