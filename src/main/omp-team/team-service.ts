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
  TeamTimelineEntry,
} from "../../shared/types";
import { getAgentBridge, onNewSession, whichOmp, type AgentBridge } from "../omp-service";
import { currentOmpPath } from "../store-service";
import { startWorker, killWorker, killAllWorkers, steerWorker, liveWorkerCount, liveWorkerPids } from "./worker-pool";

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

/** run-completion packet for the ONE final Telegram answer (message economy) */
export interface TeamEndPacket {
  goal: string;
  report: string;
  slices: { id: string; title: string; add: number; del: number; files?: string[] }[];
  elapsedMs: number;
}

/** remote end notifier — fired exactly once per run, when it completes */
let endNotifier: ((packet: TeamEndPacket) => void) | null = null;

export function registerTeamEndNotifier(fn: ((packet: TeamEndPacket) => void) | null): void {
  endNotifier = fn;
}

function fireEndNotifier(): void {
  if (!run || !endNotifier) return;
  endNotifier({
    goal: run.goal,
    report: run.report ?? "",
    slices: run.slices.map((s) => ({ id: s.id, title: s.title, add: s.add, del: s.del, ...(s.files ? { files: s.files } : {}) })),
    elapsedMs: Date.now() - (run.feed[0]?.at ?? Date.now()),
  });
}

/** read-only: a team run is mid-flight (Telegram treats the whole run as ONE task) */
export function isTeamRunActive(): boolean {
  return !!run && run.phase !== "done" && run.phase !== "stopped" && run.phase !== "stalled";
}

/** read-only live-state slice for the Telegram digest (never plan/summary prose) */
export function teamDigestData(): { phase: string; active: string[]; done: number; total: number } | null {
  if (!isTeamRunActive()) return null;
  return {
    phase: run!.phase,
    active: run!.slices.filter((s) => s.state === "active").map((s) => `slice ${s.id}`),
    done: run!.slices.filter((s) => s.state === "done").length,
    total: run!.slices.length,
  };
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
      files: Array.isArray(r.files) ? r.files.filter((f): f is string => typeof f === "string").slice(0, 40) : undefined,
    });
  }
  return out;
}

/**
 * Disjoint-files discipline (crew-rail §2): planned write-sets assign file
 * ownership per slice; overlapping slices are forced onto a dependency edge
 * (serialized) at plan validation. The auto-added edge is marked in autoDeps
 * so the gate renders it with its tooltip. Deterministic direction: the later
 * slice (by array order) serializes AFTER the earlier one.
 */
