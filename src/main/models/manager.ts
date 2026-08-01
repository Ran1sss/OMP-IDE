/**
 * Model Control backend, profile edition: OMP's models.yml `providers:` map
 * is the profile registry (source of truth). The IDE enumerates it, writes
 * through it (create/duplicate/rename/delete), and keeps only supplementary
 * metadata (favorites, enabled, origin badges, roles mirror, thinking) in
 * its own store. Every model reference is `<profile>/<model>` — natively
 * OMP's own addressing, no translation layer.
 */

import type { IpcMain } from "electron";
import { BrowserWindow } from "electron";
import { readdirSync } from "node:fs";
import { basename } from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import { runOneshot, oneshotAvailable, smolSelector } from "../oneshot-runner";
import type {
  ModelsState,
  ModelsUsage,
  ModelRole,
  ModelEvent,
  ProviderInfo,
  ProviderTemplateId,
  ValidateResult,
  ProviderHealth,
  ThinkingLevel,
} from "../../shared/types";
import { MODEL_ROLES, THINKING_LEVELS } from "../../shared/types";
import { getAgentBridge, setOmpChildEnv, onNewSession, registerThinkingControl, type AgentBridge } from "../omp-service";
import { LEVEL_TO_OMP, capabilityFromCatalog, type ThinkCapability } from "./thinking";
import {
  loadModelsStore,
  saveModelsStore,
  defaultMeta,
  putProviderKey,
  getProviderKey,
  dropProviderKey,
  hasProviderKey,
  rekeyProfile,
  type BuiltinProfile,
  type ProfileMeta,
} from "./store";
import { TEMPLATES, fetchProviderModels } from "./providers";
import {
  MODELS_YML,
  CONFIG_YML,
  envVarFor,
  writeRole,
  readRoles,
  readOmpProfiles,
  writeOmpProfile,
  deleteOmpProfile,
  renameOmpProfile,
  renameInConfigYml,
  validProfileName,
  BUILTIN_ENV,
  type OmpProfile,
} from "./omp-config";
import { probeBalance } from "./balance";
import { SwapEngine, notifyRemote } from "./swap-engine";
import { registerTesterHost, registerTesterHandlers } from "./api-tester";
import type { TesterProtocol, TesterVerdict } from "../../shared/types";

/**
 * Prompt Improve instruction template, v1 (versioned in code per spec §2).
 * The oneshot payload = this system prompt + draft + one workspace line —
 * no file contents, no chat history, no secrets.
 */
const ENHANCE_SYSTEM_V1 =
  "Rewrite the user's draft as a precise task for a coding agent working in this workspace. " +
  "Keep the user's language (Russian stays Russian). Keep the intent; add missing specifics " +
  "only when they are unambiguous from the draft or the workspace line. State the expected " +
  "deliverable. No preamble, no quotes, no commentary — output the rewritten prompt only.";

class ModelsManager {
  private bridge: AgentBridge = getAgentBridge();
  private health = new Map<string, { state: ProviderHealth; detail?: string }>();
  private pendingSwitch: { selector: string; label: string } | null = null;
  private usage: ModelsUsage = { requests: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, hasTokenData: false };
  /** Prompt Improve oneshots — real requests the session stats never see (cost honesty) */
  private extraRequests = 0;
  private usagePollTimer: NodeJS.Timeout | null = null;
  /** session-only thinking override; cleared on new session */
  private sessionThinking: ThinkingLevel | null = null;
  /** thinking level change queued to the run boundary */
  private pendingThinking: ThinkingLevel | null = null;
  /** capability of active model per omp catalog; refreshed on model change */
  private activeCapability: ThinkCapability = "unknown";
  /** live snapshot of OMP's profile registry (reconciled from models.yml) */
  private profiles: OmpProfile[] = [];
  private watcher: FSWatcher | null = null;
  private reconcileTimer: NodeJS.Timeout | null = null;
  /** last state JSON pushed — reconcile skips no-op pushes (self-write loop guard) */
  private lastStateJson = "";
  /** depleted = quota/wallet empty; the swap engine is the only writer */
  private depleted = new Map<string, string>();
  private balancePollTimer: NodeJS.Timeout | null = null;
  /** roles the swap engine gave up on (recovery card names the situation) */
  private degradedRoles = new Map<ModelRole, string>();
  readonly swap = new SwapEngine({
    candidates: () => {
      const store = loadModelsStore();
      return this.allInfos().map((p) => ({
        name: p.id,
        modelIds: p.models.map((m) => m.id),
        enabled: p.enabled,
        healthOk: p.health === "ok" || p.health === "unknown" || p.health === "depleted",
        balance: store.profileMeta[p.id]?.balance?.value ?? null,
      }));
    },
    rewriteRole: (role, selector, origin) => this.assignRole(role, selector, origin),
    setDepleted: (name, depleted, detail) => {
      if (depleted) {
        this.depleted.set(name, detail ?? "quota exhausted");
        this.health.set(name, { state: "depleted", detail });
      } else {
        this.depleted.delete(name);
        if (this.health.get(name)?.state === "depleted") this.health.set(name, { state: "unknown" });
      }
      this.pushState();
    },
    isDepleted: (name) => this.depleted.has(name),
    probeBalance: (name) => void this.checkBalance(name),
    effectiveThinking: () => this.effectiveThinking(),
    log: (kind, detail, origin) => this.log(kind, detail, origin),
    notifyUi: (message, crit) => {
      for (const w of BrowserWindow.getAllWindows()) w.webContents.send("models:swapNotice", { message, crit });
    },
    promptContinue: () =>
      this.bridge.prompt(
        "[auto-swap] The previous model reply failed because the provider's quota ran out; the profile has been swapped. Continue with the task exactly where it left off.",
      ),
    markRoleDegraded: (role, message) => {
      this.degradedRoles.set(role, message);
      this.pushState();
    },
  });

