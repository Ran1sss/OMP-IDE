/**
 * OMP IDE renderer entry: shell assembly, layout persistence, commands.
 */

import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/layout.css";
import "./styles/panels.css";
import "@xterm/xterm/css/xterm.css";
import "./styles/monaco-extras.css";

import { el, clear, svgIcon } from "./core/dom";
import { I } from "./core/icons";
import { on, emit } from "./core/bus";
import { state, baseName, normPath } from "./core/state";
import { registerCommand, installKeybindings } from "./core/commands";
import { toast, confirmDialog, installDialogEscape } from "./core/ui";
import { initEditorArea, saveActive, saveAll, closeActiveTab, splitEditor, toggleWordWrap, zoomFont, goToLine, findInFile, hasDirtyTabs, relayoutEditors, activeFilePath } from "./features/editor";
import { initExplorer, loadWorkspaceTree, collapseAll } from "./features/explorer";
import { initTerminal, toggleTerminal, createTerminal } from "./features/terminal";
import { initSearchPanel, focusSearch } from "./features/search";
import { initGitPanel, refreshGit, switchBranch, onBranchChange } from "./features/git";
import { openPalette, invalidateFileCache } from "./features/palette";
import { initAgentPanel, startAgent, focusAgentInput } from "./features/agent";
import { openSessionHistory } from "./features/history";
import { initOutline, setOutlineVisible } from "./features/outline";
import { openSettingsDialog, applyAccent } from "./features/settings";
import { showWelcome } from "./features/welcome";
import { initRemote, createBeacon } from "./features/remote";
import { initModels, createModelChip, openModelsDialog, switchModelViaPicker, assignRoleViaPicker, setSessionThinkingViaPicker } from "./features/models";
import { createNotificationBell } from "./features/notifications";
import "./styles/remote.css";
import "./styles/models.css";
import "./styles/mentions.css";
import "./styles/team.css";
import type { LayoutState, OmpStatus } from "../shared/types";

type ViewId = "explorer" | "search" | "git" | "remote" | "outline";

// ---------------------------------------------------------------- shell DOM

const app = document.getElementById("app")!;

// title bar
const wsNameEl = el("span", { class: "ws-name" });
const maxBtn = el("button", { class: "win-btn", title: "Maximize" });
maxBtn.append(svgIcon(I.maximize));
const titlebar = el(
  "div",
  { class: "titlebar" },
  el("div", { class: "app-mark" }, el("span", { class: "mark-core" }), el("span", { text: "OMP IDE" })),
  wsNameEl,
  el("span", { class: "titlebar-spacer" }),
  el("div", { class: "win-controls" },
    (() => { const b = el("button", { class: "win-btn", title: "Minimize", onClick: () => window.ide.win.minimize() }); b.append(svgIcon(I.minimize)); return b; })(),
    (() => { maxBtn.addEventListener("click", () => window.ide.win.maximize()); return maxBtn; })(),
    (() => { const b = el("button", { class: "win-btn close", title: "Close", onClick: () => window.ide.win.close() }); b.append(svgIcon(I.close)); return b; })(),
  ),
);
window.ide.win.onMaximized((max) => {
  clear(maxBtn);
  maxBtn.append(svgIcon(max ? I.restore : I.maximize));
});

// activity bar
const viewButtons = new Map<string, HTMLElement>();
function actButton(id: string, icon: string, title: string, extraClass = ""): HTMLElement {
  const b = el("button", { class: `act-btn ${extraClass}`, title, onClick: () => switchView(id as ViewId | "agent") });
  b.append(svgIcon(icon));
  viewButtons.set(id, b);
  return b;
}
const settingsBtn = el("button", { class: "act-btn", title: "Settings", onClick: () => openSettingsDialog() });
settingsBtn.append(svgIcon(I.settings));
const activitybar = el(
  "div",
  { class: "activitybar" },
  actButton("explorer", I.files, "Explorer"),
  actButton("search", I.search, "Search"),
  actButton("outline", I.outline, "Outline"),
  actButton("git", I.git, "Source Control"),
  actButton("remote", I.zap, "Remote Control Center"),
  actButton("agent", I.agent, "OMP Agent", "agent-act"),
  el("span", { class: "act-spacer" }),
  settingsBtn,
);

