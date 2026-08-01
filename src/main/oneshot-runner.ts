/**
 * Generic stateless OMP oneshot runner — ONE invocation mechanism shared by
 * the Telegram chat listener (remote/watch-manager) and Prompt Improve
 * (models:enhance). Extracted from remote/oneshot.ts so the remote module
 * stays deletable while both features reuse the exact same call.
 *
 * Discovery (CLI → config → env ladder, verified live on omp v17.1.3):
 *  - CLI: `omp --help` documents `-p, --print` — "Non-interactive mode:
 *    process prompt and exit" — plus `--no-tools --no-session` for a
 *    stateless call and `--model <selector>` for role binding:
 *      omp -p --no-tools --no-session --no-extensions --no-skills \
 *          --no-rules --thinking off --model <selector> \
 *          --system-prompt "<system>" "<prompt>"
 *    prints the completion text to stdout and exits (~5–16 s).
 *  - config: role selectors live in ~/.omp/agent/config.yml `modelRoles`
 *    (read via readRoles()); the ROLE names are fixed by the specs, the
 *    model behind each is the user's choice in the Models UI.
 *  - env: PI_SMOL_MODEL would override, but we pass --model explicitly so
 *    the binding is observable in Model Events / OMP output.
 *
 * The main agent session is never touched — every call spawns a separate
 * short-lived `omp` child that exits with its completion.
 */

import { spawn } from "node:child_process";
import { app } from "electron";
import { whichOmp, getAgentBridge } from "./omp-service";
import { currentOmpPath } from "./store-service";
import { readRoles } from "./models/omp-config";

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

export type OneshotRun = { ok: true; stdout: string } | { ok: false; error: string };

/** One stateless completion = one short-lived omp child. */
export async function runOneshot(opts: {
  system: string;
  prompt: string;
  /** `<profile>/<model>` selector; omitted = OMP's default binding */
  model?: string | null;
  /** default 60 s */
  timeoutMs?: number;
}): Promise<OneshotRun> {
  if (!(await oneshotAvailable())) return { ok: false, error: "requires OMP oneshot support" };
  const bin = ompBin!;

  const args = [
    "-p",
    "--no-tools",
    "--no-session",
    "--no-extensions",
    "--no-skills",
    "--no-rules",
    "--thinking",
    "off",
    ...(opts.model ? ["--model", opts.model] : []),
    "--system-prompt",
    opts.system,
    opts.prompt,
  ];

  const { promise, resolve } = Promise.withResolvers<OneshotRun>();
  let out = "";
  let err = "";
  let settled = false;
  const done = (r: OneshotRun) => {
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
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }

  const timeoutMs = opts.timeoutMs ?? 60_000;
  const killer = setTimeout(() => {
    try {
      proc.kill();
    } catch {}
    done({ ok: false, error: `oneshot timed out after ${Math.round(timeoutMs / 1000)}s` });
  }, timeoutMs);

  proc.stdout.setEncoding("utf-8");
  proc.stdout.on("data", (c: string) => (out += c));
  proc.stderr.setEncoding("utf-8");
  proc.stderr.on("data", (c: string) => (err = (err + c).slice(-500)));
  proc.on("error", (e) => {
    clearTimeout(killer);
    ompBin = null;
    done({ ok: false, error: e.message });
  });
  proc.on("exit", (code) => {
    clearTimeout(killer);
    if (code !== 0) {
      done({ ok: false, error: `omp exited ${code ?? "?"}${err ? ` — ${err.slice(-200)}` : ""}` });
      return;
    }
    done({ ok: true, stdout: out });
  });
  return promise;
}
