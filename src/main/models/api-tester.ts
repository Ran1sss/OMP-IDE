import type { IpcMain } from "electron";
import { BrowserWindow } from "electron";
import type {
  TesterProtocol,
  TesterResult,
  TesterTarget,
  TesterVerdict,
} from "../../shared/types";
import { TESTER_PROTOCOLS } from "../../shared/types";
import { classifyProviderError } from "./error-classifier";

/**
 * API Tester engine (spec: omp-ide-api-tester-prompt.md) — hvoy.ai-style key &
 * endpoint checks, in-IDE. One engine, two entry points (profile Deep test +
 * free-form view). The probe is a REAL minimal completion (tiny prompt, small
 * max-tokens); a TCP connect or /models list is NOT a pass.
 *
 * Privacy line (absolute): keys go ONLY to the endpoint under test. Nothing is
 * ever sent to hvoy.ai — it is the methodology reference and a link-out.
 *
 * The protocol matrix is DATA (same principle as the autoswap classifier):
 * request builder + response parser per protocol. Extending = adding an entry.
 */

// -------------------------------------------------- protocol matrix

const PROBE_PROMPT = "Reply with the single word: ok";
const MAX_TOKENS = 16;
const BODY_CAP = 20_000;

interface SseExtract {
  /** does this SSE data frame carry generated content? */
  isContent(frame: Record<string, unknown>): boolean;
  /** usage block if this frame carries one (final frames usually do) */
  usage(frame: Record<string, unknown>): TesterResult["usage"];
  /** model id if this frame claims one */
  model(frame: Record<string, unknown>): string | null;
}

interface ProtocolSpec {
  id: TesterProtocol;
  label: string;
  /** endpoint path appended to the base URL (model interpolated where needed) */
  path(model: string, streaming: boolean): string;
  headers(key: string): Record<string, string>;
  /** which header carries the secret (redaction target) */
  authHeader: string;
  body(model: string, streaming: boolean): Record<string, unknown>;
  /** usage mapping from a non-streaming response body */
  usage(json: Record<string, unknown>): TesterResult["usage"];
  /** model-echo field from a non-streaming response body */
  model(json: Record<string, unknown>): string | null;
  /** provider error message from an error body (verbatim) */
  errorMessage(json: Record<string, unknown>): string | null;
  sse: SseExtract;
  /** known-model hints for the free-form view */
  hints: string[];
}

function numAt(obj: unknown, ...path: string[]): number | null {
  let cur: unknown = obj;
  for (const k of path) {
    if (!cur || typeof cur !== "object") return null;
    cur = (cur as Record<string, unknown>)[k];
  }
  return typeof cur === "number" ? cur : null;
}

function strAt(obj: unknown, ...path: string[]): string | null {
  let cur: unknown = obj;
  for (const k of path) {
    if (!cur || typeof cur !== "object") return null;
    cur = (cur as Record<string, unknown>)[k];
  }
  return typeof cur === "string" ? cur : null;
}

