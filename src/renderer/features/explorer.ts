/**
 * Explorer: lazy tree, rename/create/delete/move, git badges, change pulses.
 */

import { el, clear, svgIcon } from "../core/dom";
import { I } from "../core/icons";
import { on, emit } from "../core/bus";
import { state, baseName, dirName, normPath, joinPath, SEP } from "../core/state";
import { toast, confirmDialog, contextMenu, inputDialog, errorText } from "../core/ui";
import { t } from "../core/i18n";
import { setMentionDragData } from "./mentions";
import type { DirEntry, GitFileStatus } from "../../shared/types";

interface TreeNode {
  path: string;
  name: string;
  isDir: boolean;
  expanded: boolean;
  loaded: boolean;
  children: TreeNode[];
  rowEl?: HTMLElement;
  childrenEl?: HTMLElement;
}

let rootNode: TreeNode | null = null;
let treeEl: HTMLElement;
/** anchor for ranges and keyboard ops; a member of selectedPaths whenever set */
let selectedPath: string | null = null;
const selectedPaths = new Set<string>();
/** paths → attribution of latest change, consumed by the pulse */
const pendingPulse = new Map<string, "agent" | "user" | "external">();
/** files the agent recently touched (attribution window) */
const agentTouched = new Map<string, number>();
/** files the user recently saved */
const userSaved = new Map<string, number>();
const ATTRIB_WINDOW_MS = 3000;

let gitIndex = new Map<string, GitFileStatus>();
let gitDirtyDirs = new Set<string>();

const CODE_EXT: Record<string, true> = {
  ts: true, tsx: true, js: true, jsx: true, mjs: true, cjs: true, py: true, rs: true,
  go: true, java: true, c: true, h: true, cpp: true, cs: true, rb: true, php: true,
  sh: true, ps1: true, lua: true, swift: true, kt: true,
};
const IMG_EXT: Record<string, true> = {
  png: true, jpg: true, jpeg: true, gif: true, webp: true, bmp: true, ico: true, svg: true, avif: true,
};

function iconFor(node: TreeNode): HTMLElement {
  if (node.isDir) return svgIcon(node.expanded ? I.folderOpen : I.folder);
  const i = node.name.lastIndexOf(".");
  const ext = i < 0 ? "" : node.name.slice(i + 1).toLowerCase();
  if (IMG_EXT[ext]) return svgIcon(I.fileImage);
  if (CODE_EXT[ext]) return svgIcon(I.fileCode);
  return svgIcon(I.file);
}

// ---------------------------------------------------------------- git badges

function gitBadge(path: string, isDir: boolean): HTMLElement | null {
  if (isDir) {
    return gitDirtyDirs.has(normPath(path))
      ? el("span", { class: "git-badge m", text: "●" })
      : null;
  }
  const st = gitIndex.get(normPath(path));
  if (!st) return null;
  const code = st.worktree !== " " ? st.worktree : st.index;
  if (code === "?" ) return el("span", { class: "git-badge u", text: "U" });
  if (code === "M") return el("span", { class: "git-badge m", text: "M" });
  if (code === "A") return el("span", { class: "git-badge a", text: "A" });
  if (code === "D") return el("span", { class: "git-badge d", text: "D" });
  if (code === "R") return el("span", { class: "git-badge a", text: "R" });
  return null;
}

export function updateGitIndex(files: GitFileStatus[]) {
  gitIndex = new Map();
  gitDirtyDirs = new Set();
  if (!state.root) return;
  for (const f of files) {
    const abs = normPath(joinPath(state.root, f.path));
    gitIndex.set(abs, f);
    let dir = dirName(abs);
    const rootN = normPath(state.root);
    while (dir.length >= rootN.length && dir !== dirName(dir)) {
      gitDirtyDirs.add(dir);
      if (dir === rootN) break;
      dir = dirName(dir);
    }
  }
  if (rootNode) rerenderVisible(rootNode);
}

// ---------------------------------------------------------------- selection

