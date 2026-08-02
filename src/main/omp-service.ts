import type { IpcMain, WebContents } from "electron";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { execFile } from "node:child_process";
import * as fs from "node:fs";
import { isAbsolute, resolve as resolvePath } from "node:path";
import type { OmpEvent, OmpStatus, OmpFileEdit, OmpTodoPhase, ThinkingLevel } from "../shared/types";
import { classifyAgentEnd } from "../shared/agent-end";
import { currentOmpPath } from "./store-service";

/**
 * OMP process manager. Spawns `omp --mode rpc` in the workspace directory,
 * parses the JSONL event stream and forwards normalized OmpEvents plus an
 * OmpStatus state machine to the renderer, and mirrors both to the agent
 * bridge consumed by the remote (Telegram) module.
 */

interface OmpSession {
  proc: ChildProcessWithoutNullStreams;
  owner: WebContents;
  root: string;
  buf: string;
  reqSeq: number;
  status: OmpStatus;
  intentionalKill: boolean;
  startedAt: number;
  /** an abort was requested this turn (IDE button OR remote /stop via bridge) */
  abortRequested?: boolean;
  /** stopReason of the last turn_end this run — omp's own verdict ("aborted", "stop", …) */
  lastStopReason?: string;
}

const sessions = new Map<number, OmpSession>();
/** window id of the most recently started session — the bridge targets this one */
let primaryId: number | null = null;

// -------------------------------------------------- agent bridge (main-process consumers)

export interface UiAnswerRecord {
  by: string;
  answer: string;
}

export type UiAnswerResult =
  | { applied: true }
  | { applied: false; already: UiAnswerRecord }
  | { applied: false; already: null };

export interface PromptDisplayOptions {
  /** false for orchestration prompts that must never enter the user feed */
  echo?: boolean;
  /** user-facing echo when the model receives a larger internal prompt */
  displayText?: string;
}

export interface AgentBridge {
  onStatus(cb: (s: OmpStatus) => void): () => void;
  onEvent(cb: (e: OmpEvent) => void): () => void;
  onUiRequest(cb: (req: BridgeUiRequest) => void): () => void;
  getStatus(): OmpStatus | null;
  getRoot(): string | null;
  getTodoPhases(): OmpTodoPhase[];
  getStartedAt(): number | null;
  /** prompt/steer/answer routed to the live session. `display` separates the
   *  internal model prompt from what the user sees in the IDE feed. */
  prompt(message: string, via?: { username: string; botName: string; attribution?: string }, display?: PromptDisplayOptions): boolean;
  abort(): boolean;
  newSession(): boolean;
  restartSession(): Promise<boolean>;
  /** first-wins answer to a pending agent question */
  answerUi(id: string, payload: Record<string, unknown>, by: string, answerLabel: string): UiAnswerResult;
  /** raw RPC round-trip to the live omp process (set_model, get_available_models, …) */
  request(cmd: Record<string, unknown>, timeoutMs?: number): Promise<BridgeResponse>;
  /** active model as reported by get_state */
  getActiveModel(): { provider: string; id: string; name: string } | null;
  onModelChange(cb: (m: { provider: string; id: string; name: string }) => void): () => void;
}

export interface BridgeUiRequest {
  id: string;
  method: string;
  title?: string;
  message?: string;
  placeholder?: string;
  options?: string[];
}

export interface BridgeResponse {
  success: boolean;
  data?: Record<string, unknown>;
  error?: string;
}

const bridgeStatusListeners = new Set<(s: OmpStatus) => void>();
const bridgeEventListeners = new Set<(e: OmpEvent) => void>();
const bridgeUiListeners = new Set<(req: BridgeUiRequest) => void>();
const bridgeModelListeners = new Set<(m: { provider: string; id: string; name: string }) => void>();
/** open agent questions; first answer wins, later ones see the record */
const pendingUi = new Map<string, { session: OmpSession; answered: UiAnswerRecord | null }>();
/** in-flight bridge RPC requests by frame id */
const pendingRequests = new Map<string, { resolve: (r: BridgeResponse) => void; timer: NodeJS.Timeout }>();
let lastTodoPhases: OmpTodoPhase[] = [];
let lastActiveModel: { provider: string; id: string; name: string } | null = null;
/** extra env merged into every spawned omp child (models module provider keys) */
let extraChildEnv: Record<string, string> = {};