// side panel with three stacked views
const sideTitle = el("span", { class: "panel-header" });
const sideActions = el("span", { class: "actions" });
const explorerView = el("div", { style: { display: "flex", flexDirection: "column", flex: "1", minHeight: "0" } });
const searchView = el("div", { style: { display: "none", flexDirection: "column", flex: "1", minHeight: "0" } });
const outlineView = el("div", { style: { display: "none", flexDirection: "column", flex: "1", minHeight: "0" } });
const gitView = el("div", { style: { display: "none", flexDirection: "column", flex: "1", minHeight: "0" } });
const remoteView = el("div", { style: { display: "none", flexDirection: "column", flex: "1", minHeight: "0" } });
const sidepanel = el(
  "div",
  { class: "sidepanel" },
  el("div", { class: "panel-title" }, sideTitle, sideActions),
  explorerView,
  searchView,
  outlineView,
  gitView,
  remoteView,
);

// center: editor + terminal
const editorArea = el("div", { class: "editor-area" });
const termRegion = el("div", { class: "term-region" });
const centerCol = el("div", { class: "center-col" }, editorArea, termRegion);

// agent panel + energy seam
const seam = el("div", { class: "seam" });
const agentpanel = el("div", { class: "agentpanel" });

// resize handles
const sideHandle = el("div", { class: "resize-h" });
const agentHandle = el("div", { class: "resize-h" });
const termHandle = el("div", { class: "resize-v" });
centerCol.insertBefore(termHandle, termRegion);

const workbench = el(
  "div",
  { class: "workbench" },
  activitybar,
  sidepanel,
  sideHandle,
  centerCol,
  agentHandle,
  seam,
  agentpanel,
);

// status bar
const sbBranch = el("span", { class: "sb-item sb-branch", title: "Switch branch", onClick: () => void switchBranch() });
const sbCursor = el("span", { class: "sb-item mono static", text: "Ln 1, Col 1" });
const sbLang = el("span", { class: "sb-item static", text: "" });
const sbEnc = el("span", { class: "sb-item static", text: "UTF-8" });
const sbAgentOrb = el("span", { class: "orb idle" });
const sbAgentTool = el("span", { class: "sb-tool" });
const sbAgent = el("span", { class: "sb-item sb-agent", title: "Agent status", onClick: () => switchView("agent") }, sbAgentOrb, sbAgentTool);
const sbBell = createNotificationBell();
const sbBeacon = createBeacon(() => switchView("remote"));
const sbModelChip = createModelChip();
const statusbar = el(
  "div",
  { class: "statusbar" },
  sbBranch,
  el("span", { class: "sb-spacer" }),
  sbCursor,
  sbEnc,
  sbLang,
  sbModelChip,
  sbBeacon,
  sbAgent,
  sbBell,
);

app.append(titlebar, workbench, statusbar);

// ---------------------------------------------------------------- view switching

let activeView: ViewId | "agent" | null = null;

