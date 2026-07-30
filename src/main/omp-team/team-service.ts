import type { IpcMain } from "electron";
import { app, BrowserWindow } from "electron";
import * as fs from "node:fs";
import { join } from "node:path";
import type {
  OmpEvent,
  TeamAgent,
  TeamFeedEntry,
  TeamRunState,
  TeamSlice,
} from "../../shared/types";
import { getAgentBridge, onNewSession, type AgentBridge } from "../omp-service";

/**
 * Team Mode orchestration adapter (spec: omp-ide-agent-team-prompt.md).
 *
 * == OMP multi-agent surface (discovered from omp v17.1.3, 2026-07-30) ==
 * The harness's own primitives run the crew:
 *   - `task` tool  — batch-spawns background subagents (tasks[], agent types,
 *     effort); results auto-deliver into the spawning session on yield.
 *   - `hub` tool   — inter-agent messaging (send/wait/jobs/cancel) and parked
 *     event-driven wait states: `hub wait` blocks until a job settles or a
 *     message arrives. This IS the sleep/wake primitive — no polling.
 * Subagent lifecycle is NOT surfaced as dedicated frames in the root RPC
 * stream (only the task/hub tool_execution frames are visible), so the
 * orchestrating agent narrates team state through the marker protocol below.
 * The IDE parses markers into authoritative state; it never simulates agents.
 *
 * == Marker protocol (agent → IDE) ==
 * One event per line, alone on the line, minified JSON:
 *   @@TEAM@@ {"ev":"probe","ok":true|false,"detail"?}
 *   @@TEAM@@ {"ev":"planners","agents":[{"name","glyph"}...]}
 *   @@TEAM@@ {"ev":"say","who","text"}
 *   @@TEAM@@ {"ev":"round","n"}
 *   @@TEAM@@ {"ev":"converged","forced":bool}
 *   @@TEAM@@ {"ev":"plan","summary","workers":[{"name","glyph"}],"slices":[...]}
 *   @@TEAM@@ {"ev":"worker","name","state","slice"?,"waitingFor"?}
 *   @@TEAM@@ {"ev":"slice","id","state","handoff"?,"add"?,"del"?,"error"?}
 *   @@TEAM@@ {"ev":"replan","slices":[...],"note"}
 *   @@TEAM@@ {"ev":"needs-call","slice","error"}
 *   @@TEAM@@ {"ev":"verify","result":"gap"|"pass","note"}
 *   @@TEAM@@ {"ev":"report","text"}
 * Non-marker text is relayed into the feed attributed to the lead planner —
 * nothing the model says is hidden, nothing is fabricated.
 *
 * == Environment reality ==
 * The capability probe in this environment (2026-07-30) produced zero model
 * turns from a trivial scout spawn — the probe-fail → solo-fallback path is
 * the expected live path here, per spec §2. Solo runs the SAME pipeline
 * sequentially; the dependency graph still gates execution order, so
 * sleep/wake transitions remain real state, just time-multiplexed.
 */

/** phases in which a run is live (persisted, stream-tapped, steerable) */
const LIVE_PHASE: Partial<Record<TeamRunState["phase"], true>> = {
  probe: true,
  deliberate: true,
  gate: true,
  execute: true,
  verify: true,
};
const MAX_FEED = 500;
const MARKER = "@@TEAM@@";

let bridge: AgentBridge | null = null;
let run: TeamRunState | null = null;
/** accumulated non-marker prose per streaming message (flushed to feed) */
const proseBuf = new Map<number, string>();
/** partial-line tail per streaming message */
const lineBuf = new Map<number, string>();
/** remote gate notifier (Telegram bridge registers; null = remote absent) */
let gateNotifier: ((packet: { runId: string; goal: string; summary: string; slices: TeamSlice[]; solo: boolean }) => void) | null = null;

export function registerTeamGateNotifier(
  fn: ((packet: { runId: string; goal: string; summary: string; slices: TeamSlice[]; solo: boolean }) => void) | null,
): void {
  gateNotifier = fn;
}

