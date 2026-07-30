/**
 * Outline side view — a persistent symbol tree for the active editor tab.
 * Backed by the same ts.worker navtree as the breadcrumb symbol trail
 * (TS/JS only; other languages get an honest "no symbol provider" state).
 * Cursor-follows: the enclosing symbol highlights as the caret moves.
 */

import { el, clear } from "../core/dom";
import { on } from "../core/bus";
import {
  activeOutline,
  activeCursorOffset,
  jumpToOffset,
  type OutlineSnapshot,
} from "./editor";

let host: HTMLElement | null = null;
let listEl: HTMLElement | null = null;
let snapshot: OutlineSnapshot | null = null;
let refreshTimer: number | undefined;
let retryCount = 0;
/** the outline only polls/renders while its view is actually visible */
let visible = false;

const RETRY_DELAYS_MS = [500, 1000, 2000, 4000];

/** kind → single-character glyph in the app's mono data language */
const KIND_GLYPH: Record<string, string> = {
  class: "C",
  interface: "I",
  enum: "E",
  function: "ƒ",
  method: "ƒ",
  constructor: "ƒ",
  property: "◦",
  getter: "◦",
  setter: "◦",
  var: "◦",
  let: "◦",
  const: "◦",
  alias: "T",
  type: "T",
  module: "M",
};

export function initOutline(container: HTMLElement): void {
  host = container;
  on("editor-status", () => {
    if (!visible) return;
    // cursor move: cheap highlight now, debounced structure refresh after
    if (listEl) highlightCursor();
    scheduleRefresh();
  });
  // agent edits / external reloads change the model content
  on("agent-edited", () => visible && scheduleRefresh());
  on("user-saved", () => visible && scheduleRefresh());
  // tab opened/closed/switched/group collapsed — without this the panel goes
  // stale (e.g. keeps the last file's symbols after every tab is closed)
  on("active-tab-changed", () => visible && scheduleRefresh());
}

/** view-switch hook: the shell shows/hides the view and tells us */
export function setOutlineVisible(v: boolean): void {
  visible = v;
  if (v) {
    retryCount = 0;
    void refresh();
  }
}

function scheduleRefresh(): void {
  clearTimeout(refreshTimer);
  refreshTimer = window.setTimeout(() => void refresh(), 200);
}

async function refresh(): Promise<void> {
  if (!host || !visible) return;
  let snap: OutlineSnapshot | null;
  try {
    snap = await activeOutline();
  } catch {
    // cold worker — bounded retry, mirroring the crumb ladder
    if (retryCount < RETRY_DELAYS_MS.length) {
      const delay = RETRY_DELAYS_MS[retryCount++];
      clearTimeout(refreshTimer);
      refreshTimer = window.setTimeout(() => void refresh(), delay);
    }
    return;
  }
  retryCount = 0;
  snapshot = snap;
  render();
}

function render(): void {
  if (!host) return;
  clear(host);
  listEl = null;
  if (!snapshot) {
    host.append(empty("Open a file to see its outline."));
    return;
  }
  if (snapshot.unsupported) {
    host.append(empty("No symbol provider for this language — outline covers TS/JS."));
    return;
  }
  if (!snapshot.nodes.length) {
    host.append(empty("No symbols in this file."));
    return;
  }
  listEl = el("div", { class: "outline-list" });
  for (const n of snapshot.nodes) {
    listEl.append(
      el(
        "button",
        {
          class: "outline-row",
          style: { paddingLeft: `${8 + n.depth * 14}px` },
          dataset: { start: String(n.start), end: String(n.end) },
          title: `${n.kind} · ${n.text}`,
          onClick: () => jumpToOffset(n.jump),
        },
        el("span", { class: "outline-kind mono", text: KIND_GLYPH[n.kind] ?? "·" }),
        el("span", { class: "outline-name", text: n.text }),
      ),
    );
  }
  host.append(listEl);
  highlightCursor();
}

function empty(text: string): HTMLElement {
  return el("div", { class: "outline-empty dim", text });
}

/** mark the innermost row enclosing the cursor */
function highlightCursor(): void {
  if (!listEl || !snapshot) return;
  const cur = activeCursorOffset();
  if (!cur || cur.path !== snapshot.path) return;
  let best: HTMLElement | null = null;
  let bestSpan = Number.MAX_SAFE_INTEGER;
  for (const row of listEl.querySelectorAll<HTMLElement>(".outline-row")) {
    const s = Number(row.dataset.start);
    const e = Number(row.dataset.end);
    row.classList.remove("active");
    if (cur.offset >= s && cur.offset <= e && e - s < bestSpan) {
      best = row;
      bestSpan = e - s;
    }
  }
  if (best) {
    best.classList.add("active");
    best.scrollIntoView({ block: "nearest" });
  }
}
