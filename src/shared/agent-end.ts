export interface AgentEndClassification {
  aborted: boolean;
  failed: boolean;
}

/** The final OMP stop reason wins; the local abort flag is only a no-verdict fallback. */
export function classifyAgentEnd(lastStopReason: string | undefined, abortRequested: boolean): AgentEndClassification {
  return {
    aborted: lastStopReason !== undefined ? lastStopReason === "aborted" : abortRequested,
    failed: lastStopReason === "error",
  };
}

export type TeamAgentEndDecision = "continue" | "error" | "none";

/** Called after Team's synchronous event listener has updated its phase. */
export function classifyTeamAgentEnd(phase: string | null): TeamAgentEndDecision {
  if (phase === "route" || phase === "gate" || phase === "execute" || phase === "verify") return "continue";
  return phase === "stalled" ? "error" : "none";
}

export function shouldStallTeamLeadEnd(
  phase: string,
  poolActive: boolean,
  executionStarting: boolean,
  needsCall: boolean,
): boolean {
  return (phase === "execute" || phase === "verify") && !poolActive && !executionStarting && !needsCall;
}
