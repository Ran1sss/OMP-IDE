/**
 * Auto-swap engine: quota failover between profiles exposing the SAME model.
 *
 * Invariants (never violated):
 *  - same model id — no candidate ⇒ no swap, existing recovery flow fires;
 *  - same effective thinking level — levels are role-bound in this build
 *    (role default + session override + boost live outside profiles), so a
 *    profile rewrite cannot disturb the resolver; each SWAP log entry records
 *    the level as proof.
 *
 * Retry mechanics: OMP keeps turn history through a mid-session set_model
 * (verified live on v17: after a failed turn, set_model + a continuation
 * prompt completes the ORIGINAL request). There is no `retry` RPC.
 *
 * Deletability: removing this module (and its one-line imports in manager.ts /
 * watch-manager.ts / remote manager) restores pre-swap Model Control behavior.
 */

import type { ModelRole, ThinkingLevel } from "../../shared/types";
import { MODEL_ROLES } from "../../shared/types";
import { classifyProviderError, type ErrorClass } from "./error-classifier";
import { loadModelsStore, saveModelsStore } from "./store";

export interface SwapHost {
  /** live profile snapshot in card order: name, model ids, enabled, health */
  candidates(): { name: string; modelIds: string[]; enabled: boolean; healthOk: boolean; balance: number | null }[];
  /** rewrite a role through the existing qualified-switch path */
  rewriteRole(role: ModelRole, selector: string, origin: string): Promise<{ ok: boolean; error?: string }>;
  /** mark/unmark the depleted health state (engine is the only writer) */
  setDepleted(name: string, depleted: boolean, detail?: string): void;
  isDepleted(name: string): boolean;
  /** async wallet confirmation after marking depleted */
  probeBalance(name: string): void;
  effectiveThinking(): ThinkingLevel;
  log(kind: "SWAP" | "health", detail: string, origin: string): void;
  /** toast in every window */
  notifyUi(message: string, crit: boolean): void;
  /** continuation prompt to the live agent (default role retries) */
  promptContinue(): boolean;
  /** all-candidates-exhausted → the existing recovery card path */
  markRoleDegraded(role: ModelRole, message: string): void;
}

/** remote notice hook — registered by the remote module when it's built */
let remoteNotifier: ((text: string) => void) | null = null;

export function registerSwapRemoteNotifier(fn: ((text: string) => void) | null): void {
  remoteNotifier = fn;
}

export function notifyRemote(text: string): void {
  remoteNotifier?.(text);
}

interface Incident {
  /** profiles already tried during this incident — each at most once */
  tried: Set<string>;
  startedAt: number;
  /** one rate-limit retry per incident */
  rateRetried: boolean;
  /** one remote notice per smol incident (spec: not per batched evaluation) */
  noticed: boolean;
}

const INCIDENT_TTL_MS = 10 * 60_000;

export class SwapEngine {
  private incidents = new Map<ModelRole, Incident>();

  constructor(private host: SwapHost) {}

  /** call when a turn/oneshot SUCCEEDS on a role — closes the incident */
  clearIncident(role: ModelRole): void {
    this.incidents.delete(role);
  }

  private incident(role: ModelRole): Incident {
    let inc = this.incidents.get(role);
    if (inc && Date.now() - inc.startedAt > INCIDENT_TTL_MS) inc = undefined;
    if (!inc) {
      inc = { tried: new Set(), startedAt: Date.now(), rateRetried: false, noticed: false };
      this.incidents.set(role, inc);
    }
    return inc;
  }

  /** roles currently bound to profile/model (a provider error names both) */
  private rolesFor(provider: string, modelId: string): ModelRole[] {
    const store = loadModelsStore();
    return MODEL_ROLES.filter((r) => store.roles[r] === `${provider}/${modelId}`);
  }

