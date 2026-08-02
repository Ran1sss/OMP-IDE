/**
 * Process-level worker pool (crew-rail spec §2, mechanism 2 — the guaranteed
 * parallelism path). One `omp --mode rpc` child per ACTIVE worker (cap 4),
 * each its own session in the workspace, prompted with the approved plan, its
 * assigned slice, the fixed contracts, and hand-off notes of completed deps.
 *
 * The pool is a dumb executor: it spawns, streams, classifies, and reports.
 * All plan state lives in team-service (one orchestrating brain — no second
 * source of truth). Starts are staggered ≥2s apart (provider pressure).
 *
 * Rate limits: a 429/quota turn-error flips the worker to `throttled` for a
 * backoff window, then the SAME process retries its slice prompt once. The
 * existing autoswap machinery still applies per process (it rides omp's own
 * provider config), so a swap mid-slice is omp's business, not ours.
 */

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { whichOmp, getOmpChildEnv, getAgentBridge } from "../omp-service";
import { currentOmpPath } from "../store-service";

export interface WorkerResult {
  ok: boolean;
  /** worker's final answer text (hand-off note lives inside) */
  text: string;
  /** error detail when !ok */
  error?: string;
  aborted?: boolean;
}

export interface WorkerToolCall {
  tool: string;
  summary: string;
  at: number;
  /** absolute or workspace-relative path for file-edit calls */
  editPath?: string;
  add?: number;
  del?: number;
}

export interface WorkerEvents {
  onToolCall(call: WorkerToolCall): void;
  onThrottled(detail: string): void;
  onResumed(): void;
  onText(text: string): void;
  onExit(result: WorkerResult): void;
}

interface WorkerProc {
  name: string;
  proc: ChildProcessWithoutNullStreams;
  buf: string;
  events: WorkerEvents;
  finalText: string;
  lastText: string;
  throttleTimer: NodeJS.Timeout | null;
  retried: boolean;
  prompt: string;
  ended: boolean;
  terminalError?: string;
  killed: boolean;
}

const MAX_WORKERS = 4;
const STAGGER_MS = 2000;
const THROTTLE_BACKOFF_MS = 15_000;

const live = new Map<string, WorkerProc>();
let lastSpawnAt = 0;
/** serialize stagger waits so two simultaneous starts don't both pass the gap check */
let spawnChain: Promise<unknown> = Promise.resolve();

export function liveWorkerCount(): number {
  return live.size;
}

export function liveWorkerPids(): { name: string; pid: number | undefined }[] {
  return [...live.values()].map((w) => ({ name: w.name, pid: w.proc.pid }));
}

/** Spawn a worker process for one slice. Resolves when the worker is LAUNCHED. */
export async function startWorker(opts: {
  name: string;
  root: string;
  prompt: string;
  events: WorkerEvents;
}): Promise<{ ok: boolean; error?: string }> {
  if (live.size >= MAX_WORKERS) return { ok: false, error: `worker cap (${MAX_WORKERS}) reached` };
  if (live.has(opts.name)) return { ok: false, error: `worker ${opts.name} already running` };

  const bin = await whichOmp(currentOmpPath());
  if (!bin) return { ok: false, error: "omp not found" };

  // stagger: ≥2s between starts, serialized
  const gate = spawnChain.then(async () => {
    const waitMs = lastSpawnAt + STAGGER_MS - Date.now();
    if (waitMs > 0) {
      const { promise, resolve } = Promise.withResolvers<void>();
      setTimeout(resolve, waitMs);
      await promise;
    }
    lastSpawnAt = Date.now();
  });
  spawnChain = gate.catch(() => {});
  await gate;

  let proc: ChildProcessWithoutNullStreams;
  try {
    const active = getAgentBridge().getActiveModel();
    const model = active ? `${active.provider}/${active.id}` : null;
    proc = spawn(bin, ["--mode", "rpc", "--auto-approve", "--no-session", ...(model ? ["--model", model] : [])], {
      cwd: opts.root,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...getOmpChildEnv() },
    });
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }

  const w: WorkerProc = {
    name: opts.name,
    proc,
    buf: "",
    events: opts.events,
    finalText: "",
    lastText: "",
    throttleTimer: null,
    retried: false,
    prompt: opts.prompt,
    ended: false,
    killed: false,
    terminalError: undefined,
  };
  live.set(opts.name, w);

  proc.stdout.setEncoding("utf-8");
  proc.stdout.on("data", (chunk: string) => feed(w, chunk));
  let stderrTail = "";
  proc.stderr.setEncoding("utf-8");
  proc.stderr.on("data", (c: string) => {
    stderrTail = (stderrTail + c).slice(-1500);
  });
  proc.on("error", (err) => settle(w, { ok: false, text: "", error: err.message }));
  proc.on("exit", (code) => {
    if (w.ended) return;
    settle(w, {
      ok: false,
      text: w.finalText,
      error: w.killed ? "killed" : `omp exited with code ${code ?? "?"}${stderrTail ? ` — ${stderrTail.slice(-200)}` : ""}`,
      aborted: w.killed,
    });
  });
  return { ok: true };
}

