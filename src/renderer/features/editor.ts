/**
 * Editor area: Monaco, tab groups, split view, diff views, image preview,
 * dirty tracking, git gutter decorations, external-change reconciliation.
 */

import * as monaco from "monaco-editor";
import { marked } from "marked";
import { el, clear, svgIcon } from "../core/dom";
import { I } from "../core/icons";
import { on, emit } from "../core/bus";
import { state, baseName, relPath, languageForPath, imageMime, normPath, noteRecentFile } from "../core/state";
import { toast, confirmDialog, contextMenu } from "../core/ui";
import { setMentionDragData } from "./mentions";

// ---------------------------------------------------------------- monaco env

self.MonacoEnvironment = {
  getWorkerUrl(_moduleId: string, label: string): string {
    if (label === "json") return "./workers/json.worker.js";
    if (label === "css" || label === "scss" || label === "less") return "./workers/css.worker.js";
    if (label === "html" || label === "handlebars" || label === "razor") return "./workers/html.worker.js";
    if (label === "typescript" || label === "javascript") return "./workers/ts.worker.js";
    return "./workers/editor.worker.js";
  },
};

monaco.editor.defineTheme("reactor", {
  base: "vs-dark",
  inherit: true,
  rules: [
    { token: "comment", foreground: "5c6478", fontStyle: "italic" },
    { token: "keyword", foreground: "5ea2ff" },
    { token: "string", foreground: "55e6c1" },
    { token: "number", foreground: "e8c574" },
    { token: "regexp", foreground: "ff9e5e" },
    { token: "type", foreground: "7fd0ff" },
    { token: "function", foreground: "b7c5ff" },
    { token: "variable", foreground: "eef1f8" },
    { token: "constant", foreground: "e8c574" },
    { token: "tag", foreground: "5ea2ff" },
    { token: "attribute.name", foreground: "55e6c1" },
    { token: "delimiter", foreground: "9aa3b8" },
  ],
  colors: {
    "editor.background": "#0a0c12",
    "editor.foreground": "#eef1f8",
    "editorLineNumber.foreground": "#3a4157",
    "editorLineNumber.activeForeground": "#9aa3b8",
    "editorCursor.foreground": "#5ea2ff",
    "editor.selectionBackground": "#5ea2ff3d",
    "editor.inactiveSelectionBackground": "#5ea2ff20",
    "editor.lineHighlightBackground": "#10131c",
    "editorWhitespace.foreground": "#232837",
    "editorIndentGuide.background1": "#171b27",
    "editorIndentGuide.activeBackground1": "#323950",
    "editorWidget.background": "#10131c",
    "editorWidget.border": "#323950",
    "editorSuggestWidget.background": "#10131c",
    "editorSuggestWidget.border": "#323950",
    "editorSuggestWidget.selectedBackground": "#5ea2ff26",
    "input.background": "#171b27",
    "input.border": "#232837",
    "scrollbarSlider.background": "#23283766",
    "scrollbarSlider.hoverBackground": "#32395088",
    "scrollbarSlider.activeBackground": "#323950aa",
    "minimap.background": "#0a0c12",
    "diffEditor.insertedTextBackground": "#55e6c122",
    "diffEditor.removedTextBackground": "#ff5e7a22",
    "diffEditor.insertedLineBackground": "#55e6c114",
    "diffEditor.removedLineBackground": "#ff5e7a14",
    "editorGutter.addedBackground": "#55e6c1",
    "editorGutter.modifiedBackground": "#ff9e5e",
    "editorGutter.deletedBackground": "#ff5e7a",
  },
});

// ---------------------------------------------------------------- types

interface DiffPayload {
  title: string;
  path: string;
  original: string;
  modified: string;
  language?: string;
}

interface EditorTab {
  /** unique key: file path, or diff:<path> */
  key: string;
  kind: "file" | "diff" | "image" | "mdprev";
  path: string;
  title: string;
  model?: monaco.editor.ITextModel;
  diff?: DiffPayload;
  imageSrc?: string;
  /** rendered-markdown preview source (kind "mdprev") */
  preview?: string;
  dirty: boolean;
  /** mtime of disk content backing the model */
  diskMtime: number;
  /** disk content hash-ish (length + head) to cheaply detect sameness */
  savedVersionId: number;
}

interface EditorGroup {
  id: number;
  tabs: EditorTab[];
  active: string | null;
  /** tab keys, most-recently-activated first (MRU Ctrl+Tab); session-scoped like focus */
  mru: string[];
  tabsEl: HTMLElement;
  crumbsEl: HTMLElement;
  hostEl: HTMLElement;
  rootEl: HTMLElement;
  /** this group's live widgets — per-group so both splits stay editable at once */
  editor: monaco.editor.IStandaloneCodeEditor | null;
  diffEditor: monaco.editor.IDiffEditor | null;
  /** key of the tab currently mounted in hostEl */
  mountedKey: string | null;
}

// ---------------------------------------------------------------- module state

let areaEl: HTMLElement;
const groups: EditorGroup[] = [];
let focusedGroup: EditorGroup | null = null;
let wordWrap = false;
/** one-shot: mountActive skips editor.focus() (tree clicks keep explorer focus) */
let suppressNextFocus = false;
let groupSeq = 0;
/** last emitted active-tab signature (focused group id + active key) — see emitActiveTabChanged */
let lastActiveSig: string | null = null;

const gitDecorations = new Map<string, string[]>(); // path -> decoration ids

// ---------------------------------------------------------------- helpers

/**
 * Locate a tab by key, preferring the focused group. A tab OBJECT may be held
 * by both groups at once (split duplicate) — model, dirty state, and save
 * identity are shared; each group renders its own view.
 */
function findTab(key: string): { group: EditorGroup; tab: EditorTab } | null {
  const pref = focusedGroupObj();
  if (pref) {
    const tab = pref.tabs.find((t) => t.key === key);
    if (tab) return { group: pref, tab };
  }
  for (const g of groups) {
    if (g === pref) continue;
    const tab = g.tabs.find((t) => t.key === key);
    if (tab) return { group: g, tab };
  }
  return null;
}

/** number of groups currently holding this tab object (split views share the object) */
function viewCount(tab: EditorTab): number {
  let n = 0;
  for (const g of groups) if (g.tabs.includes(tab)) n++;
  return n;
}

/** re-render the strip of every group holding the tab (dirty dot stays coherent across views) */
function renderGroupsHolding(tab: EditorTab): void {
  for (const g of groups) if (g.tabs.includes(tab)) renderTabs(g);
}

/** The group the user last focused. Falls back to the first group when the reference is stale. */
function focusedGroupObj(): EditorGroup | null {
  if (focusedGroup && groups.includes(focusedGroup)) return focusedGroup;
  return groups[0] ?? null;
}