const MATRIX: Record<TesterProtocol, ProtocolSpec> = {
  "openai-chat": {
    id: "openai-chat",
    label: "OpenAI Chat Completions",
    path: () => "/chat/completions",
    headers: (key) => ({ Authorization: `Bearer ${key}`, "Content-Type": "application/json" }),
    authHeader: "Authorization",
    body: (model, streaming) => ({
      model,
      messages: [{ role: "user", content: PROBE_PROMPT }],
      max_tokens: MAX_TOKENS,
      ...(streaming ? { stream: true, stream_options: { include_usage: true } } : {}),
    }),
    usage: (j) => ({
      input: numAt(j, "usage", "prompt_tokens"),
      output: numAt(j, "usage", "completion_tokens"),
      reasoning: numAt(j, "usage", "completion_tokens_details", "reasoning_tokens"),
    }),
    model: (j) => strAt(j, "model"),
    errorMessage: (j) => strAt(j, "error", "message") ?? strAt(j, "message"),
    sse: {
      isContent: (f) => {
        const choices = f.choices;
        if (!Array.isArray(choices) || !choices.length) return false;
        return strAt(choices[0], "delta", "content") !== null;
      },
      usage: (f) =>
        f.usage && typeof f.usage === "object"
          ? {
              input: numAt(f, "usage", "prompt_tokens"),
              output: numAt(f, "usage", "completion_tokens"),
              reasoning: numAt(f, "usage", "completion_tokens_details", "reasoning_tokens"),
            }
          : null,
      model: (f) => strAt(f, "model"),
    },
    hints: ["gpt-4o", "gpt-4o-mini", "claude-fable-5", "gemini-2.5-pro", "deepseek-chat"],
  },
  "openai-responses": {
    id: "openai-responses",
    label: "OpenAI Responses",
    path: () => "/responses",
    headers: (key) => ({ Authorization: `Bearer ${key}`, "Content-Type": "application/json" }),
    authHeader: "Authorization",
    body: (model, streaming) => ({
      model,
      input: PROBE_PROMPT,
      max_output_tokens: MAX_TOKENS,
      ...(streaming ? { stream: true } : {}),
    }),
    usage: (j) => ({
      input: numAt(j, "usage", "input_tokens"),
      output: numAt(j, "usage", "output_tokens"),
      reasoning: numAt(j, "usage", "output_tokens_details", "reasoning_tokens"),
    }),
    model: (j) => strAt(j, "model"),
    errorMessage: (j) => strAt(j, "error", "message") ?? strAt(j, "message"),
    sse: {
      isContent: (f) => f.type === "response.output_text.delta",
      usage: (f) =>
        f.type === "response.completed"
          ? {
              input: numAt(f, "response", "usage", "input_tokens"),
              output: numAt(f, "response", "usage", "output_tokens"),
              reasoning: numAt(f, "response", "usage", "output_tokens_details", "reasoning_tokens"),
            }
          : null,
      model: (f) => strAt(f, "response", "model"),
    },
    hints: ["gpt-4o", "gpt-4.1", "o4-mini"],
  },
  anthropic: {
    id: "anthropic",
    label: "Anthropic Messages",
    path: () => "/v1/messages",
    headers: (key) => ({
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    }),
    authHeader: "x-api-key",
    body: (model, streaming) => ({
      model,
      messages: [{ role: "user", content: PROBE_PROMPT }],
      max_tokens: MAX_TOKENS,
      ...(streaming ? { stream: true } : {}),
    }),
    usage: (j) => ({
      input: numAt(j, "usage", "input_tokens"),
      output: numAt(j, "usage", "output_tokens"),
      reasoning: null,
    }),
    model: (j) => strAt(j, "model"),
    errorMessage: (j) => strAt(j, "error", "message") ?? strAt(j, "message"),
    sse: {
      isContent: (f) => f.type === "content_block_delta",
      usage: (f) => {
        if (f.type === "message_start")
          return { input: numAt(f, "message", "usage", "input_tokens"), output: null, reasoning: null };
        if (f.type === "message_delta")
          return { input: null, output: numAt(f, "usage", "output_tokens"), reasoning: null };
        return null;
      },
      model: (f) => strAt(f, "message", "model"),
    },
    hints: ["claude-sonnet-4-20250514", "claude-opus-4-20250514", "claude-fable-5"],
  },
  gemini: {
    id: "gemini",
    label: "Gemini generateContent",
    path: (model, streaming) =>
      `/v1beta/models/${encodeURIComponent(model)}:${streaming ? "streamGenerateContent?alt=sse" : "generateContent"}`,
    headers: (key) => ({ "x-goog-api-key": key, "Content-Type": "application/json" }),
    authHeader: "x-goog-api-key",
    body: () => ({
      contents: [{ parts: [{ text: PROBE_PROMPT }] }],
      generationConfig: { maxOutputTokens: MAX_TOKENS },
    }),
    usage: (j) => ({
      input: numAt(j, "usageMetadata", "promptTokenCount"),
      output: numAt(j, "usageMetadata", "candidatesTokenCount"),
      reasoning: numAt(j, "usageMetadata", "thoughtsTokenCount"),
    }),
    model: (j) => strAt(j, "modelVersion"),
    errorMessage: (j) => strAt(j, "error", "message") ?? strAt(j, "message"),
    sse: {
      isContent: (f) => {
        const c = f.candidates;
        if (!Array.isArray(c) || !c.length || !c[0] || typeof c[0] !== "object") return false;
        const content = (c[0] as Record<string, unknown>).content;
        return !!content && typeof content === "object" && Array.isArray((content as Record<string, unknown>).parts);
      },
      usage: (f) =>
        f.usageMetadata && typeof f.usageMetadata === "object"
          ? {
              input: numAt(f, "usageMetadata", "promptTokenCount"),
              output: numAt(f, "usageMetadata", "candidatesTokenCount"),
              reasoning: numAt(f, "usageMetadata", "thoughtsTokenCount"),
            }
          : null,
      model: (f) => strAt(f, "modelVersion"),
    },
    hints: ["gemini-2.5-pro", "gemini-2.5-flash", "gemini-2.0-flash"],
  },
};

