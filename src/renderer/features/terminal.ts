/**
 * Terminal region: xterm.js tabs over real PTYs, link handling, restart cards.
 */

import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { el, clear, svgIcon } from "../core/dom";
import { I } from "../core/icons";
import { on, emit } from "../core/bus";
import { state, normPath, joinPath } from "../core/state";
import { t as tr } from "../core/i18n";

interface TermTab {
  id: string;
  name: string;
  term: Terminal;
  fit: FitAddon;
  mountEl: HTMLElement;
  dead: boolean;
  exitCode?: number;
}

let regionEl: HTMLElement;
let headerEl: HTMLElement;
let bodyEl: HTMLElement;
const tabs: TermTab[] = [];
let active: string | null = null;
let seq = 0;

// Nebula ANSI palette: cyan/magenta anchors, readable pastels, solid indigo bg.
const XTERM_THEME = {
  background: "#0d0a1c",
  foreground: "#f0edff",
  cursor: "#e26bf5",
  cursorAccent: "#0a0817",
  selectionBackground: "#e26bf53d",
  black: "#211a41",
  red: "#fb4d6d",
  green: "#8bffb0",
  yellow: "#fbbf24",
  blue: "#7f9bff",
  magenta: "#e26bf5",
  cyan: "#34e0f7",
  white: "#9d95c9",
  brightBlack: "#645d8e",
  brightRed: "#ff8fa8",
  brightGreen: "#b8ffd1",
  brightYellow: "#fdd97a",
  brightBlue: "#a9bcff",
  brightMagenta: "#efa3fb",
  brightCyan: "#8aecfb",
  brightWhite: "#f0edff",
};

/** Matches path[:line[:col]] — used for clickable file links in output. */
const FILE_LINK_RE = /(?:[A-Za-z]:)?[\w~./\\-]+\.[A-Za-z0-9]{1,8}(?::\d+(?::\d+)?)?/;

function renderHeader() {
  clear(headerEl);
  for (const t of tabs) {
    headerEl.append(
      el(
        "div",
        {
          class: `term-tab${t.id === active ? " active" : ""}${t.dead ? " dead" : ""}`,
          onClick: () => activate(t.id),
        },
        el("span", { class: "term-dot" }),
        el("span", { text: t.name }),
        (() => {
          const b = el("span", {
            class: "icon-btn term-tab-x",
            title: tr("term.kill"),
            onClick: (e) => {
              e.stopPropagation();
              void killTab(t.id);
            },
          });
          b.append(svgIcon(I.close));
          return b;
        })(),
      ),
    );
  }
  const addBtn = el("button", {
    class: "icon-btn",
    title: tr("term.new"),
    onClick: () => void createTerminal(),
  });
  addBtn.append(svgIcon(I.plus));
  headerEl.append(addBtn);
  headerEl.append(el("span", { style: { flex: "1" } }));
  const hideBtn = el("button", {
    class: "icon-btn",
    title: tr("term.hide"),
    onClick: () => toggleTerminal(),
  });
  hideBtn.append(svgIcon(I.chevronDown));
  headerEl.append(hideBtn);
}

function activate(id: string) {
  active = id;
  for (const t of tabs) t.mountEl.classList.toggle("hidden", t.id !== id);
  renderHeader();
  requestAnimationFrame(() => {
    const t = tabs.find((x) => x.id === id);
    if (t && !t.dead) {
      t.fit.fit();
      void window.ide.pty.resize(t.id, t.term.cols, t.term.rows);
      t.term.focus();
    }
  });
}