function activeTab(): EditorTab | null {
  const g = focusedGroupObj();
  if (!g || !g.active) return null;
  return g.tabs.find((t) => t.key === g.active) ?? null;
}

export function activeFilePath(): string | null {
  const t = activeTab();
  return t && t.kind === "file" ? t.path : null;
}

export function dirtyCount(): number {
  // a tab shared across both groups is ONE dirty buffer, not two
  const seen = new Set<EditorTab>();
  for (const g of groups) for (const t of g.tabs) if (t.dirty) seen.add(t);
  return seen.size;
}

// ---------------------------------------------------------------- rendering

function renderTabs(g: EditorGroup) {
  clear(g.tabsEl);
  for (const tab of g.tabs) {
    const closeBtn = el("span", {
      class: "tab-close",
      onClick: (e) => {
        e.stopPropagation();
        void closeTab(tab.key, { group: g });
      },
    });
    closeBtn.append(svgIcon(I.close));
    const node = el(
      "div",
      {
        class: tab.key === g.active ? "tab active" : "tab",
        title: tab.path,
        draggable: true,
        dataset: { key: tab.key },
        onClick: () => {
          focusedGroup = g;
          activateTab(g, tab.key);
        },
        onContextMenu: (e) => {
          e.preventDefault();
          showTabMenu(g, tab, e.clientX, e.clientY);
        },
        onDragStart: (e) => {
          e.dataTransfer?.setData("omp/tab", JSON.stringify({ key: tab.key, from: g.id }));
          // mention payload for the agent prompt (files only, not diff/image views)
          if (tab.kind === "file") setMentionDragData(e, [{ path: tab.path, kind: "file" }]);
          (e.target as HTMLElement).classList.add("dragging");
        },
        onDragEnd: (e) => (e.target as HTMLElement).classList.remove("dragging"),
        onDragOver: (e) => {
          if (!e.dataTransfer?.types.includes("omp/tab")) return;
          e.preventDefault();
          if (node.classList.contains("dragging")) return; // hovering the dragged tab itself
          const r = node.getBoundingClientRect();
          const before = e.clientX < r.left + r.width / 2;
          node.classList.toggle("drop-before", before);
          node.classList.toggle("drop-after", !before);
        },
        onDragLeave: () => node.classList.remove("drop-before", "drop-after"),
        onDrop: (e) => {
          node.classList.remove("drop-before", "drop-after");
          const raw = e.dataTransfer?.getData("omp/tab");
          if (!raw) return;
          e.preventDefault();
          e.stopPropagation(); // the group root's drop handler must not double-handle
          try {
            const { key, from } = JSON.parse(raw) as { key: string; from: number };
            if (from !== g.id) {
              moveTabToGroup(key, from, g.id);
              return;
            }
            const r = node.getBoundingClientRect();
            reorderTab(g, key, tab.key, e.clientX < r.left + r.width / 2);
          } catch {}
        },
      },
      tab.dirty ? el("span", { class: "tab-dirty", title: "Unsaved changes" }) : null,
      el("span", { text: tab.title }),
      closeBtn,
    );
    g.tabsEl.append(node);
  }
}

function showTabMenu(g: EditorGroup, tab: EditorTab, x: number, y: number) {
  // EVO-30 debt: with an existing two-group layout, drag MOVES a tab; this menu
  // item duplicates via the same shared-push path splitEditor uses (same object).
  const other = groups.find((gr) => gr !== g && !gr.tabs.includes(tab)) ?? null;
  contextMenu(x, y, [
    { label: "Close", key: "Ctrl+W", action: () => void closeTab(tab.key, { group: g }) },
    { label: "Close Others", action: () => void closeOthers(g, tab.key) },
    { label: "Close All", action: () => void closeAllInGroup(g) },
    ...(other
      ? [{ label: "Duplicate into Other Group", action: () => duplicateIntoGroup(tab, other) }]
      : []),
    { separator: true },
    { label: "Copy Path", action: () => void navigator.clipboard.writeText(tab.path) },
    ...(tab.kind === "file"
      ? [{ label: "Reveal in Explorer", action: () => revealInExplorer(tab.path) }]
      : []),
  ]);
}

/** Shared-push duplicate: the other group gains a view of the SAME tab object. */
function duplicateIntoGroup(tab: EditorTab, to: EditorGroup) {
  if (to.tabs.includes(tab)) return;
  to.tabs.push(tab);
  focusedGroup = to;
  for (const gr of groups) gr.rootEl.classList.toggle("focused-group", gr === to);
  activateTab(to, tab.key);
}
function revealInExplorer(path: string) {
  emit("view-switch", "explorer");
  emit("reveal-in-tree", path);
}

async function closeOthers(g: EditorGroup, keep: string) {
  for (const key of g.tabs.map((t) => t.key)) if (key !== keep) await closeTab(key, { group: g });
}

async function closeAllInGroup(g: EditorGroup) {
  for (const key of g.tabs.map((t) => t.key)) await closeTab(key, { group: g });
}

function renderEmpty(host: HTMLElement) {
  clear(host);
  host.append(
    el(
      "div",
      { class: "editor-empty" },
      el("div", { class: "hint-row" }, el("span", { class: "keycap", text: "Ctrl" }), el("span", { class: "keycap", text: "P" }), el("span", { text: "open file" })),
      el("div", { class: "hint-row" }, el("span", { class: "keycap", text: "Ctrl" }), el("span", { class: "keycap", text: "Shift" }), el("span", { class: "keycap", text: "P" }), el("span", { text: "command palette" })),
      el("div", { class: "hint-row" }, el("span", { class: "keycap", text: "Ctrl" }), el("span", { class: "keycap", text: "`" }), el("span", { text: "terminal" })),
    ),
  );
}

/**
 * Emit "active-tab-changed" only when the consumer-visible active tab actually
 * changed (focused group identity + its active key). Same-tab re-mounts
 * (e.g. relayout) are filtered at the source.
 *
 * CAVEAT (run-5 debt, documented): the signature keys on group id + tab KEY, so a
 * same-key CONTENT change (e.g. openDiff refreshing an already-open diff tab) does
 * not re-emit. Correct today — openDiff re-mounts affected groups explicitly — but
 * a future consumer that cares about diff-content changes needs a version tick
 * folded into `sig` (e.g. a per-tab revision counter bumped on payload swap).
 */
function emitActiveTabChanged() {
  queueMicrotask(() => {
    const g = focusedGroupObj();
    const sig = g ? `${g.id}:${g.active ?? ""}` : "";
    if (sig === lastActiveSig) return;
    lastActiveSig = sig;
    emit("active-tab-changed", undefined);
  });
}

