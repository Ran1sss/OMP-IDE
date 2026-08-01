/**
 * Source control panel: staged/unstaged lists, commit, branch switch,
 * discard, diff view, log. Feeds tree badges via explorer.updateGitIndex.
 */

import { el, clear, svgIcon } from "../core/dom";
import { I } from "../core/icons";
import { on, emit } from "../core/bus";
import { state, baseName, dirName, joinPath, normPath, languageForPath } from "../core/state";
import { toast, confirmDialog, selectDialog, formDialog, contextMenu, errorText } from "../core/ui";
import { updateGitIndex } from "./explorer";
import type { GitStatus, GitFileStatus, GitCommitInfo } from "../../shared/types";

let panelEl: HTMLElement;
let commitMsg: HTMLTextAreaElement;
/** Survives panel re-renders (stage/unstage/watcher refresh recreate the textarea). */
let pendingMsg = "";
let status: GitStatus = { isRepo: false, branch: "", ahead: 0, behind: 0, files: [] };
let branchListeners: ((branch: string, ahead: number, behind: number) => void)[] = [];

export function onBranchChange(cb: (branch: string, ahead: number, behind: number) => void) {
  branchListeners.push(cb);
}

// ---------------------------------------------------------------- data

let refreshTimer: number | undefined;

export async function refreshGit(): Promise<void> {
  if (!state.root) return;
  status = await window.ide.git.status(state.root);
  updateGitIndex(status.isRepo ? status.files : []);
  for (const cb of branchListeners) cb(status.isRepo ? status.branch : "", status.ahead, status.behind);
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
    live: true, // SCM diffs re-snapshot on save/git changes; agent-edit diffs stay frozen
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
    toast(`Discard failed: ${errorText(err)}`, { crit: true });
  }
}

async function doCommit() {
  if (!state.root) return;
  const msg = commitMsg.value.trim();
  if (!msg) {
    toast("Commit message is empty");
    commitMsg.focus();
    return;
  }
  const stagedCount = status.files.filter((f) => f.index !== " " && f.index !== "?").length;
  if (stagedCount === 0) {
    const unstaged = status.files.filter((f) => f.worktree !== " ");
    if (unstaged.length === 0) {
      toast("No changes to commit");
      return;
    }
    const ok = await confirmDialog({
      title: "Nothing staged",
      message: `Stage all ${unstaged.length} ${unstaged.length === 1 ? "change" : "changes"} and commit?`,
      confirmLabel: "Stage All & Commit",
      focusConfirm: true,
    });
    if (!ok) return;
    await window.ide.git.stage(state.root, unstaged.map((f) => f.path));
  }
  try {
    await window.ide.git.commit(state.root, msg);
    commitMsg.value = "";
    pendingMsg = "";
    emit("git-refresh", undefined);
    toast("Committed");
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    // Fresh machine / fresh repo: git refuses without user.name+email. Walk the
    // user through a repo-local identity instead of dumping 8 lines of stderr.
    if (/unable to auto-detect email|Please tell me who you are/i.test(text)) {
      const identity = await formDialog({
        title: "Git needs your identity",
        message: "This repository has no user.name/user.email. Set them for THIS repo to commit.",
        fields: [
          { key: "name", label: "Name", placeholder: "Your Name" },
          { key: "email", label: "Email", placeholder: "you@example.com" },
        ],
        confirmLabel: "Save & Commit",
      });
      if (!identity) return;
      const { name, email } = identity;
      try {
        await window.ide.git.setIdentity(state.root, name, email);
        await window.ide.git.commit(state.root, msg);
        commitMsg.value = "";
        pendingMsg = "";
        emit("git-refresh", undefined);
        toast("Committed");
      } catch (err2) {
        toast(`Commit failed: ${err2 instanceof Error ? err2.message : err2}`, { crit: true });
      }
      return;
    }
    toast(`Commit failed: ${text}`, { crit: true });
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
    toast(`Checkout failed: ${errorText(err)}`, { crit: true });
  }
}

// ---------------------------------------------------------------- render

function codeClass(c: string): string {
  if (c === "M" || c === "R") return "m";
  if (c === "A") return "a";
  if (c === "D") return "d";
  return "u";
}

