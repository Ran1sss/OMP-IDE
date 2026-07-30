/**
 * Team Mode UI (spec: omp-ide-agent-team-prompt.md): deliberation feed,
 * plan approval gate (editable list + DAG), live team board with sleep/wake,
 * failure cards, verification report. Renders ONLY main-process team state
 * (`team:state`) — agents are never simulated here.
 *
 * Deletable: removing this module (and its two hooks in agent.ts) restores
 * the plain agent panel untouched.
 */

import { marked } from "marked";
import { el, clear } from "../core/dom";
import { toast, confirmDialog, formDialog, inputDialog } from "../core/ui";
import type { TeamAgent, TeamRunState, TeamSlice } from "../../shared/types";

let panelEl: HTMLElement;
let surfaceEl: HTMLElement;
let inputEl: HTMLTextAreaElement;
let toggleBtn: HTMLElement | null = null;

/** Team toggle armed: the NEXT send becomes a team goal */
let armed = false;
let run: TeamRunState | null = null;
let defaultPlaceholder = "";

/** feed length already rendered (incremental append) */
let feedRendered = 0;
let feedRunId = "";
let feedListEl: HTMLElement | null = null;
/** previous agent states — drives the wake materialize + edge pulse */
let prevAgentState: Record<string, string> = {};
let elapsedTimer: number | undefined;

const MARKER = "@@TEAM@@";

/**
 * Strip protocol marker lines from agent chat text (team run narration).
 * Separator lines (`---`/`***`/`___`) adjacent to a stripped marker are
 * dropped too — orphaned they render as a stack of bare <hr>s.
 */
export function stripTeamMarkers(text: string): string {
  if (!text.includes(MARKER)) return text;
  const lines = text.split("\n");
  const isMarker = lines.map((l) => l.trimStart().startsWith(MARKER));
  const isSep = lines.map((l) => /^(-{3,}|\*{3,}|_{3,})$/.test(l.trim()));
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (isMarker[i]) continue;
    if (isSep[i] && (isMarker[i - 1] || isMarker[i + 1])) continue;
    out.push(lines[i]);
  }
  return out.join("\n");
}

// ---------------------------------------------------------------- toggle + composer routing

export function createTeamToggle(): HTMLElement {
  toggleBtn = el("button", {
    class: "team-toggle",
    title: "Team mode: the next message becomes a team goal (deliberate → approve → build together)",
    text: "TEAM",
    onClick: () => {
      if (run && run.phase !== "done" && run.phase !== "stopped" && run.phase !== "stalled") {
        toast("A team run is active — stop or finish it first");
        return;
      }
      armed = !armed;
      toggleBtn!.classList.toggle("armed", armed);
      if (inputEl) inputEl.placeholder = armed ? "Give the team ONE goal…" : defaultPlaceholder;
    },
  });
  return toggleBtn;
}

/**
 * Called by the composer before the plain prompt path. Returns true when the
 * message was consumed by team mode (goal start or mid-run steering).
 */
export function teamConsumesPrompt(message: string): boolean {
  if (run) {
    if (run.phase === "probe" || run.phase === "deliberate") {
      void window.ide.team.steer(message);
      return true;
    }
    if (run.phase === "gate") {
      toast("Approve or discard the plan first");
      return true;
    }
    if (run.phase === "execute" || run.phase === "verify") {
      // "@Name message" targets one worker; anything else is a team note
      const m = /^@(\S+)\s+([\s\S]+)$/.exec(message);
      const worker = m ? run.agents.find((a) => a.kind === "worker" && a.name.toLowerCase() === m[1].toLowerCase()) : undefined;
      void window.ide.team.steer(worker ? m![2] : message, worker?.name);
      return true;
    }
    return false; // done/stopped/stalled → plain prompt works again
  }
  if (!armed) return false;
  armed = false;
  toggleBtn?.classList.remove("armed");
  void window.ide.team.start(message).then((r) => {
    if (!r.ok) toast(r.error ?? "Failed to start the team run", { crit: true });
  });
  return true;
}

// ---------------------------------------------------------------- state plumbing

