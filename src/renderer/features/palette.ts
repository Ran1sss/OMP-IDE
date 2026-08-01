/**
 * «Омнибар» (function-redesign §5): one wide glass bar docked under the title
 * bar, replacing the centered palette. Both hotkeys open the SAME component —
 * Ctrl+P preselects Files, Ctrl+Shift+P preselects Commands. Results render in
 * labeled sections (Commands / Files / Models / Agent); Up/Down traverse all
 * sections continuously, Tab jumps to the next section header, Enter executes.
 * The command registry and keybindings are untouched — surface swap only.
 */

import { el, clear } from "../core/dom";
import { emit } from "../core/bus";
import { state, relPath } from "../core/state";
import { allCommands, type Command } from "../core/commands";
import { fuzzyMatch, highlight } from "../core/fuzzy";
import { omnibarModelItems } from "./models";
import { focusAgentInput, setAgentDraft } from "./agent";

type Mode = "files" | "commands";
type Section = "Commands" | "Files" | "Models" | "Agent";

interface BarItem {
  section: Section;
  label: string;
  key?: string;
  indices: number[];
  score: number;
  run: () => void;
}

let overlay: HTMLElement | null = null;
let listEl: HTMLElement;
let inputEl: HTMLInputElement;
let mode: Mode = "files";
let flat: BarItem[] = [];
let selected = 0;
let fileCache: string[] = [];
let fileCacheRoot: string | null = null;

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

/** section order is fixed; the preselected section (by hotkey) sorts first */
function sectionOrder(): Section[] {
  return mode === "commands"
    ? ["Commands", "Files", "Models", "Agent"]
    : ["Files", "Commands", "Models", "Agent"];
}

function buildFlat(query: string): BarItem[] {
  const q = query.trim();
  const out: BarItem[] = [];

  // Commands — from the single registry, keybindings shown
  for (const c of allCommands() as Command[]) {
    const m = q ? fuzzyMatch(q, c.title) : { score: 0, indices: [] as number[] };
    if (!m) continue;
    out.push({ section: "Commands", label: c.title, key: c.keybinding, indices: m.indices, score: m.score, run: () => c.handler() });
  }

  // Files — fuzzy over the workspace index, match-quality + recency ranking
  const recentSet = new Map(state.recentFiles.map((f, i) => [f, i]));
  const files = fileCache
    .map((f) => ({ f, rel: relPath(f), recent: recentSet.get(f) }))
    .sort((a, b) => (a.recent ?? 999) - (b.recent ?? 999) || a.rel.length - b.rel.length);
  let fileCount = 0;
  for (const { f, rel, recent } of files) {
    if (fileCount >= (q ? 200 : 20)) break;
    const m = q ? fuzzyMatch(q, rel) : { score: 0, indices: [] as number[] };
    if (!m) continue;
    fileCount++;
    out.push({
      section: "Files",
      label: rel,
      indices: m.indices,
      score: m.score + (recent !== undefined ? Math.max(0, 30 - recent * 3) : 0),
      run: () => emit("open-file", { path: f }),
    });
  }

  // Models — enabled qualified ids through the standard switch command
  for (const it of omnibarModelItems()) {
    const m = q ? fuzzyMatch(q, it.selector) : null;
    if (!m) continue; // models only surface on a query — noise otherwise
    out.push({ section: "Models", label: it.selector, indices: m.indices, score: m.score, run: it.run });
  }

  // rank within sections, order sections, cap
  const order = sectionOrder();
  out.sort((a, b) => order.indexOf(a.section) - order.indexOf(b.section) || b.score - a.score);
  const capped = out.slice(0, 80);

  // Agent — free-text escape hatch when nothing matches well
  const best = capped[0]?.score ?? -1;
  if (q && (capped.length === 0 || best < 12)) {
    capped.push({
      section: "Agent",
      label: `→ спросить агента: "${q}"`,
      indices: [],
      score: -1,
      run: () => {
        setAgentDraft(q);
        focusAgentInput();
      },
    });
  }
  return capped;
}

function renderList(): void {
  clear(listEl);
  if (flat.length === 0) {
    listEl.append(el("div", { class: "pal-none", text: "Nothing matches" }));
    return;
  }
  let lastSection: Section | null = null;
  flat.forEach((item, i) => {
    if (item.section !== lastSection) {
      lastSection = item.section;
      listEl.append(el("div", { class: "ob-section", text: item.section.toUpperCase() }));
    }
    const row = el("div", {
      class: i === selected ? "pal-row selected" : "pal-row",
      dataset: { idx: String(i) },
      onClick: () => {
        selected = i;
        commit();
      },
    });
    const labelSpan = el("span", { style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" } });
    labelSpan.append(highlight(item.label, item.indices, "pal-hl"));
    row.append(labelSpan);
    if (item.key) row.append(el("span", { class: "pal-key keycap", text: item.key }));
    listEl.append(row);
  });
  listEl.querySelector(".pal-row.selected")?.scrollIntoView({ block: "nearest" });
}

function applyFilter(): void {
  flat = buildFlat(inputEl.value);
  selected = 0;
  renderList();
}

function commit(): void {
  const pick = flat[selected];
  closePalette();
  pick?.run();
}

/** Tab: jump selection to the first item of the next section (wraps). */
function jumpSection(): void {
  if (!flat.length) return;
  const cur = flat[selected]?.section;
  for (let i = selected + 1; i < flat.length + selected; i++) {
    const idx = i % flat.length;
    if (flat[idx].section !== cur) {
      selected = idx;
      renderList();
      return;
    }
  }
}

export function closePalette(): void {
  if (!overlay) return;
  const o = overlay;
  overlay = null;
  o.classList.remove("visible");
  setTimeout(() => o.remove(), 210);
}

export async function openPalette(m: Mode): Promise<void> {
  if (overlay) {
    if (mode === m) {
      closePalette();
      return;
    }
    closePalette();
  }
  mode = m;

  inputEl = el("input", {
    class: "pal-input",
    placeholder: m === "files" ? "Файл, команда, модель… (Tab — след. секция)" : "Команда, файл, модель… (Tab — след. секция)",
    onInput: () => applyFilter(),
    onKeyDown: (e) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        selected = Math.min(selected + 1, flat.length - 1);
        renderList();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        selected = Math.max(selected - 1, 0);
        renderList();
      } else if (e.key === "Tab") {
        e.preventDefault();
        jumpSection();
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
  const panel = el("div", { class: "omnibar" }, inputEl, listEl);
  overlay = el("div", { class: "overlay ob-overlay" }, panel);
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) closePalette();
  });
  document.body.append(overlay);
  inputEl.focus(); // synchronous — rAF is throttled in occluded windows
  requestAnimationFrame(() => overlay?.classList.add("visible"));

  await loadFiles();
  applyFilter();
}