// -------------------------------------------------- host hook (Models integration)

export interface TesterHost {
  /** resolve a profile target: base URL, key, protocol guess, enabled models */
  resolveProfile(name: string): { baseUrl: string; key: string; protocol: TesterProtocol; models: string[] } | null;
  /** all enabled profiles with keys (Test all) */
  enabledProfiles(): string[];
  /** Model Events entry (kind TEST) */
  logTest(detail: string): void;
  /** deep-test failure feeds the same health machinery as autoswap */
  applyHealth(name: string, verdict: TesterVerdict, detail: string): void;
}

let host: TesterHost | null = null;

export function registerTesterHost(h: TesterHost | null): void {
  host = h;
}

// -------------------------------------------------- helpers

export function redactKey(key: string): string {
  if (!key) return "(no key)";
  if (key.length <= 10) return key.slice(0, 2) + "…";
  return `${key.slice(0, 8)}…${key.slice(-4)}`;
}

/** requested "gpt-4o" vs returned "gpt-4o-2024-08-06" is a version tag, not fraud */
function modelsMatch(requested: string, returned: string): boolean {
  const a = requested.toLowerCase();
  const b = returned.toLowerCase();
  return a === b || b.startsWith(a) || a.startsWith(b);
}

function pretty(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2).slice(0, BODY_CAP);
  } catch {
    return text.slice(0, BODY_CAP);
  }
}

/** base URL normalization: gemini/anthropic paths are absolute from origin-ish roots */
function joinUrl(base: string, path: string): string {
  const b = base.replace(/\/+$/, "");
  // OpenAI-family bases conventionally end in /v1; anthropic/gemini paths carry their own version
  return b + path;
}

// -------------------------------------------------- the engine

/** serialize probes per base URL + key — never hammer one endpoint in parallel */
const targetQueues = new Map<string, Promise<unknown>>();

function serialized<T>(qKey: string, run: () => Promise<T>): Promise<T> {
  const prev = targetQueues.get(qKey) ?? Promise.resolve();
  const next = prev.then(run, run);
  targetQueues.set(qKey, next.catch(() => undefined));
  return next;
}