  init(): void {
    this.reconcile();
    // adopt roles already present in omp's config.yml (user may have set them there)
    const store = loadModelsStore();
    const ompRoles = readRoles();
    for (const role of MODEL_ROLES) {
      if (!store.roles[role] && ompRoles[role]) store.roles[role] = ompRoles[role] ?? null;
    }
    saveModelsStore();
    this.applyChildEnv();

    // session overrides die with the session (by design)
    onNewSession(() => {
      this.sessionThinking = null;
      this.pendingThinking = null;
      void this.applyThinking("new-session");
      this.pushState();
    });
    this.bridge.onModelChange((m) => {
      this.log("switch", `active model now ${m.provider}/${m.id}`, "omp");
      void this.refreshCapability();
      void this.applyThinking("model-change");
      this.pushState();
    });
    this.bridge.onStatus((s) => {
      if (s.state === "idle" && this.pendingSwitch) {
        const sw = this.pendingSwitch;
        this.pendingSwitch = null;
        void this.requestSwitch(sw.selector, "queued");
      }
      if (s.state === "idle" && this.pendingThinking !== null) {
        this.pendingThinking = null;
        void this.applyThinking("queued");
      }
      if (s.state === "idle") void this.refreshUsage();
    });
    this.bridge.onEvent((e) => {
      if (e.kind === "user-message") this.usage.requests++;
      if (e.kind === "agent-end") void this.refreshUsage();
      if (e.kind === "turn-error") {
        void this.swap.onProviderError(e.provider, e.modelId, e.status, e.message, "turn");
      }
      if (e.kind === "agent-end") {
        // a clean end closes swap incidents; a turn-error above re-opens them
        for (const role of MODEL_ROLES) {
          if (!this.degradedRoles.has(role)) this.swap.clearIncident(role);
        }
      }
    });
    this.startBalancePoll();
    void this.refreshCapability();
    void this.applyThinking("startup");

    // health check on start for profiles owning a role
    const owned = new Set<string>();
    for (const role of MODEL_ROLES) {
      const sel = store.roles[role];
      if (sel) owned.add(sel.split("/")[0]);
    }
    for (const name of owned) {
      if (this.findProfile(name)) void this.checkHealth(name);
    }

    // live config sync: external edits reconcile into the UI (~2s)
    this.watcher = chokidar.watch([MODELS_YML, CONFIG_YML], { ignoreInitial: true });
    this.watcher.on("all", () => {
      clearTimeout(this.reconcileTimer ?? undefined);
      this.reconcileTimer = setTimeout(() => {
        const prev = this.profiles;
        this.reconcile();
        this.applyChildEnv();
        this.pushState(); // no-op when nothing changed (lastStateJson guard)
        this.checkOrphanedRoles(prev);
      }, 500);
    });

    // cross-module thinking surface (consumed by the remote module's /think)
    registerThinkingControl({
      describe: () => ({
        effective: this.effectiveThinking(),
        override: this.sessionThinking,
        capability: this.activeCapability,
      }),
      setSession: (level, origin) => {
        if (!(THINKING_LEVELS as string[]).includes(level))
          return { ok: false, error: `Unknown level "${level}". Use: ${THINKING_LEVELS.join(" · ")}` };
        if (this.activeCapability === "no-thinking")
          return { ok: false, error: "Active model doesn't support thinking." };
        const r = this.setSessionThinking(level as ThinkingLevel, origin);
        return { ok: true, pending: r.pending };
      },
    });

    // API tester ↔ Models integration: profile resolution, TEST events,
    // health updates through the same machinery as autoswap.
    registerTesterHost({
      resolveProfile: (name) => {
        const info = this.allInfos().find((p) => p.id === name);
        if (!info) return null;
        const builtin = loadModelsStore().builtins.find((b) => b.name === name);
        const profile = this.findProfile(name);
        const key = builtin ? (getProviderKey(name) ?? "") : profile ? this.validationKey(profile) : "";
        if (!key) return null;
        // template → wire protocol; custom profiles are OpenAI-compatible by construction
        const protocol: TesterProtocol =
          info.template === "anthropic" ? "anthropic" :
          info.template === "google" ? "gemini" : "openai-chat";
        // starred model first, then card order
        const models = [...info.models].sort((a, b) => Number(b.favorite) - Number(a.favorite)).map((m) => m.id);
        return { baseUrl: info.baseUrl, key, protocol, models };
      },
      enabledProfiles: () => this.allInfos().filter((p) => p.enabled && p.hasKey && p.origin !== "readonly").map((p) => p.id),
      logTest: (detail) => {
        this.log("TEST", detail, "tester");
      },
      applyHealth: (name, verdict: TesterVerdict, detail) => {
        if (verdict === "auth") this.health.set(name, { state: "auth-error", detail: detail.slice(0, 200) });
        else if (verdict === "quota") {
          // same writer as autoswap: depleted + async wallet confirmation
          this.depleted.set(name, detail.slice(0, 200));
          this.health.set(name, { state: "depleted", detail: detail.slice(0, 200) });
          void this.checkBalance(name);
        } else if (verdict === "rate-limited") this.health.set(name, { state: "rate-limited", detail: detail.slice(0, 200) });
        else if (verdict === "ok" && this.health.get(name)?.state !== "depleted") {
          this.health.set(name, { state: "ok" });
        }
        // network/mismatch/unparseable do not flip health — they describe the
        // probe, not the credential (mismatch IS surfaced on the verdict card)
        this.pushState();
      },
    });
  }

  dispose(): void {
    clearInterval(this.usagePollTimer ?? undefined);
    clearTimeout(this.reconcileTimer ?? undefined);
    clearInterval(this.balancePollTimer ?? undefined);
    void this.watcher?.close();
    registerThinkingControl(null);
  }

  // ================================================== balances

  private startBalancePoll(): void {
    clearInterval(this.balancePollTimer ?? undefined);
    const minutes = loadModelsStore().balancePollMinutes;
    if (minutes <= 0) {
      this.balancePollTimer = null;
      return;
    }
    this.balancePollTimer = setInterval(() => void this.checkAllBalances(), minutes * 60_000);
  }

  /** endpoint for a profile: stored value, else the template prefill (echogate) */
  balanceEndpointFor(name: string): string {
    const meta = loadModelsStore().profileMeta[name];
    if (meta?.balanceEndpoint !== undefined) return meta.balanceEndpoint;
    // NOTE: reads raw profile/builtin records, NOT allInfos() (which builds
    // ProviderInfo via this very function — recursion)
    const baseUrl = this.findProfile(name)?.baseUrl ?? loadModelsStore().builtins.find((b) => b.name === name)?.baseUrl ?? "";
    // echogate prefill: any profile pointing at the echogate API
    if (/api\.echogate\.one/i.test(baseUrl)) return "/wallet/balance";
    return "";
  }