  /**
   * Entry point for provider failures (live-session turn errors AND smol
   * oneshot failures). Returns what was done, for callers that retry
   * themselves (the listener re-evaluates on its next batch).
   */
  async onProviderError(
    provider: string,
    modelId: string,
    status: number | null,
    message: string,
    origin: "turn" | "oneshot",
  ): Promise<{ action: "swapped" | "retry-wait" | "none"; newSelector?: string }> {
    const store = loadModelsStore();
    const cls: ErrorClass = classifyProviderError(status, message);
    const roles = this.rolesFor(provider, modelId);
    if (!roles.length) return { action: "none" };

    if (cls.kind === "rate-limit-transient") {
      // never swap for a rate blip: wait once, then nudge the turn onward
      const role = roles[0];
      const inc = this.incident(role);
      if (origin === "turn" && !inc.rateRetried) {
        inc.rateRetried = true;
        setTimeout(() => {
          if (this.host.promptContinue())
            this.host.log("health", `rate-limited on ${provider} — retried after ${Math.round(cls.retryAfterMs / 1000)}s`, "auto");
        }, cls.retryAfterMs);
        return { action: "retry-wait" };
      }
      return { action: "none" };
    }

    if (cls.kind !== "quota-depleted") return { action: "none" }; // auth/network: existing health flow

    if (!store.autoSwapEnabled) return { action: "none" };

    let result: { action: "swapped" | "none"; newSelector?: string } = { action: "none" };
    for (const role of roles) {
      if (store.autoSwapRoleOptOut[role]) continue;
      const r = await this.swapRole(role, provider, modelId, origin);
      if (r) result = { action: "swapped", newSelector: r };
    }
    return result;
  }

  private async swapRole(
    role: ModelRole,
    fromProfile: string,
    modelId: string,
    origin: "turn" | "oneshot",
  ): Promise<string | null> {
    const inc = this.incident(role);
    inc.tried.add(fromProfile);
    this.host.setDepleted(fromProfile, true, "quota/balance exhausted");
    this.host.probeBalance(fromProfile); // async wallet confirmation

    // candidates: enabled ∧ healthy ∧ ¬depleted ∧ same model, balance desc then card order
    const all = this.host.candidates();
    const candidates = all
      .filter(
        (c) =>
          c.enabled &&
          c.healthOk &&
          !this.host.isDepleted(c.name) &&
          c.name !== fromProfile &&
          !inc.tried.has(c.name) &&
          c.modelIds.includes(modelId),
      )
      .sort((a, b) => (b.balance ?? -Infinity) - (a.balance ?? -Infinity));

    if (!candidates.length) {
      const msg = `all profiles for ${modelId} are depleted`;
      this.host.log("SWAP", `${role}: ${msg} (tried: ${[...inc.tried].join(", ")})`, "auto");
      this.host.markRoleDegraded(role, msg);
      this.host.notifyUi(`No profiles left for ${modelId} — ${role} degraded`, true);
      if (!inc.noticed) {
        inc.noticed = true;
        notifyRemote(`⚠ ${role}: ${msg}`);
      }
      return null;
    }

    const target = candidates[0];
    inc.tried.add(target.name);
    const selector = `${target.name}/${modelId}`;
    const level = this.host.effectiveThinking();

    const res = await this.host.rewriteRole(role, selector, "auto");
    if (!res.ok) {
      this.host.log("SWAP", `${role}: rewrite to ${selector} failed: ${res.error ?? "?"}`, "auto");
      return null;
    }

    // loud, everywhere — toast + SWAP log (with level proof) + remote notice
    this.host.log(
      "SWAP",
      `${role}: ${fromProfile} → ${target.name} (${modelId}, thinking ${level}, quota/depleted)`,
      "auto",
    );
    this.host.notifyUi(`Swapped ${role}: ${fromProfile} → ${target.name} (quota)`, false);
    if (origin === "turn" || !inc.noticed) {
      inc.noticed = true;
      notifyRemote(`⚠ swapped ${role}: ${fromProfile} → ${target.name} (quota)`);
    }

    // retry the failed turn once on the new profile (history survives set_model)
    if (origin === "turn" && role === "default") this.host.promptContinue();
    return selector;
  }
}
