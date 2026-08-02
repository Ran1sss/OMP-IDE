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
import { emit, on } from "../core/bus";
import { toast, confirmDialog, formDialog, inputDialog } from "../core/ui";
import { t } from "../core/i18n";
import type { TeamRunState, TeamSlice, TeamTimelineEntry } from "../../shared/types";

let panelEl: HTMLElement;
let surfaceEl: HTMLElement;
let inputEl: HTMLTextAreaElement;
let toggleBtn: HTMLElement | null = null;

/** Team toggle armed: the NEXT send becomes a team goal */
let armed = false;
let run: TeamRunState | null = null;

/** Read-only view of the live run for glance surfaces (agent NOW zone). */
export function teamRun(): TeamRunState | null {
  return run;
}

/** Keep chronological feed order: user bubble → dispatch card → final. */
export function placeTeamSurfaceAfterUserMessage(): void {
  if (!run || !surfaceEl) return;
  const chat = panelEl.querySelector(".agent-chat");
  if (chat) chat.append(surfaceEl);
}

/** current run identity for one-time surface reset */
let surfaceRunId = "";
let elapsedTimer: number | undefined;
/** expanded ledger groups (worker + first timestamp + size) */
const expandedGroups = new Set<string>();

/** legacy decorated marker line: `##NAME##`, `@@NAME@@` or `::NAME::` */
const PROTO_RE = /^(##[A-Z][A-Z0-9_]*##|@@[A-Z][A-Z0-9_]*@@|::[A-Z][A-Z0-9_]*::)/;

function isProtoLine(trimmed: string): boolean {
  if (PROTO_RE.test(trimmed)) return true;
  // Any event-shaped JSON line is transport, even when malformed. The main
  // adapter renders a designed error card; history/live chat never show raw.
  return trimmed.startsWith("{") && trimmed.includes("\"ev\"");
}
/**
 * Strip protocol lines from agent chat text (team run narration): bare
 * `{"ev":…}` JSON events (primary) and legacy decorated markers. Separator
 * lines (`---`/`***`/`___`) adjacent to a stripped line are dropped too —
 * orphaned they render as a stack of bare <hr>s.
 */
export function stripTeamMarkers(text: string): string {
  if (!text.includes("{\"ev\"") && !text.includes("##") && !text.includes("@@") && !text.includes("::")) return text;
  const lines = text.split("\n");
  const isMarker = lines.map((l) => isProtoLine(l.trim()));
  if (!isMarker.some(Boolean)) return text;
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
    title: t("team.toggleTip"),
    text: t("team.title"),
    onClick: () => {
      if (run && run.phase !== "done" && run.phase !== "stopped" && run.phase !== "stalled") {
        toast(t("team.runActiveToast"));
        return;
      }
      armed = !armed;
      toggleBtn!.classList.toggle("armed", armed);
      if (inputEl) inputEl.placeholder = armed ? t("team.goalPlaceholder") : t("agent.placeholder");
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
    if (run.phase === "route") {
      void window.ide.team.steer(message);
      return true;
    }
    if (run.phase === "gate") {
      toast(t("team.approveFirstToast"));
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
  // @-mentions of roster roles pin those roles (manual override §5); no
  // mentions = the router auto-assigns. Mentions are matched against the
  // known roster ids so a stray @path (file) is ignored here.
  const mentioned = extractAgentMentions(message);
  void window.ide.team.start(message, mentioned).then((r) => {
    if (!r.ok) toast(r.error ?? t("team.startFailed"), { crit: true });
  });
  return true;
}

/** roster role ids explicitly @-mentioned in the goal text (manual override) */
let rosterIds: Set<string> = new Set();
function extractAgentMentions(message: string): string[] {
  const out = new Set<string>();
  for (const m of message.matchAll(/@([a-z][\w-]*)/gi)) {
    const id = m[1].toLowerCase();
    if (rosterIds.has(id)) out.add(id);
  }
  return [...out];
}

// ---------------------------------------------------------------- state plumbing

export function initTeamSurface(opts: { panel: HTMLElement; input: HTMLTextAreaElement }): void {
  panelEl = opts.panel;
  inputEl = opts.input;
  surfaceEl = el("div", { class: "team-surface", style: { display: "none" } });
  // The surface lives inside the unified chat timeline. It starts hidden and
  // is moved after the team goal bubble by placeTeamSurfaceAfterUserMessage().
  const chat = panelEl.querySelector(".agent-chat");
  if (chat) chat.append(surfaceEl);
  else panelEl.append(surfaceEl);

  window.ide.team.onState((s) => applyState(s));
  void window.ide.team.getState().then((s) => applyState(s));
  // cache the roster ids so @-mentions in a goal can be matched to roles
  void window.ide.team.roster().then((roles) => { rosterIds = new Set(roles.map((r) => r.id)); });

  // live language switch: rebuild fixed strings; on-demand dialogs rebuild on open
  on("lang-changed", () => {
    if (toggleBtn) {
      toggleBtn.title = t("team.toggleTip");
      toggleBtn.textContent = t("team.title");
    }
    if (run) {
      surfaceRunId = ""; // forces render() to clear + re-render from scratch
      applyState(run);
    } else if (armed && inputEl) {
      inputEl.placeholder = t("team.goalPlaceholder");
    }
  });
}

function applyState(s: TeamRunState | null): void {
  run = s;
  emit("team-state", undefined);
  const live = !!s;
  panelEl.classList.toggle("team-live", live);
  surfaceEl.style.display = live ? "" : "none";
  if (!s) {
    clear(surfaceEl);
    clearInterval(elapsedTimer);
    elapsedTimer = undefined;
    if (inputEl && !armed) inputEl.placeholder = t("agent.placeholder");
    return;
  }
  if (inputEl) {
    inputEl.placeholder =
      s.phase === "route" ? t("team.noteRouter") :
      s.phase === "execute" || s.phase === "verify" ? t("team.steerPlaceholder") :
      t("agent.placeholder");
  }
  render();
}

// ---------------------------------------------------------------- helpers

function fmtElapsed(sinceMs: number): string {
  const s = Math.max(0, Math.floor((Date.now() - sinceMs) / 1000));
  return s < 60 ? t("team.elapsedSec", s) : t("team.elapsedMinSec", Math.floor(s / 60), s % 60);
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


/** displayed slice-state word (detail popover chip) */
function sliceStateLabel(st: string): string {
  switch (st) {
    case "pending": return t("team.stPending");
    case "active": return t("team.stActive");
    case "done": return t("team.stDone");
    case "failed": return t("team.stFailed");
    case "replanned": return t("team.stReplanned");
    default: return st;
  }
}

// ---------------------------------------------------------------- rendering

function render(): void {
  if (!run) return;
  const r = run;
  if (surfaceRunId !== r.runId) {
    clear(surfaceEl);
    surfaceRunId = r.runId;
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
  else renderDispatch(body, r); // route / gate / execute / verify / done / stopped

  armElapsedTicker(r);
}

function renderHead(head: HTMLElement, r: TeamRunState): void {
  clear(head);
  const phaseLabel: Record<string, string> = {
    route: t("team.phaseRoute"),
    gate: t("team.phaseGate"),
    execute: t("team.phaseExecute"),
    verify: t("team.phaseVerify"),
    done: t("team.phaseDone"),
    stopped: t("team.phaseStopped"),
    stalled: t("team.phaseStalled"),
  };
  head.append(
    el("span", { class: "th-title", text: t("team.title") }),
    el("span", { class: "th-phase mono", text: phaseLabel[r.phase] ?? r.phase }),
  );
  // honesty badge: the LIVE mechanism, never a generic label (crew-rail §2)
  if (r.mechanism) {
    const m = r.mechanism;
    // badge truthfulness (crew-design §3): `parallel ×N` requires N ≥ 2 live
    // worker processes; exactly one live renders `solo (reason)`; zero live
    // renders no badge (the phase label carries the state). `parallel ×1`
    // is unrendercable by construction.
    let label: string | null = null;
    let soloTint = false;
    if (m.kind === "solo") {
      label = t("team.mechSolo", m.reason ?? t("team.mechSoloDefault"));
      soloTint = true;
    } else if (m.active >= 2) {
      label = m.throttled > 0 ? t("team.mechParallelThrottled", m.active, m.throttled) : t("team.mechParallel", m.active);
    } else if (m.active === 1) {
      label = t("team.mechSoloOne", m.singleReason ?? t("team.mechOneSliceReady"));
    }
    if (label) {
      head.append(el("span", {
        class: `th-mech mono${soloTint ? " solo" : ""}`,
        title: m.kind === "solo" ? t("team.mechSoloTip") : t("team.mechParallelTip"),
        text: label,
      }));
    }
  } else if (r.solo && (r.phase === "route" || r.phase === "gate")) {
    head.append(el("span", { class: "th-mech mono", title: t("team.processParallelTip"), text: t("team.processParallel") }));
  }
  head.append(
    el("span", { class: "th-goal", title: r.goal, text: r.goal }),
    el("span", { style: { flex: "1" } }),
    r.phase === "done" || r.phase === "stopped" || r.phase === "stalled"
      ? el("button", { class: "btn btn-ghost th-btn", text: t("team.dismiss"), onClick: () => void window.ide.team.clear() })
      : el("button", { class: "btn btn-danger th-btn", text: t("team.stopTeam"), onClick: () => void window.ide.team.stop() }),
  );
}

// ---- dispatch card (auto-routing 2A): one card, rows update in place
//
// The card is the single feed surface for a team run: flag title + one row per
// assigned role (chip · task · status). During `route` it shows the routing
// indicator; at `gate` a grace bar + «изменить»; through execute/verify the
// rows transition в очереди → работает… → готово IN PLACE (never new messages);
// at done the card stays and the ONE final message is the lead's summary.

function renderDispatch(body: HTMLElement, r: TeamRunState): void {
  clear(body);
  const editable = r.phase === "gate";
  const graphMode = body.dataset.graph === "1";
  const card = el("div", { class: "team-dispatch materialize" });
  const title = el("div", { class: "dsp-title" },
    el("span", { class: "dsp-flag", text: "⚑" }),
    el("span", { class: "dsp-heading", text: dispatchHeading(r) }),
  );
  if (r.slices.length) {
    title.append(el("span", { style: { flex: "1" } }));
    if (editable) title.append(el("button", { class: "btn btn-ghost dsp-viewbtn", text: t("team.edit"), onClick: () => void window.ide.team.hold() }));
    title.append(el("button", { class: "btn btn-ghost dsp-viewbtn", text: graphMode ? t("team.listView") : t("team.graphView"), onClick: () => { body.dataset.graph = graphMode ? "" : "1"; render(); } }));
  }
  card.append(title);
  if (r.protocolError) card.append(protocolErrorCard(r.protocolError.raw));
  if (!r.slices.length) {
    card.append(el("div", { class: "dsp-routing dim", text: t("team.routingLine") }));
    body.append(card);
    return;
  }
  if (graphMode) card.append(renderDag(r.slices, { clickable: true }));
  else {
    const rows = el("div", { class: "dsp-rows" });
    for (const s of r.slices) rows.append(dispatchRow(s, r, editable || (r.phase === "execute" && s.state === "pending")));
    card.append(rows);
  }
  if (editable) card.append(dispatchGate(r));
  body.append(card);
  if (r.phase === "execute" || r.phase === "verify" || r.phase === "done") renderExecExtras(card, r);
}

function protocolErrorCard(raw: string): HTMLElement {
  const details = el("details", { class: "dsp-proto-raw" }, el("summary", { text: t("team.protocolDetails") }), el("pre", { text: raw }));
  return el("div", { class: "dsp-proto-error" }, el("div", { class: "dsp-proto-title", text: t("team.protocolError") }), details);
}

function dispatchHeading(r: TeamRunState): string {
  if (r.phase === "route") return t("team.dspRouting");
  const roles = r.slices.length;
  if (r.phase === "gate") return t("team.dspAssigned", roles);
  if (r.phase === "done") return t("team.dspDone");
  if (r.phase === "stopped") return t("team.dspStopped");
  return t("team.dspRunning", roles);
}

function dispatchRow(s: TeamSlice, r: TeamRunState, editable: boolean): HTMLElement {
  const idx = r.slices.indexOf(s);
  const depNote = s.deps.length === 0 ? "" : s.deps.length === 1 ? t("team.afterOne", s.deps[0]) : t("team.afterMany");
  const statusText = s.state === "active" ? t("team.dspWorking") : s.state === "done" ? t("team.dspStDone") : s.state === "failed" ? t("team.dspStFailed") : s.state === "replanned" ? t("team.dspStReplanned") : (idx === r.slices.length - 1 && r.slices.length > 1 ? t("team.dspLast") : (depNote || t("team.dspQueued")));
  const statusCls = s.state === "active" ? "run" : s.state === "done" ? "ok" : s.state === "failed" ? "fail" : "wait";
  const row = el("div", { class: `dsp-row st-${s.state}` },
    el("span", { class: `dsp-chip agc-${(idx % 4) + 1}`, text: s.worker }),
    el("span", { class: "dsp-task", title: s.scope || s.title, text: s.title }),
    el("span", { class: `dsp-st ${statusCls}`, text: statusText }),
  );
  if (!editable) {
    row.classList.add("clickable");
    row.addEventListener("click", () => showSliceDetail(s));
  } else {
    row.append(el("span", { class: "dsp-tools" },
      el("button", { class: "btn btn-ghost dsp-tbtn", text: t("team.edit"), onClick: (e) => { e.stopPropagation(); void window.ide.team.hold().then(() => editSliceDialog(s)); } }),
      el("button", { class: "btn btn-ghost dsp-tbtn", text: t("team.deps"), title: t("team.depsTip"), onClick: (e) => { e.stopPropagation(); void window.ide.team.hold().then(() => editDepsDialog(s, r)); } }),
      el("button", { class: "btn btn-ghost dsp-tbtn dsp-del", text: "✕", title: t("team.deleteSliceTip"), onClick: (e) => { e.stopPropagation(); void window.ide.team.hold().then(() => window.ide.team.deleteSlice(s.id)).then((res) => { if (res && !res.ok) toast(res.error ?? t("team.deleteRejected"), { crit: true }); }); } }),
    ));
  }
  return row;
}

function dispatchGate(r: TeamRunState): HTMLElement {
  const wrap = el("div", { class: "dsp-gate" });
  if (r.graceUntil && r.graceUntil > Date.now()) {
    const bar = el("div", { class: "dsp-grace" }, el("div", { class: "dsp-grace-fill" }));
    wrap.append(el("div", { class: "dsp-graceline" }, el("span", { class: "dim", text: t("team.graceLine") }), bar));
    const remain = r.graceUntil - Date.now();
    const fill = bar.querySelector(".dsp-grace-fill") as HTMLElement;
    fill.style.transition = "none"; fill.style.width = "100%";
    requestAnimationFrame(() => { fill.style.transition = `width ${remain}ms linear`; fill.style.width = "0%"; });
  }
  wrap.append(el("div", { class: "dsp-actions" },
    el("button", { class: "btn btn-ghost", text: t("team.addSliceBtn"), onClick: () => void window.ide.team.hold().then(() => addSliceDialog()) }),
    el("span", { style: { flex: "1" } }),
    el("button", { class: "btn btn-ghost", text: t("team.discard"), onClick: () => { void window.ide.team.hold().then(() => confirmDialog({ title: t("team.discardPlanTitle"), message: t("team.discardPlanMsg"), confirmLabel: t("team.discard"), danger: true })).then((ok) => { if (ok) void window.ide.team.discard(); }); } }),
    el("button", { class: "btn btn-primary", text: t("team.dspStartNow"), onClick: () => void window.ide.team.approve().then((res) => { if (!res.ok) toast(res.error ?? t("team.approveFailed"), { crit: true }); }) }),
  ));
  return wrap;
}
async function editSliceDialog(s: TeamSlice): Promise<void> {
  const values = await formDialog({
    title: t("team.editSliceTitle", s.id),
    fields: [
      { key: "title", label: t("team.fldTitle"), value: s.title },
      { key: "scope", label: t("team.fldScope"), value: s.scope },
    ],
    confirmLabel: t("team.save"),
  });
  if (!values) return;
  const res = await window.ide.team.editSlice(s.id, { title: values.title, scope: values.scope });
  if (!res.ok) toast(res.error ?? t("team.editRejected"), { crit: true });
}

async function editDepsDialog(s: TeamSlice, r: TeamRunState): Promise<void> {
  const others = r.slices.filter((x) => x.id !== s.id).map((x) => x.id).join(", ");
  const raw = await inputDialog({
    title: t("team.depsOfTitle", s.id),
    message: t("team.depsMsg", others || t("team.none")),
    value: s.deps.join(", "),
  });
  if (raw === null) return;
  const deps = raw.split(",").map((x) => x.trim()).filter(Boolean);
  const res = await window.ide.team.setDeps(s.id, deps);
  if (!res.ok) toast(res.error ?? t("team.edgeRejected"), { crit: true });
}

async function addSliceDialog(): Promise<void> {
  const values = await formDialog({
    title: t("team.addSliceTitle"),
    fields: [
      { key: "title", label: t("team.fldTitle") },
      { key: "scope", label: t("team.fldScope") },
      { key: "deps", label: t("team.fldDeps") },
    ],
    confirmLabel: t("team.add"),
  });
  if (!values) return;
  const deps = values.deps.replace(/^-$/, "").split(",").map((x) => x.trim()).filter(Boolean);
  const res = await window.ide.team.addSlice({ title: values.title, scope: values.scope, deps });
  if (!res.ok) toast(res.error ?? t("team.sliceRejected"), { crit: true });
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
  const card = surfaceEl.querySelector(".team-dispatch");
  if (!card) return;
  const workerEvents = (run?.timeline ?? []).filter((e) => e.worker === s.worker);
  const log = workerEvents.length
    ? el("div", { class: "sd-log" },
        ...workerEvents.slice(-30).map((e) => el("div", { class: "sd-log-row mono" },
          el("span", { class: "sd-log-tool", text: e.tool }),
          el("span", { class: "sd-log-summary", text: e.summary }),
        )),
      )
    : null;
  card.append(
    el("div", { class: "slice-detail materialize" },
      el("div", { class: "sd-head" },
        el("span", { class: "mono", text: `${s.worker} · ${s.title}` }),
        el("span", { class: `tc-chip mono st-${s.state}`, text: sliceStateLabel(s.state) }),
        el("span", { class: "mono dim", text: `+${s.add} −${s.del}` }),
        el("span", { style: { flex: "1" } }),
        el("button", { class: "btn btn-ghost th-btn", text: "✕", onClick: (e) => (e.currentTarget as HTMLElement).closest(".slice-detail")?.remove() }),
      ),
      el("div", { class: "sd-meta mono dim" },
        el("span", { text: s.deps.length ? t("team.depsLbl", `${s.deps.join(", ")}${s.autoDeps?.length ? t("team.autoSuffix", s.autoDeps.join(", ")) : ""}`) : t("team.depsNone") }),
        s.contract ? el("span", { text: t("team.contractLbl", s.contract) }) : null,
        s.files?.length ? el("span", { text: t("team.filesLbl", s.files.join(", ")) }) : null,
      ),
      log,
      el("div", { class: "sd-body dim", text: s.handoff ?? t("team.noHandoff") }),
    ),
  );
}

// ---- execution board — Crew Rail (crew-rail spec §3, lab variant 1)

/** timeline filter — session-scoped UI state (set by a dispatch-row click) */
let timelineFilter: string | null = null;

/**
 * Execution detail appended UNDER the dispatch card (Part 3): the shared
 * attributed timeline (row-click filters it), the needs-call pause, and the
 * ONE final message — the lead's report, green-edged like the single-agent
 * final (voice 8+2). The card rows already carry chip·task·status, so the old
 * crew rail/pipeline are gone; per-agent logs open via row-click (showSliceDetail).
 */
function renderExecExtras(host: HTMLElement, r: TeamRunState): void {
  // shared attributed timeline (filterable by clicking a row → showSliceDetail)
  const entries = (r.timeline ?? []).filter((e) => !timelineFilter || e.worker === timelineFilter);
  if (entries.length) {
    const tl = el("div", { class: "crew-tl" });
    tl.append(el("div", { class: "ctl-head mono", text: timelineFilter ? t("team.timelineHeadFiltered", timelineFilter, entries.length) : t("team.timelineHead", entries.length) }));
    const timelineRow = (e: TeamTimelineEntry, nested = false): HTMLElement =>
      el("div", { class: `ctl-row mono${nested ? " nested" : ""}` },
        el("span", { class: "ctl-sigil", text: e.glyph }),
        el("span", { class: "ctl-worker", text: e.worker }),
        el("span", { class: "ctl-tool", text: e.tool }),
        el("span", { class: "ctl-sum", text: e.summary }),
        el("span", { class: "ctl-at dim", text: new Date(e.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }) }),
      );
    const recent = entries.slice(-60);
    const groups: TeamTimelineEntry[][] = [];
    for (const e of recent) {
      const g = groups[groups.length - 1];
      if (g && g[0].worker === e.worker) g.push(e);
      else groups.push([e]);
    }
    for (const g of groups.slice(-40)) {
      if (g.length === 1) { tl.append(timelineRow(g[0])); continue; }
      const key = `${g[0].worker}:${g[0].at}:${g.length}`;
      const open = expandedGroups.has(key);
      const counts = new Map<string, number>();
      for (const e of g) counts.set(e.tool, (counts.get(e.tool) ?? 0) + 1);
      const tools = [...counts].map(([tool, n]) => (n > 1 ? `${tool} ×${n}` : tool)).join(" + ");
      const dur = Math.max(1, Math.round((g[g.length - 1].at - g[0].at) / 1000));
      tl.append(el("div", {
        class: `ctl-row ctl-group mono${open ? " open" : ""}`,
        title: open ? t("team.collapseGroup") : t("team.expandGroup", g.length),
        onClick: () => { if (open) expandedGroups.delete(key); else expandedGroups.add(key); render(); },
      },
        el("span", { class: "ctl-sigil", text: g[0].glyph }),
        el("span", { class: "ctl-worker", text: g[0].worker }),
        el("span", { class: "ctl-tool", text: tools }),
        el("span", { class: "ctl-sum", text: g[g.length - 1].summary }),
        el("span", { class: "ctl-at dim", text: t("team.elapsedSec", dur) }),
        el("span", { class: "ctl-chev dim", text: open ? "▾" : "▸" }),
      ));
      if (open) for (const e of g) tl.append(timelineRow(e, true));
    }
    host.append(tl);
    tl.scrollTop = tl.scrollHeight;
  }

  if (r.needsCall) {
    const call = r.needsCall;
    host.append(
      el("div", { class: "needs-call materialize" },
        el("div", { class: "nc-title", text: t("team.needsCallTitle", call.sliceId) }),
        el("div", { class: "nc-error mono dim", text: call.error }),
        el("div", { class: "nc-actions" },
          el("button", { class: "btn btn-primary", text: t("team.retry"), onClick: () => void window.ide.team.needsCall("retry") }),
          el("button", {
            class: "btn", text: t("team.editSliceBtn"),
            onClick: () => {
              const s = r.slices.find((x) => x.id === call.sliceId);
              void inputDialog({ title: t("team.rescopeTitle", call.sliceId), message: t("team.rescopeMsg"), value: s?.scope ?? "" })
                .then((scope) => { if (scope !== null) void window.ide.team.needsCall("retry", scope); });
            },
          }),
          el("button", { class: "btn btn-danger", text: t("team.abortRun"), onClick: () => void window.ide.team.needsCall("abort") }),
        ),
      ),
    );
  }

  // the ONE final message (Part 3 §4): the lead's report, green-edged
  if (r.phase === "done" && r.report) {
    const rep = el("div", { class: "dsp-final md materialize" });
    rep.innerHTML = marked.parse(r.report, { async: false });
    host.append(rep);
  }
}

// ---- stalled / restart honesty

function renderStalled(body: HTMLElement, r: TeamRunState): void {
  clear(body);
  body.append(
    el("div", { class: "team-stalled materialize" },
      el("div", { class: "ts-title", text: r.didNotSurvive ? t("team.didNotSurvive") : t("team.stalledTitle") }),
      el("div", { class: "dim", text: r.didNotSurvive
        ? t("team.didNotSurviveMsg")
        : t("team.stalledMsg") }),
      el("div", { class: "ts-goal mono", text: r.goal }),
      r.slices.length ? renderDag(r.slices, { clickable: false }) : null,
      el("div", { class: "tg-actions" },
        el("button", { class: "btn btn-ghost", text: t("team.dismiss"), onClick: () => void window.ide.team.clear() }),
        el("button", {
          class: "btn btn-primary", text: t("team.restartRun"),
          onClick: () => void window.ide.team.restartRun().then((res) => {
            if (!res.ok) toast(res.error ?? t("team.restartFailed"), { crit: true });
          }),
        }),
      ),
    ),
  );
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