function serializeOverlaps(slices: TeamSlice[]): void {
  const norm = (f: string) => f.replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
  for (let i = 0; i < slices.length; i++) {
    const a = slices[i];
    if (!a.files?.length) continue;
    const aset = new Set(a.files.map(norm));
    for (let j = i + 1; j < slices.length; j++) {
      const b = slices[j];
      if (!b.files?.length) continue;
      const shared = b.files.filter((f) => aset.has(norm(f)));
      if (!shared.length) continue;
      // already ordered? (either direction, direct edge) — nothing to add
      if (b.deps.includes(a.id) || a.deps.includes(b.id)) continue;
      const next = slices.map((s) => (s.id === b.id ? { ...s, deps: [...s.deps, a.id] } : s));
      if (hasCycle(next)) continue; // ordering exists transitively the other way
      b.deps = [...b.deps, a.id];
      b.autoDeps = [...(b.autoDeps ?? []), a.id];
      sysNote(`serialized ${a.id} → ${b.id}: both touch ${shared[0]}`);
    }
  }
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
      // deterministic sigils from the ordered glyph set (crew-rail §3): the
      // model may propose glyphs, but assignment is ours — stable + unique
      run.planSummary = typeof ev.summary === "string" ? ev.summary : "";
      serializeOverlaps(run.slices);
      const workers = Array.isArray(ev.workers) ? ev.workers : [];
      const SIGILS = ["◆", "▲", "●", "■", "◇", "✚"];
      const workerAgents: TeamAgent[] = workers
        .filter((w): w is { name: string; glyph?: string } => !!w && typeof (w as Record<string, unknown>).name === "string")
        .slice(0, 6)
        .map((w, i) => ({
          name: w.name,
          glyph: SIGILS[i % SIGILS.length],
          kind: "worker" as const,
          state: "sleeping" as const,
          sinceMs: Date.now(),
          filesTouched: 0,
          add: 0,
          del: 0,
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
      // needs-call means PAUSED: the user owns the next move. A model that
      // keeps narrating past the pause must not complete the run underneath
      // the decision card.
      if (run.phase !== "execute" && run.phase !== "verify") break;
      if (run.needsCall) break;
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
      if (run.needsCall) break;
      run.report = typeof ev.text === "string" ? ev.text : "";
      run.phase = "done";
      for (const a of run.agents) if (a.state !== "failed") a.state = "done";
      sysNote("run complete — team report delivered");
      fireEndNotifier();
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
      } else if ((run.phase === "execute" || run.phase === "verify") && !run.needsCall && !poolActive) {
        // pool mode: the LEAD session ending a turn is normal — workers run in
        // their own processes; only the lead-orchestrated path can stall here
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
      // NOT fatal by itself: omp retries transient provider failures within
      // the same run (stream timeouts, 5xx). Flipping to stalled here would
      // freeze the board while the turn recovers and keeps emitting markers.
      // If the failure IS fatal, agent-end lands next and stalls the run.
      sysNote(`provider error mid-run (retrying): ${e.message.slice(0, 200)}`);
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
    `  ${MARKER} {"ev":"plan","summary":"one line","workers":[{"name":"Kilo","glyph":"●"}],"slices":[{"id":"A","title":"...","scope":"one line","worker":"Kilo","deps":[],"contract":"types/files/signatures fixed before fan-out","files":["src/a.ts","src/b.ts"]}]}`,
    "  (files = the slice's planned write-set — REQUIRED; the IDE serializes slices whose write-sets overlap)",
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
    "- Do NOT restate the plan in prose — the IDE renders it from the plan event; that event line is the only place the full plan appears.",
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

// -------------------------------------------------- process-level parallelism
//
// Mechanism ladder (crew-rail §2):
//  1. Harness-native subagents — probed in deliberation as before. DIAGNOSIS
//     (2026-07-30, time-boxed per spec): spawns via the task tool create job
//     entries but produce ZERO model turns in this environment; hub wait
//     times out with no reply. Root cause sits inside the harness's subagent
//     scheduler (no requests ever reach a provider — confirmed via provider
//     logs), not in IDE config; no in-config fix exists on our side. The
//     probe therefore realistically lands on `ok:false` here.
//  2. Process-level parallelism (below) — one `omp --mode rpc` child per
//     active worker, cap 4, staggered ≥2s. The IDE-side orchestrator routes
//     lifecycle: start when runnable, collect hand-off, wake dependents.
//     Built unconditionally; THE guaranteed path.
//  3. Solo sequential — only if even process spawning fails (omp missing);
//     the badge then states the actual reason.

/** pool executor active for the current run's execute phase */
let poolActive = false;
/** consecutive failure count per slice id (two → needs-call) */
const failCounts = new Map<string, number>();
/** per-slice live diffstat accumulated from worker tool calls */
const sliceRunStats = new Map<string, { add: number; del: number }>();

function timelinePush(entry: TeamTimelineEntry): void {
  if (!run) return;
  run.timeline = run.timeline ?? [];
  run.timeline.push(entry);
  if (run.timeline.length > 300) run.timeline.splice(0, run.timeline.length - 300);
}

function updateMechanism(): void {
  if (!run || !poolActive) return;
  const throttled = run.agents.filter((a) => a.state === "throttled").length;
  const live = liveWorkerCount();
  // badge truthfulness (crew-design §3): with exactly one live worker the
  // renderer shows `solo (reason)` — compute the honest reason here, from
  // the live process table + slice graph, never from the plan's width
  let singleReason: string | undefined;
  if (live === 1) {
    const done = new Set(run.slices.filter((s) => s.state === "done").map((s) => s.id));
    const pending = run.slices.filter((s) => s.state === "pending");
    const ready = pending.filter((s) => s.deps.every((d) => done.has(d))).length;
    singleReason =
      throttled > 0 ? "rate-limit" :
      ready > 0 ? "staggered start" :
      pending.length > 0 ? "deps" :
      "1 slice ready";
  }
  run.mechanism = { kind: "parallel", active: live, throttled, ...(singleReason ? { singleReason } : {}) };
}

function workerPrompt(r: TeamRunState, s: TeamSlice): string {
  const contracts = r.slices
    .filter((x) => x.contract)
    .map((x) => `  ${x.id}: ${x.contract}`)
    .join("\n");
  const handoffs = r.slices
    .filter((x) => s.deps.includes(x.id) && x.handoff)
    .map((x) => `  — ${x.id} (${x.title}): ${x.handoff}`)
    .join("\n");
  return [
    `[TEAM WORKER] You are worker "${s.worker}" on a crew executing a user-approved plan. You own slice ${s.id} and ONLY slice ${s.id}.`,
    "",
    `GOAL (whole team):\n${r.goal}`,
    "",
    `PLAN (context — other slices belong to other workers):\n${r.slices.map((x) => `  ${x.id} [${x.worker}] ${x.title}${x.deps.length ? ` (deps: ${x.deps.join(",")})` : ""}`).join("\n")}`,
    "",
    `YOUR SLICE ${s.id}: ${s.title}`,
    `SCOPE: ${s.scope}`,
    s.files?.length ? `PLANNED WRITE-SET (stay inside it): ${s.files.join(", ")}` : "",
    contracts ? `FIXED CONTRACTS (do NOT renegotiate):\n${contracts}` : "",
    handoffs ? `HAND-OFF NOTES from completed dependencies (build on them):\n${handoffs}` : "",
    "",
    "RULES:",
    "- Execute exactly your slice; do not touch files owned by other slices.",
    "- Verify your own work (run/exercise what you changed) before finishing.",
    "- END with a final message that STARTS with \"HANDOFF:\" — one paragraph: what changed, where, what to watch for.",
  ].filter(Boolean).join("\n");
}

function launchSlice(s: TeamSlice): void {
  const r = run!;
  const agent = r.agents.find((a) => a.name === s.worker && a.kind === "worker");
  // wake moment: chip materialize (waking) → working on confirmed spawn
  if (agent) {
    agent.state = "waking";
    agent.slice = s.id;
    agent.waitingFor = undefined;
    agent.sinceMs = Date.now();
  }
  s.state = "active";
  sliceRunStats.set(s.id, { add: 0, del: 0 });
  pushState();

  void startWorker({
    name: s.worker,
    root: bridge!.getRoot() ?? process.cwd(),
    prompt: workerPrompt(r, s),
    events: {
      onToolCall(call) {
        if (!run) return;
        const a = run.agents.find((x) => x.name === s.worker);
        if (a) a.lastActivity = `${call.tool} ${call.summary}`.slice(0, 120);
        if (call.editPath) {
          const stats = sliceRunStats.get(s.id);
          if (stats) {
            stats.add += call.add ?? 0;
            stats.del += call.del ?? 0;
          }
          if (a) {
            a.filesTouched++;
            a.add = (a.add ?? 0) + (call.add ?? 0);
            a.del = (a.del ?? 0) + (call.del ?? 0);
          }
        }
        timelinePush({ worker: s.worker, glyph: a?.glyph ?? "●", tool: call.tool, summary: call.summary, sliceId: s.id, at: call.at });
        pushState();
      },
      onThrottled(detail) {
        if (!run) return;
        const a = run.agents.find((x) => x.name === s.worker);
        if (a) { a.state = "throttled"; a.sinceMs = Date.now(); }
        sysNote(`${s.worker} throttled (rate limit): ${detail}`);
        updateMechanism();
        pushState();
      },
      onResumed() {
        if (!run) return;
        const a = run.agents.find((x) => x.name === s.worker);
        if (a) { a.state = "working"; a.sinceMs = Date.now(); }
        sysNote(`${s.worker} resumed after backoff`);
        updateMechanism();
        pushState();
      },
      onText() { /* worker prose is not relayed 1:1 — the hand-off lands at exit */ },
      onExit(result) {
        onWorkerExit(s.id, result.ok, result.text, result.error, result.aborted);
      },
    },
  }).then((res) => {
    if (!run) return;
    const a = run.agents.find((x) => x.name === s.worker);
    if (res.ok) {
      if (a && a.state === "waking") { a.state = "working"; a.sinceMs = Date.now(); }
    } else {
      if (a) a.state = "failed";
      s.state = "failed";
      sysNote(`${s.worker} failed to start: ${res.error}`);
    }
    updateMechanism();
    pushState();
  });
}

function onWorkerExit(sliceId: string, ok: boolean, text: string, error?: string, aborted?: boolean): void {
  if (!run || !poolActive) return;
  const s = run.slices.find((x) => x.id === sliceId);
  const a = s ? run.agents.find((x) => x.name === s.worker) : undefined;
  if (!s) return;
  if (aborted) return; // stop flow owns the board state

  if (ok) {
    const stats = sliceRunStats.get(s.id) ?? { add: 0, del: 0 };
    s.state = "done";
    s.add += stats.add;
    s.del += stats.del;
    const m = /HANDOFF:\s*([\s\S]+)/i.exec(text);
    s.handoff = (m ? m[1] : text).trim().slice(0, 1200) || "(no hand-off note)";
    failCounts.delete(s.id);
    if (a) {
      const more = run.slices.some((x) => x.worker === a.name && (x.state === "pending" || x.state === "active"));
      a.state = more ? "sleeping" : "done";
      a.slice = undefined;
      a.sinceMs = Date.now();
      a.lastActivity = `slice ${s.id} done`;
    }
    sysNote(`slice ${s.id} done — ${s.worker} handed off (+${s.add} −${s.del})`);
  } else {
    const n = (failCounts.get(s.id) ?? 0) + 1;
    failCounts.set(s.id, n);
    if (n >= 2) {
      s.state = "failed";
      if (a) { a.state = "failed"; a.sinceMs = Date.now(); }
      run.needsCall = { sliceId: s.id, error: (error ?? "worker failed twice").slice(0, 600) };
      sysNote(`slice ${s.id} failed twice — needs your call`);
      updateMechanism();
      pushState();
      return;
    }
    s.state = "pending"; // one visible retry
    if (a) { a.state = "sleeping"; a.slice = undefined; a.sinceMs = Date.now(); }
    sysNote(`slice ${s.id} failed (${(error ?? "unknown").slice(0, 160)}) — retrying`);
  }
  updateMechanism();
  scheduleSlices();
}

/** Core scheduler: start every runnable slice (deps done, owner free, cap 4). */
function scheduleSlices(): void {
  if (!run || run.phase !== "execute" || !poolActive || run.needsCall) {
    pushState();
    return;
  }
  const busy = new Set(
    run.agents.filter((a) => a.kind === "worker" && (a.state === "working" || a.state === "waking" || a.state === "throttled")).map((a) => a.name),
  );
  for (const s of run.slices) {
    if (s.state !== "pending") continue;
    if (liveWorkerCount() >= 4) break;
    const depsDone = s.deps.every((d) => run!.slices.find((x) => x.id === d)?.state === "done");
    if (!depsDone || busy.has(s.worker)) continue;
    busy.add(s.worker);
    launchSlice(s);
  }
  // sleeping bookkeeping: idle workers with future slices show what they wait for
  for (const a of run.agents) {
    if (a.kind !== "worker" || a.state !== "sleeping") continue;
    const nextSlice = run.slices.find((x) => x.worker === a.name && x.state === "pending");
    a.waitingFor = nextSlice ? nextSlice.deps.filter((d) => run!.slices.find((x) => x.id === d)?.state !== "done") : undefined;
  }
  updateMechanism();
  if (run.slices.every((x) => x.state === "done")) {
    finishParallelRun();
    return;
  }
  pushState();
}

function finishParallelRun(): void {
  if (!run) return;
  poolActive = false;
  const last = run.slices[run.slices.length - 1];
  run.report = [
    "## Team report (process-parallel run)",
    "",
    ...run.slices.map((s) => `**${s.id} · ${s.title}** — ${s.worker}, +${s.add} −${s.del}\n${s.handoff ?? ""}`),
    "",
    `Verification: ${last?.handoff ?? "see final slice hand-off"}`,
  ].join("\n");
  run.phase = "done";
  for (const a of run.agents) if (a.state !== "failed") a.state = "done";
  run.mechanism = { kind: "parallel", active: 0, throttled: 0 };
  sysNote("run complete — team report assembled from worker hand-offs");
  fireEndNotifier();
  pushState();
}

/** Mechanism ladder entry: called from approve() when the probe failed. */
async function beginParallelExecution(): Promise<void> {
  const r = run!;
  const bin = await whichOmp(currentOmpPath());
  if (!bin) {
    // rung 3 — honest solo with the ACTUAL reason
    r.mechanism = { kind: "solo", active: 1, throttled: 0, reason: "omp not found" };
    sysNote("solo: omp not found — the lead session executes sequentially");
    bridge!.prompt(executionPrompt(r));
    pushState();
    return;
  }
  poolActive = true;
  failCounts.clear();
  sliceRunStats.clear();
  r.timeline = [];
  r.mechanism = { kind: "parallel", active: 0, throttled: 0 };
  sysNote("execution: process-level parallelism (one omp per active worker, cap 4, ≥2s stagger)");
  scheduleSlices();
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
  if (run.solo) {
    // rung 1 passed earlier (probe ok): the lead session runs the crew itself
    // via harness subagents… except probe-ok is the rare case; solo=true means
    // the probe FAILED → rung 2: process-level parallelism (unconditional).
    void beginParallelExecution();
  } else {
    // harness-native subagents confirmed working — the lead session orchestrates
    run.mechanism = { kind: "parallel", active: 0, throttled: 0 };
    bridge!.prompt(executionPrompt(run));
  }
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
  // pool mode: targeted steering reaches the worker's own process; team notes
  // land in every live worker
  let ok: boolean;
  if (poolActive) {
    ok = target
      ? steerWorker(target, message)
      : run.agents.filter((a) => a.kind === "worker" && (a.state === "working" || a.state === "throttled"))
          .map((a) => steerWorker(a.name, message))
          .some(Boolean);
  } else {
    ok = bridge!.prompt(message);
  }
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
  if (poolActive && s) {
    // reset the failure ledger for a fresh pair of attempts and reschedule
    failCounts.delete(s.id);
    s.state = "pending";
    const a = run.agents.find((x) => x.name === s.worker);
    if (a && a.state === "failed") { a.state = "sleeping"; a.sinceMs = Date.now(); }
    scheduleSlices();
    return;
  }
  bridge!.prompt(
    `[team gate] ${editedScope !== undefined ? `Slice ${call.sliceId} was rescoped to: ${editedScope.trim()}. ` : ""}Retry slice ${call.sliceId} now. Resume the state protocol from where you paused.`,
  );
  pushState();
}

function stopRun(): void {
  if (!run || !LIVE_PHASE[run.phase]) return;
  // the abort round-trip lands as agent-end{aborted} which freezes the board;
  // flip phase immediately so a dead process can't leave a zombie run
  if (poolActive) {
    poolActive = false;
    killAllWorkers();
    if (run.mechanism) run.mechanism = { ...run.mechanism, active: 0 };
  } else {
    bridge!.abort();
  }
  run.phase = "stopped";
  sysNote("run interrupted — board frozen in its last state");
  pushState();
}

function clearRun(): void {
  poolActive = false;
  killAllWorkers();
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
      poolActive = false;
      killAllWorkers();
      run.phase = "stopped";
      sysNote("new agent session — team run ended");
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
  killAllWorkers(); // no orphaned omp children on app quit
  persist(); // a live run at quit stays on disk → restart-honesty notice
}
