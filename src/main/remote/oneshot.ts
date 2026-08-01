/**
 * Chat-listener triage over the shared OMP oneshot runner — the listener's
 * brain. The invocation mechanism itself (CLI discovery, spawn, timeout)
 * lives in ../oneshot-runner.ts and is shared with Prompt Improve; this
 * module owns only the triage prompt and verdict parsing.
 *
 * The smol role binds the call: the ROLE name is fixed by the spec, the
 * model behind it is the user's choice in the Models UI.
 */

import { runOneshot, oneshotAvailable, smolSelector } from "../oneshot-runner";

// listener callers (watch-manager) import these from here — same surface
export { oneshotAvailable, smolSelector };

const TRIAGE_SYSTEM_PROMPT =
  "You are a triage filter for a dev-team group chat. Decide if the transcript " +
  "contains a concrete, actionable software task for this workspace. " +
  "Reply with exactly NO, or exactly TASK: <one short imperative line>.";

export type OneshotResult =
  | { kind: "task"; line: string }
  | { kind: "no-task" }
  | { kind: "error"; error: string };

/** Evaluate a transcript batch on the smol role. One call = one omp child. */
export async function evaluateTranscript(transcript: string): Promise<OneshotResult> {
  const res = await runOneshot({
    system: TRIAGE_SYSTEM_PROMPT,
    prompt: transcript,
    model: smolSelector(),
    timeoutMs: 60_000,
  });
  if (!res.ok) return { kind: "error", error: res.error };
  return parseVerdict(res.stdout);
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