export function setOmpChildEnv(env: Record<string, string>): void {
  extraChildEnv = env;
}

/** merged env for ANY omp child (worker pool spawns its own processes) */
export function getOmpChildEnv(): Record<string, string> {
  return { ...extraChildEnv };
}

/**
 * Cross-module thinking control. The models module registers an implementation
 * on init; the remote module consumes it if present (/think). Keeping the
 * broker here preserves module isolation: either module can be deleted and
 * the other keeps working.
 */
export interface ThinkingControl {
  describe(): {
    effective: ThinkingLevel;
    override: ThinkingLevel | null;
    capability: string;
  };
  setSession(level: string, origin: string): { ok: boolean; pending?: boolean; error?: string };
}

let thinkingControl: ThinkingControl | null = null;

export function registerThinkingControl(c: ThinkingControl | null): void {
  thinkingControl = c;
}

export function getThinkingControl(): ThinkingControl | null {
  return thinkingControl;
}

function primarySession(): OmpSession | null {
  if (primaryId !== null) {
    const s = sessions.get(primaryId);
    if (s) return s;
  }
  for (const s of sessions.values()) return s;
  return null;
}

// -------------------------------------------------- binary resolution

export function whichOmp(customPath: string): Promise<string | null> {
  const { promise, resolve } = Promise.withResolvers<string | null>();
  if (customPath) {
    const p = isAbsolute(customPath) ? customPath : resolvePath(customPath);
    resolve(fs.existsSync(p) ? p : null);
    return promise;
  }
  const probe = process.platform === "win32" ? "where" : "which";
  execFile(probe, ["omp"], { windowsHide: true }, (err, stdout) => {
    if (err || !stdout.trim()) {
      resolve(null);
      return;
    }
    const first = stdout.split(/\r?\n/).find((l) => l.trim().length > 0);
    resolve(first ? first.trim() : null);
  });
  return promise;
}

// -------------------------------------------------- frame normalization

interface RpcFrame {
  type?: string;
  id?: string;
  command?: string;
  success?: boolean;
  error?: string;
  method?: string;
  title?: string;
  message?: unknown;
  placeholder?: string;
  options?: string[];
  toolCallId?: string;
  toolName?: string;
  args?: unknown;
  intent?: string;
  isError?: boolean;
  result?: { content?: { type?: string; text?: string }[]; details?: Record<string, unknown> };
  assistantMessageEvent?: {
    type?: string;
    delta?: string;
    contentIndex?: number;
    toolCall?: { id?: string; name?: string; arguments?: unknown };
  };
  phases?: OmpTodoPhase[];
  data?: Record<string, unknown>;
}

function extractFileEdit(frame: RpcFrame): OmpFileEdit | undefined {
  const details = frame.result?.details;
  if (!details) return undefined;
  const path = details.path;
  const oldText = details.oldText;
  const newText = details.newText;
  if (typeof path !== "string" || typeof newText !== "string") return undefined;
  return {
    path,
    op: typeof details.op === "string" ? details.op : "update",
    oldText: typeof oldText === "string" ? oldText : "",
    newText,
    diff: typeof details.diff === "string" ? details.diff : undefined,
  };
}

function resultText(frame: RpcFrame): string {
  const content = frame.result?.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text)
    .join("\n");
}

// -------------------------------------------------- session lifecycle

let msgSeq = 0;

function setStatus(s: OmpSession, status: OmpStatus) {
  s.status = status;
  if (!s.owner.isDestroyed()) s.owner.send("omp:status", status);
  if (s === primarySession()) for (const cb of bridgeStatusListeners) cb(status);
}