/** plain click / reveal: the entry becomes the whole selection and the anchor */
function selectSingle(path: string) {
  selectedPath = path;
  selectedPaths.clear();
  selectedPaths.add(path);
}

/** flattened visible tree order — the coordinate space for shift ranges */
function visiblePaths(): string[] {
  const out: string[] = [];
  const walk = (n: TreeNode) => {
    for (const c of n.children) {
      out.push(c.path);
      if (c.isDir && c.expanded) walk(c);
    }
  };
  if (rootNode?.expanded) walk(rootNode);
  return out;
}

/** selection in rendered order; entries hidden by a collapse keep set order at the end */
function orderedSelection(): string[] {
  const ordered = visiblePaths().filter((p) => selectedPaths.has(p));
  for (const p of selectedPaths) if (!ordered.includes(p)) ordered.push(p);
  return ordered;
}

/** drop entries nested inside another listed folder — the parent op covers them */
function topLevelOnly(paths: string[]): string[] {
  return paths.filter((p) => !paths.some((q) => q !== p && p.startsWith(q + SEP)));
}

// ---------------------------------------------------------------- rendering

function rowDepthPad(depth: number): string {
  return `${8 + depth * 12}px`;
}

function renderNode(node: TreeNode, depth: number): HTMLElement {
  const container = el("div");
  const st = gitIndex.get(normPath(node.path));
  const code = st ? (st.worktree !== " " ? st.worktree : st.index) : null;
  const gitCls = code === "?" ? " git-new" : code && code !== " " ? " git-dirty" : "";

  const row = el(
    "div",
    {
      class: `row${selectedPaths.has(node.path) ? " selected" : ""}${gitCls}`,
      style: { paddingLeft: rowDepthPad(depth) },
      title: node.path,
      dataset: { path: node.path },
      draggable: node !== rootNode,
      onClick: (e) => {
        if (e.ctrlKey || e.metaKey) {
          // toggle membership; the anchor follows the last toggled-on entry
          if (selectedPaths.has(node.path)) {
            selectedPaths.delete(node.path);
            if (selectedPath === node.path) {
              selectedPath = null;
              for (const p of selectedPaths) selectedPath = p;
            }
          } else {
            selectedPaths.add(node.path);
            selectedPath = node.path;
          }
          rerenderVisible(rootNode!);
          return;
        }
        if (e.shiftKey && selectedPath) {
          const order = visiblePaths();
          const a = order.indexOf(selectedPath);
          const b = order.indexOf(node.path);
          if (a >= 0 && b >= 0) {
            // contiguous range from the anchor; the anchor itself stays primary
            selectedPaths.clear();
            for (let i = Math.min(a, b); i <= Math.max(a, b); i++) selectedPaths.add(order[i]);
            rerenderVisible(rootNode!);
            return;
          }
        }
        selectSingle(node.path);
        if (node.isDir) {
          void toggleDir(node);
        } else {
          emit("open-file", { path: node.path, focus: false });
        }
        rerenderVisible(rootNode!);
      },
      onContextMenu: (e) => {
        e.preventDefault();
        // right-click keeps a multi-selection the row is part of; otherwise selects it
        if (!selectedPaths.has(node.path)) selectSingle(node.path);
        rerenderVisible(rootNode!);
        showNodeMenu(node, e.clientX, e.clientY);
      },
      onKeyDown: (e) => {
        if (e.key === "F2" && node !== rootNode) {
          e.preventDefault();
          startRename(node);
        }
      },
      onDragStart: (e) => {
        // dragging a selected row carries the whole selection
        const paths = selectedPaths.has(node.path) ? orderedSelection() : [node.path];
        e.dataTransfer?.setData("omp/path", paths.join("\n"));
        // mention payload rides along; existing drag-to-move is untouched
        setMentionDragData(e, paths.map((p) => ({ path: p, kind: findNode(p)?.isDir ? "folder" : "file" })));
      },
      onDragOver: (e) => {
        if (!node.isDir) return;
        if (e.dataTransfer?.types.includes("omp/path")) {
          e.preventDefault();
          row.classList.add("drop-target");
        }
      },
      onDragLeave: () => row.classList.remove("drop-target"),
      onDrop: (e) => {
        row.classList.remove("drop-target");
        const raw = e.dataTransfer?.getData("omp/path");
        if (raw && node.isDir) {
          e.preventDefault();
          e.stopPropagation();
          void moveAllInto(raw.split("\n"), node.path);
        }
      },
    },
    node.isDir
      ? el("span", { class: node.expanded ? "twisty open" : "twisty" }, svgIcon(I.chevron))
      : el("span", { class: "twisty" }),
    el("span", { class: "file-ico" }, iconFor(node)),
    el("span", { class: "label", text: node.name }),
    gitBadge(node.path, node.isDir),
  );
  row.tabIndex = 0;
  node.rowEl = row;
  container.append(row);

  const pulse = pendingPulse.get(normPath(node.path));
  if (pulse) {
    pendingPulse.delete(normPath(node.path));
    // hidden tree (view switched away): consume WITHOUT animating — display:none
    // never fires animationend, so the class would stick and replay on show
    if (treeEl.offsetParent) {
      const color =
        pulse === "agent" ? "var(--energy-25)" : pulse === "user" ? "var(--power-25)" : "var(--flare-15)";
      row.style.setProperty("--pulse-color", color);
      row.classList.add("pulse");
      // two animations ride the class (bg pulse + light sweep); remove only
      // when the longer body pulse ends, not on the sweep's earlier end event
      const onEnd = (e: AnimationEvent) => {
        if (e.animationName !== "row-pulse") return;
        row.classList.remove("pulse");
        row.removeEventListener("animationend", onEnd);
      };
      row.addEventListener("animationend", onEnd);
    }
  }

  if (node.isDir) {
    const childrenEl = el("div");
    node.childrenEl = childrenEl;
    if (node.expanded) {
      for (const child of node.children) childrenEl.append(renderNode(child, depth + 1));
    }
    container.append(childrenEl);
  }
  return container;
}