async function probe(target: TesterTarget, key: string): Promise<TesterResult> {
  const spec = MATRIX[target.protocol];
  const model = target.model.trim();
  const url = joinUrl(target.baseUrl.trim(), spec.path(model, target.streaming));
  const headers = spec.headers(key);
  const body = spec.body(model, target.streaming);
  const timeoutMs = Math.max(5, Math.min(300, target.timeoutSeconds ?? 30)) * 1000;

  const redactedHeaders = { ...headers, [spec.authHeader]: headers[spec.authHeader].replace(key, redactKey(key)) };
  const rawRequest = `POST ${url}\n${Object.entries(redactedHeaders)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n")}\n\n${JSON.stringify(body, null, 2)}`;

  const base: Omit<TesterResult, "verdict" | "detail"> = {
    httpStatus: null,
    ttfbMs: null,
    totalMs: null,
    firstTokenMs: null,
    chunkCount: null,
    usage: null,
    modelRequested: model,
    modelReturned: null,
    rawRequest,
    rawResponse: "",
    target: {
      profileId: target.profileId,
      baseUrl: target.baseUrl,
      protocol: target.protocol,
      model,
      streaming: target.streaming,
    },
    at: Date.now(),
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const t0 = Date.now();

  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    const total = Date.now() - t0;
    // undici buries the real code in error.cause ("fetch failed" wrapper)
    const cause = e instanceof Error && e.cause instanceof Error ? e.cause : null;
    const causeCode = cause && typeof (cause as NodeJS.ErrnoException).code === "string" ? (cause as NodeJS.ErrnoException).code : "";
    const msg = [e instanceof Error ? e.message : String(e), causeCode, cause?.message ?? ""].filter(Boolean).join(" — ");
    const aborted = e instanceof Error && e.name === "AbortError";
    // name the layer: DNS/TLS/refused/timeout are distinguishable from HTTP errors
    const layer = aborted
      ? `timeout — no response within ${timeoutMs / 1000}s`
      : /ENOTFOUND|EAI_AGAIN/i.test(msg) ? `DNS — ${msg}`
      : /ECONNREFUSED/i.test(msg) ? `connect — ${msg}`
      : /certificate|TLS|SSL|CERT/i.test(msg) ? `TLS — ${msg}`
      : /ECONNRESET|socket/i.test(msg) ? `connection — ${msg}`
      : msg;
    return { ...base, verdict: "network", detail: `network · ${layer}`, totalMs: total };
  }

  const ttfb = Date.now() - t0;
  let text = "";
  let firstTokenMs: number | null = null;
  let chunkCount = 0;
  const usageAcc: { input: number | null; output: number | null; reasoning: number | null } = { input: null, output: null, reasoning: null };
  let sawUsage = false;
  let sseModel: string | null = null;
  const isSse = (res.headers.get("content-type") ?? "").includes("text/event-stream");

  try {
    if (target.streaming && res.ok && isSse && res.body) {
      // stream: measure time-to-first-token + chunk count, harvest usage frames
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        let idx: number;
        while ((idx = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, idx).trim();
          buf = buf.slice(idx + 1);
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;
          text += payload + "\n";
          let frame: Record<string, unknown>;
          try {
            frame = JSON.parse(payload) as Record<string, unknown>;
          } catch {
            continue;
          }
          chunkCount++;
          if (firstTokenMs === null && spec.sse.isContent(frame)) firstTokenMs = Date.now() - t0;
          const u = spec.sse.usage(frame);
          if (u) {
            sawUsage = true;
            if (u.input !== null) usageAcc.input = u.input;
            if (u.output !== null) usageAcc.output = u.output;
            if (u.reasoning !== null) usageAcc.reasoning = u.reasoning;
          }
          const m = spec.sse.model(frame);
          if (m) sseModel = m;
        }
      }
    } else {
      text = await res.text();
    }
  } catch (e) {
    clearTimeout(timer);
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ...base,
      verdict: "network",
      detail: `network · body read failed — ${msg}`,
      httpStatus: res.status,
      ttfbMs: ttfb,
      totalMs: Date.now() - t0,
      rawResponse: pretty(text),
    };
  }
  clearTimeout(timer);
  const total = Date.now() - t0;

  const filled: Omit<TesterResult, "verdict" | "detail"> = {
    ...base,
    httpStatus: res.status,
    ttfbMs: ttfb,
    totalMs: total,
    firstTokenMs,
    chunkCount: target.streaming && isSse ? chunkCount : null,
    rawResponse: pretty(text),
  };

  // HTTP error → the autoswap classifier decides the family
  if (!res.ok) {
    let providerMsg = text.slice(0, 800);
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      providerMsg = spec.errorMessage(parsed) ?? providerMsg;
    } catch {
      // keep raw head
    }
    const cls = classifyProviderError(res.status, providerMsg);
    const verdict: TesterVerdict =
      cls.kind === "auth" ? "auth" :
      cls.kind === "quota-depleted" ? "quota" :
      cls.kind === "rate-limit-transient" ? "rate-limited" :
      cls.kind === "network" ? "network" : "http-error";
    return { ...filled, verdict, detail: providerMsg };
  }

  // parse success payload
  if (target.streaming && isSse) {
    if (chunkCount === 0) {
      return { ...filled, verdict: "unparseable", detail: `SSE stream carried no data frames. Body head:\n${text.slice(0, 500)}` };
    }
    const streamUsage = sawUsage ? usageAcc : null;
    const returned = sseModel;
    if (returned && !modelsMatch(model, returned))
      return { ...filled, usage: streamUsage, modelReturned: returned, verdict: "model-mismatch", detail: `requested ${model}, endpoint served ${returned}` };
    return { ...filled, usage: streamUsage, modelReturned: returned, verdict: "ok", detail: `completed generation over ${chunkCount} chunks` };
  }

  let json: Record<string, unknown>;
  try {
    json = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { ...filled, verdict: "unparseable", detail: `response is not JSON (wrong path? gateway block page?). Body head:\n${text.slice(0, 500)}` };
  }

  const usage = spec.usage(json);
  const hasUsage = usage && (usage.input !== null || usage.output !== null);
  const returned = spec.model(json);
  if (returned && !modelsMatch(model, returned)) {
    return {
      ...filled,
      usage: hasUsage ? usage : null,
      modelReturned: returned,
      verdict: "model-mismatch",
      detail: `requested ${model}, endpoint served ${returned}`,
    };
  }
  return {
    ...filled,
    usage: hasUsage ? usage : null,
    modelReturned: returned,
    verdict: "ok",
    detail: "completed generation",
  };
}

