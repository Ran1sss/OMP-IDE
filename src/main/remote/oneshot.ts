/**
 * OMP oneshot completion mechanism — the listener's brain.
 *
 * Discovery (CLI → config → env ladder):
 *  - CLI: `omp --help` documents `-p, --print` — "Non-interactive mode:
 *    process prompt and exit" — plus `--no-tools --no-session` for a
 *    stateless call and `--model <selector>` for role binding. Verified
 *    live on omp v17.1.3:
 *      omp -p --no-tools --no-session --no-extensions --no-skills \
 *          --no-rules --thinking off --model <smolSelector> \
 *          --system-prompt "<triage>" "<transcript>"
 *    prints the completion text to stdout and exits (~5–16 s).
 *  - config: the `smol` role selector lives in ~/.omp/agent/config.yml
 *    `modelRoles.smol` (read via readRoles()); the ROLE name is fixed by
 *    the spec, the model behind it is the user's choice in the Models UI.
 *  - env: PI_SMOL_MODEL would override, but we pass --model explicitly so
 *    the binding is observable in the Model Events/OMP output.
 *
 * The main agent session is never touched — this spawns a separate
 * short-lived `omp` process per evaluation batch.
 */

import { spawn } from "node:child_process";
import { app } from "electron";
import { whichOmp, getAgentBridge } from "../omp-service";
import { currentOmpPath } from "../store-service";
import { readRoles } from "../models/omp-config";

const TRIAGE_SYSTEM_PROMPT =
  "You are a triage filter for a dev-team group chat. Decide if the transcript " +
  "contains a concrete, actionable software task for this workspace. " +
  "Reply with exactly NO, or exactly TASK: <one short imperative line>.";

export type OneshotResult =
  | { kind: "task"; line: string }
  | { kind: "no-task" }
  | { kind: "error"; error: string };

/** cached binary path; re-probed when missing so recovery needs no restart */
let ompBin: string | null = null;

export async function oneshotAvailable(): Promise<boolean> {
  if (ompBin) return true;
  ompBin = await whichOmp(currentOmpPath());
  return ompBin !== null;
}

/** smol selector from OMP config with any `:thinking` suffix stripped; null = unassigned */
export function smolSelector(): string | null {
  const raw = readRoles().smol;
  if (!raw || raw.startsWith("@")) return null;
  const colon = raw.lastIndexOf(":");
  return colon > raw.indexOf("/") && colon !== -1 ? raw.slice(0, colon) : raw;
}

/** Evaluate a transcript batch on the smol role. One call = one omp child. */
export async function evaluateTranscript(transcript: string): Promise<OneshotResult> {
  if (!(await oneshotAvailable())) return { kind: "error", error: "requires OMP oneshot support" };
  const bin = ompBin!;
  const selector = smolSelector();

  const args = [
    "-p",
    "--no-tools",
    "--no-session",
    "--no-extensions",
    "--no-skills",
    "--no-rules",
    "--thinking",
    "off",
    ...(selector ? ["--model", selector] : []),
    "--system-prompt",
    TRIAGE_SYSTEM_PROMPT,
    transcript,
  ];

  const { promise, resolve } = Promise.withResolvers<OneshotResult>();
  let out = "";
  let err = "";
  let settled = false;
  const done = (r: OneshotResult) => {
    if (settled) return;
    settled = true;
    resolve(r);
  };

  let proc;
  try {
    proc = spawn(bin, args, {
      cwd: getAgentBridge().getRoot() ?? app.getPath("userData"),
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    ompBin = null; // binary vanished — re-probe next time
    return { kind: "error", error: e instanceof Error ? e.message : String(e) };
  }

  const killer = setTimeout(() => {
    try {
      proc.kill();
    } catch {}
    done({ kind: "error", error: "oneshot timed out after 60s" });
  }, 60_000);

  proc.stdout.setEncoding("utf-8");
  proc.stdout.on("data", (c: string) => (out += c));
  proc.stderr.setEncoding("utf-8");
  proc.stderr.on("data", (c: string) => (err = (err + c).slice(-500)));
  proc.on("error", (e) => {
    clearTimeout(killer);
    ompBin = null;
    done({ kind: "error", error: e.message });
  });
  proc.on("exit", (code) => {
    clearTimeout(killer);
    if (code !== 0) {
      done({ kind: "error", error: `omp exited ${code ?? "?"}${err ? ` — ${err.slice(-200)}` : ""}` });
      return;
    }
    done(parseVerdict(out));
  });
  return promise;
}

/** tolerate spinner lines, surrounding whitespace and quotes around the verdict */
function parseVerdict(stdout: string): OneshotResult {
  const lines = stdout
    .split(/\r?\n/)
    .map((l) => l.trim().replace(/^["'«]|["'»]$/g, "").trim())
    .filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = lines[i].match(/^TASK:\s*(.+)$/i);
    if (m) return { kind: "task", line: m[1].trim() };
    if (/^NO[.!]?$/i.test(lines[i])) return { kind: "no-task" };
  }
  return { kind: "no-task" };
}
