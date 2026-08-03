/**
 * OMP integration adapter.
 *
 * DISCOVERY (verified against omp v17.1.3 on this machine):
 * 1. Live switching — RPC mode supports `set_model {provider, modelId}` and
 *    `get_available_models`; a switch applies to the NEXT TURN of the live
 *    session (no restart needed). This is the primary mechanism.
 * 2. Persistence + roles — `~/.omp/agent/config.yml` holds `modelRoles`
 *    (default/smol/slow/…) as `provider/modelId[:thinking]` selectors, and
 *    `enabledModels`. `omp config` CLI cannot set nested record keys
 *    ("Unknown setting: modelRoles.default"), so we edit the YAML
 *    surgically with the `yaml` document API (preserves comments/unknown keys).
 * 3. PROFILES — `~/.omp/agent/models.yml` `providers:` map IS OMP's profile
 *    registry: each key is a profile name, each value {baseUrl, apiKey, api,
 *    models[]}. Multiple profiles may share a template/base URL (observed
 *    live: echogate, echogate-ranis, echogate-fall-out, … all
 *    openai-completions on distinct endpoints). Models are addressed
 *    `<profile>/<model>` everywhere (CLI --model, enabledModels, modelRoles,
 *    RPC set_model {provider: <profile>}). The IDE enumerates this map as
 *    its card list — no parallel registry. `omp --help` confirms fuzzy
 *    `provider/model` addressing; `--profile` flag is a different feature
 *    (isolated auth/session dirs), NOT provider profiles.
 * 4. Keys: OMP's models.yml convention is env-name-or-literal in `apiKey`;
 *    for IDE-created profiles we write an ENV VAR NAME (OMP_IDE_KEY_<name>)
 *    and inject the secret into the spawned omp child env (safeStorage on
 *    the IDE side). Imported profiles keep whatever the user wrote —
 *    including literal keys — byte-for-byte.
 * 5. Built-in providers (anthropic/openai/google/openrouter) — not
 *    models.yml entries; resolved via standard env vars. They surface as
 *    singleton pseudo-profiles named by OMP's provider id.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import { join } from "node:path";
import { parseDocument, Document, YAMLMap, YAMLSeq, isSeq, isMap, isScalar } from "yaml";
import type { ModelRole } from "../../shared/types";
import type { StoredModel } from "./store";

export const AGENT_DIR = join(os.homedir(), ".omp", "agent");
export const MODELS_YML = join(AGENT_DIR, "models.yml");
export const CONFIG_YML = join(AGENT_DIR, "config.yml");

export function envVarFor(profileName: string): string {
  return `OMP_IDE_KEY_${profileName.replace(/[^a-zA-Z0-9]/g, "_").toUpperCase()}`;
}

function loadDoc(path: string): Document {
  try {
    return parseDocument(fs.readFileSync(path, "utf-8"));
  } catch {
    return new Document({});
  }
}

function saveDoc(path: string, doc: Document): void {
  fs.mkdirSync(AGENT_DIR, { recursive: true });
  fs.writeFileSync(path, doc.toString(), "utf-8");
}

// ---------------------------------------------------------------- config.yml (roles)

/** Persist a role selector into ~/.omp/agent/config.yml modelRoles (surgical). */
export function writeRole(role: ModelRole, selector: string): void {
  const doc = loadDoc(CONFIG_YML);
  if (!(doc.get("modelRoles") instanceof YAMLMap)) doc.set("modelRoles", new YAMLMap());
  doc.setIn(["modelRoles", role], selector);
  ensureEnabledModel(doc, selector);
  saveDoc(CONFIG_YML, doc);
}

/** Adds a selector to OMP's allowlist without changing any persisted role. */
export function enableModelSelector(selector: string): void {
  const doc = loadDoc(CONFIG_YML);
  ensureEnabledModel(doc, selector);
  saveDoc(CONFIG_YML, doc);
}

/**
 * config.yml `enabledModels` is an allowlist when non-empty: models absent
 * from it are invisible to the live session. Any selector we assign must be
 * appended or set_model rejects it with "Model not found".
 */
function ensureEnabledModel(doc: Document, selector: string): void {
  const bare = selector.replace(/:.*$/, ""); // strip thinking suffix
  const node = doc.get("enabledModels");
  if (!isSeq(node)) return; // no allowlist — everything is visible
  const items = node.items.map((i) => String(i));
  if (items.includes(bare)) return;
  node.add(doc.createNode(bare));
}

export function readRoles(): Partial<Record<ModelRole, string>> {
  const doc = loadDoc(CONFIG_YML);
  const out: Partial<Record<ModelRole, string>> = {};
  for (const role of ["default", "smol", "slow"] as ModelRole[]) {
    const v = doc.getIn(["modelRoles", role]);
    if (typeof v === "string") out[role] = v;
  }
  return out;
}

/**
 * Rename a profile inside config.yml: every `oldName/…` reference in
 * modelRoles and enabledModels becomes `newName/…`. Part of the atomic
 * rename (models.yml + config.yml + IDE store together).
 */
export function renameInConfigYml(oldName: string, newName: string): void {
  const doc = loadDoc(CONFIG_YML);
  const prefix = `${oldName}/`;
  const roles = doc.get("modelRoles");
  if (roles instanceof YAMLMap) {
    for (const item of roles.items) {
      if (isScalar(item.value) && typeof item.value.value === "string" && item.value.value.startsWith(prefix)) {
        item.value.value = `${newName}/${item.value.value.slice(prefix.length)}`;
      }
    }
  }
  const enabled = doc.get("enabledModels");
  if (isSeq(enabled)) {
    for (const item of enabled.items) {
      if (isScalar(item) && typeof item.value === "string" && item.value.startsWith(prefix)) {
        item.value = `${newName}/${item.value.slice(prefix.length)}`;
      }
    }
  }
  saveDoc(CONFIG_YML, doc);
}

