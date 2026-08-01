/**
 * Global search panel: streamed ripgrep results grouped by file,
 * replace-in-files with per-match preview + confirm.
 */

import { el, clear, svgIcon } from "../core/dom";
import { I } from "../core/icons";
import { on, emit } from "../core/bus";
import { state, baseName, relPath, dirName } from "../core/state";
import { toast, confirmDialog } from "../core/ui";
import { t } from "../core/i18n";
import type { SearchMatch, ReplaceEdit } from "../../shared/types";

let panelEl: HTMLElement;
let resultsEl: HTMLElement;
let summaryEl: HTMLElement;
let queryInput: HTMLTextAreaElement | HTMLInputElement;
let replaceInput: HTMLInputElement;
let includeInput: HTMLInputElement;
let excludeInput: HTMLInputElement;

let regexOn = false;
let caseOn = false;
let currentSearch = 0;
/** completed search with a real query — distinguishes "no query" from "0 hits" */
let searchDone = false;
let staleBar: HTMLElement | null = null;
let matchesByFile = new Map<string, SearchMatch[]>();
let totalMatches = 0;
/** match key -> excluded from replace */
const excluded = new Set<string>();

function matchKey(m: SearchMatch): string {
  return `${m.file}:${m.line}:${m.column}`;
}

function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number): (...args: A) => void {
  let t: number | undefined;
  return (...args: A) => {
    clearTimeout(t);
    t = window.setTimeout(() => fn(...args), ms);
  };
}

// ---------------------------------------------------------------- render

function renderEmptyHint() {
  clear(resultsEl);
  clear(summaryEl);
  resultsEl.append(
    el(
      "div",
      { class: "search-empty" },
      svgIcon(I.search),
      el("div", { text: t("search.hint") }),
      el(
        "div",
        { class: "hint-row", style: { display: "flex", gap: "6px", alignItems: "center" } },
        el("span", { class: "keycap", text: ".*" }),
        el("span", { text: t("search.hintRegex") }),
        el("span", { class: "keycap", text: "Aa" }),
        el("span", { text: t("search.hintCase") }),
      ),
    ),
  );
}

/** Designed zero-hit state — never the onboarding hint (that means "no query"). */
function renderNoMatches() {
  clear(resultsEl);
  const filters = [includeInput.value.trim() && t("search.filterInclude"), excludeInput.value.trim() && t("search.filterExclude"), caseOn && t("search.hintCase"), regexOn && t("search.hintRegex")].filter(Boolean).join(" · ");
  resultsEl.append(
    el(
      "div",
      { class: "search-empty" },
      svgIcon(I.search),
      el("div", {}, t("search.noMatchesFor") + " ", el("span", { class: "mono", text: `"${queryInput.value}"` })),
      filters ? el("div", { class: "hint-row", text: t("search.activeFilters", filters) }) : null,
    ),
  );
}

function renderSummary(done: boolean, hitLimit: boolean, error?: string) {
  clear(summaryEl);
  if (error) {
    summaryEl.append(el("span", { class: "warn", text: error }));
    return;
  }
  const files = matchesByFile.size;
  if (totalMatches === 0 && done) {
    summaryEl.append(el("span", { text: t("search.noResults") }));
    return;
  }
  if (totalMatches === 0) {
    summaryEl.append(el("span", { text: t("search.searching") }));
    return;
  }
  summaryEl.append(
    el("span", {
      class: "mono",
      text: done ? t("search.summary", totalMatches, files) : `${t("search.summary", totalMatches, files)}…`,
    }),
  );
  if (hitLimit) summaryEl.append(el("span", { class: "warn", text: ` ${t("search.limitReached")}` }));
}

function highlightSegments(m: SearchMatch, replacement: string | null): HTMLElement {
  const pre = m.lineText.slice(Math.max(0, m.column - 40), m.column);
  const hit = m.lineText.slice(m.column, m.column + m.length);
  const post = m.lineText.slice(m.column + m.length, m.column + m.length + 80);
  const span = el("span", { style: { overflow: "hidden", textOverflow: "ellipsis" } });
  span.append(pre);
  if (replacement !== null) {
    span.append(el("span", { class: "m-del", text: hit }));
    span.append(el("span", { class: "m-repl", text: replacement }));
  } else {
    span.append(el("span", { class: "m-hit", text: hit }));
  }
  span.append(post);
  return span;
}