export async function createTerminal(): Promise<void> {
  const id = `term_${++seq}_${Date.now()}`;
  const name = `pwsh ${seq}`;
  const mountEl = el("div", { class: "term-mount hidden" });
  bodyEl.append(mountEl);

  const term = new Terminal({
    fontFamily: "JetBrains Mono, monospace",
    fontSize: 12.5,
    theme: XTERM_THEME,
    cursorBlink: true,
    allowProposedApi: true,
    scrollback: 8000,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.loadAddon(
    new WebLinksAddon((_e, uri) => window.ide.win.openExternal(uri)),
  );
  term.open(mountEl);

  // File-path links: click opens in editor at line.
  term.registerLinkProvider({
    provideLinks(bufferLineNumber, callback) {
      const line = term.buffer.active.getLine(bufferLineNumber - 1);
      if (!line) return callback(undefined);
      const text = line.translateToString(true);
      const links: {
        range: { start: { x: number; y: number }; end: { x: number; y: number } };
        text: string;
        activate(): void;
      }[] = [];
      const re = new RegExp(FILE_LINK_RE.source, "g");
      let m: RegExpExecArray | null;
      while ((m = re.exec(text))) {
        const raw = m[0];
        if (!raw.includes(".") || raw.length < 4) continue;
        const start = m.index;
        links.push({
          range: {
            start: { x: start + 1, y: bufferLineNumber },
            end: { x: start + raw.length, y: bufferLineNumber },
          },
          text: raw,
          activate: () => void openFileLink(raw),
        });
      }
      callback(links.length ? links : undefined);
    },
  });

  const tab: TermTab = { id, name, term, fit, mountEl, dead: false };
  tabs.push(tab);
  activate(id);

  term.onData((data) => void window.ide.pty.write(id, data));
  term.onResize(({ cols, rows }) => void window.ide.pty.resize(id, cols, rows));

  const res = await window.ide.pty.create({
    id,
    cwd: state.root ?? "",
    shell: state.settings.terminalShell || undefined,
    cols: term.cols,
    rows: term.rows,
  });
  if (!res.ok) {
    markDead(tab, undefined, res.error);
    return;
  }
  requestAnimationFrame(() => {
    fit.fit();
    void window.ide.pty.resize(id, term.cols, term.rows);
  });
}

async function openFileLink(raw: string) {
  const m = raw.match(/^(.*?)(?::(\d+))?(?::(\d+))?$/);
  if (!m) return;
  let p = m[1];
  const line = m[2] ? parseInt(m[2], 10) : undefined;
  if (!/^(?:[A-Za-z]:)?[\\/]/.test(p) && state.root) p = joinPath(state.root, p);
  const st = await window.ide.fs.stat(normPath(p));
  if (st && !st.isDir) emit("open-file", { path: normPath(p), line });
}

function markDead(tab: TermTab, exitCode?: number, error?: string) {
  tab.dead = true;
  tab.exitCode = exitCode;
  renderHeader();
  const card = el(
    "div",
    { class: "restart-card" },
    el("div", { class: "rc-title", text: tr("term.exited") }),
    el("div", {
      class: "rc-detail",
      text: error ?? (exitCode !== undefined ? tr("term.exitCode", exitCode) : tr("term.ended")),
    }),
    el("button", {
      class: "btn btn-primary",
      text: tr("term.restart"),
      onClick: () => {
        void restartTab(tab);
      },
    }),
  );
  tab.mountEl.append(card);
}

async function restartTab(tab: TermTab) {
  tab.mountEl.querySelector(".restart-card")?.remove();
  tab.term.reset();
  tab.dead = false;
  renderHeader();
  const res = await window.ide.pty.create({
    id: tab.id,
    cwd: state.root ?? "",
    shell: state.settings.terminalShell || undefined,
    cols: tab.term.cols,
    rows: tab.term.rows,
  });
  if (!res.ok) {
    markDead(tab, undefined, res.error);
    return;
  }
  requestAnimationFrame(() => {
    tab.fit.fit();
    void window.ide.pty.resize(tab.id, tab.term.cols, tab.term.rows);
    tab.term.focus();
  });
}

async function killTab(id: string) {
  const idx = tabs.findIndex((t) => t.id === id);
  if (idx < 0) return;
  const [tab] = tabs.splice(idx, 1);
  await window.ide.pty.kill(id);
  tab.term.dispose();
  tab.mountEl.remove();
  if (active === id) {
    active = tabs[Math.min(idx, tabs.length - 1)]?.id ?? null;
    if (active) activate(active);
  }
  renderHeader();
  if (tabs.length === 0 && !regionEl.classList.contains("collapsed")) {
    toggleTerminal(); // hide empty region
  }
}

export function toggleTerminal() {
  const collapsed = regionEl.classList.toggle("collapsed");
  if (!collapsed) {
    if (tabs.length === 0) void createTerminal();
    else activate(active ?? tabs[0].id);
  }
  emit("relayout", undefined);
}

export function isTerminalVisible(): boolean {
  return !regionEl.classList.contains("collapsed");
}

/** Workspace switch: kill every PTY and drop all tabs (no prompts — shells are stateless). */
export async function disposeAllTerminals(): Promise<void> {
  for (const t of [...tabs]) {
    await window.ide.pty.kill(t.id);
    t.term.dispose();
    t.mountEl.remove();
  }
  tabs.length = 0;
  active = null;
  renderHeader();
  if (!regionEl.classList.contains("collapsed")) regionEl.classList.add("collapsed");
}

export function fitActiveTerminal() {
  const t = tabs.find((x) => x.id === active);
  if (t && !t.dead && isTerminalVisible()) {
    t.fit.fit();
    void window.ide.pty.resize(t.id, t.term.cols, t.term.rows);
  }
}

export function initTerminal(region: HTMLElement) {
  regionEl = region;
  headerEl = el("div", { class: "term-header" });
  bodyEl = el("div", { class: "term-body" });
  regionEl.append(headerEl, bodyEl);
  regionEl.classList.add("collapsed");
  renderHeader();

  window.ide.pty.onData((id, data) => {
    tabs.find((t) => t.id === id)?.term.write(data);
  });
  window.ide.pty.onExit(({ id, exitCode }) => {
    const tab = tabs.find((t) => t.id === id);
    if (tab && !tab.dead) markDead(tab, exitCode);
  });

  on("relayout", () => fitActiveTerminal());
  // persistent header: re-render tooltips on language switch
  on("lang-changed", () => renderHeader());
  window.addEventListener("resize", () => fitActiveTerminal());
}