/** Kill a worker (park/stop). Its exit resolves as aborted. */
export function killWorker(name: string): void {
  const w = live.get(name);
  if (!w) return;
  w.killed = true;
  if (w.throttleTimer) { clearTimeout(w.throttleTimer); w.throttleTimer = null; }
  try {
    w.proc.kill();
  } catch {}
}

export function killAllWorkers(): void {
  for (const name of [...live.keys()]) killWorker(name);
}

/** Mid-run steering: inject a user message into a live worker's session. */
export function steerWorker(name: string, message: string): boolean {
  const w = live.get(name);
  if (!w || w.ended) return false;
  send(w, { id: `wk_steer_${Date.now()}`, type: "prompt", message, streamingBehavior: "steer" });
  return true;
}

function settle(w: WorkerProc, result: WorkerResult): void {
  if (w.ended) return;
  w.ended = true;
  if (w.throttleTimer) { clearTimeout(w.throttleTimer); w.throttleTimer = null; }
  live.delete(w.name);
  try {
    w.proc.kill();
  } catch {}
  w.events.onExit(result);
}

function send(w: WorkerProc, cmd: Record<string, unknown>): void {
  if (w.proc.exitCode !== null) return;
  try {
    w.proc.stdin.write(JSON.stringify(cmd) + "\n");
  } catch {}
}

function feed(w: WorkerProc, chunk: string): void {
  w.buf += chunk;
  let nl: number;
  while ((nl = w.buf.indexOf("\n")) >= 0) {
    const line = w.buf.slice(0, nl);
    w.buf = w.buf.slice(nl + 1);
    if (!line.trim()) continue;
    let frame: Record<string, any>;
    try {
      frame = JSON.parse(line);
    } catch {
      continue;
    }
    try {
      handleFrame(w, frame);
    } catch {
      /* one bad frame must not kill the stream */
    }
  }
}

function handleFrame(w: WorkerProc, frame: Record<string, any>): void {
  switch (frame.type) {
    case "ready":
      send(w, { id: "wk_neg", type: "negotiate_protocol", protocolVersion: 2 });
      send(w, { id: "wk_prompt", type: "prompt", message: w.prompt });
      break;
    case "message_update": {
      const ev = frame.assistantMessageEvent;
      if (ev?.type === "text_delta" && typeof ev.delta === "string") {
        w.lastText += ev.delta;
        w.events.onText(ev.delta);
      } else if (ev?.type === "text_start") {
        w.lastText = "";
      } else if (ev?.type === "text_end") {
        if (w.lastText.trim()) w.finalText = w.lastText;
      }
      break;
    }
    case "tool_execution_start": {
      if (typeof frame.toolName === "string") {
        const args = frame.args as Record<string, unknown> | undefined;
        const target =
          typeof frame.intent === "string" && frame.intent
            ? frame.intent
            : typeof args?.path === "string" ? (args.path as string)
            : typeof args?.command === "string" ? String(args.command).slice(0, 60)
            : "";
        w.events.onToolCall({ tool: frame.toolName, summary: target, at: Date.now() });
      }
      break;
    }
    case "tool_execution_end": {
      const details = frame.result?.details as Record<string, unknown> | undefined;
      if (details && typeof details.path === "string" && typeof details.newText === "string") {
        const oldText = typeof details.oldText === "string" ? details.oldText : "";
        const lines = (details.newText as string).split("\n").length - oldText.split("\n").length;
        w.events.onToolCall({
          tool: String(frame.toolName ?? "edit"),
          summary: details.path,
          at: Date.now(),
          editPath: details.path,
          add: lines >= 0 ? lines || 1 : 0,
          del: lines < 0 ? -lines : 0,
        });
      }
      break;
    }
    case "turn_end": {
      const msg = frame.message && typeof frame.message === "object" ? (frame.message as Record<string, unknown>) : null;
      if (msg && msg.stopReason === "error") {
        const status = typeof msg.errorStatus === "number" ? msg.errorStatus : null;
        const detail = typeof msg.errorMessage === "string" ? msg.errorMessage : "provider error";
        const throttled = status === 429 || /rate.?limit|quota|overloaded|too many/i.test(detail);
        if (throttled && !w.retried) {
          w.retried = true;
          w.events.onThrottled(detail.slice(0, 200));
          w.throttleTimer = setTimeout(() => {
            w.throttleTimer = null;
            w.terminalError = undefined;
            w.events.onResumed();
            send(w, { id: "wk_retry", type: "prompt", message: w.prompt });
          }, THROTTLE_BACKOFF_MS);
        } else {
          w.terminalError = `${status ?? "provider"}: ${detail}`;
        }
      }
      break;
    }
    case "agent_end": {
      if (w.throttleTimer) break;
      settle(w, w.terminalError
        ? { ok: false, text: w.finalText, error: w.terminalError }
        : { ok: true, text: w.finalText });
      break;
    }
    default:
      break;
  }
}