// -------------------------------------------------- persistence (restart honesty)

function persistPath(): string {
  return join(app.getPath("userData"), "team-run.json");
}

function persist(): void {
  try {
    if (run && LIVE_PHASE[run.phase]) {
      fs.writeFileSync(persistPath(), JSON.stringify(run));
    } else {
      fs.rmSync(persistPath(), { force: true });
    }
  } catch {
    // best-effort — a failed persist only degrades the restart notice
  }
}

/** On boot: a live run on disk means the app died mid-run. P0 = no resume. */
function loadStale(): void {
  try {
    const raw = fs.readFileSync(persistPath(), "utf8");
    const saved = JSON.parse(raw) as TeamRunState;
    if (LIVE_PHASE[saved.phase]) {
      saved.didNotSurvive = true;
      saved.phase = "stalled";
      run = saved;
    }
    fs.rmSync(persistPath(), { force: true });
  } catch {
    // no stale run
  }
}

// -------------------------------------------------- state fan-out

function pushState(): void {
  persist();
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.webContents.isDestroyed()) win.webContents.send("team:state", run);
  }
}

function feed(entry: Omit<TeamFeedEntry, "at">): void {
  if (!run) return;
  run.feed.push({ ...entry, at: Date.now() });
  if (run.feed.length > MAX_FEED) run.feed.splice(0, run.feed.length - MAX_FEED);
}

function sysNote(text: string): void {
  feed({ author: "team", text, kind: "system" });
}

// -------------------------------------------------- plan graph validation

/** true when `deps` edges over `slices` contain a cycle */
function hasCycle(slices: TeamSlice[]): boolean {
  const byId = new Map(slices.map((s) => [s.id, s]));
  const state = new Map<string, 0 | 1 | 2>(); // 0 unvisited, 1 in-stack, 2 done
  const visit = (id: string): boolean => {
    const st = state.get(id) ?? 0;
    if (st === 1) return true;
    if (st === 2) return false;
    state.set(id, 1);
    for (const dep of byId.get(id)?.deps ?? []) {
      if (byId.has(dep) && visit(dep)) return true;
    }
    state.set(id, 2);
    return false;
  };
  return slices.some((s) => visit(s.id));
}

function normalizeSlices(raw: unknown): TeamSlice[] {
  if (!Array.isArray(raw)) return [];
  const out: TeamSlice[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    if (typeof r.id !== "string" || typeof r.title !== "string") continue;
    out.push({
      id: r.id,
      title: r.title,
      scope: typeof r.scope === "string" ? r.scope : "",
      worker: typeof r.worker === "string" ? r.worker : "lead",
      deps: Array.isArray(r.deps) ? r.deps.filter((d): d is string => typeof d === "string") : [],
      contract: typeof r.contract === "string" ? r.contract : undefined,
      state: r.state === "done" || r.state === "active" || r.state === "failed" || r.state === "replanned"
        ? r.state : "pending",
      handoff: typeof r.handoff === "string" ? r.handoff : undefined,
      add: typeof r.add === "number" ? r.add : 0,
      del: typeof r.del === "number" ? r.del : 0,
    });
  }
  return out;
}

// -------------------------------------------------- marker event application