function emit(s: OmpSession, e: OmpEvent) {
  if (!s.owner.isDestroyed()) s.owner.send("omp:event", e);
  if (e.kind === "todos") lastTodoPhases = e.phases;
  if (s === primarySession()) for (const cb of bridgeEventListeners) cb(e);
}

function sendCmd(s: OmpSession, cmd: Record<string, unknown>) {
  if (s.proc.exitCode !== null) return;
  s.reqSeq++;
  s.proc.stdin.write(JSON.stringify({ id: `ide_${s.reqSeq}`, ...cmd }) + "\n");
}

function handleFrame(s: OmpSession, frame: RpcFrame) {
  switch (frame.type) {
    case "ready": {
      sendCmd(s, { type: "negotiate_protocol", protocolVersion: 2 });
      sendCmd(s, { type: "get_state" });
      setStatus(s, { state: "idle", model: s.status.model });
      break;
    }
    case "response": {
      // bridge-initiated RPC round-trips carry a br_ id
      if (typeof frame.id === "string" && pendingRequests.has(frame.id)) {
        const p = pendingRequests.get(frame.id)!;
        pendingRequests.delete(frame.id);
        clearTimeout(p.timer);
        p.resolve({ success: frame.success === true, data: frame.data, error: frame.error });
        // fall through to get_state bookkeeping below only for get_state frames
        if (frame.command !== "get_state") break;
      }
      if (frame.command === "get_state" && frame.success && frame.data) {
        const model = frame.data.model as { name?: string; id?: string; provider?: string } | undefined;
        const phases = frame.data.todoPhases;
        if (Array.isArray(phases)) emit(s, { kind: "todos", phases: phases as OmpTodoPhase[] });
        setStatus(s, { ...s.status, model: model?.name ?? model?.id });
        if (model?.id && model.provider) {
          const active = { provider: model.provider, id: model.id, name: model.name ?? model.id };
          const changed = !lastActiveModel || lastActiveModel.provider !== active.provider || lastActiveModel.id !== active.id;
          lastActiveModel = active;
          if (changed) for (const cb of bridgeModelListeners) cb(active);
        }
      }
      if (frame.success === false && frame.error) {
        emit(s, { kind: "text-end", messageId: ++msgSeq, text: `⚠ ${frame.command}: ${frame.error}` });
      }
      break;
    }
    case "agent_start":
      setStatus(s, { state: "thinking", model: s.status.model });
      s.lastStopReason = undefined;
      emit(s, { kind: "agent-start" });
      break;
    case "turn_end": {
      // Provider failures surface here: the final assistant message carries
      // stopReason "error" + errorStatus/errorMessage (observed on omp v17:
      // {"stopReason":"error","errorStatus":401,"errorMessage":"401 Invalid
      // API key …","provider":"<profile>","model":"<id>"}). The swap engine
      // listens for this event.
      const msg = frame.message && typeof frame.message === "object" ? (frame.message as Record<string, unknown>) : null;
      if (msg && typeof msg.stopReason === "string") s.lastStopReason = msg.stopReason;
      if (msg && msg.stopReason === "error") {
        emit(s, {
          kind: "turn-error",
          provider: typeof msg.provider === "string" ? msg.provider : "",
          modelId: typeof msg.model === "string" ? msg.model : "",
          status: typeof msg.errorStatus === "number" ? msg.errorStatus : null,
          message: typeof msg.errorMessage === "string" ? msg.errorMessage.slice(0, 500) : "",
        });
      }
      break;
    }
    case "agent_end": {
      setStatus(s, { state: "idle", model: s.status.model });
      // Interrupt marking prefers omp's own verdict: the final turn_end's
      // stopReason ("aborted" vs "stop"/"toolUse"/…). The local abortRequested
      // flag is only a fallback for runs that die before any turn_end — it
      // races: a turn finishing naturally just after the user clicks
      // Interrupt must NOT read as interrupted.
      const { aborted, failed } = classifyAgentEnd(s.lastStopReason, s.abortRequested === true);
      emit(s, { kind: "agent-end", aborted, failed });
      s.abortRequested = false;
      s.lastStopReason = undefined;
      // Refresh todos snapshot after each run.
      sendCmd(s, { type: "get_state" });
      break;
    }
    case "message_update": {
      const ev = frame.assistantMessageEvent;
      if (!ev) break;
      if (ev.type === "text_start") emit(s, { kind: "text-start", messageId: ++msgSeq });
      else if (ev.type === "text_delta" && typeof ev.delta === "string")
        emit(s, { kind: "text-delta", messageId: msgSeq, delta: ev.delta });
      else if (ev.type === "text_end") emit(s, { kind: "text-end", messageId: msgSeq, text: "" });
      else if (ev.type === "thinking_delta" && typeof ev.delta === "string")
        emit(s, { kind: "thinking-delta", messageId: msgSeq, delta: ev.delta });
      break;
    }
    case "tool_execution_start": {
      if (typeof frame.toolCallId === "string" && typeof frame.toolName === "string") {
        setStatus(s, { state: "tool", tool: frame.toolName, model: s.status.model });
        emit(s, {
          kind: "tool-start",
          toolCallId: frame.toolCallId,
          toolName: frame.toolName,
          args: frame.args,
          intent: frame.intent,
        });
      }
      break;
    }
    case "tool_execution_end": {
      if (typeof frame.toolCallId === "string" && typeof frame.toolName === "string") {
        setStatus(s, { state: "thinking", model: s.status.model });
        emit(s, {
          kind: "tool-end",
          toolCallId: frame.toolCallId,
          toolName: frame.toolName,
          isError: frame.isError === true,
          resultText: resultText(frame).slice(0, 4000),
          fileEdit: extractFileEdit(frame),
        });
        // The todo tool mutates session todo state; re-pull so the strip stays live.
        if (frame.toolName === "todo") sendCmd(s, { type: "get_state" });
      }
      break;
    }
    case "todo_reminder":
    case "todo_auto_clear":
      sendCmd(s, { type: "get_state" });
      break;
    case "extension_ui_request": {
      const method = frame.method ?? "";
      if (method === "confirm" || method === "input" || method === "select" || method === "editor") {
        if (typeof frame.id === "string") {
          const req = {
            id: frame.id,
            method,
            title: frame.title,
            message: typeof frame.message === "string" ? frame.message : undefined,
            placeholder: frame.placeholder,
            options: frame.options,
          };
          if (!s.owner.isDestroyed()) s.owner.send("omp:uiRequest", req);
          pendingUi.set(frame.id, { session: s, answered: null });
          setStatus(s, { state: "awaiting-input", model: s.status.model });
          if (s === primarySession()) for (const cb of bridgeUiListeners) cb(req);
        }
      }
      // notify/setStatus/setWidget/setTitle are cosmetic; ignore.
      break;
    }
    default:
      break;
  }
}

