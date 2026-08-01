/**
 * OMP IDE renderer entry: shell assembly, layout persistence, commands.
 */

import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/layout.css";
import "./styles/panels.css";
import "./styles/motion.css";
import "@xterm/xterm/css/xterm.css";
import "./styles/monaco-extras.css";

import { el, clear, svgIcon } from "./core/dom";
import { I } from "./core/icons";
import { on, emit } from "./core/bus";
import { state, baseName, normPath } from "./core/state";
import { registerCommand, installKeybindings } from "./core/commands";
import { t, applyLang, resolveLang } from "./core/i18n";
import { toast, choiceDialog, installDialogEscape } from "./core/ui";
import { initEditorArea, saveActive, saveAll, closeActiveTab, splitEditor, toggleWordWrap, zoomFont, goToLine, findInFile, hasDirtyTabs, relayoutEditors, activeFilePath, cycleTab, openMarkdownPreview, focusGroup } from "./features/editor";
import { initExplorer, loadWorkspaceTree, collapseAll } from "./features/explorer";
import { initTerminal, toggleTerminal, createTerminal } from "./features/terminal";
import { initSearchPanel, focusSearch } from "./features/search";
import { initGitPanel, refreshGit, switchBranch, onBranchChange } from "./features/git";
import { openPalette, invalidateFileCache } from "./features/palette";
import { initAgentPanel, startAgent, focusAgentInput } from "./features/agent";
import { openSessionHistory } from "./features/history";
import { initOutline, setOutlineVisible } from "./features/outline";
import { openSettingsDialog, applyAccent } from "./features/settings";
import { initMotion, applyMotion } from "./core/motion";
import { showWelcome } from "./features/welcome";
import { initRemote, createBeacon } from "./features/remote";
import { initModels, createModelChip, openModelsDialog, switchModelViaPicker, assignRoleViaPicker, setSessionThinkingViaPicker } from "./features/models";
import { openApiTester } from "./features/tester";
import { createNotificationBell } from "./features/notifications";
import "./styles/remote.css";
import "./styles/models.css";
import "./styles/mentions.css";
import "./styles/team.css";
import "./styles/enhance.css";
import type { LayoutState, OmpStatus } from "../shared/types";

type ViewId = "explorer" | "search" | "git" | "remote" | "outline";

// ---------------------------------------------------------------- shell DOM

const app = document.getElementById("app")!;

// title bar
const wsNameEl = el("span", { class: "ws-name" });
let winMax = false;
const minBtn = el("button", { class: "win-btn", title: t("chrome.minimize"), onClick: () => window.ide.win.minimize() });
minBtn.append(svgIcon(I.minimize));
const closeWinBtn = el("button", { class: "win-btn close", title: t("chrome.close"), onClick: () => window.ide.win.close() });
closeWinBtn.append(svgIcon(I.close));
const maxBtn = el("button", { class: "win-btn", title: t("chrome.maximize") });
maxBtn.append(svgIcon(I.maximize));
const titlebar = el(
  "div",
  { class: "titlebar" },
  el("div", { class: "grain-layer" }),
  el("div", { class: "app-mark" }, el("span", { class: "mark-core" }), el("span", { text: "OMP IDE" })),
  wsNameEl,
  el("span", { class: "titlebar-spacer" }),
  el("div", { class: "win-controls" },
    minBtn,
    (() => { maxBtn.addEventListener("click", () => window.ide.win.maximize()); return maxBtn; })(),
    closeWinBtn,
  ),
);
window.ide.win.onMaximized((max) => {
  winMax = max;
  clear(maxBtn);
  maxBtn.append(svgIcon(max ? I.restore : I.maximize));
  maxBtn.title = t(max ? "chrome.restore" : "chrome.maximize");
});