function applyMarker(raw: string): void {
  if (!run || !LIVE_PHASE[run.phase]) return;
  let ev: Record<string, unknown>;
  try {
    ev = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return; // malformed marker — ignored, prose path already skipped it
  }
  switch (ev.ev) {
    case "probe": {
      if (run.phase !== "probe") break;
      run.solo = ev.ok !== true;
      run.phase = "deliberate";
      sysNote(
        run.solo
          ? `capability probe failed (${typeof ev.detail === "string" ? ev.detail.slice(0, 160) : "no subagent round-trip"}) — solo fallback: same pipeline, sequential`
          : "capability probe passed — multi-agent crew",
      );
      break;
    }
    case "planners": {
      if (run.phase !== "deliberate") break;
      const agents = Array.isArray(ev.agents) ? ev.agents : [];
      run.agents = agents
        .filter((a): a is { name: string; glyph?: string } => !!a && typeof (a as Record<string, unknown>).name === "string")
        .slice(0, 3)
        .map((a) => ({
          name: a.name,
          glyph: typeof a.glyph === "string" && a.glyph ? a.glyph.slice(0, 2) : "◆",
          kind: "planner" as const,
          state: "deliberating" as const,
          sinceMs: Date.now(),
          filesTouched: 0,
        }));
      break;
    }
    case "say": {
      if (typeof ev.who === "string" && typeof ev.text === "string") {
        feed({ author: ev.who, glyph: run.agents.find((a) => a.name === ev.who)?.glyph, text: ev.text, kind: "argument" });
      }
      break;
    }
    case "round": {
      if (typeof ev.n === "number") {
        run.round = ev.n;
        sysNote(`round ${ev.n}/${run.maxRounds}`);
      }
      break;
    }
    case "converged": {
      sysNote(ev.forced === true ? "convergence forced — lead planner wrote the final plan from the strongest surviving points" : "planners converged");
      break;
    }
    case "plan": {
      if (run.phase !== "deliberate") break;
      const slices = normalizeSlices(ev.slices);
      if (!slices.length || hasCycle(slices)) {
        sysNote("plan event rejected: empty or cyclic slice graph");
        break;
      }
      run.slices = slices;
      run.planSummary = typeof ev.summary === "string" ? ev.summary : "";
      const workers = Array.isArray(ev.workers) ? ev.workers : [];
      const workerAgents: TeamAgent[] = workers
        .filter((w): w is { name: string; glyph?: string } => !!w && typeof (w as Record<string, unknown>).name === "string")
        .slice(0, 6)
        .map((w) => ({
          name: w.name,
          glyph: typeof w.glyph === "string" && w.glyph ? w.glyph.slice(0, 2) : "●",
          kind: "worker" as const,
          state: "sleeping" as const,
          sinceMs: Date.now(),
          filesTouched: 0,
        }));
      for (const p of run.agents) if (p.kind === "planner") p.state = "done";
      run.agents = [...run.agents.filter((a) => a.kind === "planner"), ...workerAgents];
      run.phase = "gate";
      sysNote("plan converged — awaiting your approval");
      gateNotifier?.({ runId: run.runId, goal: run.goal, summary: run.planSummary, slices: run.slices, solo: run.solo });
      break;
    }
    case "worker": {
      if (run.phase !== "execute" && run.phase !== "verify") break;
      if (typeof ev.name !== "string") break;
      const w = run.agents.find((a) => a.name === ev.name);
      if (!w || w.kind !== "worker") break;
      const st = ev.state;
      if (st === "working" || st === "sleeping" || st === "waking" || st === "done" || st === "failed") {
        w.state = st;
        w.sinceMs = Date.now();
        w.slice = typeof ev.slice === "string" ? ev.slice : st === "sleeping" ? undefined : w.slice;
        w.waitingFor = Array.isArray(ev.waitingFor)
          ? ev.waitingFor.filter((d): d is string => typeof d === "string")
          : undefined;
        if (st === "working" && w.slice) {
          const s = run.slices.find((x) => x.id === w.slice);
          if (s && s.state === "pending") s.state = "active";
        }
      }
      break;
    }
    case "slice": {
      if (run.phase !== "execute" && run.phase !== "verify") break;
      if (typeof ev.id !== "string") break;
      const s = run.slices.find((x) => x.id === ev.id);
      if (!s) break;
      const st = ev.state;
      if (st === "active" || st === "done" || st === "failed" || st === "replanned") s.state = st;
      if (typeof ev.handoff === "string") s.handoff = ev.handoff;
      if (typeof ev.add === "number") s.add = ev.add;
      if (typeof ev.del === "number") s.del = ev.del;
      if (st === "failed") {
        sysNote(`slice ${s.id} failed: ${typeof ev.error === "string" ? ev.error.slice(0, 200) : "unknown error"}`);
      }
      break;
    }
    case "replan": {
      if (run.phase !== "execute" && run.phase !== "verify") break;
      const slices = normalizeSlices(ev.slices);
      if (!slices.length || hasCycle(slices)) {
        sysNote("re-plan rejected: empty or cyclic slice graph");
        break;
      }
      run.slices = slices;
      sysNote(`plan edited: ${typeof ev.note === "string" ? ev.note.slice(0, 300) : "orchestrator re-planned"}`);
      break;
    }
    case "needs-call": {
      if (run.phase !== "execute" && run.phase !== "verify") break;
      run.needsCall = {
        sliceId: typeof ev.slice === "string" ? ev.slice : "",
        error: typeof ev.error === "string" ? ev.error.slice(0, 600) : "two consecutive failures",
      };
      sysNote("team paused — needs your call");
      break;
    }
    case "verify": {
      if (run.phase !== "execute" && run.phase !== "verify") break;
      run.phase = "verify";
      sysNote(
        ev.result === "pass"
          ? `verification passed${typeof ev.note === "string" ? ` — ${ev.note.slice(0, 300)}` : ""}`
          : `verification found a gap${typeof ev.note === "string" ? ` — ${ev.note.slice(0, 300)}` : ""}`,
      );
      break;
    }
    case "report": {
      if (run.phase !== "execute" && run.phase !== "verify") break;
      run.report = typeof ev.text === "string" ? ev.text : "";
      run.phase = "done";
      for (const a of run.agents) if (a.state !== "failed") a.state = "done";
      sysNote("run complete — team report delivered");
      break;
    }
    default:
      break;
  }
}

