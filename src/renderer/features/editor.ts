/**
 * Editor area: Monaco, tab groups, split view, diff views, image preview,
 * dirty tracking, git gutter decorations, external-change reconciliation.
 */

import * as monaco from "monaco-editor";
import { el, clear, svgIcon } from "../core/dom";
import { I } from "../core/icons";
import { on, emit } from "../core/bus";
import { state, baseName, languageForPath, imageMime, normPath, noteRecentFile } from "../core/state";
import { toast, confirmDialog } from "../core/ui";
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
  kind: "file" | "diff" | "image";
  path: string;
  title: string;
  model?: monaco.editor.ITextModel;
  diff?: DiffPayload;
  imageSrc?: string;
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
  tabsEl: HTMLElement;
  hostEl: HTMLElement;
  rootEl: HTMLElement;
}

// ---------------------------------------------------------------- module state

let areaEl: HTMLElement;
const groups: EditorGroup[] = [];
let focusedGroup = 0;
let editor: monaco.editor.IStandaloneCodeEditor | null = null;
let diffEditor: monaco.editor.IDiffEditor | null = null;
let currentMount: { group: number; key: string } | null = null;
let wordWrap = false;
/** one-shot: mountActive skips editor.focus() (tree clicks keep explorer focus) */
let suppressNextFocus = false;
let groupSeq = 0;

const gitDecorations = new Map<string, string[]>(); // path -> decoration ids

// ---------------------------------------------------------------- helpers

function findTab(key: string): { group: EditorGroup; tab: EditorTab; gi: number } | null {
  for (let gi = 0; gi < groups.length; gi++) {
    const tab = groups[gi].tabs.find((t) => t.key === key);
    if (tab) return { group: groups[gi], tab, gi };
  }
  return null;
}

function activeTab(): EditorTab | null {
  const g = groups[focusedGroup];
  if (!g || !g.active) return null;
  return g.tabs.find((t) => t.key === g.active) ?? null;
}

export function activeFilePath(): string | null {
  const t = activeTab();
  return t && t.kind === "file" ? t.path : null;
}

export function dirtyCount(): number {
  let n = 0;
  for (const g of groups) for (const t of g.tabs) if (t.dirty) n++;
  return n;
}

// ---------------------------------------------------------------- rendering

