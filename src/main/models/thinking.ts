/**
 * Thinking-level mapping and capability.
 *
 * DISCOVERY (verified against omp v17.1.3, extends the model-mechanism block
 * in omp-config.ts):
 * 1. Live control — RPC `set_thinking_level {level}` on the running session;
 *    vocabulary off|minimal|low|medium|high|xhigh|max. `get_state` echoes the
 *    active `thinkingLevel` (ground truth). Applies to the next turn.
 * 2. Persistence — `config.yml` `modelRoles` selectors accept a `:level`
 *    suffix (e.g. `provider/model:high`); omp applies it on session start.
 * 3. Capability — omp's own model catalog (RPC `get_available_models`)
 *    carries per-model `thinking` metadata; models without it are
 *    non-thinking and omp itself never sends reasoning params to them.
 *    The IDE derives capability from that catalog (runtime), with a
 *    persisted `no-thinking` overlay for models whose set_thinking_level
 *    is rejected at runtime.
 *
 * The IDE vocabulary is off|low|med|high|xhigh|max; this table maps it onto
 * omp's scheme. It is data — no scattered conditionals.
 */

import type { ThinkingLevel } from "../../shared/types";

export type ThinkLevel = ThinkingLevel;

/** IDE level → omp `set_thinking_level` / `:suffix` value */
export const LEVEL_TO_OMP: Record<ThinkLevel, string> = {
  off: "off",
  low: "low",
  med: "medium",
  high: "high",
  xhigh: "xhigh",
  max: "max",
};

/** omp thinkingLevel → nearest IDE level (for displaying ground truth) */
export function ompLevelToIde(omp: string): ThinkLevel {
  switch (omp) {
    case "off":
      return "off";
    case "minimal":
    case "low":
      return "low";
    case "medium":
    case "auto":
      return "med";
    case "xhigh":
      return "xhigh";
    case "max":
      return "max";
    default:
      return "high";
  }
}

export type ThinkCapability = "supported" | "no-thinking" | "unknown";

/**
 * Derive capability from an omp catalog entry's `thinking` field.
 * Shapes seen in the wild: `{mode:"effort", efforts:[…]}`, `["high","max"]`,
 * `true`, or absent/false for non-thinking models.
 */
export function capabilityFromCatalog(thinking: unknown, reasoning: unknown): ThinkCapability {
  if (thinking && typeof thinking === "object") return "supported";
  if (Array.isArray(thinking) && thinking.length) return "supported";
  if (thinking === true || reasoning === true) return "supported";
  if (thinking === undefined && reasoning === undefined) return "unknown";
  return "no-thinking";
}
