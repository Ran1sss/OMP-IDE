/**
 * Command palette (Ctrl+Shift+P) and fuzzy file opener (Ctrl+P).
 * One overlay component, two modes, backed by the command registry.
 */

import { el, clear } from "../core/dom";
import { emit } from "../core/bus";
import { state, relPath, baseName } from "../core/state";
import { allCommands, type Command } from "../core/commands";
import { fuzzyMatch, highlight } from "../core/fuzzy";

type Mode = "files" | "commands";

let overlay: HTMLElement | null = null;
let listEl: HTMLElement;
let inputEl: HTMLInputElement;
let mode: Mode = "files";
let items: PaletteItem[] = [];
let filtered: { item: PaletteItem; indices: number[] }[] = [];
let selected = 0;
let fileCache: string[] = [];
let fileCacheRoot: string | null = null;

interface PaletteItem {
  label: string;
  detail?: string;
  key?: string;
  run: () => void;
}

async function loadFiles(): Promise<void> {
  if (!state.root) {
    fileCache = [];
    return;
  }
  if (fileCacheRoot === state.root && fileCache.length) return;
  fileCache = await window.ide.fs.listAllFiles(state.root);
  fileCacheRoot = state.root;
}

export function invalidateFileCache(): void {
  fileCacheRoot = null;
}

function buildItems(): PaletteItem[] {
  if (mode === "commands") {
    return allCommands().map((c: Command) => ({
      label: c.title,
      key: c.keybinding,
      run: () => c.handler(),
    }));
  }
  const recentSet = new Map(state.recentFiles.map((f, i) => [f, i]));
  return fileCache
    .map((f) => ({ f, rel: relPath(f), recent: recentSet.get(f) }))
    .sort((a, b) => {
      const ra = a.recent ?? 999;
      const rb = b.recent ?? 999;
      return ra - rb || a.rel.length - b.rel.length;
    })
    .map(({ f, rel }) => ({
      label: rel,
      run: () => emit("open-file", { path: f }),
    }));
}

function applyFilter(): void {
  const q = inputEl.value.trim();
  if (!q) {
    filtered = items.slice(0, 60).map((item) => ({ item, indices: [] }));
  } else {
    const scored: { item: PaletteItem; indices: number[]; score: number }[] = [];
    for (const item of items) {
      const m = fuzzyMatch(q, item.label);
      if (m) scored.push({ item, indices: m.indices, score: m.score });
    }
    scored.sort((a, b) => b.score - a.score);
    filtered = scored.slice(0, 60);
  }
  selected = 0;
  renderList();
}

function renderList(): void {
  clear(listEl);
  if (filtered.length === 0) {
    listEl.append(el("div", { class: "pal-none", text: mode === "files" ? "No matching files" : "No matching commands" }));
    return;
  }
  filtered.forEach(({ item, indices }, i) => {
    const row = el("div", {
      class: i === selected ? "pal-row selected" : "pal-row",
      onClick: () => {
        selected = i;
        commit();
      },
    });
    const labelSpan = el("span", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } });
    labelSpan.append(highlight(item.label, indices, "pal-hl"));
    row.append(labelSpan);
    if (item.detail) row.append(el("span", { class: "pal-detail", text: item.detail }));
    if (item.key) row.append(el("span", { class: "pal-key keycap", text: item.key }));
    listEl.append(row);
  });
  listEl.children[selected]?.scrollIntoView({ block: "nearest" });
}

function commit(): void {
  const pick = filtered[selected];
  closePalette();
  pick?.item.run();
}

export function closePalette(): void {
  if (!overlay) return;
  const o = overlay;
  overlay = null;
  o.classList.remove("visible");
  setTimeout(() => o.remove(), 170);
}

export async function openPalette(m: Mode): Promise<void> {
  if (overlay) {
    // toggle / switch mode in place
    if (mode === m) {
      closePalette();
      return;
    }
    closePalette();
  }
  mode = m;

  inputEl = el("input", {
    class: "pal-input",
    placeholder: m === "files" ? "Search files by name…" : "Type a command…",
    onInput: () => applyFilter(),
    onKeyDown: (e) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        selected = Math.min(selected + 1, filtered.length - 1);
        renderList();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        selected = Math.max(selected - 1, 0);
        renderList();
      } else if (e.key === "Enter") {
        e.preventDefault();
        commit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        closePalette();
      }
    },
  }) as HTMLInputElement;

  listEl = el("div", { class: "pal-list" });
  const panel = el("div", { class: "palette" }, inputEl, listEl);
  overlay = el("div", { class: "overlay" }, panel);
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) closePalette();
  });
  document.body.append(overlay);
  inputEl.focus(); // synchronous — rAF is throttled in occluded windows
  requestAnimationFrame(() => overlay?.classList.add("visible"));

  if (m === "files") await loadFiles();
  items = buildItems();
  applyFilter();
}
