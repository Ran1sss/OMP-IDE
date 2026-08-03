/**
 * Models module persistence — SUPPLEMENTARY state beside OMP's own config.
 *
 * OMP's models.yml is the source of truth for custom profiles (name, baseUrl,
 * models). This store only keeps what OMP has no schema for: favorites,
 * enabled flags, origin badges, built-in (env-var) providers, roles mirror,
 * thinking levels, and the event log. Keys are encrypted via safeStorage in
 * models-vault.json, keyed by profile name.
 */

import { app, safeStorage } from "electron";
import * as fs from "node:fs";
import { join } from "node:path";
import type { ModelRole, ProviderTemplateId, ModelEvent, ThinkingLevel } from "../../shared/types";

export interface StoredModel {
  id: string;
  name: string;
  contextWindow: number | null;
}

/** Built-in providers (anthropic/openai/google/openrouter) are not models.yml
 * profiles — OMP resolves them via env vars. Singleton per template; the
 * profile name IS the OMP provider id. */
export interface BuiltinProfile {
  name: string;
  template: ProviderTemplateId;
  baseUrl: string;
  models: StoredModel[];
}

export interface ProfileMeta {
  /** ide = created here · imported = found in OMP config */
  origin: "ide" | "imported";
  enabled: boolean;
  favorites: string[];
  /** balance probe URL or base-relative path; "" = no probe */
  balanceEndpoint?: string;
  /** cached readout with timestamp; null = never probed */
  balance?: { value: number | null; currency: string | null; checkedAt: number; raw?: string } | null;
  /** low-balance warning threshold; null/undefined = off */
  lowThreshold?: number | null;
  /** one notice per threshold crossing, re-armed when balance recovers */
  thresholdNotified?: boolean;
}

export interface ModelsStore {
  builtins: BuiltinProfile[];
  /** per-profile-name metadata for models.yml profiles AND builtins */
  profileMeta: Record<string, ProfileMeta>;
  /** role → "<profile>/<model>" (natively OMP-qualified) */
  roles: Record<ModelRole, string | null>;
  thinkingRoles: Record<ModelRole, ThinkingLevel>;
  /** "<profile>/<model>" selectors that rejected thinking params */
  noThinking: string[];
  events: ModelEvent[];
  /** most recently activated qualified selectors, newest first */
  recentModels: string[];
  /** auto-swap master toggle (default ON) + per-role opt-outs */
  autoSwapEnabled: boolean;
  autoSwapRoleOptOut: Record<ModelRole, boolean>;
  /** periodic balance poll, minutes; 0 = off (default 10) */
  balancePollMinutes: number;
}

let cache: ModelsStore | null = null;

function storePath(): string {
  return join(app.getPath("userData"), "models-store.json");
}

function vaultPath(): string {
  return join(app.getPath("userData"), "models-vault.json");
}

export function defaultMeta(origin: "ide" | "imported"): ProfileMeta {
  return { origin, enabled: true, favorites: [] };
}

/**
 * v1 store shape (pre-profiles): providers[] with generated ids; custom
 * providers lived in models.yml as `omp-ide-<id>`. Migrate: profile name =
 * the models.yml key; vault re-keyed; role selectors rewritten.
 */
interface V1Provider {
  id: string;
  template: ProviderTemplateId;
  displayName: string;
  baseUrl: string;
  enabled: boolean;
  models: { id: string; name: string; contextWindow: number | null; favorite: boolean }[];
}

const BUILTIN_NAMES: Record<string, string> = {
  anthropic: "anthropic",
  openai: "openai",
  google: "google",
  openrouter: "openrouter",
};

function migrateV1(parsed: Record<string, unknown>): ModelsStore {
  const providers = parsed.providers as V1Provider[];
  const out: ModelsStore = {
    builtins: [],
    profileMeta: {},
    roles: { default: null, smol: null, slow: null },
    thinkingRoles: {
      default: (parsed.thinkingRoles as Record<string, ThinkingLevel>)?.default ?? "med",
      smol: (parsed.thinkingRoles as Record<string, ThinkingLevel>)?.smol ?? "off",
      slow: (parsed.thinkingRoles as Record<string, ThinkingLevel>)?.slow ?? "high",
    },
    noThinking: [],
    events: Array.isArray(parsed.events) ? (parsed.events as ModelEvent[]).slice(-50) : [],
    recentModels: [],
    autoSwapEnabled: true,
    autoSwapRoleOptOut: { default: false, smol: false, slow: false },
    balancePollMinutes: 10,
  };
  /** old provider id → new profile name */
  const nameOf: Record<string, string> = {};
  for (const p of providers) {
    const name = p.template === "custom" ? `omp-ide-${p.id}` : BUILTIN_NAMES[p.template] ?? p.id;
    nameOf[p.id] = name;
    out.profileMeta[name] = {
      origin: "ide",
      enabled: p.enabled,
      favorites: p.models.filter((m) => m.favorite).map((m) => m.id),
    };
    if (p.template !== "custom") {
      out.builtins.push({
        name,
        template: p.template,
        baseUrl: p.baseUrl,
        models: p.models.map((m) => ({ id: m.id, name: m.name, contextWindow: m.contextWindow })),
      });
    }
    // re-key the vault entry to the profile name
    const v = readVault();
    if (v[p.id] !== undefined && p.id !== name) {
      v[name] = v[p.id];
      delete v[p.id];
      writeVault(v);
    }
  }
  const rewrite = (sel: string | null): string | null => {
    if (!sel) return null;
    const slash = sel.indexOf("/");
    if (slash < 0) return sel;
    const prov = sel.slice(0, slash);
    return `${nameOf[prov] ?? prov}${sel.slice(slash)}`;
  };
  const roles = parsed.roles as Record<ModelRole, string | null> | undefined;
  out.roles.default = rewrite(roles?.default ?? null);
  out.roles.smol = rewrite(roles?.smol ?? null);
  out.roles.slow = rewrite(roles?.slow ?? null);
  out.noThinking = (Array.isArray(parsed.noThinking) ? (parsed.noThinking as string[]) : [])
    .map((s) => rewrite(s))
    .filter((s): s is string => s !== null);
  return out;
}