/**
 * Status-bar truth for the focused group's active tab: cursor for file editors,
 * an honest kind label and no Ln/Col for image/preview/diff/empty (the bar
 * previously kept the previous file's cursor when focus moved to a non-file tab).
 */
function emitEditorStatus(g: EditorGroup) {
  if (focusedGroupObj() !== g) return;
  const tab = g.active ? g.tabs.find((t) => t.key === g.active) : null;
  if (!tab) {
    emit("editor-status", { path: null, line: null, column: null, language: "" });
    return;
  }
  if (tab.kind === "file" && g.editor && tab.model) {
    emit("editor-status", {
      path: tab.path,
      line: g.editor.getPosition()?.lineNumber ?? 1,
      column: g.editor.getPosition()?.column ?? 1,
      language: tab.model.getLanguageId(),
    });
    return;
  }
  const language =
    tab.kind === "image" ? "Image"
    : tab.kind === "mdprev" ? "Markdown Preview"
    : tab.diff?.language ?? "diff";
  emit("editor-status", { path: tab.path, line: null, column: null, language });
}

/** (Re)mount the appropriate widget into the group's host. */
function mountActive(g: EditorGroup) {
  const tab = g.active ? g.tabs.find((t) => t.key === g.active) : null;
  // every open/close/switch/collapse path funnels here — consumers (outline)
  // re-read the active tab after the mount settles
  emitActiveTabChanged();

  // EVO-31 debt: refresh is a full re-mount — keep the preview's scroll position
  // when the SAME preview tab is being re-rendered (save/watcher refresh).
  const prevScrollEl = g.hostEl.querySelector<HTMLElement>(".md-preview");
  const prevScroll = prevScrollEl && g.mountedKey === (tab?.key ?? null) ? prevScrollEl.scrollTop : null;

  // Dispose this group's own widgets; the other split's instances are untouched.
  g.editor?.dispose();
  g.editor = null;
  g.diffEditor?.dispose();
  g.diffEditor = null;
  g.mountedKey = null;
  clear(g.hostEl);

  if (!tab) {
    renderEmpty(g.hostEl);
    renderCrumbs(g, null);
    emitEditorStatus(g);
    return;
  }
  renderCrumbs(g, tab);

  const mount = el("div", { class: "monaco-mount" });
  g.hostEl.append(mount);

  if (tab.kind === "image") {
    mount.className = "image-preview";
    mount.append(el("img", {}) as HTMLImageElement);
    (mount.firstChild as HTMLImageElement).src = tab.imageSrc ?? "";
    g.mountedKey = tab.key;
    emitEditorStatus(g);
    return;
  }

  if (tab.kind === "mdprev") {
    mount.className = "md-preview";
    const body = el("div", { class: "md" });
    body.innerHTML = marked.parse(tab.preview ?? "", { async: false });
    // preview is inert: links must not navigate the app window
    for (const a of body.querySelectorAll("a")) {
      a.addEventListener("click", (e) => e.preventDefault());
    }
    mount.append(body);
    if (prevScroll !== null) mount.scrollTop = prevScroll;
    g.mountedKey = tab.key;
    emitEditorStatus(g);
    return;
  }

  if (tab.kind === "diff") {
    const orig = monaco.editor.createModel(tab.diff!.original, tab.diff!.language ?? "plaintext");
    const mod = monaco.editor.createModel(tab.diff!.modified, tab.diff!.language ?? "plaintext");
    const de = monaco.editor.createDiffEditor(mount, {
      theme: "reactor",
      readOnly: true,
      renderSideBySide: true,
      automaticLayout: false,
      fontFamily: "JetBrains Mono",
      fontSize: state.settings.fontSize,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
    });
    de.setModel({ original: orig, modified: mod });
    de.onDidDispose(() => {
      orig.dispose();
      mod.dispose();
    });
    g.diffEditor = de;
    g.mountedKey = tab.key;
    emitEditorStatus(g);
    return;
  }

  // file — editors are per-group; the same model can be live in both splits
  const ed = monaco.editor.create(mount, {
    model: tab.model!,
    theme: "reactor",
    fontFamily: "JetBrains Mono",
    fontSize: state.settings.fontSize,
    fontLigatures: true,
    minimap: { enabled: true },
    automaticLayout: false,
    scrollBeyondLastLine: false,
    wordWrap: wordWrap ? "on" : "off",
    smoothScrolling: true,
    cursorBlinking: "phase",
    renderLineHighlight: "all",
    padding: { top: 8 },
    multiCursorModifier: "ctrlCmd",
  });
  g.editor = ed;
  g.mountedKey = tab.key;

  ed.onDidChangeCursorPosition((e) => {
    scheduleSymbolTrail(g, tab);
    // a background split's cursor must not lie to the status bar
    if (focusedGroupObj() !== g) return;
    emit("editor-status", {
      path: tab.path,
      line: e.position.lineNumber,
      column: e.position.column,
      language: tab.model!.getLanguageId(),
    });
  });
  ed.onDidFocusEditorText(() => {
    focusedGroup = g;
    for (const gr of groups) gr.rootEl.classList.toggle("focused-group", gr.id === g.id);
    emitActiveTabChanged(); // focus can move consumers (outline) to a different file
    emitEditorStatus(g);
  });
  if (!suppressNextFocus) ed.focus();
  suppressNextFocus = false;
  emitEditorStatus(g);
  void refreshGitGutter(tab);
}

// ---------------------------------------------------------------- breadcrumbs
// Path segments for every file/diff tab; TS/JS additionally get a symbol trail
// from the bundled TypeScript worker's navigation tree. Other languages keep
// path-only crumbs — no provider, no fake symbols.

interface NavItem {
  text: string;
  kind: string;
  spans?: Array<{ start: number; length: number }>;
  nameSpan?: { start: number; length: number };
  childItems?: NavItem[];
}

/** the subset of monaco's TS worker we rely on; its d.ts omits navtree */
interface NavTreeWorker {
  getNavigationTree(fileName: string): Promise<NavItem | null>;
}

/**
 * monaco 0.56 re-exports the TS language runtime at the module top level
 * (`export { …register.js as typescript }` in editor.main.js); the old
 * `languages.typescript` is a `{deprecated: true}` stub and the navtree
 * method is missing from the d.ts. No runtime check is possible against a
 * worker proxy — assert the two members we call, at one named boundary.
 */
interface TsRuntimeNamespace {
  getTypeScriptWorker(): Promise<(uri: monaco.Uri) => Promise<NavTreeWorker>>;
  /** JS models activate only the JavaScript mode — its worker is separate */
  getJavaScriptWorker(): Promise<(uri: monaco.Uri) => Promise<NavTreeWorker>>;
}