function rerenderVisible(root: TreeNode) {
  const hadFocus = treeEl.contains(document.activeElement);
  clear(treeEl);
  if (root.expanded) {
    for (const child of root.children) treeEl.append(renderNode(child, 0));
  }
  // Keep keyboard flow: re-focus the selected row so F2/Delete keep working.
  if (hadFocus && selectedPath) {
    const row = treeEl.querySelector<HTMLElement>(`[data-path="${CSS.escape(selectedPath)}"]`);
    row?.focus();
  }
}

async function toggleDir(node: TreeNode) {
  node.expanded = !node.expanded;
  if (node.expanded && !node.loaded) await loadChildren(node);
  rerenderVisible(rootNode!);
}

async function loadChildren(node: TreeNode) {
  try {
    const entries: DirEntry[] = await window.ide.fs.readDir(node.path);
    node.children = entries.filter((e) => e.name !== ".git").map((e) => ({
      path: normPath(e.path),
      name: e.name,
      isDir: e.isDir,
      expanded: false,
      loaded: false,
      children: [],
    }));
    node.loaded = true;
  } catch (err) {
    toast(t("explorer.readFailed", node.name, errorText(err)), { crit: true });
  }
}

// ---------------------------------------------------------------- mutations

function findNode(path: string, from: TreeNode | null = rootNode): TreeNode | null {
  if (!from) return null;
  const n = normPath(path);
  if (normPath(from.path) === n) return from;
  if (!n.startsWith(normPath(from.path) + SEP)) return null;
  for (const child of from.children) {
    const hit = findNode(n, child);
    if (hit) return hit;
  }
  return null;
}