export function initTeamSurface(opts: { panel: HTMLElement; input: HTMLTextAreaElement }): void {
  panelEl = opts.panel;
  inputEl = opts.input;
  defaultPlaceholder = inputEl.placeholder;
  surfaceEl = el("div", { class: "team-surface", style: { display: "none" } });
  // between the agent head and the chat (chat stays as the unified timeline)
  const chat = panelEl.querySelector(".agent-chat");
  if (chat) panelEl.insertBefore(surfaceEl, chat);
  else panelEl.append(surfaceEl);

  window.ide.team.onState((s) => applyState(s));
  void window.ide.team.getState().then((s) => applyState(s));
}

function applyState(s: TeamRunState | null): void {
  run = s;
  const live = !!s;
  panelEl.classList.toggle("team-live", live);
  surfaceEl.style.display = live ? "" : "none";
  if (!s) {
    clear(surfaceEl);
    feedListEl = null;
    feedRendered = 0;
    feedRunId = "";
    prevAgentState = {};
    clearInterval(elapsedTimer);
    elapsedTimer = undefined;
    if (inputEl && !armed) inputEl.placeholder = defaultPlaceholder;
    return;
  }
  if (inputEl) {
    inputEl.placeholder =
      s.phase === "probe" || s.phase === "deliberate" ? "note to planners…" :
      s.phase === "execute" || s.phase === "verify" ? "steer the team… (@Name targets one worker)" :
      defaultPlaceholder;
  }
  render();
}

// ---------------------------------------------------------------- helpers