const tsRuntimeNs: TsRuntimeNamespace | undefined =
  (monaco as unknown as { typescript?: TsRuntimeNamespace }).typescript;

let crumbTimer: number | undefined;
/**
 * Cold-worker resilience: the first navtree ask after app start can time out
 * while the TS mode is still booting. Instead of waiting for the next cursor
 * move, failed asks retry on a short backoff (bounded) keyed to the tab; any
 * fresh schedule (cursor move / tab switch) resets the ladder.
 */
const TRAIL_RETRY_DELAYS_MS = [500, 1000, 2000, 4000];
let trailRetry: { key: string; attempt: number } | null = null;

/** does this tab's language get a symbol trail? (auto mode shows crumbs only then) */
function hasSymbolTrail(tab: EditorTab): boolean {
  if (tab.kind !== "file" || !tab.model) return false;
  const lang = tab.model.getLanguageId();
  return lang === "typescript" || lang === "javascript";
}

/** Re-render every group's crumb bar (settings change applies live). */
export function refreshCrumbs(): void {
  for (const g of groups) {
    const tab = g.active ? g.tabs.find((t) => t.key === g.active) ?? null : null;
    renderCrumbs(g, tab);
  }
}

function renderCrumbs(g: EditorGroup, tab: EditorTab | null) {
  const c = g.crumbsEl;
  clear(c);
  const mode = state.settings.breadcrumbs;
  const visible =
    tab && tab.kind !== "image" &&
    (mode === "on" || (mode === "auto" && hasSymbolTrail(tab)));
  if (!tab || !visible) {
    c.style.display = "none";
    return;
  }
  c.style.display = "";
  const parts = relPath(tab.path).split(/[\\/]/).filter(Boolean);
  parts.forEach((p, i) => {
    if (i) c.append(el("span", { class: "crumb-sep", text: "›" }));
    c.append(
      el("button", {
        class: i === parts.length - 1 ? "crumb crumb-file" : "crumb",
        text: p,
        title: "Reveal in Explorer",
        onClick: () => revealInExplorer(tab.path),
      }),
    );
  });
  c.append(el("span", { class: "crumb-symbols", dataset: { key: tab.key } }));
  scheduleSymbolTrail(g, tab);
}

function scheduleSymbolTrail(g: EditorGroup, tab: EditorTab) {
  trailRetry = null; // a user-driven schedule restarts the retry ladder
  clearTimeout(crumbTimer);
  crumbTimer = window.setTimeout(() => void updateSymbolTrail(g, tab), 150);
}

/** One raced navtree fetch (worker may be cold — the caller owns retries). */
async function fetchNavTree(tab: EditorTab): Promise<NavItem | null> {
  if (tab.kind !== "file" || !tab.model || !tsRuntimeNs) return null;
  const lang = tab.model.getLanguageId();
  if (lang !== "typescript" && lang !== "javascript") return null;
  // Each language activates its own mode+worker; asking the TS worker about
  // a JS model rejects with "TypeScript not registered!". The accessor's
  // promise never SETTLES until the mode is set up (first-open race), so
  // race it against a timeout instead of hanging forever.
  const accessor = lang === "typescript"
    ? tsRuntimeNs.getTypeScriptWorker()
    : tsRuntimeNs.getJavaScriptWorker();
  const timeout = new Promise<never>((_, rej) => setTimeout(() => rej(new Error("worker timeout")), 3000));
  const getWorker = await Promise.race([accessor, timeout]);
  const client = await Promise.race([getWorker(tab.model.uri), timeout]);
  return Promise.race([client.getNavigationTree(tab.model.uri.toString()), timeout]);
}

async function updateSymbolTrail(g: EditorGroup, tab: EditorTab) {
  const holder = g.crumbsEl.querySelector<HTMLElement>(".crumb-symbols");
  if (!holder || holder.dataset.key !== tab.key) return;
  if (tab.kind !== "file" || !tab.model || !g.editor || g.mountedKey !== tab.key) return;
  const lang = tab.model.getLanguageId();
  if (lang !== "typescript" && lang !== "javascript") return;
  let tree: NavItem | null = null;
  try {
    tree = await fetchNavTree(tab);
  } catch (err) {
    // worker/mode not up yet — path-only crumbs now; retry on a bounded
    // backoff so a cold ts.worker still yields a trail without user input
    console.debug(`[crumbs] navtree unavailable: ${err instanceof Error ? err.message : String(err)}`);
    const attempt = trailRetry?.key === tab.key ? trailRetry.attempt : 0;
    if (attempt < TRAIL_RETRY_DELAYS_MS.length) {
      trailRetry = { key: tab.key, attempt: attempt + 1 };
      clearTimeout(crumbTimer);
      crumbTimer = window.setTimeout(() => void updateSymbolTrail(g, tab), TRAIL_RETRY_DELAYS_MS[attempt]);
    }
    return;
  }
  trailRetry = null;
  // async gap: the tab may have been switched away while the worker ran
  if (!tree || holder.dataset.key !== tab.key || g.mountedKey !== tab.key || !g.editor) return;
  const pos = g.editor.getPosition();
  if (!pos) return;
  const offset = tab.model.getOffsetAt(pos);
  const chain: NavItem[] = [];
  let level = tree.childItems ?? [];
  while (level.length) {
    const hit = level.find((it) => (it.spans ?? []).some((s) => offset >= s.start && offset <= s.start + s.length));
    if (!hit) break;
    chain.push(hit);
    level = hit.childItems ?? [];
  }
  clear(holder);
  chain.forEach((item, i) => {
    holder.append(el("span", { class: "crumb-sep", text: "›" }));
    const siblings = i === 0 ? tree!.childItems ?? [] : chain[i - 1].childItems ?? [];
    holder.append(
      el("button", {
        class: "crumb crumb-symbol",
        text: item.text,
        title: "Siblings…",
        onClick: (e) => {
          const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
          contextMenu(
            r.left,
            r.bottom + 4,
            siblings.map((s) => ({ label: s.text, action: () => jumpToNavItem(g, tab, s) })),
          );
        },
      }),
    );
  });
}

function jumpToNavItem(g: EditorGroup, tab: EditorTab, item: NavItem) {
  if (!g.editor || !tab.model || g.mountedKey !== tab.key) return;
  const span = item.nameSpan ?? item.spans?.[0];
  if (!span) return;
  const p = tab.model.getPositionAt(span.start);
  g.editor.setPosition(p);
  g.editor.revealPositionInCenter(p);
  g.editor.focus();
}