function startRename(node: TreeNode) {
  const row = node.rowEl;
  if (!row) return;
  const label = row.querySelector(".label");
  if (!label) return;
  const input = el("input", {
    class: "rename-input",
    value: node.name,
    onKeyDown: (e) => {
      if (e.key === "Enter") void commit();
      if (e.key === "Escape") {
        // latch BEFORE rerendering: the rerender detaches the input, which fires
        // blur -> commit() -> a second rerender racing the first (F6 removeChild flake)
        done = true;
        rerenderVisible(rootNode!);
      }
      e.stopPropagation();
    },
    onBlur: () => void commit(),
  });
  let done = false;
  const commit = async () => {
    if (done) return;
    done = true;
    const newName = input.value.trim();
    if (!newName || newName === node.name) {
      rerenderVisible(rootNode!);
      return;
    }
    const newPath = joinPath(dirName(node.path), newName);
    try {
      await window.ide.fs.rename(node.path, newPath);
      // watcher events will refresh the tree
    } catch (err) {
      toast(t("explorer.renameFailed", errorText(err)), { crit: true });
      rerenderVisible(rootNode!);
    }
  };
  label.replaceWith(input);
  input.focus();
  const dot = node.name.lastIndexOf(".");
  input.setSelectionRange(0, node.isDir || dot <= 0 ? node.name.length : dot);
}

async function moveInto(srcPath: string, destDir: string) {
  const src = normPath(srcPath);
  const dest = normPath(destDir);
  // skip no-op moves and moves into the entry's own subtree
  if (dirName(src) === dest || src === dest || dest.startsWith(src + SEP)) return;
  try {
    await window.ide.fs.move(src, dest);
  } catch (err) {
    toast(t("explorer.moveFailed", errorText(err)), { crit: true });
  }
}

/** sequential multi-entry move; nested picks collapse to their top-level parents */
async function moveAllInto(srcPaths: string[], destDir: string) {
  for (const src of topLevelOnly(srcPaths.map(normPath))) await moveInto(src, destDir);
}

function showNodeMenu(node: TreeNode, x: number, y: number) {
  const dirForNew = node.isDir ? node.path : dirName(node.path);
  contextMenu(x, y, [
    ...(node.isDir
      ? []
      : [{ label: t("explorer.open"), action: () => emit("open-file", { path: node.path }) }]),
    { label: t("explorer.newFile"), action: () => void createIn(dirForNew, "file") },
    { label: t("explorer.newFolder"), action: () => void createIn(dirForNew, "folder") },
    { separator: true },
    { label: t("explorer.rename"), key: "F2", action: () => startRename(node) },
    { label: t("explorer.copyPath"), action: () => void navigator.clipboard.writeText(node.path) },
    { label: t("explorer.copyRelativePath"), action: () => void navigator.clipboard.writeText(node.path.slice((state.root?.length ?? 0) + 1)) },
    { separator: true },
    {
      label: t("explorer.delete"),
      key: "Del",
      danger: true,
      action: () => void deleteSelected(node),
    },
  ]);
}

async function createIn(dir: string, kind: "file" | "folder") {
  const name = await inputDialog({
    title: kind === "file" ? t("explorer.newFileTitle") : t("explorer.newFolderTitle"),
    placeholder: kind === "file" ? t("explorer.newFilePlaceholder") : t("explorer.newFolderPlaceholder"),
  });
  if (!name) return;
  const path = joinPath(dir, name);
  try {
    if (kind === "file") {
      await window.ide.fs.createFile(path);
      emit("open-file", { path });
    } else {
      await window.ide.fs.createDir(path);
    }
    const parent = findNode(dir);
    if (parent) {
      parent.expanded = true;
      await loadChildren(parent);
      rerenderVisible(rootNode!);
    }
  } catch (err) {
    toast(t("explorer.createFailed", errorText(err)), { crit: true });
  }
}

async function deleteNode(node: TreeNode) {
  const ok = await confirmDialog({
    title: node.isDir ? t("explorer.deleteFolderTitle") : t("explorer.deleteFileTitle"),
    message: t("explorer.deleteConfirm", node.name),
    confirmLabel: t("explorer.delete"),
    danger: true,
  });
  if (!ok) return;
  try {
    await window.ide.fs.trash(node.path);
  } catch (err) {
    toast(t("explorer.deleteFailed", errorText(err)), { crit: true });
  }
}