function renderResults() {
  staleBar = null; // clear() drops the node; a new fs event may re-add it
  clear(resultsEl);
  const replacing = replaceInput.value.length > 0;
  for (const [file, matches] of matchesByFile) {
    const group = el("div", { class: "search-file-group" });
    const rel = relPath(file);
    const head = el(
      "div",
      { class: "sf-head", onClick: () => emit("open-file", { path: file }) },
      svgIcon(I.file),
      el("span", { text: baseName(file) }),
      el("span", { class: "sf-dir", text: dirName(rel) === rel ? "" : dirName(rel) }),
      el("span", { class: "sf-count mono", text: String(matches.length) }),
    );
    group.append(head);
    for (const m of matches) {
      const key = matchKey(m);
      const row = el(
        "div",
        {
          class: "search-match-row",
          onClick: () =>
            emit("open-file", { path: m.file, line: m.line, column: m.column, selectLength: m.length }),
        },
      );
      if (replacing) {
        const cb = el("input", { class: "m-check", type: "checkbox" }) as HTMLInputElement;
        cb.checked = !excluded.has(key);
        cb.addEventListener("click", (e) => {
          e.stopPropagation();
          if (cb.checked) excluded.delete(key);
          else excluded.add(key);
        });
        row.append(cb);
      }
      row.append(
        el("span", { class: "m-line", text: String(m.line) }),
        highlightSegments(m, replacing ? replaceInput.value : null),
      );
      group.append(row);
    }
    resultsEl.append(group);
  }
  if (matchesByFile.size === 0) {
    if (searchDone && queryInput.value.trim()) renderNoMatches();
    else renderEmptyHint();
  }
}

// ---------------------------------------------------------------- search driver

const runSearch = debounce(() => void startSearch(), 250);

async function startSearch() {
  const pattern = queryInput.value;
  currentSearch++;
  const id = `s${currentSearch}`;
  matchesByFile = new Map();
  totalMatches = 0;
  excluded.clear();
  searchDone = false;
  staleBar = null;
  if (!pattern.trim() || !state.root) {
    renderEmptyHint();
    return;
  }
  clear(resultsEl);
  renderSummary(false, false);
  await window.ide.search.start({
    id,
    pattern,
    regex: regexOn,
    caseSensitive: caseOn,
    include: includeInput.value,
    exclude: excludeInput.value,
    root: state.root,
  });
}

// ---------------------------------------------------------------- replace

async function applyReplace() {
  const replacement = replaceInput.value;
  const edits: ReplaceEdit[] = [];
  for (const matches of matchesByFile.values()) {
    for (const m of matches) {
      if (excluded.has(matchKey(m))) continue;
      edits.push({
        file: m.file,
        line: m.line,
        column: m.column,
        matchText: m.lineText.slice(m.column, m.column + m.length),
        replaceText: replacement,
      });
    }
  }
  if (edits.length === 0) {
    toast(t("search.nothingSelected"));
    return;
  }
  const fileCount = new Set(edits.map((e) => e.file)).size;
  const ok = await confirmDialog({
    title: t("search.replaceTitle"),
    message: t("search.replaceConfirm", edits.length, fileCount),
    confirmLabel: t("search.replaceN", edits.length),
    danger: true,
  });
  if (!ok) return;
  const res = await window.ide.search.replace(edits);
  if (res.failed.length) {
    toast(t("search.replacedFailed", res.applied, res.failed.length), { crit: true });
  } else {
    toast(t("search.replacedOk", res.applied));
  }
  emit("git-refresh", undefined);
  void startSearch();
}

// ---------------------------------------------------------------- init

