import type { IpcMain } from "electron";
import { BrowserWindow } from "electron";
import type {
  TesterBatteryProgress,
  TesterBatteryResult,
  TesterCheckId,
  TesterCheckResult,
  TesterCheckStatus,
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

/** «Оценка»: one battery request — a real chat exchange with a tiny fixed shape */
interface BatteryRequest {
  system?: string;
  user: string;
  maxTokens: number;
  temperature?: number;
  /** request the protocol's NATIVE strict-JSON mode; unsupported protocols skip the check */
  structured?: boolean;
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
  // ---- battery(«Оценка») extractors — non-streaming bodies only
  /** chat body for an arbitrary battery exchange */
  chatBody(model: string, req: BatteryRequest): Record<string, unknown>;
  /** does the protocol have a native strict-JSON output mode? */
  supportsStructured: boolean;
  /** assistant text from a non-streaming response */
  content(json: Record<string, unknown>): string | null;
  /** finish reason token, classified: stop = clean, length = cap truncation */
  finishReason(json: Record<string, unknown>): { raw: string; kind: "stop" | "length" | "other" } | null;
  /** cached-token count when the usage block reports one */
  cachedTokens(json: Record<string, unknown>): number | null;
  /** number of assistant turns in the envelope (role-bleed check) */
  assistantCount(json: Record<string, unknown>): number | null;
  /** envelope violation for the protocol-compliance check; null = well-formed */
  envelopeIssue(json: Record<string, unknown>): string | null;
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
    chatBody: (model, req) => ({
      model,
      messages: [
        ...(req.system ? [{ role: "system", content: req.system }] : []),
        { role: "user", content: req.user },
      ],
      max_tokens: req.maxTokens,
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.structured ? { response_format: { type: "json_object" } } : {}),
    }),
    supportsStructured: true,
    content: (j) => strAt(Array.isArray(j.choices) ? j.choices[0] : null, "message", "content"),
    finishReason: (j) => {
      const raw = strAt(Array.isArray(j.choices) ? j.choices[0] : null, "finish_reason");
      if (!raw) return null;
      return { raw, kind: raw === "stop" ? "stop" : raw === "length" ? "length" : "other" };
    },
    cachedTokens: (j) => numAt(j, "usage", "prompt_tokens_details", "cached_tokens"),
    assistantCount: (j) =>
      Array.isArray(j.choices) ? j.choices.filter((c) => strAt(c, "message", "role") === "assistant").length : null,
    envelopeIssue: (j) => {
      if (!Array.isArray(j.choices) || !j.choices.length) return "choices[] missing or empty";
      if (strAt(j.choices[0], "message", "role") !== "assistant") return "choices[0].message.role is not 'assistant'";
      if (strAt(j.choices[0], "finish_reason") === null) return "finish_reason missing";
      const input = numAt(j, "usage", "prompt_tokens");
      const output = numAt(j, "usage", "completion_tokens");
      if (input === null || output === null) return "usage block missing prompt/completion counts";
      const total = numAt(j, "usage", "total_tokens");
      if (total !== null && total < input + output) return `usage inconsistent: total_tokens ${total} < ${input}+${output}`;
      return null;
    },
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
    chatBody: (model, req) => ({
      model,
      input: [
        ...(req.system ? [{ role: "system", content: req.system }] : []),
        { role: "user", content: req.user },
      ],
      max_output_tokens: Math.max(16, req.maxTokens),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.structured ? { text: { format: { type: "json_object" } } } : {}),
    }),
    supportsStructured: true,
    content: (j) => {
      if (!Array.isArray(j.output)) return null;
      const texts: string[] = [];
      for (const item of j.output) {
        if (strAt(item, "type") !== "message") continue;
        const parts = (item as Record<string, unknown>).content;
        if (!Array.isArray(parts)) continue;
        for (const p of parts) {
          const txt = strAt(p, "text");
          if (txt !== null) texts.push(txt);
        }
      }
      return texts.length ? texts.join("") : null;
    },
    finishReason: (j) => {
      const status = strAt(j, "status");
      if (!status) return null;
      if (status === "completed") return { raw: status, kind: "stop" };
      const reason = strAt(j, "incomplete_details", "reason");
      if (status === "incomplete" && reason === "max_output_tokens") return { raw: `${status}/${reason}`, kind: "length" };
      return { raw: reason ? `${status}/${reason}` : status, kind: "other" };
    },
    cachedTokens: (j) => numAt(j, "usage", "input_tokens_details", "cached_tokens"),
    assistantCount: (j) =>
      Array.isArray(j.output)
        ? j.output.filter((o) => strAt(o, "type") === "message" && strAt(o, "role") === "assistant").length
        : null,
    envelopeIssue: (j) => {
      if (strAt(j, "status") === null) return "status missing";
      if (!Array.isArray(j.output)) return "output[] missing";
      if (numAt(j, "usage", "input_tokens") === null || numAt(j, "usage", "output_tokens") === null)
        return "usage block missing input/output counts";
      return null;
    },
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
    chatBody: (model, req) => ({
      model,
      ...(req.system ? { system: req.system } : {}),
      messages: [{ role: "user", content: req.user }],
      max_tokens: req.maxTokens,
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
    }),
    supportsStructured: false,
    content: (j) => {
      if (!Array.isArray(j.content)) return null;
      const texts = j.content.map((b) => strAt(b, "text")).filter((s): s is string => s !== null);
      return texts.length ? texts.join("") : null;
    },
    finishReason: (j) => {
      const raw = strAt(j, "stop_reason");
      if (!raw) return null;
      return { raw, kind: raw === "end_turn" || raw === "stop_sequence" ? "stop" : raw === "max_tokens" ? "length" : "other" };
    },
    cachedTokens: (j) => numAt(j, "usage", "cache_read_input_tokens"),
    assistantCount: (j) => (strAt(j, "type") === "message" ? (strAt(j, "role") === "assistant" ? 1 : 0) : null),
    envelopeIssue: (j) => {
      if (strAt(j, "type") !== "message") return "type is not 'message'";
      if (strAt(j, "role") !== "assistant") return "role is not 'assistant'";
      if (!Array.isArray(j.content)) return "content[] missing";
      if (strAt(j, "stop_reason") === null) return "stop_reason missing";
      if (numAt(j, "usage", "input_tokens") === null || numAt(j, "usage", "output_tokens") === null)
        return "usage block missing input/output counts";
      return null;
    },
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
    chatBody: (model, req) => ({
      ...(req.system ? { systemInstruction: { parts: [{ text: req.system }] } } : {}),
      contents: [{ role: "user", parts: [{ text: req.user }] }],
      generationConfig: {
        maxOutputTokens: req.maxTokens,
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
        ...(req.structured ? { responseMimeType: "application/json" } : {}),
      },
    }),
    supportsStructured: true,
    content: (j) => {
      const cand = Array.isArray(j.candidates) ? j.candidates[0] : null;
      if (!cand || typeof cand !== "object") return null;
      const content = (cand as Record<string, unknown>).content;
      const parts = content && typeof content === "object" ? (content as Record<string, unknown>).parts : null;
      if (!Array.isArray(parts)) return null;
      const texts = parts.map((p) => strAt(p, "text")).filter((s): s is string => s !== null);
      return texts.length ? texts.join("") : null;
    },
    finishReason: (j) => {
      const raw = strAt(Array.isArray(j.candidates) ? j.candidates[0] : null, "finishReason");
      if (!raw) return null;
      return { raw, kind: raw === "STOP" ? "stop" : raw === "MAX_TOKENS" ? "length" : "other" };
    },
    cachedTokens: (j) => numAt(j, "usageMetadata", "cachedContentTokenCount"),
    assistantCount: (j) =>
      Array.isArray(j.candidates) ? j.candidates.filter((c) => strAt(c, "content", "role") === "model").length : null,
    envelopeIssue: (j) => {
      if (!Array.isArray(j.candidates) || !j.candidates.length) return "candidates[] missing or empty";
      if (strAt(j.candidates[0], "finishReason") === null) return "finishReason missing";
      if (numAt(j, "usageMetadata", "promptTokenCount") === null || numAt(j, "usageMetadata", "candidatesTokenCount") === null)
        return "usageMetadata missing token counts";
      return null;
    },
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