// ---------------------------------------------------------------- outline (side view)

/** flattened navtree node for the outline panel */
export interface OutlineNode {
  text: string;
  kind: string;
  depth: number;
  /** offset of the name (jump target) */
  jump: number;
  /** enclosing span for cursor highlight */
  start: number;
  end: number;
}

export interface OutlineSnapshot {
  path: string;
  /** true when the language has no symbol provider (honest empty state) */
  unsupported: boolean;
  nodes: OutlineNode[];
}

function flattenNav(items: NavItem[], depth: number, out: OutlineNode[]): void {
  for (const it of items) {
    const span = it.spans?.[0];
    if (!span) continue;
    out.push({
      text: it.text,
      kind: it.kind,
      depth,
      jump: it.nameSpan?.start ?? span.start,
      start: span.start,
      end: span.start + span.length,
    });
    if (it.childItems?.length) flattenNav(it.childItems, depth + 1, out);
  }
}

/** Outline of the active tab; null = no file tab. Throws while the worker is cold. */
export async function activeOutline(): Promise<OutlineSnapshot | null> {
  const tab = activeTab();
  if (!tab || tab.kind !== "file" || !tab.model) return null;
  const lang = tab.model.getLanguageId();
  if (lang !== "typescript" && lang !== "javascript") {
    return { path: tab.path, unsupported: true, nodes: [] };
  }
  const tree = await fetchNavTree(tab);
  const nodes: OutlineNode[] = [];
  if (tree?.childItems) flattenNav(tree.childItems, 0, nodes);
  return { path: tab.path, unsupported: false, nodes };
}

/** current cursor offset in the active file tab (outline highlight) */
export function activeCursorOffset(): { path: string; offset: number } | null {
  const g = focusedGroupObj();
  const tab = activeTab();
  if (!g || !tab || tab.kind !== "file" || !tab.model || !g.editor || g.mountedKey !== tab.key) return null;
  const pos = g.editor.getPosition();
  if (!pos) return null;
  return { path: tab.path, offset: tab.model.getOffsetAt(pos) };
}

/** jump the active editor to a model offset (outline click) */
export function jumpToOffset(offset: number): void {
  const g = focusedGroupObj();
  const tab = activeTab();
  if (!g || !tab || tab.kind !== "file" || !tab.model || !g.editor || g.mountedKey !== tab.key) return;
  const p = tab.model.getPositionAt(offset);
  g.editor.setPosition(p);
  g.editor.revealPositionInCenter(p);
  g.editor.focus();
}

function activateTab(g: EditorGroup, key: string) {
  g.active = key;
  noteMru(g, key);
  renderTabs(g);
  mountActive(g);
}

/** move `key` to the front of the group's MRU list */
function noteMru(g: EditorGroup, key: string) {
  const i = g.mru.indexOf(key);
  if (i === 0) return;
  if (i > 0) g.mru.splice(i, 1);
  g.mru.unshift(key);
}

// ---------------------------------------------------------------- open/close

export async function openFile(
  path: string,
  pos?: { line?: number; column?: number; selectLength?: number; focus?: boolean },
) {
  const key = normPath(path);
  if (pos?.focus === false) suppressNextFocus = true;
  const existing = findTab(key);
  if (existing) {
    focusedGroup = existing.group;
    activateTab(existing.group, key);
    revealPosition(pos);
    return;
  }

  const mime = imageMime(key);
  const g = focusedGroupObj();
  if (!g) return;

  if (mime) {
    try {
      const res = await window.ide.fs.readFile(key);
      const src = res.binary
        ? `data:${mime};base64,${res.content}`
        : `data:${mime};utf8,${encodeURIComponent(res.content)}`;
      const tab: EditorTab = {
        key, kind: "image", path: key, title: baseName(key),
        imageSrc: src, dirty: false, diskMtime: res.mtimeMs, savedVersionId: 0,
      };
      g.tabs.push(tab);
      activateTab(g, key);
    } catch (err) {
      toast(`Cannot open ${baseName(key)}: ${err instanceof Error ? err.message : err}`, { crit: true });
    }
    return;
  }

  try {
    const res = await window.ide.fs.readFile(key);
    if (res.binary) {
      toast(`${baseName(key)} is a binary file`, { crit: false });
      return;
    }
    const model = monaco.editor.createModel(res.content, languageForPath(key), monaco.Uri.file(key));
    const tab: EditorTab = {
      key, kind: "file", path: key, title: baseName(key),
      model, dirty: false, diskMtime: res.mtimeMs, savedVersionId: model.getAlternativeVersionId(),
    };
    model.onDidChangeContent(() => {
      const nowDirty = model.getAlternativeVersionId() !== tab.savedVersionId;
      if (nowDirty !== tab.dirty) {
        tab.dirty = nowDirty;
        renderGroupsHolding(tab);
      }
    });
    g.tabs.push(tab);
    activateTab(g, key);
    revealPosition(pos);
    noteRecentFile(key);
  } catch (err) {
    toast(`Cannot open ${baseName(key)}: ${err instanceof Error ? err.message : err}`, { crit: true });
  }
}

function revealPosition(pos?: { line?: number; column?: number; selectLength?: number }) {
  const ed = focusedGroupObj()?.editor;
  if (!pos?.line || !ed) return;
  const line = pos.line;
  const col = (pos.column ?? 0) + 1;
  ed.revealLineInCenter(line);
  if (pos.selectLength) {
    ed.setSelection(new monaco.Selection(line, col, line, col + pos.selectLength));
  } else {
    ed.setPosition({ lineNumber: line, column: col });
  }
  ed.focus();
}

export function openDiff(payload: DiffPayload) {
  const key = `diff:${payload.title}:${payload.path}`;
  const g = focusedGroupObj();
  if (!g) return;
  const existing = findTab(key);
  if (existing) {
    // refresh contents in every group viewing this diff
    existing.tab.diff = payload;
    focusedGroup = existing.group;
    for (const g of groups) if (g.mountedKey === key && g !== existing.group) mountActive(g);
    activateTab(existing.group, key);
    return;
  }
  const tab: EditorTab = {
    key, kind: "diff", path: payload.path, title: payload.title,
    diff: payload, dirty: false, diskMtime: 0, savedVersionId: 0,
  };
  g.tabs.push(tab);
  activateTab(g, key);
}