/** delete the whole selection when the target row is part of it */
async function deleteSelected(node: TreeNode) {
  if (!selectedPaths.has(node.path) || selectedPaths.size <= 1) return deleteNode(node);
  const count = selectedPaths.size;
  const ok = await confirmDialog({
    title: t("explorer.deleteManyTitle", count),
    message: t("explorer.deleteManyConfirm", count),
    confirmLabel: t("explorer.delete"),
    danger: true,
  });
  if (!ok) return;
  for (const p of topLevelOnly(orderedSelection())) {
    try {
      await window.ide.fs.trash(p);
    } catch (err) {
      toast(t("explorer.deleteFailed", errorText(err)), { crit: true });
    }
  }
}

// ---------------------------------------------------------------- watcher integration

async function refreshDirOf(path: string) {
  const dir = dirName(normPath(path));
  const node = findNode(dir);
  if (node?.loaded) {
    await loadChildren(node);
  } else if (normPath(dir) === normPath(state.root ?? "")) {
    if (rootNode) await loadChildren(rootNode);
  }
}

let refreshQueued = false;
function scheduleRerender() {
  if (refreshQueued) return;
  refreshQueued = true;
  requestAnimationFrame(() => {
    refreshQueued = false;
    if (rootNode) rerenderVisible(rootNode);
  });
}

// ---------------------------------------------------------------- pulse attribution

function noteAgentTouch(path: string) {
  const n = normPath(path);
  agentTouched.set(n, Date.now());
  // the watcher's fs event usually beats the tool-end carrying the edit:
  // retro-upgrade a pulse that was mis-attributed in that gap
  if (pendingPulse.has(n) && pendingPulse.get(n) !== "agent") pendingPulse.set(n, "agent");
  const row = findNode(n)?.rowEl;
  if (row?.classList.contains("pulse")) row.style.setProperty("--pulse-color", "var(--energy-25)");
}

function attributionFor(path: string): "agent" | "user" | "external" {
  const n = normPath(path);
  const now = Date.now();
  const a = agentTouched.get(n);
  if (a && now - a < ATTRIB_WINDOW_MS) return "agent";
  const u = userSaved.get(n);
  if (u && now - u < ATTRIB_WINDOW_MS) return "user";
  return "external";
}

// ---------------------------------------------------------------- init