function fmtElapsed(sinceMs: number): string {
  const s = Math.max(0, Math.floor((Date.now() - sinceMs) / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

/** longest-path layering for the DAG (layer 0 = roots) */
function layerSlices(slices: TeamSlice[]): Map<string, number> {
  const byId = new Map(slices.map((s) => [s.id, s]));
  const memo = new Map<string, number>();
  const depth = (id: string, seen: Set<string>): number => {
    if (memo.has(id)) return memo.get(id)!;
    if (seen.has(id)) return 0; // cycle guard — main validates, render must not hang
    seen.add(id);
    const s = byId.get(id);
    const d = !s || !s.deps.length
      ? 0
      : 1 + Math.max(...s.deps.filter((x) => byId.has(x)).map((x) => depth(x, seen)), -1);
    memo.set(id, d);
    return d;
  };
  for (const s of slices) depth(s.id, new Set());
  return memo;
}

function planStats(slices: TeamSlice[]): { tracks: number; contracts: number } {
  const layers = layerSlices(slices);
  const width = new Map<number, number>();
  for (const l of layers.values()) width.set(l, (width.get(l) ?? 0) + 1);
  let tracks = 1;
  for (const w of width.values()) tracks = Math.max(tracks, w);
  return { tracks, contracts: slices.filter((s) => s.contract && s.contract.trim()).length };
}

const ORB_BY_STATE: Record<string, string> = {
  deliberating: "thinking",
  working: "tool",
  sleeping: "idle",
  waking: "thinking",
  done: "idle",
  failed: "dead",
};

// ---------------------------------------------------------------- rendering

function render(): void {
  if (!run) return;
  const r = run;
  // The feed appends incrementally; everything else rebuilds (small DOM).
  if (feedRunId !== r.runId) {
    clear(surfaceEl);
    feedListEl = null;
    feedRendered = 0;
    feedRunId = r.runId;
    prevAgentState = {};
  }

  let head = surfaceEl.querySelector(".team-head") as HTMLElement | null;
  if (!head) {
    head = el("div", { class: "team-head" });
    surfaceEl.append(head);
  }
  renderHead(head, r);

  let body = surfaceEl.querySelector(".team-body") as HTMLElement | null;
  if (!body) {
    body = el("div", { class: "team-body" });
    surfaceEl.append(body);
  }

  if (r.didNotSurvive || r.phase === "stalled") renderStalled(body, r);
  else if (r.phase === "probe" || r.phase === "deliberate") renderDeliberation(body, r);
  else if (r.phase === "gate") renderGate(body, r);
  else renderBoard(body, r); // execute / verify / done / stopped

  renderFeed(r);
  armElapsedTicker(r);
}

function renderHead(head: HTMLElement, r: TeamRunState): void {
  clear(head);
  const phaseLabel: Record<string, string> = {
    probe: "probing capability",
    deliberate: `deliberating · round ${Math.max(1, r.round)}/${r.maxRounds}`,
    gate: "plan awaiting approval",
    execute: "building",
    verify: "verifying",
    done: "complete",
    stopped: "stopped",
    stalled: "stalled",
  };
  head.append(
    el("span", { class: "th-title", text: "TEAM" }),
    el("span", { class: "th-phase mono", text: phaseLabel[r.phase] ?? r.phase }),
  );
  if (r.solo) {
    head.append(el("span", { class: "th-solo mono", title: "Subagent probe failed — one agent plays the roles sequentially. Same pipeline, honest labels.", text: "solo fallback" }));
  }
  head.append(
    el("span", { class: "th-goal", title: r.goal, text: r.goal }),
    el("span", { style: { flex: "1" } }),
    r.phase === "done" || r.phase === "stopped" || r.phase === "stalled"
      ? el("button", { class: "btn btn-ghost th-btn", text: "Dismiss", onClick: () => void window.ide.team.clear() })
      : el("button", { class: "btn btn-danger th-btn", text: "Stop team", onClick: () => void window.ide.team.stop() }),
  );
}

// ---- deliberation

function renderDeliberation(body: HTMLElement, r: TeamRunState): void {
  let wrap = body.querySelector(".team-delib") as HTMLElement | null;
  if (!wrap) {
    clear(body);
    feedListEl = null;
    feedRendered = 0;
    wrap = el("div", { class: "team-delib" });
    body.append(wrap);
  }
  let cards = wrap.querySelector(".td-planners") as HTMLElement | null;
  if (!cards) {
    cards = el("div", { class: "td-planners" });
    wrap.append(cards);
  }
  clear(cards);
  for (const a of r.agents.filter((x) => x.kind === "planner")) cards.append(agentCard(a));
  if (!feedListEl) {
    feedListEl = el("div", { class: "team-feed" });
    wrap.append(feedListEl);
  }
}

function agentCard(a: TeamAgent): HTMLElement {
  const prev = prevAgentState[a.name];
  const woke = (prev === "sleeping") && (a.state === "waking" || a.state === "working");
  prevAgentState[a.name] = a.state;
  const card = el(
    "div",
    { class: `team-card st-${a.state}${woke ? " materialize" : ""}` },
    el("div", { class: "tc-row" },
      el("span", { class: "tc-glyph mono", text: a.glyph }),
      el("span", { class: "tc-agent mono", text: a.name }),
      el("span", { class: `orb ${ORB_BY_STATE[a.state] ?? "idle"}` }),
    ),
    el("div", { class: "tc-row tc-meta" },
      el("span", { class: "tc-chip mono", text: a.state }),
      a.kind === "worker" && a.slice && (a.state === "working" || a.state === "waking")
        ? el("span", { class: "mono dim", text: `slice ${a.slice}` }) : null,
      a.state === "working" || a.state === "deliberating"
        ? el("span", { class: "mono dim tc-elapsed", dataset: { since: String(a.sinceMs) }, text: fmtElapsed(a.sinceMs) }) : null,
    ),
    a.state === "sleeping" && a.waitingFor?.length
      ? el("div", { class: "tc-wait dim", text: `waiting for ${a.waitingFor.join(", ")}` })
      : null,
    a.kind === "worker"
      ? el("div", { class: "tc-files dim mono", text: `${a.filesTouched} file${a.filesTouched === 1 ? "" : "s"} touched` })
      : null,
  );
  return card;
}

// ---- plan gate

function renderGate(body: HTMLElement, r: TeamRunState): void {
  clear(body);
  feedListEl = null;
  feedRendered = 0;
  const stats = planStats(r.slices);
  const summary = `${r.slices.length} slice${r.slices.length === 1 ? "" : "s"} · ${stats.tracks} parallel track${stats.tracks === 1 ? "" : "s"} · est. ${stats.contracts} contract${stats.contracts === 1 ? "" : "s"}`;

  let graphMode = body.dataset.graph === "1";
  const viewBtn = el("button", {
    class: "btn btn-ghost th-btn",
    text: graphMode ? "List view" : "Graph view",
    onClick: () => {
      body.dataset.graph = graphMode ? "" : "1";
      render();
    },
  });

  const gate = el("div", { class: "team-gate materialize" },
    el("div", { class: "tg-summary" },
      el("span", { class: "mono", text: summary }),
      r.planSummary ? el("span", { class: "dim", text: r.planSummary }) : null,
      el("span", { style: { flex: "1" } }),
      viewBtn,
    ),
  );

  if (graphMode) {
    gate.append(renderDag(r.slices, { clickable: false }));
  } else {
    const list = el("div", { class: "tg-list" });
    for (const s of r.slices) list.append(gateSliceRow(s, r));
    gate.append(list);
  }

  gate.append(
    el("div", { class: "tg-actions" },
      el("button", {
        class: "btn btn-ghost", text: "Add slice…",
        onClick: () => void addSliceDialog(),
      }),
      el("span", { style: { flex: "1" } }),
      el("button", {
        class: "btn btn-ghost", text: "Discard",
        onClick: () => {
          void confirmDialog({ title: "Discard plan", message: "Drop the converged plan and return to a plain prompt?", confirmLabel: "Discard", danger: true })
            .then((ok) => { if (ok) void window.ide.team.discard(); });
        },
      }),
      el("button", {
        class: "btn btn-primary", text: "Approve & run",
        onClick: () => void window.ide.team.approve().then((res) => {
          if (!res.ok) toast(res.error ?? "Approval failed", { crit: true });
        }),
      }),
    ),
  );
  body.append(gate);
}

function gateSliceRow(s: TeamSlice, r: TeamRunState): HTMLElement {
  return el("div", { class: "tg-slice" },
    el("span", { class: "tg-id mono", text: s.id }),
    el("div", { class: "tg-main" },
      el("div", { class: "tg-title", text: s.title }),
      el("div", { class: "tg-scope dim", text: s.scope }),
      s.contract ? el("div", { class: "tg-contract mono dim", text: `contract: ${s.contract}` }) : null,
    ),
    el("span", { class: "tg-deps mono dim", text: s.deps.length ? `← ${s.deps.join(", ")}` : "root" }),
    el("span", { class: "tg-worker mono", text: s.worker }),
    el("button", {
      class: "btn btn-ghost tg-btn", text: "Edit",
      onClick: () => void editSliceDialog(s),
    }),
    el("button", {
      class: "btn btn-ghost tg-btn", text: "Deps",
      title: "Edit dependencies (cycles rejected)",
      onClick: () => void editDepsDialog(s, r),
    }),
    el("button", {
      class: "btn btn-ghost tg-btn tg-del", text: "✕",
      title: "Delete slice",
      onClick: () => void window.ide.team.deleteSlice(s.id).then((res) => {
        if (!res.ok) toast(res.error ?? "Cannot delete", { crit: true });
      }),
    }),
  );
}

async function editSliceDialog(s: TeamSlice): Promise<void> {
  const values = await formDialog({
    title: `Edit slice ${s.id}`,
    fields: [
      { key: "title", label: "Title", value: s.title },
      { key: "scope", label: "Scope (one line)", value: s.scope },
    ],
    confirmLabel: "Save",
  });
  if (!values) return;
  const res = await window.ide.team.editSlice(s.id, { title: values.title, scope: values.scope });
  if (!res.ok) toast(res.error ?? "Edit rejected", { crit: true });
}

async function editDepsDialog(s: TeamSlice, r: TeamRunState): Promise<void> {
  const others = r.slices.filter((x) => x.id !== s.id).map((x) => x.id).join(", ");
  const raw = await inputDialog({
    title: `Dependencies of ${s.id}`,
    message: `Comma-separated slice ids (available: ${others || "none"}). A cycle is rejected.`,
    value: s.deps.join(", "),
  });
  if (raw === null) return;
  const deps = raw.split(",").map((x) => x.trim()).filter(Boolean);
  const res = await window.ide.team.setDeps(s.id, deps);
  if (!res.ok) toast(res.error ?? "Edge rejected", { crit: true });
}

async function addSliceDialog(): Promise<void> {
  const values = await formDialog({
    title: "Add slice",
    fields: [
      { key: "title", label: "Title" },
      { key: "scope", label: "Scope (one line)" },
      { key: "deps", label: "Dependencies (comma-separated ids, or -)" },
    ],
    confirmLabel: "Add",
  });
  if (!values) return;
  const deps = values.deps.replace(/^-$/, "").split(",").map((x) => x.trim()).filter(Boolean);
  const res = await window.ide.team.addSlice({ title: values.title, scope: values.scope, deps });
  if (!res.ok) toast(res.error ?? "Slice rejected", { crit: true });
}

// ---- DAG

function renderDag(slices: TeamSlice[], opts: { clickable: boolean; pulseDeps?: string[] }): HTMLElement {
  const layers = layerSlices(slices);
  const cols = new Map<number, TeamSlice[]>();
  for (const s of slices) {
    const l = layers.get(s.id) ?? 0;
    if (!cols.has(l)) cols.set(l, []);
    cols.get(l)!.push(s);
  }
  const NW = 108, NH = 36, GX = 56, GY = 14, PAD = 8;
  const colCount = Math.max(...cols.keys(), 0) + 1;
  const rowMax = Math.max(...[...cols.values()].map((c) => c.length), 1);
  const width = PAD * 2 + colCount * NW + (colCount - 1) * GX;
  const height = PAD * 2 + rowMax * NH + (rowMax - 1) * GY;

  const pos = new Map<string, { x: number; y: number }>();
  for (const [l, list] of cols) {
    const colH = list.length * NH + (list.length - 1) * GY;
    list.forEach((s, i) => {
      pos.set(s.id, {
        x: PAD + l * (NW + GX),
        y: PAD + (height - PAD * 2 - colH) / 2 + i * (NH + GY),
      });
    });
  }

  const svgNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.setAttribute("class", "team-dag");
  svg.style.aspectRatio = `${width} / ${height}`;

  for (const s of slices) {
    const to = pos.get(s.id)!;
    for (const d of s.deps) {
      const from = pos.get(d);
      if (!from) continue;
      const x1 = from.x + NW, y1 = from.y + NH / 2, x2 = to.x, y2 = to.y + NH / 2;
      const path = document.createElementNS(svgNS, "path");
      path.setAttribute("d", `M ${x1} ${y1} C ${x1 + GX / 2} ${y1}, ${x2 - GX / 2} ${y2}, ${x2} ${y2}`);
      const dep = slices.find((x) => x.id === d);
      const active = dep?.state === "done" && (s.state === "active" || s.state === "pending");
      const pulse = opts.pulseDeps?.includes(d) && s.state === "active";
      path.setAttribute("class", `dag-edge${active ? " live" : ""}${pulse ? " pulse" : ""}`);
      svg.append(path);
    }
  }

  for (const s of slices) {
    const p = pos.get(s.id)!;
    const g = document.createElementNS(svgNS, "g");
    g.setAttribute("class", `dag-node st-${s.state}`);
    const rect = document.createElementNS(svgNS, "rect");
    rect.setAttribute("x", String(p.x)); rect.setAttribute("y", String(p.y));
    rect.setAttribute("width", String(NW)); rect.setAttribute("height", String(NH));
    rect.setAttribute("rx", "6");
    const label = document.createElementNS(svgNS, "text");
    label.setAttribute("x", String(p.x + 8)); label.setAttribute("y", String(p.y + 15));
    label.setAttribute("class", "dag-id");
    label.textContent = s.id;
    const title = document.createElementNS(svgNS, "text");
    title.setAttribute("x", String(p.x + 8)); title.setAttribute("y", String(p.y + 28));
    title.setAttribute("class", "dag-title");
    title.textContent = s.title.length > 14 ? s.title.slice(0, 13) + "…" : s.title;
    g.append(rect, label, title);
    if (opts.clickable) {
      g.addEventListener("click", () => showSliceDetail(s));
      g.style.cursor = "pointer";
    }
    svg.append(g);
  }

  const wrap = el("div", { class: "team-dag-wrap" });
  wrap.append(svg);
  return wrap;
}

function showSliceDetail(s: TeamSlice): void {
  const existing = surfaceEl.querySelector(".slice-detail");
  existing?.remove();
  const board = surfaceEl.querySelector(".team-board");
  if (!board) return;
  board.append(
    el("div", { class: "slice-detail materialize" },
      el("div", { class: "sd-head" },
        el("span", { class: "mono", text: `${s.id} · ${s.title}` }),
        el("span", { class: `tc-chip mono st-${s.state}`, text: s.state }),
        el("span", { class: "mono dim", text: `+${s.add} −${s.del}` }),
        el("span", { style: { flex: "1" } }),
        el("button", { class: "btn btn-ghost th-btn", text: "✕", onClick: (e) => (e.currentTarget as HTMLElement).closest(".slice-detail")?.remove() }),
      ),
      el("div", { class: "sd-body dim", text: s.handoff ?? "No hand-off note yet — the finisher writes it when the slice completes." }),
    ),
  );
}

// ---- execution board

function renderBoard(body: HTMLElement, r: TeamRunState): void {
  let board = body.querySelector(".team-board") as HTMLElement | null;
  const fresh = !board;
  if (!board) {
    clear(body);
    feedListEl = null;
    feedRendered = 0;
    board = el("div", { class: "team-board" });
    body.append(board);
  }

  let cards = board.querySelector(".tb-cards") as HTMLElement | null;
  if (!cards) { cards = el("div", { class: "tb-cards" }); board.append(cards); }
  clear(cards);
  for (const a of r.agents.filter((x) => x.kind === "worker")) cards.append(agentCard(a));
  if (!r.agents.some((x) => x.kind === "worker")) {
    for (const a of r.agents) cards.append(agentCard(a));
  }

  // wake pulse: deps of slices actively worked by a just-woken worker
  const pulseDeps: string[] = [];
  for (const a of r.agents) {
    if (a.kind !== "worker" || !a.slice) continue;
    if (a.state === "waking" || (a.state === "working" && prevAgentState[a.name] === "waking")) {
      const s = r.slices.find((x) => x.id === a.slice);
      if (s) pulseDeps.push(...s.deps);
    }
  }

  let dagHost = board.querySelector(".tb-dag") as HTMLElement | null;
  if (!dagHost) { dagHost = el("div", { class: "tb-dag" }); board.append(dagHost); }
  clear(dagHost);
  dagHost.append(renderDag(r.slices, { clickable: true, pulseDeps }));

  // slice strip replaces the todo strip while the team runs (same language)
  let strip = board.querySelector(".tb-strip") as HTMLElement | null;
  if (!strip) { strip = el("div", { class: "tb-strip" }); board.append(strip); }
  clear(strip);
  for (const s of r.slices) {
    strip.append(el("span", {
      class: `tb-slice mono st-${s.state}`,
      title: `${s.title} — ${s.scope}${s.handoff ? `\n\n${s.handoff}` : ""}`,
      text: `${s.id}${s.state === "done" ? " ✓" : s.state === "failed" ? " ✕" : ""}`,
      onClick: () => showSliceDetail(s),
    }));
  }

  let extras = board.querySelector(".tb-extras") as HTMLElement | null;
  if (!extras) { extras = el("div", { class: "tb-extras" }); board.append(extras); }
  clear(extras);

  if (r.needsCall) {
    const call = r.needsCall;
    extras.append(
      el("div", { class: "needs-call materialize" },
        el("div", { class: "nc-title", text: `Slice ${call.sliceId} failed twice — needs your call` }),
        el("div", { class: "nc-error mono dim", text: call.error }),
        el("div", { class: "nc-actions" },
          el("button", { class: "btn btn-primary", text: "Retry", onClick: () => void window.ide.team.needsCall("retry") }),
          el("button", {
            class: "btn", text: "Edit slice…",
            onClick: () => {
              const s = r.slices.find((x) => x.id === call.sliceId);
              void inputDialog({ title: `Rescope slice ${call.sliceId}`, message: "New scope for the retry:", value: s?.scope ?? "" })
                .then((scope) => { if (scope !== null) void window.ide.team.needsCall("retry", scope); });
            },
          }),
          el("button", { class: "btn btn-danger", text: "Abort team run", onClick: () => void window.ide.team.needsCall("abort") }),
        ),
      ),
    );
  }

  if (r.phase === "done" && r.report) {
    const rep = el("div", { class: "team-report materialize md" });
    rep.innerHTML = marked.parse(r.report, { async: false });
    extras.append(
      el("div", { class: "tr-head mono", text: "TEAM REPORT" }),
      rep,
    );
  }
  if (r.phase === "stopped") {
    extras.append(el("div", { class: "tb-frozen dim", text: "· run stopped — board frozen in its last state ·" }));
  }
  if (fresh) board.classList.add("materialize");
}

// ---- stalled / restart honesty

function renderStalled(body: HTMLElement, r: TeamRunState): void {
  clear(body);
  feedListEl = null;
  feedRendered = 0;
  body.append(
    el("div", { class: "team-stalled materialize" },
      el("div", { class: "ts-title", text: r.didNotSurvive ? "This team run did not survive the restart" : "The team run stalled" }),
      el("div", { class: "dim", text: r.didNotSurvive
        ? "Team runs do not resume across app restarts. Below is the last known state from before the app closed."
        : "The agent turn ended without completing the protocol. You can restart the run with the same goal." }),
      el("div", { class: "ts-goal mono", text: r.goal }),
      r.slices.length ? renderDag(r.slices, { clickable: false }) : null,
      el("div", { class: "tg-actions" },
        el("button", { class: "btn btn-ghost", text: "Dismiss", onClick: () => void window.ide.team.clear() }),
        el("button", {
          class: "btn btn-primary", text: "Restart team run",
          onClick: () => void window.ide.team.restartRun().then((res) => {
            if (!res.ok) toast(res.error ?? "Restart failed", { crit: true });
          }),
        }),
      ),
    ),
  );
}

// ---- feed (deliberation + system notes, incremental)

function renderFeed(r: TeamRunState): void {
  if (!feedListEl) {
    // board phases keep the feed below the board
    const host = surfaceEl.querySelector(".team-board, .team-delib");
    if (!host) return;
    feedListEl = el("div", { class: "team-feed" });
    host.append(feedListEl);
    feedRendered = 0;
  }
  const fresh = r.feed.slice(feedRendered);
  feedRendered = r.feed.length;
  for (const f of fresh) {
    if (f.kind === "system") {
      feedListEl.append(el("div", { class: "tf-sys dim", text: `· ${f.text} ·` }));
    } else {
      feedListEl.append(
        el("div", { class: `tf-entry${f.kind === "note" ? " tf-note" : ""}` },
          el("span", { class: "tf-author mono", text: `${f.glyph ? f.glyph + " " : ""}${f.author}` }),
          el("span", { class: "tf-text", text: f.text }),
        ),
      );
    }
  }
  if (fresh.length) feedListEl.scrollTop = feedListEl.scrollHeight;
}

// ---- elapsed ticker (1 s, only while someone is on the clock)

function armElapsedTicker(r: TeamRunState): void {
  const active = r.agents.some((a) => a.state === "working" || a.state === "deliberating");
  if (active && elapsedTimer === undefined) {
    elapsedTimer = window.setInterval(() => {
      for (const n of surfaceEl.querySelectorAll<HTMLElement>(".tc-elapsed")) {
        const since = Number(n.dataset.since);
        if (since) n.textContent = fmtElapsed(since);
      }
    }, 1000);
  } else if (!active && elapsedTimer !== undefined) {
    clearInterval(elapsedTimer);
    elapsedTimer = undefined;
  }
}