function switchView(id: ViewId | "agent") {
  if (id === "agent") {
    // toggle behavior: clicking agent icon shows/hides right panel
    if (activeView === "agent" && !agentpanel.classList.contains("collapsed")) {
      agentpanel.classList.add("collapsed");
      viewButtons.get("agent")?.classList.remove("active");
      activeView = "explorer";
    } else {
      agentpanel.classList.remove("collapsed");
      viewButtons.get("agent")?.classList.add("active");
      activeView = "agent";
      focusAgentInput();
    }
    emit("relayout", undefined);
    saveLayoutSoon();
    return;
  }

  // side panel views
  if (activeView === id && !sidepanel.classList.contains("collapsed")) {
    sidepanel.classList.add("collapsed");
    viewButtons.get(id)?.classList.remove("active");
    if (id === "outline") setOutlineVisible(false);
    emit("relayout", undefined);
    saveLayoutSoon();
    return;
  }
  sidepanel.classList.remove("collapsed");
  for (const [vid, btn] of viewButtons) {
    if (vid !== "agent") btn.classList.toggle("active", vid === id);
  }
  explorerView.style.display = id === "explorer" ? "flex" : "none";
  searchView.style.display = id === "search" ? "flex" : "none";
  outlineView.style.display = id === "outline" ? "flex" : "none";
  gitView.style.display = id === "git" ? "flex" : "none";
  remoteView.style.display = id === "remote" ? "flex" : "none";
  sideTitle.textContent =
    id === "explorer" ? "Explorer" : id === "search" ? "Search" :
    id === "outline" ? "Outline" :
    id === "git" ? "Source Control" : "Remote Control";
  clear(sideActions);
  if (id === "explorer") {
    const collapseBtn = el("button", { class: "icon-btn", title: "Collapse folders", onClick: () => collapseAll() });
    collapseBtn.append(svgIcon(I.collapse));
    const refreshBtn = el("button", { class: "icon-btn", title: "Refresh", onClick: () => void loadWorkspaceTree() });
    refreshBtn.append(svgIcon(I.refresh));
    sideActions.append(collapseBtn, refreshBtn);
  }
  activeView = id;
  if (id === "search") focusSearch();
  if (id === "git") void refreshGit();
  setOutlineVisible(id === "outline");
  emit("relayout", undefined);
  saveLayoutSoon();
}

on("view-switch", (v) => switchView(v));

// ---------------------------------------------------------------- resize + layout persistence