// -------------------------------------------------- agent stream tap

function flushProse(messageId: number): void {
  const text = proseBuf.get(messageId);
  proseBuf.delete(messageId);
  if (!run || !text) return;
  const trimmed = text.trim();
  if (!trimmed) return;
  feed({ author: "lead", text: trimmed.slice(0, 2000), kind: "argument" });
}

function consumeLine(messageId: number, line: string): void {
  const t = line.trim();
  if (t.startsWith(MARKER)) {
    flushProse(messageId); // keep prose/marker ordering in the feed
    applyMarker(t.slice(MARKER.length).trim());
  } else if (t) {
    proseBuf.set(messageId, (proseBuf.get(messageId) ?? "") + line + "\n");
  }
}

function onAgentEvent(e: OmpEvent): void {
  if (!run) return;
  const live = LIVE_PHASE[run.phase] === true;
  switch (e.kind) {
    case "text-delta": {
      if (!live) break;
      let buf = (lineBuf.get(e.messageId) ?? "") + e.delta;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        consumeLine(e.messageId, buf.slice(0, nl));
        buf = buf.slice(nl + 1);
      }
      lineBuf.set(e.messageId, buf);
      pushState();
      break;
    }
    case "text-end": {
      if (!live) break;
      const tail = lineBuf.get(e.messageId) ?? "";
      lineBuf.delete(e.messageId);
      if (tail) consumeLine(e.messageId, tail);
      flushProse(e.messageId);
      pushState();
      break;
    }
    case "tool-end": {
      // live files-touched attribution: the working worker owns edits observed
      // in the root stream (solo mode = full fidelity; multi-agent slices also
      // report add/del in their done events)
      if (!live || !e.fileEdit || (run.phase !== "execute" && run.phase !== "verify")) break;
      const working = run.agents.find((a) => a.kind === "worker" && a.state === "working");
      if (working) {
        working.filesTouched++;
        const s = working.slice ? run.slices.find((x) => x.id === working.slice) : undefined;
        if (s) {
          const lines = e.fileEdit.newText.split("\n").length - e.fileEdit.oldText.split("\n").length;
          if (lines >= 0) s.add += lines || 1;
          else s.del += -lines;
        }
        pushState();
      }
      break;
    }
    case "agent-end": {
      if (!live) break;
      lineBuf.clear();
      for (const id of [...proseBuf.keys()]) flushProse(id);
      if (e.aborted) {
        run.phase = "stopped";
        sysNote("run interrupted — board frozen in its last state");
      } else if (run.phase === "probe" || run.phase === "deliberate") {
        run.phase = "stalled";
        sysNote("the deliberation turn ended without a converged plan — run stalled");
      } else if ((run.phase === "execute" || run.phase === "verify") && !run.needsCall) {
        run.phase = "stalled";
        sysNote("the execution turn ended without a report — run stalled");
      }
      // gate: the deliberation turn legitimately ends after the plan event
      // needs-call: the turn legitimately ends awaiting the user's decision
      pushState();
      break;
    }
    case "turn-error": {
      if (!live) break;
      run.phase = "stalled";
      sysNote(`provider error ended the run: ${e.message.slice(0, 200)}`);
      pushState();
      break;
    }
    default:
      break;
  }
}