/** Compact side-by-side line diff for the popover (LCS on lines, capped). */
function miniDiff(head: string, current: string): HTMLElement {
  const CAP = 400;
  const a = head.split("\n").slice(0, CAP);
  const b = current.split("\n").slice(0, CAP);
  // LCS table (small inputs — capped above)
  const n = a.length, m = b.length;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const left = el("div", { class: "md-col" });
  const right = el("div", { class: "md-col" });
  let i = 0, j = 0;
  const line = (txt: string, cls: string) => el("div", { class: `md-line ${cls}`, text: txt || "\u00a0" });
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      left.append(line(a[i], ""));
      right.append(line(b[j], ""));
      i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      left.append(line(a[i], "del"));
      right.append(line("", "pad"));
      i++;
    } else {
      left.append(line("", "pad"));
      right.append(line(b[j], "add"));
      j++;
    }
  }
  while (i < n) { left.append(line(a[i], "del")); right.append(line("", "pad")); i++; }
  while (j < m) { left.append(line("", "pad")); right.append(line(b[j], "add")); j++; }
  const body = el("div", { class: "md-body" }, left, right);
  // scroll lock: the two columns move as one
  left.addEventListener("scroll", () => { right.scrollTop = left.scrollTop; });
  return body;
}

/** Double-click: compact glass diff popover (read-only; Esc / click-outside closes). */
async function openDiffPopover(f: GitFileStatus) {
  if (!state.root) return;
  document.querySelector(".scm-diff-pop")?.remove();
  const abs = normPath(joinPath(state.root, f.path));
  const head = (await window.ide.git.headContent(state.root, f.path)) ?? "";
  let current = "";
  try {
    const res = await window.ide.fs.readFile(abs);
    current = res.binary ? "(binary)" : res.content;
  } catch { /* deleted file → empty right side */ }
  const pop = el(
    "div",
    { class: "scm-diff-pop" },
    el("div", { class: "md-head mono", text: f.path }),
    miniDiff(head, current),
  );
  panelEl.style.position = "relative";
  panelEl.append(pop);
  const dismiss = (e: MouseEvent) => {
    if (!pop.contains(e.target as Node)) close();
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") close();
  };
  const close = () => {
    pop.remove();
    window.removeEventListener("mousedown", dismiss, true);
    window.removeEventListener("keydown", onKey, true);
  };
  setTimeout(() => {
    window.addEventListener("mousedown", dismiss, true);
    window.addEventListener("keydown", onKey, true);
  });
}

/** Click/drag move with the 240ms horizontal slide, then the real git op. */
function moveFile(row: HTMLElement, f: GitFileStatus, toStaged: boolean) {
  row.classList.add(toStaged ? "slide-right" : "slide-left");
  const op = toStaged
    ? window.ide.git.stage(state.root!, [f.path])
    : window.ide.git.unstage(state.root!, [f.path]);
  // fire the op when the slide ends so the row lands in the other column on refresh
  setTimeout(() => void op.then(() => emit("git-refresh", undefined)), 240);
}

function fileRow(f: GitFileStatus, staged: boolean): HTMLElement {
  const code = staged ? f.index : f.worktree === " " ? f.index : f.worktree;
  const displayCode = code === "?" ? "U" : code;
  const rel = f.path;
  const dir = dirName(rel);

  const row = el(
    "div",
    {
      class: "git-file-row",
      title: f.path,
      tabIndex: 0,
      draggable: true,
      // single click = move to the other column (user act)
      onClick: () => moveFile(row, f, !staged),
      onDblClick: (e) => {
        e.preventDefault();
        void openDiffPopover(f);
      },
      onKeyDown: (e) => {
        if (e.key === "Enter") void openFileDiff(f, staged);      // full editor diff
        else if (e.key === " ") { e.preventDefault(); moveFile(row, f, !staged); }
      },
      onContextMenu: (e) => {
        e.preventDefault();
        contextMenu(e.clientX, e.clientY, [
          { label: "Open diff", action: () => void openFileDiff(f, staged) },
          { label: staged ? "Unstage" : "Stage", action: () => moveFile(row, f, !staged) },
          ...(!staged ? [{ label: "Discard changes", action: () => void discardFile(f) }] : []),
        ]);
      },
      onDragStart: (e) => {
        e.dataTransfer?.setData("omp/git-file", JSON.stringify({ path: f.path, staged }));
      },
    },
    el("span", { class: `gf-code ${codeClass(displayCode)}`, text: displayCode }),
    el("span", { class: "gf-name", text: baseName(rel) }),
    dir !== rel ? el("span", { class: "gf-dir", text: dir }) : null,
  );
  return row;
}