export async function closeTab(key: string, opts: { force?: boolean; group?: EditorGroup } = {}): Promise<boolean> {
  const inGroup = opts.group?.tabs.find((t) => t.key === key);
  const loc = inGroup && opts.group ? { group: opts.group, tab: inGroup } : findTab(key);
  if (!loc) return true;
  const { group, tab } = loc;

  // Shared across splits: only the LAST view closing can drop unsaved work.
  if (tab.dirty && !opts.force && viewCount(tab) === 1) {
    const ok = await confirmDialog({
      title: "Unsaved changes",
      message: `"${tab.title}" has unsaved changes. Close without saving?`,
      confirmLabel: "Close Anyway",
      danger: true,
    });
    if (!ok) return false;
  }

  const idx = group.tabs.indexOf(tab);
  group.tabs.splice(idx, 1);
  if (viewCount(tab) === 0) {
    tab.model?.dispose();
    gitDecorations.delete(tab.key);
  }

  const mi = group.mru.indexOf(key);
  if (mi >= 0) group.mru.splice(mi, 1);

  if (group.active === key) {
    // MRU successor when we have history; strip neighbor as fallback
    const next = group.tabs.find((t) => t.key === group.mru[0]) ?? group.tabs[Math.min(idx, group.tabs.length - 1)];
    group.active = next?.key ?? null;
  }

  // collapse an empty second group
  if (group.tabs.length === 0 && groups.length > 1) {
    removeGroup(group);
  } else {
    renderTabs(group);
    mountActive(group);
  }

  // EVO-31 debt: the last view of a source .md closing takes its preview along —
  // a preview of a gone buffer would keep stale content. Preview tabs are never
  // dirty, so force-close is prompt-free. (Deletes route here via handleDeleted.)
  if (tab.kind === "file" && viewCount(tab) === 0) {
    const pkey = `mdprev:${tab.key}`;
    for (const g of [...groups]) {
      if (g.tabs.some((t) => t.key === pkey)) void closeTab(pkey, { force: true, group: g });
    }
  }
  return true;
}

export async function closeActiveTab() {
  const g = focusedGroupObj();
  if (!g) return;
  if (g.active) {
    await closeTab(g.active, { group: g });
  } else if (groups.length > 1) {
    // Ctrl+W on a focused empty split group collapses it
    removeGroup(g);
  }
}

// ------------------------------------------------------- Ctrl+Tab switching

/** live MRU switcher session — exists only while Ctrl is held with the overlay up */
let switcher: { g: EditorGroup; order: string[]; idx: number; el: HTMLElement } | null = null;

/**
 * Ctrl+Tab / Ctrl+Shift+Tab. Default: most-recently-used order with a hold-Ctrl
 * overlay (release commits, Escape cancels). Strip-order cycling (EVO-29) is the
 * fallback when the setting is "strip" or the group has exactly 2 tabs — a
 * 2-tab MRU toggle IS the strip toggle, so the overlay earns nothing there.
 */
export function cycleTab(delta: 1 | -1) {
  const g = focusedGroupObj();
  if (!g || g.tabs.length < 2 || !g.active) return;
  if (switcher) {
    stepSwitcher(delta);
    return;
  }
  if (state.settings.tabSwitcher === "strip" || g.tabs.length === 2) {
    const idx = g.tabs.findIndex((t) => t.key === g.active);
    if (idx < 0) return;
    const next = g.tabs[(idx + delta + g.tabs.length) % g.tabs.length];
    activateTab(g, next.key);
    return;
  }
  openSwitcher(g, delta);
}

function openSwitcher(g: EditorGroup, delta: 1 | -1) {
  // MRU-known keys first (most recent first), then any strip stragglers
  const order = [
    ...g.mru.filter((k) => g.tabs.some((t) => t.key === k)),
    ...g.tabs.filter((t) => !g.mru.includes(t.key)).map((t) => t.key),
  ];
  if (order.length < 2) return;
  const idx = (delta + order.length) % order.length;
  const overlay = el("div", { class: "tab-switcher" });
  switcher = { g, order, idx, el: overlay };
  renderSwitcher();
  document.body.append(overlay);
  window.addEventListener("keyup", onSwitcherKeyUp, { capture: true });
  window.addEventListener("keydown", onSwitcherKeyDown, { capture: true });
  window.addEventListener("blur", cancelSwitcher);
}

function renderSwitcher() {
  if (!switcher) return;
  const { g, order, idx, el: overlay } = switcher;
  clear(overlay);
  const list = el("div", { class: "ts-list" });
  order.forEach((key, i) => {
    const tab = g.tabs.find((t) => t.key === key);
    if (!tab) return;
    const row = el(
      "div",
      {
        class: i === idx ? "ts-row selected" : "ts-row",
        onClick: () => {
          if (switcher) switcher.idx = i;
          commitSwitcher();
        },
      },
      tab.dirty ? el("span", { class: "tab-dirty", title: "Unsaved changes" }) : null,
      el("span", { class: "ts-title", text: tab.title }),
      el("span", { class: "ts-path", text: relPath(tab.path) }),
    );
    list.append(row);
  });
  overlay.append(list);
}

function stepSwitcher(delta: 1 | -1) {
  if (!switcher) return;
  switcher.idx = (switcher.idx + delta + switcher.order.length) % switcher.order.length;
  renderSwitcher();
}

function closeSwitcherOverlay() {
  if (!switcher) return;
  switcher.el.remove();
  switcher = null;
  window.removeEventListener("keyup", onSwitcherKeyUp, { capture: true });
  window.removeEventListener("keydown", onSwitcherKeyDown, { capture: true });
  window.removeEventListener("blur", cancelSwitcher);
}

function commitSwitcher() {
  if (!switcher) return;
  const { g, order, idx } = switcher;
  const key = order[idx];
  closeSwitcherOverlay();
  if (g.tabs.some((t) => t.key === key)) activateTab(g, key);
}

function cancelSwitcher() {
  closeSwitcherOverlay();
}

function onSwitcherKeyUp(e: KeyboardEvent) {
  if (e.key === "Control") commitSwitcher();
}

function onSwitcherKeyDown(e: KeyboardEvent) {
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    cancelSwitcher();
  }
}

/** Ctrl+1 / Ctrl+2: focus the Nth editor group (keyboard path to what a group click does). */
export function focusGroup(index: number) {
  const g = groups[index];
  if (!g || g === focusedGroupObj()) return;
  focusedGroup = g;
  for (const gr of groups) gr.rootEl.classList.toggle("focused-group", gr === g);
  g.editor?.focus();
  emitActiveTabChanged();
  emitEditorStatus(g); // status bar follows group focus even onto image/preview tabs
}