// -------------------------------------------------- prompts

function protocolBlock(): string {
  return [
    "STATE PROTOCOL — the IDE renders a live team board from your output.",
    `Every state change is ONE line, alone on its line: ${MARKER} {minified JSON}.`,
    "Events (emit them at the moment they happen, never batched at the end):",
    `  ${MARKER} {"ev":"probe","ok":true|false,"detail":"why"}`,
    `  ${MARKER} {"ev":"planners","agents":[{"name":"Vex","glyph":"◆"},{"name":"Ora","glyph":"▲"}]}`,
    `  ${MARKER} {"ev":"say","who":"Vex","text":"one argument"}`,
    `  ${MARKER} {"ev":"round","n":2}`,
    `  ${MARKER} {"ev":"converged","forced":false}`,
    `  ${MARKER} {"ev":"plan","summary":"one line","workers":[{"name":"Kilo","glyph":"●"}],"slices":[{"id":"A","title":"...","scope":"one line","worker":"Kilo","deps":[],"contract":"types/files/signatures fixed before fan-out"}]}`,
    `  ${MARKER} {"ev":"worker","name":"Kilo","state":"working|sleeping|waking|done|failed","slice":"A","waitingFor":["B","C"]}`,
    `  ${MARKER} {"ev":"slice","id":"A","state":"active|done|failed","handoff":"one paragraph: what changed, where, what to watch for","add":12,"del":3,"error":"on failure"}`,
    `  ${MARKER} {"ev":"replan","slices":[FULL updated slice array],"note":"what changed and why"}`,
    `  ${MARKER} {"ev":"needs-call","slice":"A","error":"..."}`,
    `  ${MARKER} {"ev":"verify","result":"gap|pass","note":"evidence"}`,
    `  ${MARKER} {"ev":"report","text":"what was built, per-slice summary, verification evidence"}`,
    "Slice ids are short (A, B, C…). Worker names are short codenames, glyphs single characters.",
  ].join("\n");
}

function deliberationPrompt(goal: string): string {
  return [
    "[TEAM MODE — deliberation run. Follow the protocol exactly.]",
    "",
    protocolBlock(),
    "",
    `GOAL:\n${goal}`,
    "",
    "PHASE 0 — CAPABILITY PROBE (first, before anything):",
    "- Spawn ONE trivial subagent (task tool, agent \"scout\", instruction: reply PONG). Bound the wait to 60 seconds (hub wait with timeoutMs).",
    `- Round-trip works → ${MARKER} {"ev":"probe","ok":true} and run the crew as real subagents.`,
    `- No reply / failure / task tool unavailable → ${MARKER} {"ev":"probe","ok":false,"detail":"..."} and run SOLO: you play every role yourself, honestly labeled through the same events. Same pipeline, sequential execution.`,
    "",
    "PHASE 1 — DELIBERATE (hard cap: 3 rounds):",
    "- Pick 2 planners (3 only if the goal spans 3+ subsystems). Emit the planners event.",
    "- The planners argue COMPETING approaches: each proposes a distinct approach, then attacks the other's weak points. Relay every argument as a say event (multi-agent: relay subagent messages; solo: write each planner's case yourself, honestly attributed). Emit a round event at each round start.",
    "- Mid-debate user notes arrive as \"[note to planners]: ...\" — planners must visibly address them.",
    "- Converge naturally, or at round 3 force it: the lead planner writes the final plan from the strongest surviving points and you emit converged with forced:true.",
    "",
    "PHASE 2 — PLAN:",
    "- Slices are small and independently verifiable; cross-slice contracts (types, file boundaries, API signatures) are FIXED in the contract field before any fan-out. Max 6 workers.",
    "- The FINAL slice is always a verification slice: exercise the built thing against the goal (run it, drive it, test it).",
    "- Emit the plan event, then END YOUR TURN IMMEDIATELY. Execute NOTHING — no file edits, no build commands. The user approves or edits the plan in the IDE; execution starts only when an approval message arrives.",
  ].join("\n");
}

