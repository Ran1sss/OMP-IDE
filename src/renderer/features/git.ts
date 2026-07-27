/**
 * Source control panel: staged/unstaged lists, commit, branch switch,
 * discard, diff view, log. Feeds tree badges via explorer.updateGitIndex.
 */

import { el, clear, svgIcon } from "../core/dom";
import { I } from "../core/icons";
import { on, emit } from "../core/bus";
import { state, baseName, dirName, joinPath, normPath, languageForPath } from "../core/state";
import { toast, confirmDialog, selectDialog } from "../core/ui";
import { updateGitIndex } from "./explorer";
import type { GitStatus, GitFileStatus, GitCommitInfo } from "../../shared/types";

let panelEl: HTMLElement;
let commitMsg: HTMLTextAreaElement;
let status: GitStatus = { isRepo: false, branch: "", ahead: 0, behind: 0, files: [] };
let branchListeners: ((branch: string) => void)[] = [];

export function onBranchChange(cb: (branch: string) => void) {
  branchListeners.push(cb);
}

// ---------------------------------------------------------------- data

let refreshTimer: number | undefined;

export async function refreshGit(): Promise<void> {
  if (!state.root) return;
  status = await window.ide.git.status(state.root);
  updateGitIndex(status.isRepo ? status.files : []);
  for (const cb of branchListeners) cb(status.isRepo ? status.branch : "");
  renderPanel();
}

function scheduleRefresh() {
  clearTimeout(refreshTimer);
  refreshTimer = window.setTimeout(() => void refreshGit(), 250);
}

// ---------------------------------------------------------------- actions

async function openFileDiff(f: GitFileStatus, staged: boolean) {
  if (!state.root) return;
  const abs = normPath(joinPath(state.root, f.path));
  const head = (await window.ide.git.headContent(state.root, f.path)) ?? "";
  let current = "";
  try {
    const res = await window.ide.fs.readFile(abs);
    current = res.binary ? "(binary)" : res.content;
  } catch {
    current = "";
  }
  emit("open-diff", {
    title: `${baseName(f.path)} (diff)`,
    path: abs,
    original: head,
    modified: current,
    language: languageForPath(f.path),
  });
}

async function discardFile(f: GitFileStatus) {
  if (!state.root) return;
  const ok = await confirmDialog({
    title: "Discard changes",
    message: `Discard all changes to "${f.path}"? This cannot be undone.`,
    confirmLabel: "Discard",
    danger: true,
  });
  if (!ok) return;
  try {
    await window.ide.git.discard(state.root, [f.path]);
    emit("git-refresh", undefined);
    toast(`Discarded changes to ${baseName(f.path)}`);
  } catch (err) {
    toast(`Discard failed: ${err instanceof Error ? err.message : err}`, { crit: true });
  }
}

async function doCommit() {
  if (!state.root) return;
  const msg = commitMsg.value.trim();
  if (!msg) {
    toast("Commit message is empty", { crit: true });
    commitMsg.focus();
    return;
  }
  const stagedCount = status.files.filter((f) => f.index !== " " && f.index !== "?").length;
  if (stagedCount === 0) {
    toast("No staged changes", { crit: true });
    return;
  }
  try {
    await window.ide.git.commit(state.root, msg);
    commitMsg.value = "";
    emit("git-refresh", undefined);
    toast("Committed");
  } catch (err) {
    toast(`Commit failed: ${err instanceof Error ? err.message : err}`, { crit: true });
  }
}

export async function switchBranch() {
  if (!state.root || !status.isRepo) return;
  const branches = await window.ide.git.branches(state.root);
  const pick = await selectDialog("Switch branch", branches.filter((b) => b !== status.branch));
  if (!pick) return;
  try {
    await window.ide.git.checkout(state.root, pick);
    emit("git-refresh", undefined);
    toast(`Switched to ${pick}`);
  } catch (err) {
    toast(`Checkout failed: ${err instanceof Error ? err.message : err}`, { crit: true });
  }
}

// ---------------------------------------------------------------- render

function codeClass(c: string): string {
  if (c === "M" || c === "R") return "m";
  if (c === "A") return "a";
  if (c === "D") return "d";
  return "u";
}

function fileRow(f: GitFileStatus, staged: boolean): HTMLElement {
  const code = staged ? f.index : f.worktree === " " ? f.index : f.worktree;
  const displayCode = code === "?" ? "U" : code;
  const rel = f.path;
  const dir = dirName(rel);

  const stageBtn = el("button", {
    class: "icon-btn",
    title: staged ? "Unstage" : "Stage",
    onClick: (e) => {
      e.stopPropagation();
      void (staged
        ? window.ide.git.unstage(state.root!, [f.path])
        : window.ide.git.stage(state.root!, [f.path])
      ).then(() => emit("git-refresh", undefined));
    },
  });
  stageBtn.append(svgIcon(staged ? I.unstage : I.stage));

  const actions = el("span", { class: "gf-actions" });
  if (!staged) {
    const discardBtn = el("button", {
      class: "icon-btn",
      title: "Discard changes",
      onClick: (e) => {
        e.stopPropagation();
        void discardFile(f);
      },
    });
    discardBtn.append(svgIcon(I.undo));
    actions.append(discardBtn);
  }
  actions.append(stageBtn);

  return el(
    "div",
    {
      class: "git-file-row",
      title: f.path,
      onClick: () => void openFileDiff(f, staged),
    },
    el("span", { class: `gf-code ${codeClass(displayCode)}`, text: displayCode }),
    el("span", { class: "gf-name", text: baseName(rel) }),
    dir !== rel ? el("span", { class: "gf-dir", text: dir }) : null,
    actions,
  );
}