function feed(s: OmpSession, chunk: string) {
  s.buf += chunk;
  let nl: number;
  while ((nl = s.buf.indexOf("\n")) >= 0) {
    const line = s.buf.slice(0, nl);
    s.buf = s.buf.slice(nl + 1);
    if (!line.trim()) continue;
    let frame: RpcFrame;
    try {
      frame = JSON.parse(line) as RpcFrame;
    } catch {
      continue;
    }
    try {
      handleFrame(s, frame);
    } catch {
      // one bad frame must not kill the stream
    }
  }
}

async function startSession(wc: WebContents, root: string, customPath: string) {
  const existing = sessions.get(wc.id);
  if (existing) {
    existing.intentionalKill = true;
    try {
      existing.proc.kill();
    } catch {}
    sessions.delete(wc.id);
  }

  const bin = await whichOmp(customPath);
  if (!bin) {
    if (!wc.isDestroyed())
      wc.send("omp:status", {
        state: "unavailable",
        detail: "omp binary not found on PATH",
      } satisfies OmpStatus);
    return;
  }

  if (!wc.isDestroyed()) wc.send("omp:status", { state: "starting" } satisfies OmpStatus);

  // extra env from the models module (provider API keys); see setChildEnvProvider
  let proc: ChildProcessWithoutNullStreams;
  try {
    proc = spawn(bin, ["--mode", "rpc", "--auto-approve"], {
      cwd: root,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...extraChildEnv },
    });
  } catch (err) {
    if (!wc.isDestroyed())
      wc.send("omp:status", {
        state: "unavailable",
        detail: err instanceof Error ? err.message : String(err),
      } satisfies OmpStatus);
    return;
  }

  const s: OmpSession = {
    proc,
    owner: wc,
    root,
    buf: "",
    reqSeq: 0,
    status: { state: "starting" },
    intentionalKill: false,
    startedAt: Date.now(),
  };
  sessions.set(wc.id, s);
  primaryId = wc.id;

  proc.stdout.setEncoding("utf-8");
  proc.stdout.on("data", (chunk: string) => feed(s, chunk));
  let stderrTail = "";
  proc.stderr.setEncoding("utf-8");
  proc.stderr.on("data", (chunk: string) => {
    stderrTail = (stderrTail + chunk).slice(-2000);
  });
  proc.on("error", (err) => {
    sessions.delete(wc.id);
    if (!wc.isDestroyed())
      wc.send("omp:status", { state: "unavailable", detail: err.message } satisfies OmpStatus);
  });
  proc.on("exit", (code) => {
    const current = sessions.get(wc.id);
    if (current === s) sessions.delete(wc.id);
    if (!wc.isDestroyed() && !s.intentionalKill) {
      wc.send("omp:status", {
        state: "dead",
        detail: `omp exited with code ${code ?? "?"}${stderrTail ? ` — ${stderrTail.slice(-300)}` : ""}`,
      } satisfies OmpStatus);
    }
  });
  wc.once("destroyed", () => {
    const cur = sessions.get(wc.id);
    if (cur === s) {
      sessions.delete(wc.id);
      s.intentionalKill = true;
      try {
        s.proc.kill();
      } catch {}
    }
  });
}