// activity bar
const viewButtons = new Map<string, HTMLElement>();
function actButton(id: string, icon: string, title: string, extraClass = ""): HTMLElement {
  const b = el("button", { class: `act-btn ${extraClass}`, title, onClick: () => switchView(id as ViewId | "agent") });
  b.append(svgIcon(icon));
  viewButtons.set(id, b);
  return b;
}
const settingsBtn = el("button", { class: "act-btn", title: t("chrome.settings"), onClick: () => openSettingsDialog() });
// chrome strings re-applied live on language switch (fix 4)
function applyChromeLang(): void {
  settingsBtn.title = t("chrome.settings");
  const titles: Record<string, string> = {
    explorer: t("view.explorer"),
    search: t("view.search"),
    outline: t("view.outline"),
    git: t("view.git"),
    remote: t("view.remote"),
    agent: t("chrome.agentView"),
  };
  for (const [vid, btn] of viewButtons) if (titles[vid]) btn.title = titles[vid];
  sideHandle.title = t("chrome.panelResize");
  sbBranch.title = t("chrome.sourceControl");
  sbAgent.title = t("chrome.agentStatus");
  sbIslandFile.title = t("chrome.goToLine");
  minBtn.title = t("chrome.minimize");
  closeWinBtn.title = t("chrome.close");
  maxBtn.title = t(winMax ? "chrome.restore" : "chrome.maximize");
  applyEditorStatus();
  registerAllCommands();
  if (activeView && activeView !== "agent") sideTitle.textContent = titles[activeView] ?? "";
}
settingsBtn.append(svgIcon(I.settings));
const activitybar = el(
  "div",
  { class: "activitybar" },
  actButton("explorer", I.files, t("view.explorer")),
  actButton("search", I.search, t("view.search")),
  actButton("outline", I.outline, t("view.outline")),
  actButton("git", I.git, t("view.git")),
  actButton("remote", I.zap, t("view.remote")),
  actButton("agent", I.agent, t("chrome.agentView"), "agent-act"),
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
const sideHandle = el("div", { class: "resize-h side-handle" });
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

// status bar — «Острова»: three glass islands on a void base (redesign §10).
// Left = git (click → SCM), center = file context (click → go-to-line),
// right = model chip + agent orb + beacon + bell (existing popovers).
const sbBranch = el("span", { class: "sb-item sb-branch", title: t("chrome.sourceControl"), onClick: () => switchView("git") });
const sbCursor = el("span", { class: "sb-item mono static", text: t("chrome.lnCol", 1, 1) });
const sbLang = el("span", { class: "sb-item static", text: "" });
const sbEnc = el("span", { class: "sb-item static", text: "UTF-8" });
const sbAgentOrb = el("span", { class: "orb idle" });
const sbAgentTool = el("span", { class: "sb-tool" });
const sbAgent = el("span", { class: "sb-item sb-agent", title: t("chrome.agentStatus"), onClick: () => switchView("agent") }, sbAgentOrb, sbAgentTool);
const sbBell = createNotificationBell();
const sbBeacon = createBeacon(() => switchView("remote"));
const sbModelChip = createModelChip();
const sbIslandGit = el("div", { class: "sb-island sbi-git" }, sbBranch);
const sbIslandFile = el(
  "div",
  { class: "sb-island sbi-file", title: t("chrome.goToLine"), onClick: () => goToLine() },
  sbCursor,
  sbLang,
  sbEnc,
);
const sbIslandSys = el("div", { class: "sb-island sbi-sys" }, sbModelChip, sbBeacon, sbAgent, sbBell);
const statusbar = el(
  "div",
  { class: "statusbar" },
  sbIslandGit,
  el("span", { class: "sb-spacer" }),
  sbIslandFile,
  el("span", { class: "sb-spacer" }),
  sbIslandSys,
);

app.append(titlebar, workbench, statusbar);

// ---------------------------------------------------------------- view switching

let activeView: ViewId | "agent" | null = null;

function switchView(id: ViewId | "agent") {
  // EVO-38 (+ run-7 agent-branch fix): revealing ANY view while zen hides its
  // panel would light the button over an invisible panel (silent no-op clicks)
  // — exit zen first, before the agent branch too. A press that exits zen is a
  // reveal, never a collapse-toggle: the user asked to SEE the view, even if it
  // was the active one before zen hid it.
  const exitedZen = state.zen;
  if (state.zen) toggleZen();

  if (id === "agent") {
    // toggle behavior: clicking agent icon shows/hides right panel
    if (!exitedZen && activeView === "agent" && !agentpanel.classList.contains("collapsed")) {
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
  if (!exitedZen && activeView === id && !sidepanel.classList.contains("collapsed")) {
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
    id === "explorer" ? t("view.explorer") : id === "search" ? t("view.search") :
    id === "outline" ? t("view.outline") :
    id === "git" ? t("view.git") : t("view.remote");
  clear(sideActions);
  if (id === "explorer") {
    const collapseBtn = el("button", { class: "icon-btn", title: t("chrome.collapseFolders"), onClick: () => collapseAll() });
    collapseBtn.append(svgIcon(I.collapse));
    const refreshBtn = el("button", { class: "icon-btn", title: t("chrome.refresh"), onClick: () => void loadWorkspaceTree() });
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
    // spec (remote-panel fix 1): min 280, max 560; live reflow during drag
    const w = Math.max(280, Math.min(560, sidepanel.offsetWidth + d));
    sidepanel.style.width = `${w}px`;
  },
  done: saveLayoutSoon,
});
// double-click the handle resets the panel to its default width (360 px)
sideHandle.addEventListener("dblclick", () => {
  sidepanel.style.width = "360px";
  relayoutEditors();
  emit("relayout", undefined);
  saveLayoutSoon();
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
  sidepanel.style.width = `${Math.max(280, Math.min(560, l.sideWidth))}px`;
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

// last editor status kept so applyChromeLang can re-render the file island live
let lastEdStatus: { line: number | null; column: number | null; language: string } | null = null;
function applyEditorStatus(): void {
  const s = lastEdStatus;
  if (!s) {
    // boot placeholder — before the first editor-status event
    sbCursor.textContent = t("chrome.lnCol", 1, 1);
    return;
  }
  // null line/column = non-text tab (image/preview/diff) or empty group — no fake cursor
  sbCursor.textContent = s.line !== null && s.column !== null ? t("chrome.lnCol", s.line, s.column) : "";
  sbLang.textContent = s.language === "plaintext" ? t("chrome.plainText") : s.language;
  // encoding is a text-buffer fact; an image or empty group has none
  sbEnc.style.display = s.line !== null ? "" : "none";
}
on("editor-status", (s) => {
  lastEdStatus = s;
  applyEditorStatus();
});

onBranchChange((branch, ahead, behind) => {
  clear(sbBranch);
  if (branch) {
    sbBranch.append(svgIcon(I.branch), el("span", { text: branch }));
    // ahead/behind counts ride the git island (↑ = unpushed, ↓ = unpulled)
    if (ahead > 0 || behind > 0) {
      const parts = [ahead > 0 ? `↑${ahead}` : "", behind > 0 ? `↓${behind}` : ""].filter(Boolean).join(" ");
      sbBranch.append(el("span", { class: "sb-sync mono", text: parts }));
    }
    sbIslandGit.style.display = "";
  } else {
    sbIslandGit.style.display = "none";
  }
});

// narrow-window island degradation: <1100px drops encoding, <950px drops language + truncates
function statusbarNarrow() {
  statusbar.classList.toggle("narrow-1", window.innerWidth < 1100);
  statusbar.classList.toggle("narrow-2", window.innerWidth < 950);
}
window.addEventListener("resize", statusbarNarrow);
statusbarNarrow();

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

// Titles come from t() — registerAllCommands re-runs on lang-changed so the
// palette always lists commands in the current language (Map.set overwrites).
function registerAllCommands(): void {
  reg("workbench.openFolder", t("cmd.openFolder"), () => {
    void window.ide.dialog.openFolder().then((p) => {
      if (!p) return;
      if (state.root) window.ide.win.openWorkspaceWindow(p);
      else void openWorkspace(p);
    });
  }, "Ctrl+K Ctrl+O");
  reg("workbench.quickOpen", t("cmd.quickOpen"), () => void openPalette("files"), "Ctrl+P");
  reg("workbench.commandPalette", t("cmd.commandPalette"), () => void openPalette("commands"), "Ctrl+Shift+P");
  reg("workbench.toggleTerminal", t("cmd.toggleTerminal"), () => toggleTerminal(), "Ctrl+`");
  reg("workbench.newTerminal", t("cmd.newTerminal"), () => void createTerminal());
  reg("workbench.settings", t("cmd.settings"), () => openSettingsDialog(), "Ctrl+,");
  reg("workbench.zen", t("cmd.zen"), () => toggleZen(), "Ctrl+K Z");
  reg("view.explorer", t("cmd.viewExplorer"), () => switchView("explorer"), "Ctrl+Shift+E");
  reg("view.search", t("cmd.viewSearch"), () => switchView("search"), "Ctrl+Shift+F");
  reg("view.outline", t("cmd.viewOutline"), () => switchView("outline"), "Ctrl+Shift+O");
  reg("view.git", t("cmd.viewGit"), () => switchView("git"), "Ctrl+Shift+G");
  reg("view.agent", t("cmd.viewAgent"), () => switchView("agent"), "Ctrl+Shift+A");
  reg("file.save", t("cmd.fileSave"), () => void saveActive(), "Ctrl+S");
  reg("file.saveAll", t("cmd.fileSaveAll"), () => void saveAll(), "Ctrl+K S");
  reg("editor.closeTab", t("cmd.closeTab"), () => void closeActiveTab(), "Ctrl+W");
  reg("editor.split", t("cmd.split"), () => splitEditor(), "Ctrl+\\");
  reg("editor.nextTab", t("cmd.nextTab"), () => cycleTab(1), "Ctrl+Tab");
  reg("editor.prevTab", t("cmd.prevTab"), () => cycleTab(-1), "Ctrl+Shift+Tab");
  reg("editor.focusGroup1", t("cmd.focusGroup1"), () => focusGroup(0), "Ctrl+1");
  reg("editor.focusGroup2", t("cmd.focusGroup2"), () => focusGroup(1), "Ctrl+2");
  reg("editor.wordWrap", t("cmd.wordWrap"), () => toggleWordWrap(), "Alt+Z");
  reg("editor.zoomIn", t("cmd.zoomIn"), () => zoomFont(1), "Ctrl+=");
  reg("editor.zoomOut", t("cmd.zoomOut"), () => zoomFont(-1), "Ctrl+-");
  reg("editor.goToLine", t("cmd.goToLine"), () => goToLine(), "Ctrl+G");
  reg("editor.find", t("cmd.find"), () => findInFile(), "Ctrl+F");
  reg("editor.markdownPreview", t("cmd.markdownPreview"), () => void openMarkdownPreview(), "Ctrl+Shift+V");
  reg("git.branch", t("cmd.gitBranch"), () => void switchBranch());
  reg("git.refresh", t("cmd.gitRefresh"), () => void refreshGit());
  reg("agent.interrupt", t("cmd.agentInterrupt"), () => void window.ide.omp.abort(), "Ctrl+Shift+X");
  reg("agent.newSession", t("cmd.agentNewSession"), () => void window.ide.omp.newSession());
  reg("agent.restart", t("cmd.agentRestart"), () => void window.ide.omp.restart());
  reg("agent.history", t("cmd.agentHistory"), () => openSessionHistory());
  reg("model.switch", t("cmd.modelSwitch"), () => switchModelViaPicker("palette"));
  reg("model.assignRole", t("cmd.modelAssignRole"), () => assignRoleViaPicker("palette"));
  reg("model.settings", t("cmd.modelSettings"), () => openModelsDialog());
  reg("model.apiTester", t("cmd.modelApiTester"), () => openApiTester());
  reg("thinking.session", t("cmd.thinkingSession"), () => setSessionThinkingViaPicker("palette"));
  reg("thinking.roleDefault", t("cmd.thinkingRole"), () => openModelsDialog());
  reg("explorer.reveal", t("cmd.revealExplorer"), () => {
    const p = activeFilePath();
    if (p) {
      switchView("explorer");
      emit("reveal-in-tree", p);
    }
  });
}
registerAllCommands();

installKeybindings();
installDialogEscape();

// ---------------------------------------------------------------- workspace lifecycle

let welcomeEl: HTMLElement | null = null;

async function openWorkspace(path: string, opts?: { resumeHistory?: boolean }) {
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
  // welcome «продолжить сессию агента»: open straight into the history browser
  if (opts?.resumeHistory) openSessionHistory();
}

window.ide.fs.onChanged((changes) => {
  emit("fs-changed", changes);
  invalidateFileCache();
});

let forceClose = false; // set once the user resolves the dirty-close dialog
window.addEventListener("beforeunload", (e) => {
  if (!forceClose && hasDirtyTabs()) {
    // Electron: sync confirm is unavailable; block and ask async, then force close.
    e.preventDefault();
    e.returnValue = false;
    void choiceDialog({
      title: t("ui.unsavedTitle"),
      message: t("ui.unsavedMsg"),
      choices: [
        { label: t("ui.closeAnyway"), value: "discard", danger: true },
        { label: t("ui.saveAndClose"), value: "save" },
      ],
    }).then(async (choice) => {
      if (choice === null) return; // Cancel aborts the close
      if (choice === "save") {
        await saveAll();
        if (hasDirtyTabs()) return; // a save failed (toasted); keep the window
      }
      forceClose = true; // addEventListener handlers survive `onbeforeunload = null`
      window.ide.win.close();
    });
  }
});

// ---------------------------------------------------------------- boot

async function boot() {
  state.settings = await window.ide.store.getSettings();
  applyAccent(state.settings.accent);
  initMotion();
  applyMotion(state.settings.motion, state.settings.reduceTransparency);
  // language: OS-locale default, global setting overrides (fix 4)
  applyLang(resolveLang(state.settings.uiLang));
  applyChromeLang();
  on("lang-changed", () => applyChromeLang());

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
    welcomeEl = await showWelcome(app, (path, opts) => void openWorkspace(path, opts));
  }
}

void boot();