function renderPanel() {
  if (!panelEl) return;
  clear(panelEl);

  if (!state.root) return;

  if (!status.isRepo) {
    panelEl.append(
      el(
        "div",
        { class: "git-empty" },
        svgIcon(I.git),
        el("div", { text: "This folder is not a git repository." }),
        el("button", {
          class: "btn btn-primary",
          text: "Initialize Repository",
          onClick: () =>
            void window.ide.git.init(state.root!).then(() => emit("git-refresh", undefined)),
        }),
      ),
    );
    return;
  }

  const stagedFiles = status.files.filter((f) => f.index !== " " && f.index !== "?");
  // untracked files carry "?" in the worktree column, so one test covers both
  const unstagedFiles = status.files.filter((f) => f.worktree !== " ");

  commitMsg = el("textarea", {
    class: "input",
    placeholder: `Message (commit on ${status.branch})`,
    onKeyDown: (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        void doCommit();
      }
    },
  }) as HTMLTextAreaElement;
  commitMsg.rows = 2;

  panelEl.append(
    el(
      "div",
      { class: "commit-box" },
      commitMsg,
      el("button", { class: "btn btn-primary", text: "Commit", onClick: () => void doCommit() }),
    ),
  );

  // staged
  if (stagedFiles.length) {
    const sec = el("div", { class: "git-section" });
    const unstageAll = el("button", {
      class: "icon-btn", title: "Unstage all",
      onClick: () =>
        void window.ide.git
          .unstage(state.root!, stagedFiles.map((f) => f.path))
          .then(() => emit("git-refresh", undefined)),
    });
    unstageAll.append(svgIcon(I.unstage));
    sec.append(
      el(
        "div",
        { class: "gs-head" },
        el("span", { text: "Staged Changes" }),
        el("span", { class: "gs-count", text: String(stagedFiles.length) }),
        el("span", { style: { flex: "1" } }),
        unstageAll,
      ),
    );
    const list = el("div", { class: "git-list" });
    for (const f of stagedFiles) list.append(fileRow(f, true));
    sec.append(list);
    panelEl.append(sec);
  }

  // unstaged
  const sec = el("div", { class: "git-section", style: { flex: "1", display: "flex", flexDirection: "column", minHeight: "0" } });
  const stageAll = el("button", {
    class: "icon-btn", title: "Stage all",
    onClick: () =>
      void window.ide.git
        .stage(state.root!, unstagedFiles.map((f) => f.path))
        .then(() => emit("git-refresh", undefined)),
  });
  stageAll.append(svgIcon(I.stage));
  sec.append(
    el(
      "div",
      { class: "gs-head" },
      el("span", { text: "Changes" }),
      el("span", { class: "gs-count", text: String(unstagedFiles.length) }),
      el("span", { style: { flex: "1" } }),
      unstagedFiles.length ? stageAll : null,
    ),
  );
  const list = el("div", { class: "git-list", style: { flex: "1", overflowY: "auto" } });
  if (unstagedFiles.length === 0 && stagedFiles.length === 0) {
    list.append(el("div", { class: "dimmer", text: "No changes", style: { padding: "8px 4px" } }));
  }
  for (const f of unstagedFiles) list.append(fileRow(f, false));
  sec.append(list);
  panelEl.append(sec);

  // recent commits
  void renderLog();
}

async function renderLog() {
  if (!state.root || !status.isRepo) return;
  const commits: GitCommitInfo[] = await window.ide.git.log(state.root, 12);
  if (!commits.length) return;
  const logEl = el("div", { class: "git-log" });
  logEl.append(el("div", { class: "gs-head", style: { marginBottom: "2px" } }, el("span", { text: "Recent Commits" })));
  for (const c of commits) {
    logEl.append(
      el(
        "div",
        { class: "git-log-row", title: `${c.subject}\n${c.author}` },
        el("span", { class: "gl-hash", text: c.shortHash }),
        el("span", { class: "gl-subj", text: c.subject }),
        el("span", { class: "gl-when", text: c.date }),
      ),
    );
  }
  panelEl.append(logEl);
}

// ---------------------------------------------------------------- init

export function initGitPanel(container: HTMLElement) {
  panelEl = container;
  panelEl.classList.add("git-panel");
  on("git-refresh", () => scheduleRefresh());
  on("fs-changed", () => scheduleRefresh());
}