/** One kanban column (CHANGES or STAGED) with header, count, drop target. */
function column(title: string, files: GitFileStatus[], staged: boolean, bulk: HTMLElement | null): HTMLElement {
  const list = el("div", { class: "gc-list" });
  if (!files.length) list.append(el("div", { class: "dimmer gc-empty", text: staged ? "drop files to stage" : "clean" }));
  for (const f of files) list.append(fileRow(f, staged));
  const col = el(
    "div",
    {
      class: `git-col ${staged ? "gc-staged" : "gc-changes"}`,
      onDragOver: (e) => {
        if (!e.dataTransfer?.types.includes("omp/git-file")) return;
        e.preventDefault();
        col.classList.add("drop-hot");
      },
      onDragLeave: () => col.classList.remove("drop-hot"),
      onDrop: (e) => {
        col.classList.remove("drop-hot");
        const raw = e.dataTransfer?.getData("omp/git-file");
        if (!raw) return;
        e.preventDefault();
        try {
          const { path, staged: from } = JSON.parse(raw) as { path: string; staged: boolean };
          if (from === staged) return; // dropped on its own column
          const op = staged
            ? window.ide.git.stage(state.root!, [path])
            : window.ide.git.unstage(state.root!, [path]);
          void op.then(() => emit("git-refresh", undefined));
        } catch {}
      },
    },
    el(
      "div",
      { class: "gs-head" },
      el("span", { text: title }),
      el("span", { class: "gs-count", text: String(files.length) }),
      el("span", { style: { flex: "1" } }),
      bulk,
    ),
    list,
  );
  return col;
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
    onInput: () => {
      pendingMsg = commitMsg.value;
      renderCommitDisabled();
    },
    onKeyDown: (e) => {
      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        void doCommit();
      }
    },
  }) as HTMLTextAreaElement;
  commitMsg.value = pendingMsg;

  const stageAll = el("button", {
    class: "icon-btn", title: "Stage all",
    onClick: () =>
      void window.ide.git
        .stage(state.root!, unstagedFiles.map((f) => f.path))
        .then(() => emit("git-refresh", undefined)),
  });
  stageAll.append(svgIcon(I.stage));
  const unstageAll = el("button", {
    class: "icon-btn", title: "Unstage all",
    onClick: () =>
      void window.ide.git
        .unstage(state.root!, stagedFiles.map((f) => f.path))
        .then(() => emit("git-refresh", undefined)),
  });
  unstageAll.append(svgIcon(I.unstage));

  // «Поток слева-направо»: CHANGES → STAGED kanban; composer under STAGED.
  const commitBtn = el("button", { class: "btn btn-primary", text: "Commit", onClick: () => void doCommit() }) as HTMLButtonElement;
  const composer = el("div", { class: "commit-box" }, commitMsg, commitBtn);
  const stagedCol = column("STAGED", stagedFiles, true, stagedFiles.length ? unstageAll : null);
  stagedCol.append(composer);
  const flow = el(
    "div",
    { class: "git-flow" },
    column("CHANGES", unstagedFiles, false, unstagedFiles.length ? stageAll : null),
    stagedCol,
  );
  panelEl.append(flow);

  // commit gating: disabled while STAGED is empty or the message is blank
  const renderCommitDisabled = () => {
    commitBtn.disabled = stagedFiles.length === 0 || !commitMsg.value.trim();
  };
  renderCommitDisabled();

  // narrow panel (<300px): columns stack vertically (CSS class hook)
  flow.classList.toggle("stacked", panelEl.clientWidth < 300);

  // recent commits
  void renderLog();
}

let logToken = 0;

async function renderLog() {
  if (!state.root || !status.isRepo) return;
  const token = ++logToken;
  const commits: GitCommitInfo[] = await window.ide.git.log(state.root, 12);
  // A concurrent refresh may have re-rendered the panel while we awaited; only
  // the newest call may attach, and never twice (duplicate-section race).
  if (token !== logToken) return;
  panelEl.querySelector(".git-log")?.remove();
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