// -------------------------------------------------- shared actions (IPC + bridge)

function doPrompt(
  s: OmpSession,
  message: string,
  via?: { username: string; botName: string; attribution?: string },
  display?: PromptDisplayOptions,
) {
  if (display?.echo !== false) emit(s, { kind: "user-message", text: display?.displayText ?? message, via });
  const streaming = s.status.state === "thinking" || s.status.state === "tool";
  sendCmd(s, {
    type: "prompt",
    message: via ? `${via.attribution ?? `[remote/telegram @${via.username}]`} ${message}` : message,
    ...(streaming ? { streamingBehavior: "steer" as const } : {}),
  });
}

const newSessionListeners = new Set<() => void>();

export function onNewSession(cb: () => void): () => void {
  newSessionListeners.add(cb);
  return () => newSessionListeners.delete(cb);
}

function doNewSession(s: OmpSession) {
  pendingUi.clear();
  lastTodoPhases = [];
  sendCmd(s, { type: "new_session" });
  sendCmd(s, { type: "get_state" });
  for (const cb of newSessionListeners) cb();
}

function applyUiAnswer(
  id: string,
  payload: Record<string, unknown>,
  by: string,
  answerLabel: string,
): UiAnswerResult {
  const pending = pendingUi.get(id);
  if (!pending) return { applied: false, already: null };
  if (pending.answered) return { applied: false, already: pending.answered };
  pending.answered = { by, answer: answerLabel };
  const s = pending.session;
  s.proc.stdin.write(JSON.stringify({ type: "extension_ui_response", id, ...payload }) + "\n");
  if (s.status.state === "awaiting-input")
    setStatus(s, { state: "thinking", model: s.status.model });
  return { applied: true };
}