// -------------------------------------------------- public surface

function broadcast(r: TesterResult): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.webContents.isDestroyed()) w.webContents.send("tester:result", r);
  }
}

async function runOne(target: TesterTarget): Promise<TesterResult> {
  let key = target.apiKey ?? "";
  if (target.profileId && host) {
    const p = host.resolveProfile(target.profileId);
    if (!p) {
      const missing: TesterResult = {
        verdict: "network",
        httpStatus: null,
        detail: `profile ${target.profileId} not found or has no key`,
        ttfbMs: null, totalMs: null, firstTokenMs: null, chunkCount: null,
        usage: null, modelRequested: target.model, modelReturned: null,
        rawRequest: "", rawResponse: "",
        target: { profileId: target.profileId, baseUrl: target.baseUrl, protocol: target.protocol, model: target.model, streaming: target.streaming },
        at: Date.now(),
      };
      broadcast(missing);
      return missing;
    }
    key = p.key;
  }
  const qKey = `${target.baseUrl.trim().replace(/\/+$/, "")}|${key}`;
  const result = await serialized(qKey, () => probe(target, key));
  // profile targets feed the existing systems — events + health
  if (target.profileId && host) {
    host.logTest(
      `${target.profileId}/${target.model}: ${result.verdict}` +
        (result.httpStatus !== null ? ` (${result.httpStatus})` : "") +
        (result.ttfbMs !== null ? ` · ttfb ${result.ttfbMs}ms` : ""),
    );
    host.applyHealth(target.profileId, result.verdict, result.detail);
  }
  broadcast(result);
  return result;
}

async function runAll(): Promise<void> {
  if (!host) return;
  const names = host.enabledProfiles();
  await Promise.allSettled(
    names.map((name) => {
      const p = host!.resolveProfile(name);
      if (!p || !p.models.length) return Promise.resolve();
      return runOne({
        profileId: name,
        baseUrl: p.baseUrl,
        protocol: p.protocol,
        model: p.models[0],
        streaming: false,
      });
    }),
  );
}

export function registerTesterHandlers(ipc: IpcMain): void {
  ipc.handle("tester:run", async (_e, target: TesterTarget): Promise<TesterResult> => runOne(target));
  ipc.handle("tester:runAll", async (): Promise<void> => runAll());
  ipc.handle("tester:modelHints", async (): Promise<Record<TesterProtocol, string[]>> => {
    const out = {} as Record<TesterProtocol, string[]>;
    for (const p of TESTER_PROTOCOLS) out[p] = MATRIX[p].hints;
    return out;
  });
}