export function initSearchPanel(container: HTMLElement) {
  panelEl = container;
  panelEl.classList.add("search-panel");

  const regexBtn = el("button", { class: "chip-toggle", text: ".*", title: t("search.regex") });
  const caseBtn = el("button", { class: "chip-toggle", text: "Aa", title: t("search.matchCase") });
  regexBtn.addEventListener("click", () => {
    regexOn = !regexOn;
    regexBtn.classList.toggle("on", regexOn);
    runSearch();
  });
  caseBtn.addEventListener("click", () => {
    caseOn = !caseOn;
    caseBtn.classList.toggle("on", caseOn);
    runSearch();
  });

  queryInput = el("input", {
    class: "input mono",
    placeholder: t("search.placeholder"),
    onInput: () => runSearch(),
    onKeyDown: (e) => {
      if (e.key === "Enter") void startSearch();
    },
  }) as HTMLInputElement;

  const replaceBtn = el("button", { class: "btn", text: t("search.replaceAll"), onClick: () => void applyReplace() });
  replaceInput = el("input", {
    class: "input mono",
    placeholder: t("search.replace"),
    onInput: () => renderResults(),
  }) as HTMLInputElement;

  includeInput = el("input", {
    class: "input mono",
    placeholder: t("search.includePlaceholder"),
    onInput: () => runSearch(),
  }) as HTMLInputElement;
  excludeInput = el("input", {
    class: "input mono",
    placeholder: t("search.excludePlaceholder"),
    onInput: () => runSearch(),
  }) as HTMLInputElement;

  summaryEl = el("div", { class: "search-summary" });
  resultsEl = el("div", { class: "search-results" });

  panelEl.append(
    el("div", { class: "search-input-row" }, queryInput, el("div", { class: "search-toggles" }, caseBtn, regexBtn)),
    el("div", { class: "search-input-row", style: { display: "flex", gap: "6px" } }, replaceInput, replaceBtn),
    el("div", { class: "glob-row" }, includeInput, excludeInput),
    summaryEl,
    resultsEl,
  );
  renderEmptyHint();
  // live language switch: fixed strings of the stable inputs/buttons (fix 4)
  on("lang-changed", () => {
    queryInput.placeholder = t("search.placeholder");
    replaceInput.placeholder = t("search.replace");
    replaceBtn.textContent = t("search.replaceAll");
    regexBtn.title = t("search.regex");
    caseBtn.title = t("search.matchCase");
    includeInput.placeholder = t("search.includePlaceholder");
    excludeInput.placeholder = t("search.excludePlaceholder");
    if (!matchesByFile.size) renderEmptyHint();
  });

  window.ide.search.onBatch((b) => {
    if (b.id !== `s${currentSearch}`) return;
    for (const m of b.matches) {
      const arr = matchesByFile.get(m.file) ?? [];
      arr.push(m);
      matchesByFile.set(m.file, arr);
      totalMatches++;
    }
    renderResults();
    renderSummary(false, false);
  });
  window.ide.search.onDone((d) => {
    if (d.id !== `s${currentSearch}`) return;
    searchDone = true;
    renderResults();
    renderSummary(true, d.hitLimit, d.error);
  });

  // Results silently rot when the workspace changes underneath them (agent
  // edits, terminal git ops). Mark them stale instead of pretending.
  on("fs-changed", () => {
    if (!searchDone || !queryInput.value.trim() || staleBar) return;
    staleBar = el(
      "div",
      { class: "search-stale" },
      el("span", { text: t("search.stale") }),
      el("button", { class: "btn", text: t("search.rerun"), onClick: () => void startSearch() }),
    );
    resultsEl.prepend(staleBar);
  });
}

/** Workspace switch: drop query/results — nothing may leak into the next root. */
export function resetSearchPanel(): void {
  queryInput.value = "";
  replaceInput.value = "";
  includeInput.value = "";
  excludeInput.value = "";
  currentSearch++; // orphan any in-flight stream
  searchDone = false;
  staleBar = null;
  matchesByFile = new Map();
  totalMatches = 0;
  excluded.clear();
  renderEmptyHint();
}

export function focusSearch(seed?: string) {
  if (seed !== undefined) {
    (queryInput as HTMLInputElement).value = seed;
    runSearch();
  }
  queryInput.focus();
  (queryInput as HTMLInputElement).select();
}