/** Ctrl+Shift+V: rendered-markdown preview of the active .md tab (refreshes on save/disk change). */
export async function openMarkdownPreview() {
  const src = activeTab();
  if (!src || src.kind !== "file" || !/\.(md|markdown)$/i.test(src.path)) {
    toast("Markdown preview: open a .md file first");
    return;
  }
  const key = `mdprev:${src.key}`;
  const existing = findTab(key);
  if (existing) {
    focusedGroup = existing.group;
    activateTab(existing.group, key);
    return;
  }
  const g = focusedGroupObj();
  if (!g) return;
  const tab: EditorTab = {
    key, kind: "mdprev", path: src.path, title: `Preview: ${src.title}`,
    preview: src.model?.getValue() ?? "", dirty: false, diskMtime: 0, savedVersionId: 0,
  };
  g.tabs.push(tab);
  activateTab(g, key);
}

/** refresh any open preview of `path` from the freshest source (open buffer, else disk) */
async function refreshMarkdownPreview(path: string) {
  const key = `mdprev:${normPath(path)}`;
  const holders = groups.filter((g) => g.tabs.some((t) => t.key === key));
  if (!holders.length) return;
  const prev = holders[0].tabs.find((t) => t.key === key)!;
  const srcTab = findTab(normPath(path));
  if (srcTab?.tab.model) {
    prev.preview = srcTab.tab.model.getValue();
  } else {
    try {
      const res = await window.ide.fs.readFile(normPath(path));
      if (res.binary) return;
      prev.preview = res.content;
    } catch {
      return;
    }
  }
  for (const g of holders) if (g.mountedKey === key) mountActive(g);
}

// ---------------------------------------------------------------- save

export async function saveTab(tab: EditorTab): Promise<boolean> {
  if (tab.kind !== "file" || !tab.model) return true;
  try {
    await window.ide.fs.writeFile(tab.path, tab.model.getValue());
    const st = await window.ide.fs.stat(tab.path);
    tab.diskMtime = st?.mtimeMs ?? Date.now();
    tab.savedVersionId = tab.model.getAlternativeVersionId();
    tab.dirty = false;
    renderGroupsHolding(tab);
    emit("user-saved", tab.path);
    emit("git-refresh", undefined);
    void refreshGitGutter(tab);
    return true;
  } catch (err) {
    toast(`Save failed: ${err instanceof Error ? err.message : err}`, { crit: true });
    return false;
  }
}

export async function saveActive() {
  const t = activeTab();
  if (t) await saveTab(t);
}

export async function saveAll() {
  for (const g of groups) for (const t of g.tabs) if (t.dirty) await saveTab(t);
}

// ---------------------------------------------------------------- split view

function makeGroup(): EditorGroup {
  const tabsEl = el("div", { class: "tabs" });
  const crumbsEl = el("div", { class: "editor-crumbs", style: { display: "none" } });
  const hostEl = el("div", { class: "editor-host" });
  const rootEl = el("div", { class: "editor-group" }, tabsEl, crumbsEl, hostEl);
  const g: EditorGroup = { id: groupSeq++, tabs: [], active: null, mru: [], tabsEl, crumbsEl, hostEl, rootEl, editor: null, diffEditor: null, mountedKey: null };

  // drop target for tab drag between groups
  rootEl.addEventListener("dragover", (e) => {
    if (e.dataTransfer?.types.includes("omp/tab")) e.preventDefault();
  });
  rootEl.addEventListener("drop", (e) => {
    const raw = e.dataTransfer?.getData("omp/tab");
    if (!raw) return;
    e.preventDefault();
    try {
      const { key, from } = JSON.parse(raw) as { key: string; from: number };
      moveTabToGroup(key, from, g.id);
    } catch {}
  });
  // middle-click close, delegated to the strip so re-renders can't orphan listeners
  tabsEl.addEventListener("auxclick", (e) => {
    if (e.button !== 1) return;
    const node = (e.target instanceof HTMLElement ? e.target : null)?.closest<HTMLElement>(".tab[data-key]");
    if (!node || !tabsEl.contains(node)) return;
    e.preventDefault();
    void closeTab(node.dataset.key!);
  });
  rootEl.addEventListener("mousedown", () => {
    focusedGroup = g;
    for (const gr of groups) gr.rootEl.classList.toggle("focused-group", gr.id === g.id);
    emitActiveTabChanged(); // cross-group focus change is a consumer-visible active-tab change
    emitEditorStatus(g); // status bar follows group focus even onto image/preview tabs
  });
  return g;
}

function moveTabToGroup(key: string, fromId: number, toId: number) {
  if (fromId === toId) return;
  const from = groups.find((g) => g.id === fromId);
  const to = groups.find((g) => g.id === toId);
  if (!from || !to) return;
  const idx = from.tabs.findIndex((t) => t.key === key);
  if (idx < 0) return;
  const [tab] = from.tabs.splice(idx, 1);
  const mi = from.mru.indexOf(key);
  if (mi >= 0) from.mru.splice(mi, 1);
  // target already shows this tab (split duplicate) → merge: the source view just closes
  if (!to.tabs.includes(tab)) to.tabs.push(tab);
  if (from.active === key) from.active = from.tabs.find((t) => t.key === from.mru[0])?.key ?? from.tabs[Math.min(idx, from.tabs.length - 1)]?.key ?? null;
  focusedGroup = to;
  if (from.tabs.length === 0 && groups.length > 1) removeGroup(from);
  else {
    renderTabs(from);
    mountActive(from);
  }
  activateTab(to, key);
}

/** Reorder `key` within its own group so it lands before/after `targetKey`. */
function reorderTab(g: EditorGroup, key: string, targetKey: string, before: boolean) {
  if (key === targetKey) return;
  const fromIdx = g.tabs.findIndex((t) => t.key === key);
  const targetIdx = g.tabs.findIndex((t) => t.key === targetKey);
  if (fromIdx < 0 || targetIdx < 0) return;
  const [tab] = g.tabs.splice(fromIdx, 1);
  let insertIdx = g.tabs.findIndex((t) => t.key === targetKey);
  if (!before) insertIdx++;
  g.tabs.splice(insertIdx, 0, tab);
  renderTabs(g);
}

function removeGroup(g: EditorGroup) {
  const idx = groups.indexOf(g);
  if (idx < 0) return;
  groups.splice(idx, 1);
  g.editor?.dispose();
  g.editor = null;
  g.diffEditor?.dispose();
  g.diffEditor = null;
  g.mountedKey = null;
  // defensive: a removed group is normally empty; dispose models no view holds anymore
  for (const t of g.tabs) {
    if (viewCount(t) === 0) {
      t.model?.dispose();
      gitDecorations.delete(t.key);
    }
  }
  g.rootEl.remove();
  if (focusedGroup === g) focusedGroup = groups[0] ?? null;
  for (const gr of groups) gr.rootEl.classList.toggle("focused-group", gr === focusedGroup);
  // per-group editors: the remaining group's widget is untouched — no re-mount needed
  emitActiveTabChanged();
  emit("relayout", undefined);
}