// ---------------------------------------------------------------- models.yml (profiles)

export interface OmpProfile {
  /** the providers: map key */
  name: string;
  baseUrl: string;
  api: string;
  /** apiKey field verbatim (env var name or literal); null when absent */
  apiKeyRef: string | null;
  models: StoredModel[];
  /** entry parsed cleanly enough for the IDE to manage */
  parseable: boolean;
}

/**
 * Enumerate OMP's profile registry (models.yml providers map).
 * Unparseable entries come back with parseable:false and empty details —
 * the UI renders them read-only; writes never touch them.
 */
export function readOmpProfiles(): OmpProfile[] {
  const doc = loadDoc(MODELS_YML);
  const provMap = doc.get("providers");
  if (!(provMap instanceof YAMLMap)) return [];
  const out: OmpProfile[] = [];
  for (const item of provMap.items) {
    const name = String(item.key);
    const v = item.value;
    if (!isMap(v)) {
      out.push({ name, baseUrl: "", api: "", apiKeyRef: null, models: [], parseable: false });
      continue;
    }
    const baseUrl = v.get("baseUrl");
    const api = v.get("api");
    const apiKey = v.get("apiKey");
    const modelsNode = v.get("models");
    const models: StoredModel[] = [];
    let modelsOk = true;
    if (isSeq(modelsNode)) {
      for (const mn of modelsNode.items) {
        if (!isMap(mn)) {
          modelsOk = false;
          continue;
        }
        const id = mn.get("id");
        if (typeof id !== "string") {
          modelsOk = false;
          continue;
        }
        const mname = mn.get("name");
        const ctx = mn.get("contextWindow");
        models.push({
          id,
          name: typeof mname === "string" ? mname : id,
          contextWindow: typeof ctx === "number" ? ctx : null,
        });
      }
    } else if (modelsNode !== undefined) {
      modelsOk = false;
    }
    const parseable = typeof baseUrl === "string" && modelsOk;
    out.push({
      name,
      baseUrl: typeof baseUrl === "string" ? baseUrl : "",
      api: typeof api === "string" ? api : "openai-completions",
      apiKeyRef: typeof apiKey === "string" ? apiKey : null,
      models,
      parseable,
    });
  }
  return out;
}

/** slug rule for profile names: they are selector qualifiers and YAML keys */
export function validProfileName(name: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{0,63}$/.test(name);
}

export interface ProfileWrite {
  name: string;
  baseUrl: string;
  /** env var name to reference for the key; null = no auth */
  keyEnvVar: string | null;
  models: StoredModel[];
}

/**
 * Create or update one profile entry in models.yml (surgical: other entries,
 * comments, and unknown keys inside OUR entry are preserved; we only set the
 * fields we own).
 */
export function writeOmpProfile(p: ProfileWrite): void {
  const doc = loadDoc(MODELS_YML);
  if (!(doc.get("providers") instanceof YAMLMap)) doc.set("providers", new YAMLMap());
  const existing = doc.getIn(["providers", p.name]);
  if (existing !== undefined && !isMap(existing)) {
    // never overwrite an entry we can't parse — the read-only contract
    return;
  }
  doc.setIn(["providers", p.name, "baseUrl"], p.baseUrl);
  doc.setIn(["providers", p.name, "api"], "openai-completions");
  if (p.keyEnvVar) {
    doc.setIn(["providers", p.name, "apiKey"], p.keyEnvVar);
    doc.setIn(["providers", p.name, "authHeader"], true);
  } else {
    doc.deleteIn(["providers", p.name, "apiKey"]);
    doc.setIn(["providers", p.name, "auth"], "none");
  }
  const models = new YAMLSeq();
  for (const m of p.models) {
    models.add(
      doc.createNode({
        id: m.id,
        name: m.name,
        ...(m.contextWindow ? { contextWindow: m.contextWindow } : {}),
      }),
    );
  }
  doc.setIn(["providers", p.name, "models"], models);
  saveDoc(MODELS_YML, doc);
}

/** Delete a profile entry from models.yml. Unparseable entries are refused. */
export function deleteOmpProfile(name: string): boolean {
  const doc = loadDoc(MODELS_YML);
  const provMap = doc.get("providers");
  if (!(provMap instanceof YAMLMap)) return false;
  const entry = doc.getIn(["providers", name]);
  if (entry === undefined) return false;
  if (!isMap(entry)) return false; // read-only contract
  doc.deleteIn(["providers", name]);
  saveDoc(MODELS_YML, doc);
  return true;
}

/**
 * Rename a profile key in models.yml preserving its value node verbatim
 * (comments and unknown fields ride along). Returns false when the target
 * exists or the source is missing.
 */
export function renameOmpProfile(oldName: string, newName: string): boolean {
  const doc = loadDoc(MODELS_YML);
  const provMap = doc.get("providers");
  if (!(provMap instanceof YAMLMap)) return false;
  const src = provMap.items.find((i) => String(i.key) === oldName);
  if (!src) return false;
  if (provMap.items.some((i) => String(i.key) === newName)) return false;
  if (isScalar(src.key)) src.key.value = newName;
  else return false;
  // apiKey env-var reference follows the name for IDE-owned profiles
  if (isMap(src.value)) {
    const ref = src.value.get("apiKey");
    if (typeof ref === "string" && ref === envVarFor(oldName)) {
      src.value.set("apiKey", envVarFor(newName));
    }
  }
  saveDoc(MODELS_YML, doc);
  return true;
}

// ---------------------------------------------------------------- built-in env vars

export const BUILTIN_ENV: Record<string, string> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  google: "GEMINI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};