  async checkBalance(name: string): Promise<{ ok: boolean; value?: number; currency?: string; raw?: string; error?: string }> {
    const baseUrl = this.findProfile(name)?.baseUrl ?? loadModelsStore().builtins.find((b) => b.name === name)?.baseUrl;
    if (!baseUrl) return { ok: false, error: "Profile not found" };
    const endpoint = this.balanceEndpointFor(name);
    if (!endpoint) return { ok: false, error: "No balance endpoint configured" };
    const profile = this.findProfile(name);
    const key = profile ? this.validationKey(profile) : getProviderKey(name) ?? "";
    const res = await probeBalance(baseUrl, endpoint, key);
    const store = loadModelsStore();
    const meta = store.profileMeta[name] ?? (store.profileMeta[name] = defaultMeta("imported"));
    if (!res.ok) {
      this.log("balance", `${name}: probe failed — ${res.error}`, "probe");
      this.pushState();
      return { ok: false, error: res.error };
    }
    meta.balance = res.info;
    // funds visible again → depleted lifts (probe + manual re-enable are the removers)
    if (res.info.value !== null && res.info.value > 0 && this.depleted.has(name)) {
      this.depleted.delete(name);
      if (this.health.get(name)?.state === "depleted") this.health.set(name, { state: "unknown" });
      this.log("health", `${name}: balance recovered — depleted lifted`, "probe");
    }
    this.applyThreshold(name, meta);
    saveModelsStore();
    this.pushState();
    return res.info.value === null
      ? { ok: true, raw: res.info.raw }
      : { ok: true, value: res.info.value, currency: res.info.currency ?? undefined };
  }

  async checkAllBalances(): Promise<void> {
    const store = loadModelsStore();
    const targets = this.allInfos().filter(
      (p) => p.enabled && this.balanceEndpointFor(p.id) && (store.profileMeta[p.id]?.enabled ?? true),
    );
    // Electron's main-process fetch flakes under a 7-wide burst to one host
    // (observed: sporadic 15s stalls / "fetch failed"); pool of 3 + one retry
    // keeps the global check reliable without serializing it.
    const queue = [...targets];
    const worker = async () => {
      for (let p = queue.shift(); p; p = queue.shift()) {
        const first = await this.checkBalance(p.id);
        if (!first.ok) await this.checkBalance(p.id);
      }
    };
    await Promise.all(Array.from({ length: Math.min(3, targets.length) }, worker));
  }

  /** one toast + flare dot + remote notice per crossing, re-armed on recovery */
  private applyThreshold(name: string, meta: ProfileMeta): void {
    const threshold = meta.lowThreshold;
    const value = meta.balance?.value;
    if (threshold == null || value == null) return;
    if (value < threshold && !meta.thresholdNotified) {
      meta.thresholdNotified = true;
      this.log("balance", `${name}: balance ${value} below threshold ${threshold}`, "threshold");
      for (const w of BrowserWindow.getAllWindows())
        w.webContents.send("models:swapNotice", { message: `${name}: balance low (${value})`, crit: false });
      notifyRemote(`⚠ ${name}: balance low — ${value}${meta.balance?.currency ? ` ${meta.balance.currency}` : ""}`);
    } else if (value >= threshold && meta.thresholdNotified) {
      meta.thresholdNotified = false; // re-arm
    }
  }

  // ================================================== reconciliation (OMP wins)

  /** IDE view := OMP config. Idempotent; meta created for new profiles. */
  private reconcile(): void {
    this.profiles = readOmpProfiles();
    const store = loadModelsStore();
    let dirty = false;
    for (const p of this.profiles) {
      if (!p.parseable) continue;
      if (!store.profileMeta[p.name]) {
        store.profileMeta[p.name] = defaultMeta("imported");
        dirty = true;
      }
    }
    // meta for vanished profiles (kept for builtins) is dropped
    const live = new Set<string>([
      ...this.profiles.map((p) => p.name),
      ...store.builtins.map((b) => b.name),
    ]);
    for (const name of Object.keys(store.profileMeta)) {
      if (!live.has(name)) {
        delete store.profileMeta[name];
        this.health.delete(name);
        dirty = true;
      }
    }
    if (dirty) saveModelsStore();
  }

  /** does a selector resolve against a given profile snapshot? (builtins always live) */
  private selectorLiveIn(selector: string, profiles: OmpProfile[]): boolean {
    const slash = selector.indexOf("/");
    if (slash < 0) return false;
    const profile = selector.slice(0, slash);
    const modelId = selector.slice(slash + 1);
    const builtin = loadModelsStore().builtins.find((b) => b.name === profile);
    if (builtin) return builtin.models.some((m) => m.id === modelId);
    const p = profiles.find((x) => x.name === profile);
    return p !== undefined && p.models.some((m) => m.id === modelId);
  }

  /** an external edit tore a profile (or model id) out from under an assigned
   * role → force reassignment in the renderer. Flags only selectors the PREVIOUS
   * snapshot could resolve — never-resolvable forms (omp-native selectors adopted
   * from config.yml) stay untouched. The watcher's 500ms timer coalesces edit
   * bursts, and prev==current on a no-op reconcile, so each removal fires once. */
  private checkOrphanedRoles(prev: OmpProfile[]): void {
    const store = loadModelsStore();
    const orphaned = MODEL_ROLES.filter((role) => {
      const sel = store.roles[role];
      if (!sel) return false;
      return this.selectorLiveIn(sel, prev) && !this.selectorLiveIn(sel, this.profiles);
    });
    if (!orphaned.length) return;
    this.log("provider", `external edit orphaned role(s): ${orphaned.join(", ")}`, "external");
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send("models:rolesOrphaned", orphaned);
  }

  // ================================================== state assembly

  private findProfile(name: string): OmpProfile | undefined {
    return this.profiles.find((p) => p.name === name);
  }

  private profileTemplate(p: OmpProfile): ProviderTemplateId {
    // models.yml profiles are OpenAI-compatible by construction
    return "custom";
  }