export function getAgentBridge(): AgentBridge {
  return {
    onStatus(cb) {
      bridgeStatusListeners.add(cb);
      return () => bridgeStatusListeners.delete(cb);
    },
    onEvent(cb) {
      bridgeEventListeners.add(cb);
      return () => bridgeEventListeners.delete(cb);
    },
    onUiRequest(cb) {
      bridgeUiListeners.add(cb);
      return () => bridgeUiListeners.delete(cb);
    },
    getStatus: () => primarySession()?.status ?? null,
    getRoot: () => primarySession()?.root ?? null,
    getTodoPhases: () => lastTodoPhases,
    getStartedAt: () => primarySession()?.startedAt ?? null,
    prompt(message, via, display) {
      const s = primarySession();
      if (!s) return false;
      doPrompt(s, message, via, display);
      return true;
    },
    abort() {
      const s = primarySession();
      if (!s) return false;
      s.abortRequested = true;
      sendCmd(s, { type: "abort" });
      return true;
    },
    newSession() {
      const s = primarySession();
      if (!s) return false;
      doNewSession(s);
      return true;
    },
    async restartSession() {
      const s = primarySession();
      const wc = s?.owner;
      const root = s?.root ?? (primaryId !== null ? lastRoot.get(primaryId) : undefined);
      if (!wc || wc.isDestroyed() || !root) return false;
      await startSession(wc, root, currentOmpPath());
      return true;
    },
    answerUi: applyUiAnswer,
    request(cmd, timeoutMs = 20_000) {
      const { promise, resolve } = Promise.withResolvers<BridgeResponse>();
      const s = primarySession();
      if (!s || s.proc.exitCode !== null) {
        resolve({ success: false, error: "agent process is not running" });
        return promise;
      }
      s.reqSeq++;
      const id = `br_${s.reqSeq}`;
      const timer = setTimeout(() => {
        pendingRequests.delete(id);
        resolve({ success: false, error: "request timed out" });
      }, timeoutMs);
      pendingRequests.set(id, { resolve, timer });
      s.proc.stdin.write(JSON.stringify({ id, ...cmd }) + "\n");
      return promise;
    },
    getActiveModel: () => lastActiveModel,
    onModelChange(cb) {
      bridgeModelListeners.add(cb);
      return () => bridgeModelListeners.delete(cb);
    },
  };
}

// -------------------------------------------------- IPC

/** last workspace root per window — survives session death so restart can recover */
const lastRoot = new Map<number, string>();

export function registerOmpHandlers(ipc: IpcMain) {
  ipc.handle("omp:start", async (e, root: string) => {
    lastRoot.set(e.sender.id, root);
    await startSession(e.sender, root, currentOmpPath());
  });

  ipc.handle("omp:prompt", async (e, message: string) => {
    const s = sessions.get(e.sender.id);
    if (s) doPrompt(s, message);
  });

  ipc.handle("omp:abort", async (e) => {
    const s = sessions.get(e.sender.id);
    if (s) {
      s.abortRequested = true;
      sendCmd(s, { type: "abort" });
    }
  });

  ipc.handle("omp:newSession", async (e) => {
    const s = sessions.get(e.sender.id);
    if (s) doNewSession(s);
  });

  ipc.handle("omp:restart", async (e) => {
    const s = sessions.get(e.sender.id);
    const root = s?.root ?? lastRoot.get(e.sender.id);
    if (s) {
      s.intentionalKill = true;
      try {
        s.proc.kill();
      } catch {}
      sessions.delete(e.sender.id);
    }
    if (root) await startSession(e.sender, root, currentOmpPath());
  });

  ipc.handle("omp:dispose", async (e) => {
    const s = sessions.get(e.sender.id);
    if (s) {
      s.intentionalKill = true;
      try {
        s.proc.kill();
      } catch {}
      sessions.delete(e.sender.id);
    }
  });

  ipc.handle("omp:uiResponse", async (e, id: string, payload: Record<string, unknown>) => {
    const s = sessions.get(e.sender.id);
    if (!s) return;
    const label =
      typeof payload.value === "string" ? payload.value :
      payload.confirmed === true ? "Yes" : payload.confirmed === false ? "No" :
      payload.cancelled ? "(cancelled)" : "";
    applyUiAnswer(id, payload, "IDE", label);
  });
}

export function disposeOmp() {
  for (const s of sessions.values()) {
    s.intentionalKill = true;
    try {
      s.proc.kill();
    } catch {}
  }
  sessions.clear();
}