function renderTabs(g: EditorGroup) {
  clear(g.tabsEl);
  for (const tab of g.tabs) {
    const closeBtn = el("span", {
      class: "tab-close",
      onClick: (e) => {
        e.stopPropagation();
        void closeTab(tab.key);
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
          focusedGroup = g.id;
          activateTab(g, tab.key);
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

/** (Re)mount the appropriate widget into the group's host. */
function mountActive(g: EditorGroup) {
  const tab = g.active ? g.tabs.find((t) => t.key === g.active) : null;

  // Dispose current single-instance editors when they were mounted here.
  if (currentMount && currentMount.group === g.id) {
    editor?.dispose();
    editor = null;
    diffEditor?.dispose();
    diffEditor = null;
    currentMount = null;
  }
  clear(g.hostEl);

  if (!tab) {
    renderEmpty(g.hostEl);
    return;
  }

  const mount = el("div", { class: "monaco-mount" });
  g.hostEl.append(mount);

  if (tab.kind === "image") {
    mount.className = "image-preview";
    mount.append(el("img", {}) as HTMLImageElement);
    (mount.firstChild as HTMLImageElement).src = tab.imageSrc ?? "";
    return;
  }

  if (tab.kind === "diff") {
    const orig = monaco.editor.createModel(tab.diff!.original, tab.diff!.language ?? "plaintext");
    const mod = monaco.editor.createModel(tab.diff!.modified, tab.diff!.language ?? "plaintext");
    diffEditor = monaco.editor.createDiffEditor(mount, {
      theme: "reactor",
      readOnly: true,
      renderSideBySide: true,
      automaticLayout: false,
      fontFamily: "JetBrains Mono",
      fontSize: state.settings.fontSize,
      minimap: { enabled: false },
      scrollBeyondLastLine: false,
    });
    diffEditor.setModel({ original: orig, modified: mod });
    diffEditor.onDidDispose(() => {
      orig.dispose();
      mod.dispose();
    });
    currentMount = { group: g.id, key: tab.key };
    return;
  }

  // file
  editor = monaco.editor.create(mount, {
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
  currentMount = { group: g.id, key: tab.key };

  editor.onDidChangeCursorPosition((e) => {
    emit("editor-status", {
      path: tab.path,
      line: e.position.lineNumber,
      column: e.position.column,
      language: tab.model!.getLanguageId(),
    });
  });
  editor.onDidFocusEditorText(() => {
    focusedGroup = g.id;
    for (const gr of groups) gr.rootEl.classList.toggle("focused-group", gr.id === g.id);
  });
  if (!suppressNextFocus) editor.focus();
  suppressNextFocus = false;
  emit("editor-status", {
    path: tab.path,
    line: editor.getPosition()?.lineNumber ?? 1,
    column: editor.getPosition()?.column ?? 1,
    language: tab.model!.getLanguageId(),
  });
  void refreshGitGutter(tab);
}

function activateTab(g: EditorGroup, key: string) {
  g.active = key;
  renderTabs(g);
  mountActive(g);
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
    focusedGroup = existing.gi;
    activateTab(existing.group, key);
    revealPosition(pos);
    return;
  }

  const mime = imageMime(key);
  const g = groups[focusedGroup] ?? groups[0];

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
        const loc = findTab(tab.key);
        if (loc) renderTabs(loc.group);
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
  if (!pos?.line || !editor) return;
  const line = pos.line;
  const col = (pos.column ?? 0) + 1;
  editor.revealLineInCenter(line);
  if (pos.selectLength) {
    editor.setSelection(new monaco.Selection(line, col, line, col + pos.selectLength));
  } else {
    editor.setPosition({ lineNumber: line, column: col });
  }
  editor.focus();
}

export function openDiff(payload: DiffPayload) {
  const key = `diff:${payload.title}:${payload.path}`;
  const g = groups[focusedGroup] ?? groups[0];
  const existing = findTab(key);
  if (existing) {
    // refresh contents
    existing.tab.diff = payload;
    focusedGroup = existing.gi;
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

export async function closeTab(key: string, opts: { force?: boolean } = {}): Promise<boolean> {
  const loc = findTab(key);
  if (!loc) return true;
  const { group, tab } = loc;

  if (tab.dirty && !opts.force) {
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
  tab.model?.dispose();
  gitDecorations.delete(tab.key);

  if (group.active === key) {
    const next = group.tabs[Math.min(idx, group.tabs.length - 1)];
    group.active = next?.key ?? null;
  }

  // collapse an empty second group
  if (group.tabs.length === 0 && groups.length > 1) {
    removeGroup(group);
  } else {
    renderTabs(group);
    mountActive(group);
  }
  return true;
}

export async function closeActiveTab() {
  const g = groups[focusedGroup];
  if (g?.active) await closeTab(g.active);
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
    const loc = findTab(tab.key);
    if (loc) renderTabs(loc.group);
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
  const hostEl = el("div", { class: "editor-host" });
  const rootEl = el("div", { class: "editor-group" }, tabsEl, hostEl);
  const g: EditorGroup = { id: groupSeq++, tabs: [], active: null, tabsEl, hostEl, rootEl };

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
  rootEl.addEventListener("mousedown", () => {
    focusedGroup = g.id;
    for (const gr of groups) gr.rootEl.classList.toggle("focused-group", gr.id === g.id);
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
  to.tabs.push(tab);
  if (from.active === key) from.active = from.tabs[Math.min(idx, from.tabs.length - 1)]?.key ?? null;
  focusedGroup = to.id;
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
  g.rootEl.remove();
  if (focusedGroup === g.id) focusedGroup = groups[0]?.id ?? 0;
  const remaining = groups[0];
  if (remaining) {
    renderTabs(remaining);
    mountActive(remaining);
  }
  emit("relayout", undefined);
}

export function splitEditor() {
  if (groups.length >= 2) {
    toast("Two editor groups max");
    return;
  }
  const g = makeGroup();
  groups.push(g);
  areaEl.append(g.rootEl);
  renderTabs(g);
  mountActive(g);
  // Move the active tab over only when the source keeps at least one tab;
  // otherwise the source group would immediately collapse and undo the split.
  const src = groups[0];
  if (src.active && src.tabs.length > 1) moveTabToGroup(src.active, src.id, g.id);
  emit("relayout", undefined);
}

// ---------------------------------------------------------------- editor commands

export function toggleWordWrap() {
  wordWrap = !wordWrap;
  editor?.updateOptions({ wordWrap: wordWrap ? "on" : "off" });
  toast(`Word wrap ${wordWrap ? "on" : "off"}`);
}

export function zoomFont(delta: number) {
  state.settings.fontSize = Math.max(9, Math.min(28, state.settings.fontSize + delta));
  editor?.updateOptions({ fontSize: state.settings.fontSize });
  diffEditor?.updateOptions({ fontSize: state.settings.fontSize });
  void window.ide.store.setSettings({ fontSize: state.settings.fontSize });
}

export function goToLine() {
  editor?.focus();
  editor?.trigger("ide", "editor.action.gotoLine", null);
}

export function findInFile() {
  editor?.focus();
  editor?.trigger("ide", "actions.find", null);
}

export function relayoutEditors() {
  editor?.layout();
  diffEditor?.layout();
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
    // Clean buffer: refresh silently, preserving cursor.
    const pos = editor?.getPosition();
    model.setValue(res.content);
    tab.diskMtime = res.mtimeMs;
    tab.savedVersionId = model.getAlternativeVersionId();
    tab.dirty = false;
    if (pos && currentMount?.key === tab.key) {
      editor?.setPosition(pos);
      editor?.revealPositionInCenterIfOutsideViewport(pos);
    }
    renderTabs(loc.group);
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
    renderTabs(loc.group);
    void refreshGitGutter(tab);
  } else {
    tab.diskMtime = res.mtimeMs; // keep buffer; next save overwrites
  }
}

function handleDeleted(path: string) {
  const key = normPath(path);
  const loc = findTab(key);
  if (!loc) return;
  if (!loc.tab.dirty) void closeTab(key, { force: true });
  else toast(`${loc.tab.title} was deleted on disk — buffer kept`, { crit: true });
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
      if (c.type === "change" || c.type === "add") void reconcileExternalChange(c.path);
      else if (c.type === "unlink") handleDeleted(c.path);
    }
  });

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