  private profileInfo(p: OmpProfile): ProviderInfo {
    const store = loadModelsStore();
    const meta = store.profileMeta[p.name] ?? defaultMeta("imported");
    const h = this.health.get(p.name);
    const favs = new Set(meta.favorites);
    return {
      id: p.name,
      template: this.profileTemplate(p),
      displayName: p.name,
      baseUrl: p.baseUrl,
      enabled: p.parseable ? meta.enabled : false,
      health: h?.state ?? "unknown",
      healthDetail: h?.detail,
      models: p.models.map((m) => ({ ...m, favorite: favs.has(m.id) })),
      hasKey: hasProviderKey(p.name) || p.apiKeyRef !== null,
      origin: p.parseable ? meta.origin : "readonly",
      note: p.parseable ? undefined : "managed outside IDE — entry preserved verbatim",
      balanceEndpoint: this.balanceEndpointFor(p.name),
      balance: meta.balance ?? null,
      lowThreshold: meta.lowThreshold ?? null,
    };
  }

  private builtinInfo(b: BuiltinProfile): ProviderInfo {
    const store = loadModelsStore();
    const meta = store.profileMeta[b.name] ?? defaultMeta("ide");
    const h = this.health.get(b.name);
    const favs = new Set(meta.favorites);
    return {
      id: b.name,
      template: b.template,
      displayName: b.name,
      baseUrl: b.baseUrl,
      enabled: meta.enabled,
      health: h?.state ?? "unknown",
      healthDetail: h?.detail,
      models: b.models.map((m) => ({ ...m, favorite: favs.has(m.id) })),
      hasKey: hasProviderKey(b.name),
      origin: meta.origin,
      balanceEndpoint: this.balanceEndpointFor(b.name),
      balance: meta.balance ?? null,
      lowThreshold: meta.lowThreshold ?? null,
    };
  }

  private allInfos(): ProviderInfo[] {
    const store = loadModelsStore();
    return [
      ...store.builtins.map((b) => this.builtinInfo(b)),
      ...this.profiles.map((p) => this.profileInfo(p)),
    ];
  }

  /** the one resolver: effective = session override ?? default-role level */
  private effectiveThinking(): ThinkingLevel {
    return this.sessionThinking ?? loadModelsStore().thinkingRoles.default;
  }

  getState(): ModelsState {
    const store = loadModelsStore();
    const state: ModelsState = {
      providers: this.allInfos(),
      roles: {
        default: { selector: store.roles.default },
        smol: { selector: store.roles.smol },
        slow: { selector: store.roles.slow },
      },
      active: this.bridge.getActiveModel(),
      pending: this.pendingSwitch,
      thinking: {
        roles: { ...store.thinkingRoles },
        sessionOverride: this.sessionThinking,
        effective: this.effectiveThinking(),
        capability: this.activeCapability,
        pending: this.pendingThinking,
      },
      autoSwap: {
        enabled: store.autoSwapEnabled,
        roleOptOut: { ...store.autoSwapRoleOptOut },
      },
      balancePollMinutes: store.balancePollMinutes,
    };
    return state;
  }

  // ================================================== thinking (unchanged core)

  private async refreshCapability(): Promise<void> {
    const active = this.bridge.getActiveModel();
    if (!active) {
      this.activeCapability = "unknown";
      return;
    }
    const store = loadModelsStore();
    if (store.noThinking.includes(`${active.provider}/${active.id}`)) {
      this.activeCapability = "no-thinking";
      return;
    }
    const res = await this.bridge.request({ type: "get_available_models" }, 10_000);
    if (res.success && res.data && Array.isArray(res.data.models)) {
      const entry = (res.data.models as Record<string, unknown>[]).find(
        (m) => m.id === active.id && (m.provider === active.provider || m.provider === undefined),
      );
      if (entry) {
        this.activeCapability = capabilityFromCatalog(entry.thinking, entry.reasoning);
        this.pushState();
        return;
      }
    }
    this.activeCapability = "unknown";
  }

  /** push the effective level into the live session (next-turn semantics) */
  private async applyThinking(origin: string): Promise<void> {
    if (this.activeCapability === "no-thinking") return; // omit param entirely
    const level = this.effectiveThinking();
    const res = await this.bridge.request(
      { type: "set_thinking_level", level: LEVEL_TO_OMP[level] },
      8000,
    );
    if (!res.success && res.error) {
      const active = this.bridge.getActiveModel();
      if (active && this.activeCapability === "unknown") {
        const store = loadModelsStore();
        const sel = `${active.provider}/${active.id}`;
        if (!store.noThinking.includes(sel)) {
          store.noThinking.push(sel);
          saveModelsStore();
        }
        this.activeCapability = "no-thinking";
        this.log("THINK", `${sel} rejected thinking param — marked no-thinking`, origin);
        for (const w of BrowserWindow.getAllWindows())
          w.webContents.send("models:thinkRejected", active.id);
        this.pushState();
      }
    }
  }

  setRoleThinking(role: ModelRole, level: ThinkingLevel, origin: string): void {
    const store = loadModelsStore();
    store.thinkingRoles[role] = level;
    saveModelsStore();
    const sel = store.roles[role];
    if (sel) writeRole(role, `${sel}:${LEVEL_TO_OMP[level]}`);
    this.log("THINK", `${role} default → ${level}`, origin);
    if (role === "default" && this.sessionThinking === null) this.queueOrApplyThinking(origin);
    this.pushState();
  }

  setSessionThinking(level: ThinkingLevel | null, origin: string): { pending: boolean } {
    this.sessionThinking = level;
    this.log("THINK", level ? `session override → ${level}` : "session override cleared", origin);
    const pending = this.queueOrApplyThinking(origin);
    this.pushState();
    return { pending };
  }

  /** mid-run changes queue to the boundary — never yank a live turn */
  private queueOrApplyThinking(origin: string): boolean {
    const st = this.bridge.getStatus();
    const busy = st && (st.state === "thinking" || st.state === "tool" || st.state === "awaiting-input");
    if (busy) {
      this.pendingThinking = this.effectiveThinking();
      return true;
    }
    void this.applyThinking(origin);
    return false;
  }