/** Ctrl+\: open a second group; the active tab is DUPLICATED into it (shared buffer, two views). */
export function splitEditor() {
  if (groups.length >= 2) {
    toast("Two editor groups max");
    return;
  }
  const src = focusedGroupObj();
  const g = makeGroup();
  groups.push(g);
  areaEl.append(g.rootEl);
  const active = src?.active ? src.tabs.find((t) => t.key === src.active) ?? null : null;
  if (active) {
    // same tab OBJECT — model, dirty state, and save identity are shared
    g.tabs.push(active);
    g.active = active.key;
  }
  focusedGroup = g;
  for (const gr of groups) gr.rootEl.classList.toggle("focused-group", gr === g);
  renderTabs(g);
  mountActive(g);
  emit("relayout", undefined);
}

// ---------------------------------------------------------------- editor commands

export function toggleWordWrap() {
  wordWrap = !wordWrap;
  for (const g of groups) g.editor?.updateOptions({ wordWrap: wordWrap ? "on" : "off" });
  toast(`Word wrap ${wordWrap ? "on" : "off"}`);
}

export function zoomFont(delta: number) {
  state.settings.fontSize = Math.max(9, Math.min(28, state.settings.fontSize + delta));
  for (const g of groups) {
    g.editor?.updateOptions({ fontSize: state.settings.fontSize });
    g.diffEditor?.updateOptions({ fontSize: state.settings.fontSize });
  }
  void window.ide.store.setSettings({ fontSize: state.settings.fontSize });
}

export function goToLine() {
  const ed = focusedGroupObj()?.editor;
  ed?.focus();
  ed?.trigger("ide", "editor.action.gotoLine", null);
}

export function findInFile() {
  const ed = focusedGroupObj()?.editor;
  ed?.focus();
  ed?.trigger("ide", "actions.find", null);
}

export function relayoutEditors() {
  for (const g of groups) {
    g.editor?.layout();
    g.diffEditor?.layout();
  }
}

// ---------------------------------------------------------------- git gutter

async function refreshGitGutter(tab: EditorTab) {
  if (tab.kind !== "file" || !tab.model || !state.root) return;
  const ranges = await window.ide.git.diffRanges(state.root, tab.path);
  if (tab.model.isDisposed()) return;
  const decorations: monaco.editor.IModelDeltaDecoration[] = ranges.map((r) => ({
    range: new monaco.Range(r.start, 1, r.kind === "deleted" ? r.start : r.start + r.count - 1, 1),
    options: {
      isWholeLine: true,
      linesDecorationsClassName:
        r.kind === "added" ? "gutter-added" : r.kind === "modified" ? "gutter-modified" : "gutter-deleted",
    },
  }));
  const old = gitDecorations.get(tab.key) ?? [];
  gitDecorations.set(tab.key, tab.model.deltaDecorations(old, decorations));
}

// ---------------------------------------------------------------- external changes

async function reconcileExternalChange(path: string) {
  const key = normPath(path);
  const loc = findTab(key);
  if (!loc || loc.tab.kind !== "file" || !loc.tab.model) return;
  const tab = loc.tab;
  const model = loc.tab.model;
  const st = await window.ide.fs.stat(key);
  if (!st || st.mtimeMs <= tab.diskMtime) return;

  const res = await window.ide.fs.readFile(key);
  if (res.binary) return;
  if (res.content === model.getValue()) {
    tab.diskMtime = res.mtimeMs;
    return;
  }

  if (!tab.dirty) {
    // Clean buffer: refresh silently, preserving each viewing editor's cursor.
    const views = groups
      .filter((g) => g.mountedKey === tab.key && g.editor)
      .map((g) => ({ g, pos: g.editor!.getPosition() }));
    model.setValue(res.content);
    tab.diskMtime = res.mtimeMs;
    tab.savedVersionId = model.getAlternativeVersionId();
    tab.dirty = false;
    for (const { g, pos } of views) {
      if (!pos) continue;
      g.editor!.setPosition(pos);
      g.editor!.revealPositionInCenterIfOutsideViewport(pos);
    }
    renderGroupsHolding(tab);
    void refreshGitGutter(tab);
    return;
  }

  // Dirty buffer: conflict prompt.
  const useDisk = await confirmDialog({
    title: "File changed on disk",
    message: `"${tab.title}" was modified outside the editor while you have unsaved changes. Load the disk version and lose your edits?`,
    confirmLabel: "Load From Disk",
    danger: true,
  });
  if (useDisk) {
    model.setValue(res.content);
    tab.diskMtime = res.mtimeMs;
    tab.savedVersionId = model.getAlternativeVersionId();
    tab.dirty = false;
    renderGroupsHolding(tab);
    void refreshGitGutter(tab);
  } else {
    tab.diskMtime = res.mtimeMs; // keep buffer; next save overwrites
  }
}

function handleDeleted(path: string) {
  const key = normPath(path);
  const first = findTab(key);
  if (!first) return;
  if (first.tab.dirty) {
    toast(`${first.tab.title} was deleted on disk — buffer kept`, { crit: true });
    return;
  }
  // close every split view of the file (force path never awaits — mutations are sync)
  for (const g of [...groups]) {
    if (g.tabs.some((t) => t.key === key)) void closeTab(key, { force: true, group: g });
  }
}

// ---------------------------------------------------------------- init

export function initEditorArea(container: HTMLElement) {
  areaEl = container;
  const g = makeGroup();
  groups.push(g);
  areaEl.append(g.rootEl);
  renderTabs(g);
  mountActive(g);

  on("open-file", (p) => void openFile(p.path, p));
  on("open-diff", (p) => openDiff(p));
  on("relayout", () => relayoutEditors());
  on("git-refresh", () => {
    const t = activeTab();
    if (t) void refreshGitGutter(t);
  });
  on("fs-changed", (changes) => {
    for (const c of changes) {
      if (c.type === "change" || c.type === "add") {
        // sequence: the preview reads the buffer AFTER reconcile settles it
        void reconcileExternalChange(c.path).then(() => refreshMarkdownPreview(c.path));
      } else if (c.type === "unlink") {
        handleDeleted(c.path);
      }
    }
  });
  on("user-saved", (path) => void refreshMarkdownPreview(path));

  window.addEventListener("resize", relayoutEditors);
  // relayout after css transitions on panels
  document.addEventListener("transitionend", (e) => {
    if ((e.target as HTMLElement).closest?.(".workbench")) relayoutEditors();
  });
}

/** Guard used by window close — returns true if OK to close. */
export function hasDirtyTabs(): boolean {
  return dirtyCount() > 0;
}