export function loadModelsStore(): ModelsStore {
  if (cache) return cache;
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath(), "utf-8")) as Record<string, unknown>;
    if (Array.isArray(parsed.providers)) {
      cache = migrateV1(parsed);
      saveModelsStore();
      return cache;
    }
    const roles = parsed.roles as Record<ModelRole, string | null> | undefined;
    const thinking = parsed.thinkingRoles as Record<ModelRole, ThinkingLevel> | undefined;
    cache = {
      builtins: Array.isArray(parsed.builtins) ? (parsed.builtins as BuiltinProfile[]) : [],
      profileMeta:
        parsed.profileMeta && typeof parsed.profileMeta === "object"
          ? (parsed.profileMeta as Record<string, ProfileMeta>)
          : {},
      roles: {
        default: roles?.default ?? null,
        smol: roles?.smol ?? null,
        slow: roles?.slow ?? null,
      },
      thinkingRoles: {
        default: thinking?.default ?? "med",
        smol: thinking?.smol ?? "off",
        slow: thinking?.slow ?? "high",
      },
      noThinking: Array.isArray(parsed.noThinking) ? (parsed.noThinking as string[]) : [],
      events: Array.isArray(parsed.events) ? (parsed.events as ModelEvent[]).slice(-50) : [],
      recentModels: Array.isArray(parsed.recentModels)
        ? (parsed.recentModels as unknown[]).filter((item): item is string => typeof item === "string").slice(0, 12)
        : [],
      autoSwapEnabled: parsed.autoSwapEnabled !== false,
      autoSwapRoleOptOut: {
        default: (parsed.autoSwapRoleOptOut as Record<string, boolean> | undefined)?.default === true,
        smol: (parsed.autoSwapRoleOptOut as Record<string, boolean> | undefined)?.smol === true,
        slow: (parsed.autoSwapRoleOptOut as Record<string, boolean> | undefined)?.slow === true,
      },
      balancePollMinutes:
        typeof parsed.balancePollMinutes === "number" && parsed.balancePollMinutes >= 0
          ? parsed.balancePollMinutes
          : 10,
    };
  } catch {
    cache = {
      builtins: [],
      profileMeta: {},
      roles: { default: null, smol: null, slow: null },
      thinkingRoles: { default: "med", smol: "off", slow: "high" },
      noThinking: [],
      events: [],
      recentModels: [],
      autoSwapEnabled: true,
      autoSwapRoleOptOut: { default: false, smol: false, slow: false },
      balancePollMinutes: 10,
    };
  }
  return cache;
}

export function saveModelsStore(): void {
  if (!cache) return;
  try {
    fs.mkdirSync(app.getPath("userData"), { recursive: true });
    fs.writeFileSync(storePath(), JSON.stringify(cache, null, 2), "utf-8");
  } catch {
    // registry is reconstructible
  }
}

// ---------------------------------------------------------------- key vault

type VaultShape = Record<string, string>;

function readVault(): VaultShape {
  try {
    return JSON.parse(fs.readFileSync(vaultPath(), "utf-8")) as VaultShape;
  } catch {
    return {};
  }
}

function writeVault(v: VaultShape): void {
  fs.mkdirSync(app.getPath("userData"), { recursive: true });
  fs.writeFileSync(vaultPath(), JSON.stringify(v), "utf-8");
}

export function putProviderKey(profileName: string, key: string): void {
  const v = readVault();
  if (key) v[profileName] = safeStorage.encryptString(key).toString("base64");
  else delete v[profileName];
  writeVault(v);
}

export function getProviderKey(profileName: string): string | null {
  const enc = readVault()[profileName];
  if (!enc) return null;
  try {
    return safeStorage.decryptString(Buffer.from(enc, "base64"));
  } catch {
    return null;
  }
}

export function dropProviderKey(profileName: string): void {
  const v = readVault();
  delete v[profileName];
  writeVault(v);
}

export function hasProviderKey(profileName: string): boolean {
  return readVault()[profileName] !== undefined;
}

/** rename support: move vault entry + profileMeta + noThinking/role prefixes */
export function rekeyProfile(oldName: string, newName: string): void {
  const v = readVault();
  if (v[oldName] !== undefined) {
    v[newName] = v[oldName];
    delete v[oldName];
    writeVault(v);
  }
  const store = loadModelsStore();
  if (store.profileMeta[oldName]) {
    store.profileMeta[newName] = store.profileMeta[oldName];
    delete store.profileMeta[oldName];
  }
  const rewrite = (sel: string | null): string | null =>
    sel !== null && sel.startsWith(`${oldName}/`) ? `${newName}${sel.slice(oldName.length)}` : sel;
  for (const role of Object.keys(store.roles) as ModelRole[]) {
    store.roles[role] = rewrite(store.roles[role]);
  }
  store.noThinking = store.noThinking.map((s) => rewrite(s)).filter((s): s is string => s !== null);
  store.recentModels = store.recentModels.map((s) => rewrite(s)).filter((s): s is string => s !== null);
  saveModelsStore();
}