  pushState(): void {
    const s = this.getState();
    const json = JSON.stringify(s);
    if (json === this.lastStateJson) return;
    this.lastStateJson = json;
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send("models:state", s);
  }

  private pushUsage(): void {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send("models:usage", this.getUsage());
  }

  private log(kind: ModelEvent["kind"], detail: string, origin: string): void {
    const store = loadModelsStore();
    store.events.push({ time: Date.now(), kind, detail, origin });
    if (store.events.length > 50) store.events.shift();
    saveModelsStore();
  }

  /** env for the spawned omp child: profile key env-vars + builtin env vars */
  private applyChildEnv(): void {
    const store = loadModelsStore();
    const env: Record<string, string> = {};
    for (const b of store.builtins) {
      const meta = store.profileMeta[b.name];
      if (meta && !meta.enabled) continue;
      const key = getProviderKey(b.name);
      const envVar = BUILTIN_ENV[b.name] ?? TEMPLATES[b.template].ompEnvVar;
      if (key && envVar) env[envVar] = key;
    }
    for (const p of this.profiles) {
      if (!p.parseable) continue;
      // inject only when the profile references our env-var scheme
      if (p.apiKeyRef === envVarFor(p.name)) {
        const key = getProviderKey(p.name);
        if (key) env[p.apiKeyRef] = key;
      }
    }
    setOmpChildEnv(env);
  }

  // ================================================== profile registry ops

  /** key for VALIDATION calls the IDE itself makes (never persisted) */
  private validationKey(p: OmpProfile): string {
    const vaultKey = getProviderKey(p.name);
    if (vaultKey) return vaultKey;
    if (p.apiKeyRef) {
      // OMP convention: env-var name first, then literal
      const fromEnv = process.env[p.apiKeyRef];
      if (fromEnv) return fromEnv;
      if (!/^[A-Z_][A-Z0-9_]*$/.test(p.apiKeyRef)) return p.apiKeyRef; // literal key
    }
    return "";
  }

  async addProvider(input: {
    template: ProviderTemplateId;
    name: string;
    apiKey: string;
    baseUrl: string;
  }): Promise<{ ok: true; provider: ProviderInfo } | { ok: false; error: string }> {
    const tmpl = TEMPLATES[input.template];
    if (!tmpl) return { ok: false, error: "Unknown provider template" };
    const store = loadModelsStore();

    if (input.template !== "custom") {
      // built-in: singleton pseudo-profile named by OMP's provider id
      const name = tmpl.ompProviderId!;
      if (store.builtins.some((b) => b.name === name))
        return { ok: false, error: `${tmpl.displayName} is already configured` };
      if (tmpl.needsKey && !input.apiKey.trim()) return { ok: false, error: "API key is required" };
      const baseUrl = (input.baseUrl || tmpl.defaultBaseUrl).trim().replace(/\/+$/, "");
      const res = await fetchProviderModels(input.template, baseUrl, input.apiKey.trim());
      if (!res.ok) return { ok: false, error: res.message };
      const builtin: BuiltinProfile = {
        name,
        template: input.template,
        baseUrl,
        models: res.models.map((m) => ({ id: m.id, name: m.name, contextWindow: m.contextWindow })),
      };
      store.builtins.push(builtin);
      store.profileMeta[name] = defaultMeta("ide");
      if (input.apiKey.trim()) putProviderKey(name, input.apiKey.trim());
      saveModelsStore();
      this.health.set(name, { state: "ok" });
      this.log("provider", `added ${name} (${res.models.length} models)`, "settings");
      this.applyChildEnv();
      this.pushState();
      return { ok: true, provider: this.builtinInfo(builtin) };
    }

    // custom = a real OMP profile in models.yml
    const name = input.name.trim().toLowerCase();
    if (!validProfileName(name))
      return { ok: false, error: "Profile name must be a slug: a-z, 0-9, dots, dashes (max 64)" };
    if (this.findProfile(name) || store.builtins.some((b) => b.name === name))
      return { ok: false, error: `Profile "${name}" already exists` };
    const baseUrl = input.baseUrl.trim().replace(/\/+$/, "");
    if (!baseUrl) return { ok: false, error: "Base URL is required" };

    // OMP's models.yml convention is env-name-or-literal: a key that looks
    // like an ENV VAR NAME and resolves is written as a reference (no vault
    // copy — the value never passes through IDE storage).
    const rawKey = input.apiKey.trim();
    const isEnvRef = /^[A-Z_][A-Z0-9_]*$/.test(rawKey) && process.env[rawKey] !== undefined;
    const effectiveKey = isEnvRef ? process.env[rawKey]! : rawKey;

    const res = await fetchProviderModels("custom", baseUrl, effectiveKey);
    if (!res.ok) return { ok: false, error: res.message };

    const hasKey = rawKey.length > 0;
    if (hasKey && !isEnvRef) putProviderKey(name, rawKey);
    writeOmpProfile({
      name,
      baseUrl,
      keyEnvVar: isEnvRef ? rawKey : hasKey ? envVarFor(name) : null,
      models: res.models.map((m) => ({ id: m.id, name: m.name, contextWindow: m.contextWindow })),
    });
    store.profileMeta[name] = defaultMeta("ide");
    saveModelsStore();
    this.reconcile();
    this.health.set(name, { state: "ok" });
    this.log("provider", `profile ${name} created (${res.models.length} models) → models.yml`, "settings");
    this.applyChildEnv();
    this.pushState();
    const p = this.findProfile(name);
    return p
      ? { ok: true, provider: this.profileInfo(p) }
      : { ok: false, error: "Profile write failed — models.yml not updated" };
  }