function executionPrompt(r: TeamRunState): string {
  const plan = JSON.stringify(
    r.slices.map((s) => ({ id: s.id, title: s.title, scope: s.scope, worker: s.worker, deps: s.deps, contract: s.contract ?? "" })),
  );
  return [
    `[TEAM MODE — plan approved via ${r.approvedVia ?? "IDE"}. Execute it now.]`,
    "",
    protocolBlock(),
    "",
    `GOAL:\n${r.goal}`,
    "",
    `FINAL PLAN (user-approved — contracts are fixed, do not renegotiate them mid-flight):\n${plan}`,
    "",
    `MODE: ${r.solo ? "SOLO fallback (probe failed earlier). Play each worker yourself, in dependency order — the graph still gates what may run; a role with unmet deps is asleep." : "MULTI-AGENT. Spawn workers via the task tool; sleeping workers use hub wait (event-driven, no polling)."}`,
    "",
    "EXECUTION RULES:",
    "- Narrate every transition the moment it happens: worker working/sleeping (with waitingFor)/waking/done/failed; slice active/done/failed.",
    "- A finished slice ALWAYS carries a hand-off note (one paragraph: what changed, where, what to watch for) and add/del line counts. A woken dependent's first activity must reference the hand-off notes of its completed dependencies.",
    "- A worker that discovers a broken contract reports it; you re-plan that seam and emit a replan event (full updated slice array + note). Retry, reassign or split — your call, but visible.",
    "- TWO consecutive failures on the SAME slice: emit needs-call and END YOUR TURN. The user decides (retry / edit slice / abort); their decision arrives as a message.",
    "- Steering arrives as \"[steer → Worker]: ...\" (only that worker acts on it) or \"[team note]: ...\" (all awake workers).",
    "- VERIFY (the final slice): actually exercise the result against the goal. Gap found → verify{gap} + replan adding a gap slice + keep executing. Pass → verify{pass} with evidence.",
    "- Then emit the report event (what was built, per-slice diffstats, verification evidence) and END YOUR TURN.",
  ].join("\n");
}

// -------------------------------------------------- public actions

function startRun(goal: string): { ok: boolean; error?: string } {
  const b = bridge!;
  const st = b.getStatus();
  if (!st || st.state === "unavailable" || st.state === "dead" || st.state === "starting")
    return { ok: false, error: "agent is not running" };
  if (run && LIVE_PHASE[run.phase]) return { ok: false, error: "a team run is already active" };
  const trimmed = goal.trim();
  if (!trimmed) return { ok: false, error: "empty goal" };
  run = {
    runId: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    goal: trimmed,
    phase: "probe",
    solo: false,
    round: 0,
    maxRounds: 3,
    agents: [],
    slices: [],
    planSummary: "",
    feed: [],
    needsCall: null,
    approvedVia: null,
    startedAt: Date.now(),
    report: null,
  };
  sysNote("probing subagent capability (60s cap)…");
  if (!b.prompt(deliberationPrompt(trimmed))) {
    run = null;
    return { ok: false, error: "failed to reach the agent process" };
  }
  pushState();
  return { ok: true };
}