function installResize(handle: HTMLElement, opts: { horizontal: boolean; apply: (delta: number) => void; done: () => void }) {
  handle.addEventListener("mousedown", (e) => {
    e.preventDefault();
    handle.classList.add("dragging");
    const start = opts.horizontal ? e.clientX : e.clientY;
    let last = start;
    const move = (ev: MouseEvent) => {
      const cur = opts.horizontal ? ev.clientX : ev.clientY;
      opts.apply(cur - last);
      last = cur;
      relayoutEditors();
    };
    const up = () => {
      handle.classList.remove("dragging");
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      opts.done();
      emit("relayout", undefined);
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  });
}

installResize(sideHandle, {
  horizontal: true,
  apply: (d) => {
    const w = Math.max(200, Math.min(480, sidepanel.offsetWidth + d));
    sidepanel.style.width = `${w}px`;
  },
  done: saveLayoutSoon,
});
installResize(agentHandle, {
  horizontal: true,
  apply: (d) => {
    const w = Math.max(280, Math.min(560, agentpanel.offsetWidth - d));
    agentpanel.style.width = `${w}px`;
  },
  done: saveLayoutSoon,
});
installResize(termHandle, {
  horizontal: false,
  apply: (d) => {
    const h = Math.max(100, Math.min(window.innerHeight - 260, termRegion.offsetHeight - d));
    termRegion.style.height = `${h}px`;
  },
  done: saveLayoutSoon,
});

let layoutTimer: number | undefined;
function saveLayoutSoon() {
  if (!state.root) return;
  clearTimeout(layoutTimer);
  layoutTimer = window.setTimeout(() => {
    const layout: LayoutState = {
      sideWidth: sidepanel.offsetWidth || 300,
      agentWidth: agentpanel.offsetWidth || 380,
      termHeight: termRegion.offsetHeight || 240,
      sideCollapsed: sidepanel.classList.contains("collapsed"),
      agentCollapsed: agentpanel.classList.contains("collapsed"),
      termCollapsed: termRegion.classList.contains("collapsed"),
      activeView: activeView ?? "explorer",
    };
    void window.ide.store.setLayout(state.root!, layout);
  }, 400);
}

async function restoreLayout() {
  if (!state.root) return;
  const l = await window.ide.store.getLayout(state.root);
  if (!l) return;
  sidepanel.style.width = `${Math.max(200, Math.min(480, l.sideWidth))}px`;
  agentpanel.style.width = `${Math.max(280, Math.min(560, l.agentWidth))}px`;
  termRegion.style.height = `${Math.max(100, l.termHeight)}px`;
  agentpanel.classList.toggle("collapsed", l.agentCollapsed);
  if (!l.termCollapsed) toggleTerminal();
  viewButtons.get("agent")?.classList.toggle("active", !l.agentCollapsed);
  // Apply the side view directly — switchView() toggles, which would undo boot's default.
  const view = l.activeView === "search" || l.activeView === "git" ? l.activeView : "explorer";
  if (activeView !== view) switchView(view);
  sidepanel.classList.toggle("collapsed", l.sideCollapsed);
  if (l.sideCollapsed) {
    for (const [vid, btn] of viewButtons) if (vid !== "agent") btn.classList.remove("active");
  }
}

// ---------------------------------------------------------------- status bar wiring

on("editor-status", (s) => {
  sbCursor.textContent = `Ln ${s.line}, Col ${s.column}`;
  sbLang.textContent = s.language === "plaintext" ? "Plain Text" : s.language;
});

onBranchChange((branch) => {
  clear(sbBranch);
  if (branch) {
    sbBranch.append(svgIcon(I.branch), el("span", { text: branch }));
    sbBranch.style.display = "";
  } else {
    sbBranch.style.display = "none";
  }
});

on("agent-status", (s: OmpStatus) => {
  sbAgentOrb.className = `orb ${s.state}`;
  sbAgentTool.textContent = s.state === "tool" && s.tool ? s.tool : "";
  const live = s.state === "thinking" || s.state === "tool";
  seam.classList.toggle("live", live);
});

// ---------------------------------------------------------------- zen mode

function toggleZen() {
  state.zen = !state.zen;
  app.classList.toggle("zen", state.zen);
  emit("relayout", undefined);
}

// ---------------------------------------------------------------- commands

function reg(id: string, title: string, handler: () => void, keybinding?: string, hidden = false) {
  registerCommand({ id, title, handler, keybinding, hidden });
}

reg("workbench.openFolder", "Open Folder…", () => {
  void window.ide.dialog.openFolder().then((p) => {
    if (!p) return;
    if (state.root) window.ide.win.openWorkspaceWindow(p);
    else void openWorkspace(p);
  });
}, "Ctrl+K Ctrl+O");
reg("workbench.quickOpen", "Go to File…", () => void openPalette("files"), "Ctrl+P");
reg("workbench.commandPalette", "Show All Commands", () => void openPalette("commands"), "Ctrl+Shift+P");
reg("workbench.toggleTerminal", "Toggle Terminal", () => toggleTerminal(), "Ctrl+`");
reg("workbench.newTerminal", "Terminal: New Terminal", () => void createTerminal());
reg("workbench.settings", "Open Settings", () => openSettingsDialog(), "Ctrl+,");
reg("workbench.zen", "Toggle Zen Mode", () => toggleZen(), "Ctrl+K Z");
reg("view.explorer", "View: Explorer", () => switchView("explorer"), "Ctrl+Shift+E");
reg("view.search", "View: Search", () => switchView("search"), "Ctrl+Shift+F");
reg("view.outline", "View: Outline", () => switchView("outline"), "Ctrl+Shift+O");
reg("view.git", "View: Source Control", () => switchView("git"), "Ctrl+Shift+G");
reg("view.agent", "View: OMP Agent", () => switchView("agent"), "Ctrl+Shift+A");
reg("file.save", "File: Save", () => void saveActive(), "Ctrl+S");
reg("file.saveAll", "File: Save All", () => void saveAll(), "Ctrl+K S");
reg("editor.closeTab", "Close Editor", () => void closeActiveTab(), "Ctrl+W");
reg("editor.split", "Split Editor Right", () => splitEditor(), "Ctrl+\\");
reg("editor.wordWrap", "Toggle Word Wrap", () => toggleWordWrap(), "Alt+Z");
reg("editor.zoomIn", "Editor: Zoom In", () => zoomFont(1), "Ctrl+=");
reg("editor.zoomOut", "Editor: Zoom Out", () => zoomFont(-1), "Ctrl+-");
reg("editor.goToLine", "Go to Line…", () => goToLine(), "Ctrl+G");
reg("editor.find", "Find in File", () => findInFile(), "Ctrl+F");
reg("git.branch", "Git: Switch Branch…", () => void switchBranch());
reg("git.refresh", "Git: Refresh", () => void refreshGit());
reg("agent.interrupt", "Agent: Interrupt", () => void window.ide.omp.abort(), "Ctrl+Shift+X");
reg("agent.newSession", "Agent: New Session", () => void window.ide.omp.newSession());
reg("agent.restart", "Agent: Restart Process", () => void window.ide.omp.restart());
reg("agent.history", "Agent: Session History…", () => openSessionHistory());
reg("model.switch", "Model: Switch…", () => switchModelViaPicker("palette"));
reg("model.assignRole", "Model: Assign Role…", () => assignRoleViaPicker("palette"));
reg("model.settings", "Model: Open Settings", () => openModelsDialog());
reg("thinking.session", "Thinking: Set Level… (this session)", () => setSessionThinkingViaPicker("palette"));
reg("thinking.roleDefault", "Thinking: Set Role Default…", () => openModelsDialog());
reg("explorer.reveal", "Reveal Active File in Explorer", () => {
  const p = activeFilePath();
  if (p) {
    switchView("explorer");
    emit("reveal-in-tree", p);
  }
});

installKeybindings();
installDialogEscape();

// ---------------------------------------------------------------- workspace lifecycle

let welcomeEl: HTMLElement | null = null;

async function openWorkspace(path: string) {
  state.root = normPath(path);
  await window.ide.store.addRecent(state.root);
  wsNameEl.textContent = "";
  wsNameEl.append(el("span", { class: "sep", text: "—" }), el("span", { text: baseName(state.root) }));
  document.title = `${baseName(state.root)} — OMP IDE`;

  welcomeEl?.remove();
  welcomeEl = null;

  await restoreLayout();
  await loadWorkspaceTree();
  await window.ide.fs.watch(state.root);
  invalidateFileCache();
  await refreshGit();
  await startAgent();
}

window.ide.fs.onChanged((changes) => {
  emit("fs-changed", changes);
  invalidateFileCache();
});

window.addEventListener("beforeunload", (e) => {
  if (hasDirtyTabs()) {
    // Electron: sync confirm is unavailable; block and ask async, then force close.
    e.preventDefault();
    e.returnValue = false;
    void confirmDialog({
      title: "Unsaved changes",
      message: "You have unsaved changes. Close anyway?",
      confirmLabel: "Close Anyway",
      danger: true,
    }).then((ok) => {
      if (ok) {
        window.onbeforeunload = null;
        window.ide.win.close();
      }
    });
  }
});

// ---------------------------------------------------------------- boot

async function boot() {
  state.settings = await window.ide.store.getSettings();
  applyAccent(state.settings.accent);

  initEditorArea(editorArea);
  initExplorer(explorerView);
  initSearchPanel(searchView);
  initOutline(outlineView);
  initGitPanel(gitView);
  initRemote(remoteView);
  initModels();
  initTerminal(termRegion);
  initAgentPanel(agentpanel);
  switchView("explorer");
  viewButtons.get("agent")?.classList.add("active");

  const params = new URLSearchParams(location.search);
  const ws = params.get("ws");
  if (ws) {
    await openWorkspace(ws);
  } else {
    welcomeEl = await showWelcome(app, (path) => void openWorkspace(path));
  }
}

void boot();