  async renameProfile(oldName: string, newNameRaw: string): Promise<{ ok: boolean; error?: string }> {
    const newName = newNameRaw.trim().toLowerCase();
    if (newName === oldName) return { ok: true };
    if (!validProfileName(newName))
      return { ok: false, error: "Profile name must be a slug: a-z, 0-9, dots, dashes (max 64)" };
    const store = loadModelsStore();
    if (this.findProfile(newName) || store.builtins.some((b) => b.name === newName))
      return { ok: false, error: `Profile "${newName}" already exists` };
    const src = this.findProfile(oldName);
    if (!src) return { ok: false, error: "Profile not found" };
    if (!src.parseable) return { ok: false, error: "This entry is managed outside the IDE" };

    // atomic-ish: models.yml key first; on success propagate everywhere.
    if (!renameOmpProfile(oldName, newName))
      return { ok: false, error: "Rename failed in models.yml" };
    renameInConfigYml(oldName, newName);
    rekeyProfile(oldName, newName); // vault + meta + role mirror + noThinking
    const meta = loadModelsStore().profileMeta[newName];
    if (meta) meta.origin = "ide"; // edited → no longer "imported"
    saveModelsStore();
    const h = this.health.get(oldName);
    if (h) {
      this.health.set(newName, h);
      this.health.delete(oldName);
    }
    this.reconcile();
    this.log("provider", `profile ${oldName} renamed → ${newName}`, "settings");
    this.applyChildEnv();
    this.pushState();
    return { ok: true };
  }

  async validateProvider(name: string): Promise<ValidateResult> {
    const store = loadModelsStore();
    const builtin = store.builtins.find((b) => b.name === name);
    if (builtin) {
      const key = getProviderKey(name) ?? "";
      const res = await fetchProviderModels(builtin.template, builtin.baseUrl, key);
      this.health.set(name, {
        state: res.ok ? "ok" : res.kind === "ok" ? "network-error" : res.kind,
        detail: res.ok ? undefined : res.message,
      });
      if (res.ok) {
        builtin.models = res.models.map((m) => ({ id: m.id, name: m.name, contextWindow: m.contextWindow }));
        saveModelsStore();
      }
      this.log("validate", `${name}: ${res.message}`, "settings");
      this.pushState();
      return { ok: res.ok, message: res.message, models: res.ok ? this.builtinInfo(builtin).models : [] };
    }

    const p = this.findProfile(name);
    if (!p) return { ok: false, message: "Profile not found", models: [] };
    const res = await fetchProviderModels("custom", p.baseUrl, this.validationKey(p));
    this.health.set(name, {
      state: res.ok ? "ok" : res.kind === "ok" ? "network-error" : res.kind,
      detail: res.ok ? undefined : res.message,
    });
    if (res.ok && p.parseable) {
      // refresh model list in models.yml, preserving hand-added ids
      const manual = p.models.filter((m) => !res.models.some((n) => n.id === m.id));
      writeOmpProfile({
        name,
        baseUrl: p.baseUrl,
        keyEnvVar: p.apiKeyRef === envVarFor(name) ? p.apiKeyRef : p.apiKeyRef ? p.apiKeyRef : null,
        models: [
          ...res.models.map((m) => ({ id: m.id, name: m.name, contextWindow: m.contextWindow })),
          ...manual,
        ],
      });
      this.reconcile();
    }
    this.log("validate", `${name}: ${res.message}`, "settings");
    this.pushState();
    const fresh = this.findProfile(name);
    return { ok: res.ok, message: res.message, models: fresh ? this.profileInfo(fresh).models : [] };
  }

  async checkHealth(name: string): Promise<void> {
    await this.validateProvider(name);
  }

  removeProvider(name: string): { needsReassign: ModelRole[] } | null {
    const store = loadModelsStore();
    const owned = MODEL_ROLES.filter((r) => store.roles[r]?.startsWith(`${name}/`));
    if (owned.length) return { needsReassign: owned };

    const builtinIdx = store.builtins.findIndex((b) => b.name === name);
    if (builtinIdx >= 0) {
      store.builtins.splice(builtinIdx, 1);
      delete store.profileMeta[name];
      saveModelsStore();
    } else {
      const p = this.findProfile(name);
      if (!p) return null;
      if (!p.parseable) return null; // read-only contract: never destroy
      if (!deleteOmpProfile(name)) return null;
      delete store.profileMeta[name];
      saveModelsStore();
      this.reconcile();
    }
    dropProviderKey(name);
    this.health.delete(name);
    this.log("provider", `profile ${name} removed (models.yml)`, "settings");
    this.applyChildEnv();
    this.pushState();
    return null;
  }

  setProviderEnabled(name: string, enabled: boolean): void {
    const store = loadModelsStore();
    if (!store.profileMeta[name]) store.profileMeta[name] = defaultMeta("imported");
    store.profileMeta[name].enabled = enabled;
    saveModelsStore();
    this.applyChildEnv();
    this.pushState();
  }

  setProviderKey(name: string, apiKey: string): void {
    putProviderKey(name, apiKey.trim());
    // IDE-created profiles reference our env var; ensure the ref exists after
    // a key is first set on a profile that previously had auth:none
    const p = this.findProfile(name);
    if (p && p.parseable && apiKey.trim() && p.apiKeyRef === null) {
      writeOmpProfile({ name, baseUrl: p.baseUrl, keyEnvVar: envVarFor(name), models: p.models });
      this.reconcile();
    }
    this.health.set(name, { state: "unknown" });
    this.log("provider", `${name}: key updated`, "settings");
    this.applyChildEnv();
    this.pushState();
  }

  addCustomModel(name: string, modelId: string): void {
    const id = modelId.trim();
    if (!id) return;
    const store = loadModelsStore();
    const builtin = store.builtins.find((b) => b.name === name);
    if (builtin) {
      if (builtin.models.some((m) => m.id === id)) return;
      builtin.models.push({ id, name: id, contextWindow: null });
      saveModelsStore();
      this.pushState();
      return;
    }
    const p = this.findProfile(name);
    if (!p || !p.parseable || p.models.some((m) => m.id === id)) return;
    writeOmpProfile({
      name,
      baseUrl: p.baseUrl,
      keyEnvVar: p.apiKeyRef,
      models: [...p.models, { id, name: id, contextWindow: null }],
    });
    this.reconcile();
    this.pushState();
  }

  setFavorite(name: string, modelId: string, fav: boolean): void {
    const store = loadModelsStore();
    if (!store.profileMeta[name]) store.profileMeta[name] = defaultMeta("imported");
    const favs = new Set(store.profileMeta[name].favorites);
    if (fav) favs.add(modelId);
    else favs.delete(modelId);
    store.profileMeta[name].favorites = [...favs];
    saveModelsStore();
    this.pushState();
  }

  // ================================================== roles & switching