/** first decision wins across the IDE button and Telegram */
function approve(via: string): { ok: boolean; error?: string } {
  if (!run || run.phase !== "gate") return { ok: false, error: run?.approvedVia ? `already approved via ${run.approvedVia}` : "no plan awaiting approval" };
  if (hasCycle(run.slices)) return { ok: false, error: "the slice graph has a cycle — fix it first" };
  run.approvedVia = via;
  run.phase = "execute";
  run.needsCall = null;
  sysNote(`plan approved via ${via} — building`);
  bridge!.prompt(executionPrompt(run));
  pushState();
  return { ok: true };
}

function discard(): void {
  if (!run || run.phase !== "gate") return;
  run.phase = "stopped";
  sysNote("plan discarded");
  const dead = run;
  pushState();
  // returning to the plain prompt = no run to render
  if (run === dead) run = null;
  pushState();
}

function steer(text: string, target?: string): boolean {
  // gate excluded: the turn has ended; the plan is edited through the gate UI
  if (!run || !LIVE_PHASE[run.phase] || run.phase === "gate") return false;
  const t = text.trim();
  if (!t) return false;
  let message: string;
  if (run.phase === "probe" || run.phase === "deliberate") {
    message = `[note to planners]: ${t}`;
    feed({ author: "you", text: t, kind: "note" });
  } else if (target) {
    message = `[steer → ${target}]: ${t}`;
    feed({ author: "you", text: `→ ${target}: ${t}`, kind: "note" });
  } else {
    message = `[team note]: ${t}`;
    feed({ author: "you", text: t, kind: "note" });
  }
  const ok = bridge!.prompt(message);
  pushState();
  return ok;
}

// ---- gate editing (main owns the plan; every edit re-validates the graph)

function editSlice(id: string, patch: { title?: string; scope?: string }): { ok: boolean; error?: string } {
  if (!run || run.phase !== "gate") return { ok: false, error: "no editable plan" };
  const s = run.slices.find((x) => x.id === id);
  if (!s) return { ok: false, error: "unknown slice" };
  if (patch.title !== undefined) {
    if (!patch.title.trim()) return { ok: false, error: "title cannot be empty" };
    s.title = patch.title.trim();
  }
  if (patch.scope !== undefined) s.scope = patch.scope.trim();
  pushState();
  return { ok: true };
}

function addSlice(input: { title: string; scope: string; deps: string[] }): { ok: boolean; error?: string } {
  if (!run || run.phase !== "gate") return { ok: false, error: "no editable plan" };
  if (!input.title.trim()) return { ok: false, error: "title cannot be empty" };
  // next free single-letter id, then S2, S3…
  const used = new Set(run.slices.map((s) => s.id));
  let id = "";
  for (let i = 0; i < 26; i++) {
    const c = String.fromCharCode(65 + i);
    if (!used.has(c)) { id = c; break; }
  }
  if (!id) { let n = 2; while (used.has(`S${n}`)) n++; id = `S${n}`; }
  const deps = input.deps.filter((d) => used.has(d));
  const worker = run.agents.find((a) => a.kind === "worker")?.name ?? "lead";
  const next = [...run.slices, {
    id, title: input.title.trim(), scope: input.scope.trim(), worker, deps,
    state: "pending" as const, add: 0, del: 0,
  }];
  if (hasCycle(next)) return { ok: false, error: "that would create a cycle" };
  run.slices = next;
  pushState();
  return { ok: true };
}

function deleteSlice(id: string): { ok: boolean; error?: string } {
  if (!run || run.phase !== "gate") return { ok: false, error: "no editable plan" };
  if (!run.slices.some((s) => s.id === id)) return { ok: false, error: "unknown slice" };
  if (run.slices.length <= 1) return { ok: false, error: "a plan needs at least one slice" };
  run.slices = run.slices
    .filter((s) => s.id !== id)
    .map((s) => ({ ...s, deps: s.deps.filter((d) => d !== id) }));
  pushState();
  return { ok: true };
}

function setDeps(id: string, deps: string[]): { ok: boolean; error?: string } {
  if (!run || run.phase !== "gate") return { ok: false, error: "no editable plan" };
  const s = run.slices.find((x) => x.id === id);
  if (!s) return { ok: false, error: "unknown slice" };
  const ids = new Set(run.slices.map((x) => x.id));
  const clean = [...new Set(deps.filter((d) => ids.has(d) && d !== id))];
  const next = run.slices.map((x) => (x.id === id ? { ...x, deps: clean } : x));
  if (hasCycle(next)) return { ok: false, error: "that edge creates a cycle" };
  run.slices = next;
  pushState();
  return { ok: true };
}