async function probe(target: TesterTarget, key: string, bodyOverride?: Record<string, unknown>): Promise<TesterResult> {
  const spec = MATRIX[target.protocol];
  const model = target.model.trim();
  const url = joinUrl(target.baseUrl.trim(), spec.path(model, target.streaming));
  const headers = spec.headers(key);
  const body = bodyOverride ?? spec.body(model, target.streaming);
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

// -------------------------------------------------- «Оценка»: check battery
// hvoy-style: a battery of NAMED checks in one run, each pass/fail/skip; the ring
// percentage = passed / (total − skipped). Prompts and expectations are DATA —
// adding a check = adding an entry to BATTERY.

interface ModelFamily {
  id: string;
  re: RegExp;
  /** words the model may use about itself without contradiction */
  keywords: string[];
  /** the maker a family-fingerprint answer should name */
  maker: string;
}

const FAMILIES: ModelFamily[] = [
  { id: "claude", re: /claude|fable/i, keywords: ["claude", "anthropic", "fable"], maker: "anthropic" },
  { id: "gpt", re: /gpt|chatgpt|^o[1345](-|$)|davinci/i, keywords: ["gpt", "chatgpt", "openai"], maker: "openai" },
  { id: "gemini", re: /gemini|bard/i, keywords: ["gemini", "bard", "google", "deepmind"], maker: "google" },
  { id: "deepseek", re: /deepseek/i, keywords: ["deepseek"], maker: "deepseek" },
  { id: "llama", re: /llama/i, keywords: ["llama", "meta"], maker: "meta" },
  { id: "qwen", re: /qwen|tongyi/i, keywords: ["qwen", "tongyi", "alibaba"], maker: "alibaba" },
  { id: "mistral", re: /mistral|mixtral|codestral/i, keywords: ["mistral", "mixtral"], maker: "mistral" },
  { id: "grok", re: /grok/i, keywords: ["grok", "xai"], maker: "xai" },
];

function familyOf(model: string): ModelFamily | null {
  return FAMILIES.find((f) => f.re.test(model)) ?? null;
}

function hasWord(text: string, word: string): boolean {
  return new RegExp(`\\b${word}\\b`, "i").test(text);
}

/** a keyword of ANOTHER family present in the answer (contradiction candidate) */
function foreignFamilyWord(ans: string, own: ModelFamily): string | null {
  for (const f of FAMILIES) {
    if (f.id === own.id) continue;
    const hit = f.keywords.find((k) => hasWord(ans, k));
    if (hit) return hit;
  }
  return null;
}

function foreignMaker(ans: string, own: ModelFamily): string | null {
  for (const f of FAMILIES) {
    if (f.id !== own.id && f.maker !== own.maker && hasWord(ans, f.maker)) return f.maker;
  }
  return null;
}

/** one-line clip for check details — raw payloads live in `raw` */
function clip(s: string | null): string {
  const one = (s ?? "").replace(/\s+/g, " ").trim();
  return one ? (one.length > 160 ? `${one.slice(0, 160)}…` : one) : "(empty)";
}

function normalizeAnswer(s: string): string {
  return s.toLowerCase().replace(/[^0-9a-zа-яё]+/gi, "");
}

/** models often wrap requested JSON in a markdown fence — unwrap before parsing */
function stripFences(s: string): string {
  const m = /```(?:json)?\s*([\s\S]*?)```/.exec(s);
  return (m ? m[1] : s).trim();
}

interface Exchange {
  result: TesterResult;
  json: Record<string, unknown> | null;
  content: string | null;
  finish: { raw: string; kind: "stop" | "length" | "other" } | null;
}

interface BatteryCtx {
  model: string;
  spec: ProtocolSpec;
  family: ModelFamily | null;
}

interface BatteryCheck {
  id: TesterCheckId;
  /** requests fired for this check; [] = judges another check's exchange */
  requests: BatteryRequest[];
  /** id of the check whose exchanges to evaluate when requests is [] */
  borrows?: TesterCheckId;
  /** style-fingerprint signal: a fail renders as suspicion, never proof */
  heuristic: boolean;
  evaluate(ex: Exchange[], ctx: BatteryCtx): { status: TesterCheckStatus; detail: string };
}

const IDENTITY_PROMPT = "What AI model are you? Answer in one short sentence.";
const KNOWLEDGE_PROMPT = "Answer on one line: 17+26 = ? Also, what is the chemical symbol for gold?";
const CHARACTER_PROMPT = "Which company created you? Answer with the company name only.";
const CONSISTENCY_PROMPT = "List the numbers from 1 to 5, comma-separated. Output only the list.";
const STRUCTURED_PROMPT =
  'Return a JSON object with exactly two fields: "status" set to the string "ok" and "value" set to the number 42. Output JSON only.';
const COMPLETENESS_PROMPT = 'Output exactly five lines: "ITEM 1" through "ITEM 5", one per line, nothing else.';
const ROLES_SYSTEM = "You must answer with exactly one word: YES";
const ROLES_PROMPT = "Can you hear me?";
const LIMIT_PROMPT = "Write a detailed multi-paragraph story about the open sea.";
const LIMIT_CAP = 24;

const BATTERY: BatteryCheck[] = [
  {
    id: "signature",
    requests: [{ user: PROBE_PROMPT, maxTokens: MAX_TOKENS }],
    heuristic: false,
    evaluate: ([ex], ctx) => {
      const returned = ex.result.modelReturned;
      if (!returned) return { status: "skip", detail: "response metadata carries no model id — nothing to verify" };
      return modelsMatch(ctx.model, returned)
        ? { status: "pass", detail: `endpoint echoes ${returned}` }
        : { status: "fail", detail: `requested ${ctx.model}, endpoint served ${returned}` };
    },
  },
  {
    id: "protocol",
    requests: [],
    borrows: "signature",
    heuristic: false,
    evaluate: ([ex], ctx) => {
      if (!ex.json) return { status: "fail", detail: "response body is not JSON" };
      const issue = ctx.spec.envelopeIssue(ex.json);
      return issue
        ? { status: "fail", detail: `envelope violation: ${issue}` }
        : { status: "pass", detail: "envelope well-formed: roles, finish reason, usage self-consistent" };
    },
  },
  {
    id: "identity",
    requests: [{ user: IDENTITY_PROMPT, maxTokens: 128 }],
    heuristic: false,
    evaluate: ([ex], ctx) => {
      if (!ctx.family) return { status: "skip", detail: `family of "${ctx.model}" unknown from the id — nothing to contradict` };
      const ans = ex.content ?? "";
      if (!ans.trim()) return { status: "fail", detail: "empty answer to the identity question" };
      if (ctx.family.keywords.some((k) => hasWord(ans, k)))
        return { status: "pass", detail: `self-identifies within the ${ctx.family.id} family: ${clip(ans)}` };
      const foreign = foreignFamilyWord(ans, ctx.family);
      if (foreign)
        return { status: "fail", detail: `claims "${foreign}" while ${ctx.model} was requested — answer: ${clip(ans)}` };
      return { status: "pass", detail: `vague but not contradictory: ${clip(ans)}` };
    },
  },
  {
    id: "knowledge",
    requests: [{ user: KNOWLEDGE_PROMPT, maxTokens: 128, temperature: 0 }],
    heuristic: false,
    evaluate: ([ex]) => {
      const ans = ex.content ?? "";
      if (!ans.trim()) return { status: "fail", detail: "empty answer to the known-answer probe" };
      const okMath = /\b43\b/.test(ans);
      const okFact = /\b[Aa][Uu]\b/.test(ans);
      if (okMath && okFact) return { status: "pass", detail: `43 and Au both present: ${clip(ans)}` };
      return {
        status: "fail",
        detail: `expected "43" and "Au", ${okMath ? "Au missing" : okFact ? "43 missing" : "both missing"}: ${clip(ans)}`,
      };
    },
  },
  {
    id: "character",
    requests: [{ user: CHARACTER_PROMPT, maxTokens: 64, temperature: 0 }],
    heuristic: true,
    evaluate: ([ex], ctx) => {
      if (!ctx.family) return { status: "skip", detail: `family of "${ctx.model}" unknown from the id — no expected maker` };
      const ans = ex.content ?? "";
      if (!ans.trim()) return { status: "fail", detail: "heuristic: empty answer to the maker question" };
      if (hasWord(ans, ctx.family.maker)) return { status: "pass", detail: `names ${ctx.family.maker}: ${clip(ans)}` };
      const foreign = foreignMaker(ans, ctx.family);
      if (foreign)
        return { status: "fail", detail: `heuristic: names ${foreign}, expected ${ctx.family.maker} — answer: ${clip(ans)}` };
      return { status: "pass", detail: `vague, no rival maker named: ${clip(ans)}` };
    },
  },
  {
    id: "consistency",
    requests: [
      { user: CONSISTENCY_PROMPT, maxTokens: 64, temperature: 0 },
      { user: CONSISTENCY_PROMPT, maxTokens: 64, temperature: 0 },
    ],
    heuristic: false,
    evaluate: ([a, b]) => {
      const na = normalizeAnswer(a.content ?? "");
      const nb = normalizeAnswer(b.content ?? "");
      if (!na || !nb) return { status: "fail", detail: "one of the twin responses is empty" };
      if (na === nb) return { status: "pass", detail: "twin responses identical at temperature 0" };
      const seq = /1.*2.*3.*4.*5/;
      if (seq.test(na) && seq.test(nb))
        return { status: "pass", detail: "both twin responses carry 1..5 in order — formatting stable" };
      return { status: "fail", detail: `twin responses diverge: "${clip(a.content)}" vs "${clip(b.content)}"` };
    },
  },
  {
    id: "structured",
    requests: [{ user: STRUCTURED_PROMPT, maxTokens: 128, temperature: 0, structured: true }],
    heuristic: false,
    evaluate: ([ex]) => {
      const ans = stripFences(ex.content ?? "");
      if (!ans) return { status: "fail", detail: "empty structured response" };
      try {
        const obj = JSON.parse(ans) as Record<string, unknown>;
        if (obj && typeof obj === "object" && obj.status === "ok" && obj.value === 42)
          return { status: "pass", detail: "strict JSON parsed with the requested fields" };
        return { status: "fail", detail: `JSON parsed but fields wrong: ${clip(ans)}` };
      } catch {
        return { status: "fail", detail: `not valid JSON: ${clip(ans)}` };
      }
    },
  },
  {
    id: "completeness",
    requests: [{ user: COMPLETENESS_PROMPT, maxTokens: 300, temperature: 0 }],
    heuristic: false,
    evaluate: ([ex]) => {
      const ans = ex.content ?? "";
      const missing: string[] = [];
      for (let i = 1; i <= 5; i++) if (!ans.includes(`ITEM ${i}`)) missing.push(`ITEM ${i}`);
      if (missing.length)
        return { status: "fail", detail: `incomplete: missing ${missing.join(", ")} — ${clip(ans)}` };
      if (ex.finish && ex.finish.kind !== "stop")
        return { status: "fail", detail: `all items present but finish reason is "${ex.finish.raw}", not a clean stop` };
      return { status: "pass", detail: `all 5 items present${ex.finish ? `, finish "${ex.finish.raw}"` : ""}` };
    },
  },
  {
    id: "roles",
    // 256 tokens: reasoning models burn output budget on hidden thinking BEFORE
    // the visible word (fable-5 spends 64+ on reasoning alone) — leave headroom
    requests: [{ system: ROLES_SYSTEM, user: ROLES_PROMPT, maxTokens: 256, temperature: 0 }],
    heuristic: false,
    evaluate: ([ex], ctx) => {
      if (!ex.json) return { status: "fail", detail: "response body is not JSON" };
      const n = ctx.spec.assistantCount(ex.json);
      if (n === null) return { status: "fail", detail: "cannot locate assistant turns in the envelope" };
      if (n !== 1) return { status: "fail", detail: `expected exactly 1 assistant message, envelope carries ${n}` };
      const ans = (ex.content ?? "").trim();
      if (!ans && ex.finish?.kind === "length")
        return { status: "fail", detail: "no visible output within a 256-token cap — the budget went to hidden reasoning" };
      if (!/yes/i.test(ans)) return { status: "fail", detail: `system instruction ignored — answer: ${clip(ans)}` };
      if (ans.length > 40) return { status: "fail", detail: `role bleed: ${ans.length} chars instead of one word — ${clip(ans)}` };
      return { status: "pass", detail: `one assistant turn, system instruction honored ("${ans}")` };
    },
  },
  {
    id: "limit",
    requests: [{ user: LIMIT_PROMPT, maxTokens: LIMIT_CAP }],
    heuristic: false,
    evaluate: ([ex]) => {
      const out = ex.result.usage?.output ?? null;
      if (!ex.finish && out === null)
        return { status: "skip", detail: "endpoint reports neither finish reason nor usage — cap not verifiable" };
      if (out !== null && out > LIMIT_CAP * 2)
        return { status: "fail", detail: `max_tokens ${LIMIT_CAP} ignored: ${out} output tokens` };
      if (ex.finish?.kind === "length")
        return { status: "pass", detail: `cap honored, truncation flagged ("${ex.finish.raw}"${out !== null ? `, ${out} tokens` : ""})` };
      if (ex.finish?.kind === "stop" && (out === null || out <= LIMIT_CAP))
        return { status: "pass", detail: `finished under the cap${out !== null ? ` (${out} tokens)` : ""}` };
      if (!ex.finish) return { status: "pass", detail: `no finish reason, but ${out} output tokens is within the cap` };
      return { status: "fail", detail: `finish "${ex.finish.raw}" with ${out ?? "?"} output tokens — cap handling unclear` };
    },
  },
];

const BATTERY_GAP_MS = 1000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** static battery shape (cost honesty: the tooltip states this before firing) */
function batteryPlanFor(protocol: TesterProtocol): { requests: number; checks: number } {
  const spec = MATRIX[protocol];
  let requests = 0;
  for (const c of BATTERY) {
    if (c.requests.some((r) => r.structured) && !spec.supportsStructured) continue;
    requests += c.requests.length;
  }
  return { requests, checks: BATTERY.length };
}

function medianOf(nums: number[]): number | null {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

function broadcastBatteryCheck(p: TesterBatteryProgress): void {
  for (const w of BrowserWindow.getAllWindows()) {
    if (!w.webContents.isDestroyed()) w.webContents.send("tester:batteryCheck", p);
  }
}

async function runBattery(target: TesterTarget): Promise<TesterBatteryResult> {
  let key = target.apiKey ?? "";
  if (target.profileId && host) {
    const p = host.resolveProfile(target.profileId);
    if (p) key = p.key;
  }
  const spec = MATRIX[target.protocol];
  const model = target.model.trim();
  const ctx: BatteryCtx = { model, spec, family: familyOf(model) };
  const base: TesterTarget = { ...target, streaming: false };
  const qKey = `${target.baseUrl.trim().replace(/\/+$/, "")}|${key}`;

  return serialized(qKey, async () => {
    const checks: TesterCheckResult[] = [];
    const exchangesById = new Map<TesterCheckId, Exchange[]>();
    const ttfbs: number[] = [];
    let inSum: number | null = null;
    let outSum: number | null = null;
    let cacheSum: number | null = null;
    let bestTps: number | null = null;
    let bestOut = -1;
    let fired = 0;

    for (const check of BATTERY) {
      let entry: TesterCheckResult;
      if (check.requests.some((r) => r.structured) && !spec.supportsStructured) {
        entry = {
          id: check.id,
          status: "skip",
          detail: `${spec.label} has no native structured-output mode`,
          heuristic: check.heuristic,
          raw: [],
        };
      } else {
        const exchanges: Exchange[] = check.requests.length ? [] : [...(exchangesById.get(check.borrows!) ?? [])];
        for (const req of check.requests) {
          if (fired > 0) await sleep(BATTERY_GAP_MS);
          const r = await probe(base, key, spec.chatBody(model, req));
          fired++;
          if (r.ttfbMs !== null) ttfbs.push(r.ttfbMs);
          if (r.usage) {
            if (r.usage.input !== null) inSum = (inSum ?? 0) + r.usage.input;
            if (r.usage.output !== null) outSum = (outSum ?? 0) + r.usage.output;
          }
          let json: Record<string, unknown> | null = null;
          try {
            json = JSON.parse(r.rawResponse) as Record<string, unknown>;
          } catch {
            json = null;
          }
          if (json) {
            const cached = spec.cachedTokens(json);
            if (cached !== null) cacheSum = (cacheSum ?? 0) + cached;
          }
          // non-streaming: the body lands with (or right after) the headers, so
          // generation time ≈ the whole request — totalMs, never ttfb deltas ≈ 0
          const genMs = r.totalMs;
          const out = r.usage?.output ?? null;
          if (out !== null && out > bestOut && genMs !== null && genMs > 0) {
            bestOut = out;
            bestTps = Math.round((out / (genMs / 1000)) * 10) / 10;
          }
          exchanges.push({
            result: r,
            json,
            content: json ? spec.content(json) : null,
            finish: json ? spec.finishReason(json) : null,
          });
        }
        exchangesById.set(check.id, exchanges);
        const raw = exchanges.map((e) => ({ request: e.result.rawRequest, response: e.result.rawResponse }));
        const broken = exchanges.find((e) => e.result.verdict !== "ok" && e.result.verdict !== "model-mismatch");
        if (broken) {
          const b = broken.result;
          entry = {
            id: check.id,
            status: "fail",
            detail: `request failed: ${b.verdict}${b.httpStatus !== null ? ` (HTTP ${b.httpStatus})` : ""} — ${b.detail.slice(0, 300)}`,
            heuristic: check.heuristic,
            raw,
          };
        } else if (!exchanges.length) {
          entry = { id: check.id, status: "skip", detail: "no exchange to evaluate", heuristic: check.heuristic, raw: [] };
        } else {
          const v = check.evaluate(exchanges, ctx);
          entry = { id: check.id, status: v.status, detail: v.detail, heuristic: check.heuristic, raw };
        }
      }
      checks.push(entry);
      broadcastBatteryCheck({ done: checks.length, total: BATTERY.length, check: entry });
    }

    const skipped = checks.filter((c) => c.status === "skip").length;
    const passed = checks.filter((c) => c.status === "pass").length;
    const applicable = checks.length - skipped;
    const percent = applicable ? Math.round((passed / applicable) * 100) : 0;
    const result: TesterBatteryResult = {
      kind: "battery",
      checks,
      passed,
      applicable,
      percent,
      medianTtfbMs: medianOf(ttfbs),
      tokensPerSec: bestTps,
      inputTokens: inSum,
      outputTokens: outSum,
      cachedTokens: cacheSum,
      requestCount: fired,
      target: { profileId: target.profileId, baseUrl: target.baseUrl, protocol: target.protocol, model, streaming: false },
      at: Date.now(),
    };
    // ONE aggregated Model Events entry — never N per-request rows
    if (target.profileId && host) {
      host.logTest(`${target.profileId}/${model}: score ${percent}% · ${passed}/${applicable} checks · ${fired} requests`);
    }
    return result;
  });
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
  ipc.handle("tester:runBattery", async (_e, target: TesterTarget): Promise<TesterBatteryResult> => runBattery(target));
  ipc.handle("tester:batteryInfo", async (): Promise<Record<TesterProtocol, { requests: number; checks: number }>> => {
    const out = {} as Record<TesterProtocol, { requests: number; checks: number }>;
    for (const p of TESTER_PROTOCOLS) out[p] = batteryPlanFor(p);
    return out;
  });
  ipc.handle("tester:modelHints", async (): Promise<Record<TesterProtocol, string[]>> => {
    const out = {} as Record<TesterProtocol, string[]>;
    for (const p of TESTER_PROTOCOLS) out[p] = MATRIX[p].hints;
    return out;
  });
}