  /** validate a qualified selector against the live registry */
  private resolveSelector(selector: string): { profile: string; modelId: string } | null {
    const slash = selector.indexOf("/");
    if (slash < 0) return null;
    const profile = selector.slice(0, slash);
    const modelId = selector.slice(slash + 1);
    const store = loadModelsStore();
    const builtin = store.builtins.find((b) => b.name === profile);
    if (builtin) return builtin.models.some((m) => m.id === modelId) ? { profile, modelId } : null;
    const p = this.findProfile(profile);
    if (p && p.models.some((m) => m.id === modelId)) return { profile, modelId };
    return null;
  }

  async assignRole(role: ModelRole, selector: string, origin: string): Promise<{ ok: boolean; error?: string }> {
    const resolved = this.resolveSelector(selector);
    if (!resolved) return { ok: false, error: "Unknown model selector" };
    const store = loadModelsStore();
    const meta = store.profileMeta[resolved.profile];
    if (meta && !meta.enabled) return { ok: false, error: "Profile is disabled" };

    store.roles[role] = selector;
    saveModelsStore();
    writeRole(role, selector); // qualified id verbatim — OMP's own addressing
    this.log("role", `${role} → ${selector}`, origin);

    if (role === "default") {
      return this.requestSwitch(selector, origin);
    }
    this.pushState();
    return { ok: true };
  }

  async switchModel(selector: string, origin: string): Promise<{ ok: boolean; pending: boolean; error?: string }> {
    const resolved = this.resolveSelector(selector);
    if (!resolved) return { ok: false, pending: false, error: "Unknown model selector" };
    const store = loadModelsStore();
    store.roles.default = selector;
    saveModelsStore();
    writeRole("default", selector);

    const status = this.bridge.getStatus();
    const busy = status && (status.state === "thinking" || status.state === "tool" || status.state === "awaiting-input");
    if (busy) {
      this.pendingSwitch = { selector, label: selector };
      this.log("switch", `queued ${selector} (agent running)`, origin);
      this.pushState();
      return { ok: true, pending: true };
    }
    const r = await this.requestSwitch(selector, origin);
    return { ok: r.ok, pending: false, error: r.error };
  }

  private async requestSwitch(selector: string, origin: string): Promise<{ ok: boolean; error?: string }> {
    const resolved = this.resolveSelector(selector);
    if (!resolved) return { ok: false, error: "Unknown model selector" };
    const res = await this.bridge.request({
      type: "set_model",
      provider: resolved.profile,
      modelId: resolved.modelId,
    });
    if (!res.success) {
      if (res.error?.includes("Model not found")) {
        this.log("switch", `live registry misses ${selector} — restarting session to apply`, origin);
        const restarted = await this.bridge.restartSession();
        if (restarted) {
          this.log("switch", `switched to ${selector} (via session restart)`, origin);
          this.pushState();
          return { ok: true };
        }
      }
      this.log("switch", `set_model failed: ${res.error ?? "?"}`, origin);
      this.pushState();
      return { ok: false, error: res.error };
    }
    this.log("switch", `switched to ${selector}`, origin);
    await this.bridge.request({ type: "get_state" });
    this.pushState();
    return { ok: true };
  }

  // ================================================== usage

  private async refreshUsage(): Promise<void> {
    const res = await this.bridge.request({ type: "get_session_stats" }, 8000);
    if (!res.success || !res.data) return;
    const d = res.data;
    const tokens = "tokens" in d && d.tokens && typeof d.tokens === "object" ? (d.tokens as Record<string, unknown>) : null;
    const input = tokens && typeof tokens.input === "number" ? tokens.input : 0;
    const output = tokens && typeof tokens.output === "number" ? tokens.output : 0;
    const reasoning = tokens && typeof tokens.reasoning === "number" ? tokens.reasoning : 0;
    const userMessages = "userMessages" in d && typeof d.userMessages === "number" ? d.userMessages : this.usage.requests;
    this.usage = {
      requests: userMessages,
      inputTokens: input,
      outputTokens: output,
      reasoningTokens: reasoning,
      hasTokenData: input > 0 || output > 0,
    };
    this.pushUsage();
  }

  getUsage(): ModelsUsage {
    // enhance oneshots are real requests — surfaced in the strip, never hidden
    return { ...this.usage, requests: this.usage.requests + this.extraRequests };
  }

  // ================================================== prompt improve (enhance)

  /** Why the wand would be disabled right now; ok=true → model short name too. */
  async enhanceStatus(): Promise<{ ok: boolean; reason?: string; model?: string }> {
    if (!(await oneshotAvailable())) return { ok: false, reason: "requires OMP oneshot support" };
    const sel = smolSelector();
    if (!sel) return { ok: false, reason: "smol role unassigned" };
    const profile = sel.split("/")[0];
    const h = this.health.get(profile);
    if (h && (h.state === "depleted" || h.state === "auth-error"))
      return { ok: false, reason: `smol profile ${h.state === "depleted" ? "depleted" : "auth error"}` };
    return { ok: true, model: sel.split("/").pop() };
  }

  /**
   * One click = at most ONE stateless oneshot on the smol role (same runner
   * as the chat listener; the agent session is never touched). 20 s cap.
   */
  async enhance(draft: string, origin: string): Promise<{ ok: true; text: string; model: string } | { ok: false; error: string }> {
    const st = await this.enhanceStatus();
    if (!st.ok) return { ok: false, error: st.reason ?? "unavailable" };
    const root = this.bridge.getRoot();
    // context, minimal but real: workspace name + top-level NAMES only
    let listing = "";
    try {
      if (root) listing = readdirSync(root).slice(0, 40).join(", ");
    } catch {}
    const prompt = `DRAFT:\n${draft}\n\nWORKSPACE: ${root ? basename(root) : "(no workspace open)"}${listing ? ` — ${listing}` : ""}`;
    if (process.env.OMP_IDE_ENHANCE_LOG) console.log(`[enhance payload]\n${ENHANCE_SYSTEM_V1}\n---\n${prompt}`);
    const res = await runOneshot({ system: ENHANCE_SYSTEM_V1, prompt, model: smolSelector(), timeoutMs: 20_000 });
    if (!res.ok) return { ok: false, error: res.error };
    const text = res.stdout.trim();
    if (!text) return { ok: false, error: "empty result" };
    this.log("ENHANCE", `${st.model}: «${draft.slice(0, 70)}» → ${text.length} chars`, origin);
    this.extraRequests++;
    this.pushUsage();
    return { ok: true, text, model: st.model ?? "smol" };
  }