function needsCallDecision(choice: "retry" | "abort", editedScope?: string): void {
  if (!run || !run.needsCall) return;
  const call = run.needsCall;
  run.needsCall = null;
  if (choice === "abort") {
    run.phase = "stopped";
    sysNote("team run aborted at your call");
    pushState();
    return;
  }
  const s = run.slices.find((x) => x.id === call.sliceId);
  if (editedScope !== undefined && s) s.scope = editedScope.trim();
  sysNote(editedScope !== undefined ? `slice ${call.sliceId} rescoped — retrying` : `retrying slice ${call.sliceId}`);
  bridge!.prompt(
    `[team gate] ${editedScope !== undefined ? `Slice ${call.sliceId} was rescoped to: ${editedScope.trim()}. ` : ""}Retry slice ${call.sliceId} now. Resume the state protocol from where you paused.`,
  );
  pushState();
}

function stopRun(): void {
  if (!run || !LIVE_PHASE[run.phase]) return;
  // the abort round-trip lands as agent-end{aborted} which freezes the board;
  // flip phase immediately so a dead process can't leave a zombie run
  bridge!.abort();
  run.phase = "stopped";
  sysNote("run interrupted — board frozen in its last state");
  pushState();
}

function clearRun(): void {
  run = null;
  pushState();
}

function restartRun(): { ok: boolean; error?: string } {
  if (!run) return { ok: false, error: "no run to restart" };
  const goal = run.goal;
  run = null;
  return startRun(goal);
}

// -------------------------------------------------- module surface

export function approveTeamFromRemote(runId: string, by: string): { ok: boolean; error?: string } {
  if (!run || run.runId !== runId) return { ok: false, error: "that plan is no longer active" };
  return approve(by);
}

export function registerTeamHandlers(ipc: IpcMain): void {
  bridge = getAgentBridge();
  loadStale();
  bridge.onEvent(onAgentEvent);
  onNewSession(() => {
    if (run && LIVE_PHASE[run.phase]) {
      run.phase = "stopped";
      sysNote("new agent session — team run ended");
      pushState();
    }
  });

  ipc.handle("team:getState", async (): Promise<TeamRunState | null> => run);
  ipc.handle("team:start", async (_e, goal: string) => startRun(String(goal ?? "")));
  ipc.handle("team:steer", async (_e, text: string, target?: string) => steer(String(text ?? ""), typeof target === "string" ? target : undefined));
  ipc.handle("team:approve", async () => approve("IDE"));
  ipc.handle("team:discard", async () => discard());
  ipc.handle("team:stop", async () => stopRun());
  ipc.handle("team:editSlice", async (_e, id: string, patch: { title?: string; scope?: string }) => editSlice(id, patch ?? {}));
  ipc.handle("team:addSlice", async (_e, input: { title: string; scope: string; deps: string[] }) =>
    addSlice({ title: String(input?.title ?? ""), scope: String(input?.scope ?? ""), deps: Array.isArray(input?.deps) ? input.deps : [] }));
  ipc.handle("team:deleteSlice", async (_e, id: string) => deleteSlice(String(id ?? "")));
  ipc.handle("team:setDeps", async (_e, id: string, deps: string[]) => setDeps(String(id ?? ""), Array.isArray(deps) ? deps : []));
  ipc.handle("team:needsCall", async (_e, choice: "retry" | "abort", editedScope?: string) =>
    needsCallDecision(choice === "abort" ? "abort" : "retry", typeof editedScope === "string" ? editedScope : undefined));
  ipc.handle("team:clear", async () => clearRun());
  ipc.handle("team:restartRun", async () => restartRun());
}

export function disposeTeam(): void {
  persist(); // a live run at quit stays on disk → restart-honesty notice
}
