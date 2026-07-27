/**
 * Provider templates and live validation. Validation calls each provider's
 * model-list endpoint (cheap, authenticated) — the IDE never runs the agent
 * through these APIs, it only verifies credentials and discovers models.
 */

import type { ProviderTemplateId } from "../../shared/types";

export interface ProviderTemplate {
  id: ProviderTemplateId;
  displayName: string;
  defaultBaseUrl: string;
  /** OMP built-in provider key; custom providers get a generated key */
  ompProviderId: string | null;
  /** env var OMP resolves for this provider's key (built-ins) */
  ompEnvVar: string | null;
  needsKey: boolean;
}

export const TEMPLATES: Record<ProviderTemplateId, ProviderTemplate> = {
  anthropic: {
    id: "anthropic",
    displayName: "Anthropic",
    defaultBaseUrl: "https://api.anthropic.com",
    ompProviderId: "anthropic",
    ompEnvVar: "ANTHROPIC_API_KEY",
    needsKey: true,
  },
  openai: {
    id: "openai",
    displayName: "OpenAI",
    defaultBaseUrl: "https://api.openai.com/v1",
    ompProviderId: "openai",
    ompEnvVar: "OPENAI_API_KEY",
    needsKey: true,
  },
  google: {
    id: "google",
    displayName: "Google (Gemini)",
    defaultBaseUrl: "https://generativelanguage.googleapis.com",
    ompProviderId: "google",
    ompEnvVar: "GEMINI_API_KEY",
    needsKey: true,
  },
  openrouter: {
    id: "openrouter",
    displayName: "OpenRouter",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    ompProviderId: "openrouter",
    ompEnvVar: "OPENROUTER_API_KEY",
    needsKey: true,
  },
  custom: {
    id: "custom",
    displayName: "Custom (OpenAI-compatible)",
    defaultBaseUrl: "",
    ompProviderId: null,
    ompEnvVar: null,
    needsKey: false,
  },
};

export interface FetchedModel {
  id: string;
  name: string;
  contextWindow: number | null;
}

export interface FetchModelsResult {
  ok: boolean;
  /** human message, includes real HTTP status + host on failure */
  message: string;
  models: FetchedModel[];
  kind: "ok" | "auth-error" | "network-error" | "rate-limited";
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

function classify(status: number): "auth-error" | "rate-limited" | "network-error" {
  if (status === 401 || status === 403) return "auth-error";
  if (status === 429) return "rate-limited";
  return "network-error";
}

async function getJson(
  url: string,
  headers: Record<string, string>,
): Promise<{ ok: true; body: unknown } | { ok: false; result: FetchModelsResult }> {
  let res: Response;
  try {
    res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
  } catch (err) {
    return {
      ok: false,
      result: {
        ok: false,
        kind: "network-error",
        message: `network error — ${err instanceof Error ? err.message : String(err)} (${hostOf(url)})`,
        models: [],
      },
    };
  }
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const raw: unknown = await res.json();
      detail = errorMessageFrom(raw) ?? detail;
    } catch {}
    return {
      ok: false,
      result: {
        ok: false,
        kind: classify(res.status),
        message: `${res.status} ${res.statusText} — ${detail.slice(0, 140)} (${hostOf(url)})`,
        models: [],
      },
    };
  }
  try {
    return { ok: true, body: await res.json() };
  } catch {
    return {
      ok: false,
      result: { ok: false, kind: "network-error", message: `invalid JSON from ${hostOf(url)}`, models: [] },
    };
  }
}

/** untrusted HTTP payload → error message, runtime-checked */
function errorMessageFrom(raw: unknown): string | null {
  if (!raw || typeof raw !== "object") return null;
  if ("error" in raw && raw.error && typeof raw.error === "object" && "message" in raw.error) {
    const m = raw.error.message;
    if (typeof m === "string") return m;
  }
  if ("message" in raw && typeof raw.message === "string") return raw.message;
  return null;
}

/** untrusted payload → array under `key`, runtime-checked */
function arrayField(raw: unknown, key: string): Record<string, unknown>[] {
  if (!raw || typeof raw !== "object" || !(key in raw)) return [];
  const arr = (raw as Record<string, unknown>)[key];
  if (!Array.isArray(arr)) return [];
  return arr.filter((m): m is Record<string, unknown> => !!m && typeof m === "object");
}

function str(m: Record<string, unknown>, key: string): string | null {
  const v = m[key];
  return typeof v === "string" ? v : null;
}

function num(m: Record<string, unknown>, key: string): number | null {
  const v = m[key];
  return typeof v === "number" ? v : null;
}

function parseOpenAiList(body: unknown): FetchedModel[] {
  return arrayField(body, "data")
    .filter((m) => str(m, "id") !== null)
    .map((m) => ({
      id: str(m, "id")!,
      name: str(m, "name") ?? str(m, "id")!,
      contextWindow: num(m, "context_length") ?? num(m, "context_window") ?? num(m, "max_model_len"),
    }));
}

export async function fetchProviderModels(
  template: ProviderTemplateId,
  baseUrl: string,
  apiKey: string,
): Promise<FetchModelsResult> {
  const done = (models: FetchedModel[]): FetchModelsResult => ({
    ok: true,
    kind: "ok",
    message: `OK — ${models.length} model${models.length === 1 ? "" : "s"}`,
    models,
  });

  switch (template) {
    case "anthropic": {
      const r = await getJson(`${baseUrl.replace(/\/+$/, "")}/v1/models?limit=100`, {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      });
      if (!r.ok) return r.result;
      return done(
        arrayField(r.body, "data")
          .filter((m) => str(m, "id") !== null)
          .map((m) => ({ id: str(m, "id")!, name: str(m, "display_name") ?? str(m, "id")!, contextWindow: 200_000 })),
      );
    }
    case "google": {
      const r = await getJson(
        `${baseUrl.replace(/\/+$/, "")}/v1beta/models?pageSize=100&key=${encodeURIComponent(apiKey)}`,
        {},
      );
      if (!r.ok) return r.result;
      const models = arrayField(r.body, "models");
      return done(
        models
          .filter((m) => {
            const methods = m.supportedGenerationMethods;
            return str(m, "name") !== null && Array.isArray(methods) && methods.includes("generateContent");
          })
          .map((m) => ({
            id: str(m, "name")!.replace(/^models\//, ""),
            name: str(m, "displayName") ?? str(m, "name")!.replace(/^models\//, ""),
            contextWindow: num(m, "inputTokenLimit"),
          })),
      );
    }
    case "openai":
    case "openrouter":
    case "custom": {
      const base = baseUrl.replace(/\/+$/, "");
      const headers: Record<string, string> = {};
      if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
      const r = await getJson(`${base}/models`, headers);
      if (!r.ok) return r.result;
      let models = parseOpenAiList(r.body);
      if (template === "openai") {
        // trim non-chat artifacts (embeddings, audio, images) for signal
        models = models.filter((m) => !/embedding|whisper|tts|dall-e|moderation|davinci|babbage/i.test(m.id));
      }
      return done(models);
    }
  }
}