  getEvents(): ModelEvent[] {
    return [...loadModelsStore().events];
  }

  // ================================================== auto-swap & balance settings

  setBalanceEndpoint(name: string, endpoint: string): void {
    const store = loadModelsStore();
    const meta = store.profileMeta[name] ?? (store.profileMeta[name] = defaultMeta("imported"));
    meta.balanceEndpoint = endpoint.trim();
    if (!meta.balanceEndpoint) meta.balance = null; // no endpoint → no stale readout
    saveModelsStore();
    this.pushState();
  }

  setLowThreshold(name: string, threshold: number | null): void {
    const store = loadModelsStore();
    const meta = store.profileMeta[name] ?? (store.profileMeta[name] = defaultMeta("imported"));
    meta.lowThreshold = threshold;
    meta.thresholdNotified = false;
    saveModelsStore();
    if (meta.balance) this.applyThreshold(name, meta);
    this.pushState();
  }

  setAutoSwap(enabled: boolean): void {
    const store = loadModelsStore();
    store.autoSwapEnabled = enabled;
    saveModelsStore();
    this.log("SWAP", `auto-swap ${enabled ? "enabled" : "disabled"}`, "settings");
    this.pushState();
  }

  setRoleSwapOptOut(role: ModelRole, optOut: boolean): void {
    const store = loadModelsStore();
    store.autoSwapRoleOptOut[role] = optOut;
    saveModelsStore();
    this.pushState();
  }

  setBalancePollMinutes(minutes: number): void {
    const store = loadModelsStore();
    store.balancePollMinutes = Math.max(0, Math.min(120, minutes));
    saveModelsStore();
    this.startBalancePoll();
    this.pushState();
  }

  /** manual re-enable: one of the two removers of `depleted` */
  clearDepleted(name: string): void {
    this.depleted.delete(name);
    if (this.health.get(name)?.state === "depleted") this.health.set(name, { state: "unknown" });
    this.degradedRoles.clear(); // a fresh candidate exists — degradation no longer certain
    this.log("health", `${name}: depleted cleared manually`, "settings");
    this.pushState();
  }
}

// ================================================== module surface

let manager: ModelsManager | null = null;

/**
 * Cross-module hook for the chat listener: a failed smol oneshot reports its
 * provider error here; the swap engine classifies and swaps the `smol` role
 * by the same rules as live turns (one notice per incident, not per batch).
 */
export async function reportOneshotError(status: number | null, message: string): Promise<void> {
  if (!manager) return;
  const smol = loadModelsStore().roles.smol;
  if (!smol) return;
  const slash = smol.indexOf("/");
  if (slash < 0) return;
  await manager.swap.onProviderError(smol.slice(0, slash), smol.slice(slash + 1), status, message, "oneshot");
}

export function registerModelsHandlers(ipc: IpcMain): void {
  manager = new ModelsManager();
  manager.init();
  const m = manager;

  ipc.handle("models:getState", async () => m.getState());
  ipc.handle("models:getUsage", async () => m.getUsage());
  ipc.handle("models:addProvider", async (_e, input: { template: ProviderTemplateId; name: string; apiKey: string; baseUrl: string }) => m.addProvider(input));
  ipc.handle("models:renameProfile", async (_e, oldName: string, newName: string) => m.renameProfile(oldName, newName));
  ipc.handle("models:validateProvider", async (_e, id: string) => m.validateProvider(id));
  ipc.handle("models:removeProvider", async (_e, id: string) => m.removeProvider(id));
  ipc.handle("models:setProviderEnabled", async (_e, id: string, enabled: boolean) => m.setProviderEnabled(id, enabled));
  ipc.handle("models:setProviderKey", async (_e, id: string, key: string) => m.setProviderKey(id, key));
  ipc.handle("models:addCustomModel", async (_e, id: string, modelId: string) => m.addCustomModel(id, modelId));
  ipc.handle("models:setFavorite", async (_e, id: string, modelId: string, fav: boolean) => m.setFavorite(id, modelId, fav));
  ipc.handle("models:assignRole", async (_e, role: ModelRole, selector: string, origin: string) => m.assignRole(role, selector, origin));
  ipc.handle("models:switchModel", async (_e, selector: string, origin: string) => m.switchModel(selector, origin));
  ipc.handle("models:setRoleThinking", async (_e, role: ModelRole, level: ThinkingLevel, origin: string) => m.setRoleThinking(role, level, origin));
  ipc.handle("models:setSessionThinking", async (_e, level: ThinkingLevel | null, origin: string) => m.setSessionThinking(level, origin));
  ipc.handle("models:getEvents", async () => m.getEvents());
  ipc.handle("models:enhance", async (_e, draft: string, origin: string) => m.enhance(draft, origin));
  ipc.handle("models:enhanceStatus", async () => m.enhanceStatus());
  ipc.handle("models:setBalanceEndpoint", async (_e, id: string, endpoint: string) => m.setBalanceEndpoint(id, endpoint));
  ipc.handle("models:checkBalance", async (_e, id: string) => m.checkBalance(id));
  ipc.handle("models:checkAllBalances", async () => m.checkAllBalances());
  ipc.handle("models:setLowThreshold", async (_e, id: string, threshold: number | null) => m.setLowThreshold(id, threshold));
  ipc.handle("models:setAutoSwap", async (_e, enabled: boolean) => m.setAutoSwap(enabled));
  ipc.handle("models:setRoleSwapOptOut", async (_e, role: ModelRole, optOut: boolean) => m.setRoleSwapOptOut(role, optOut));
  ipc.handle("models:setBalancePollMinutes", async (_e, minutes: number) => m.setBalancePollMinutes(minutes));
  ipc.handle("models:clearDepleted", async (_e, id: string) => m.clearDepleted(id));
  registerTesterHandlers(ipc);
}

export function disposeModels(): void {
  registerTesterHost(null);
  manager?.dispose();
  manager = null;
}