export function initExplorer(container: HTMLElement) {
  treeEl = container;
  treeEl.classList.add("tree");

  treeEl.addEventListener("dragover", (e) => {
    if (e.dataTransfer?.types.includes("omp/path") && e.target === treeEl) {
      e.preventDefault();
      treeEl.classList.add("drop-root");
    }
  });
  treeEl.addEventListener("dragleave", (e) => {
    if (e.target === treeEl) treeEl.classList.remove("drop-root");
  });
  treeEl.addEventListener("drop", (e) => {
    treeEl.classList.remove("drop-root");
    const raw = e.dataTransfer?.getData("omp/path");
    if (raw && state.root && e.target === treeEl) {
      e.preventDefault();
      void moveAllInto(raw.split("\n"), state.root);
    }
  });
  treeEl.addEventListener("keydown", (e) => {
    if (e.key === "F2" && selectedPath) {
      const node = findNode(selectedPath);
      if (node) {
        e.preventDefault();
        startRename(node);
      }
    }
    if (e.key === "Delete" && selectedPath) {
      const node = findNode(selectedPath);
      if (node) {
        e.preventDefault();
        void deleteSelected(node);
      }
    }
    // keyboard navigation: arrows move selection through the visible order,
    // Enter opens, Right expands/steps in, Left collapses/steps out.
    const order = visiblePaths();
    if (!order.length) return;
    const moveTo = (path: string | undefined) => {
      if (!path) return;
      selectSingle(path);
      rerenderVisible(rootNode!);
      const row = findNode(path)?.rowEl;
      row?.scrollIntoView({ block: "nearest" });
      row?.focus(); // rerender rebuilt the rows; keep keydown flowing through the tree
    };
    const idx = selectedPath ? order.indexOf(selectedPath) : -1;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        moveTo(order[Math.min(idx + 1, order.length - 1)]);
        break;
      case "ArrowUp":
        e.preventDefault();
        moveTo(idx < 0 ? order[order.length - 1] : order[Math.max(idx - 1, 0)]);
        break;
      case "ArrowRight": {
        if (!selectedPath) break;
        const node = findNode(selectedPath);
        if (!node?.isDir) break;
        e.preventDefault();
        if (!node.expanded) {
          void toggleDir(node).then(() => moveTo(selectedPath!));
        } else {
          moveTo(order[idx + 1]); // first visible child
        }
        break;
      }
      case "ArrowLeft": {
        if (!selectedPath) break;
        const node = findNode(selectedPath);
        e.preventDefault();
        if (node?.isDir && node.expanded) {
          void toggleDir(node).then(() => moveTo(selectedPath!));
        } else {
          const parent = dirName(selectedPath);
          if (order.includes(parent)) moveTo(parent);
        }
        break;
      }
      case "Enter": {
        if (!selectedPath) break;
        const node = findNode(selectedPath);
        if (!node) break;
        e.preventDefault();
        if (node.isDir) {
          void toggleDir(node).then(() => moveTo(selectedPath!));
        } else {
          emit("open-file", { path: node.path, focus: true });
        }
        break;
      }
    }
  });

  on("user-saved", (path) => userSaved.set(normPath(path), Date.now()));
  on("agent-edited", (path) => noteAgentTouch(path));

  on("fs-changed", (changes) => {
    const dirsToRefresh = new Set<string>();
    for (const c of changes) {
      const n = normPath(c.path);
      if (c.type === "change") {
        pendingPulse.set(n, attributionFor(n));
      } else if (c.type === "add" || c.type === "addDir") {
        pendingPulse.set(n, attributionFor(n));
        dirsToRefresh.add(dirName(n));
      } else if (c.type === "unlink" || c.type === "unlinkDir") {
        dirsToRefresh.add(dirName(n));
        // deleted entries fall out of the selection
        selectedPaths.delete(n);
        if (selectedPath === n) selectedPath = null;
      }
    }
    void (async () => {
      for (const d of dirsToRefresh) await refreshDirOf(joinPath(d, "x"));
      scheduleRerender();
    })();
    emit("git-refresh", undefined);
  });

  on("reveal-in-tree", (path) => void reveal(path));
}

async function reveal(path: string) {
  if (!rootNode || !state.root) return;
  const n = normPath(path);
  const rootN = normPath(state.root);
  if (!n.startsWith(rootN + SEP)) return;
  const parts = n.slice(rootN.length + 1).split(SEP);
  let cur = rootNode;
  let curPath = rootN;
  for (let i = 0; i < parts.length - 1; i++) {
    curPath = joinPath(curPath, parts[i]);
    const next = findNode(curPath, cur);
    if (!next || !next.isDir) return;
    next.expanded = true;
    if (!next.loaded) await loadChildren(next);
    cur = next;
  }
  selectSingle(n);
  rerenderVisible(rootNode);
  const row = treeEl.querySelector(`[data-path="${CSS.escape(n)}"]`);
  row?.scrollIntoView({ block: "nearest" });
}

export async function loadWorkspaceTree() {
  if (!state.root) return;
  // skeleton shimmer while loading
  clear(treeEl);
  for (let i = 0; i < 8; i++) {
    const sk = el("div", { class: "skeleton" });
    sk.style.width = `${45 + ((i * 37) % 40)}%`;
    treeEl.append(sk);
  }
  rootNode = {
    path: normPath(state.root),
    name: baseName(state.root),
    isDir: true,
    expanded: true,
    loaded: false,
    children: [],
  };
  await loadChildren(rootNode);
  rerenderVisible(rootNode);
}

export function collapseAll() {
  if (!rootNode) return;
  for (const c of rootNode.children) collapseNode(c);
  rerenderVisible(rootNode);
}

function collapseNode(n: TreeNode) {
  n.expanded = false;
  for (const c of n.children) collapseNode(c);
}
