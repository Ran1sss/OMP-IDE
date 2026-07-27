/**
 * Wallet balance probes. Endpoint is user-configured per profile (URL or
 * base-relative path); echogate's template prefills `/wallet/balance`.
 *
 * Observed echogate schema (GET https://api.echogate.one/v1/wallet/balance,
 * Bearer auth, 2026-07):
 *   { "balance": -126274.99, "blocked": false, "currency": "USD",
 *     "total_spent": 148601.74, "total_earned": 0, "daily_limit": 80000,
 *     "daily_used": 17314.1, "daily_remaining": 62685.9,
 *     "bonus_credits": 0, "unlimited": false }
 * → value = balance, currency = currency. Note: balance can be NEGATIVE
 * while blocked:false (grace credit) — depleted is a classifier verdict,
 * not `value <= 0`.
 *
 * Parsing is schema-tolerant, never schema-invented: first numeric among
 * common keys, else a lone top-level number; anything else = unparseable
 * with the raw body preserved for the designed UI state.
 */

import type { BalanceInfo } from "../../shared/types";

const VALUE_KEYS = ["balance", "credits", "available", "amount", "remaining"];
const CURRENCY_KEYS = ["currency", "unit", "units"];

export function resolveBalanceUrl(baseUrl: string, endpoint: string): string | null {
  const e = endpoint.trim();
  if (!e) return null;
  if (/^https?:\/\//i.test(e)) return e;
  return `${baseUrl.replace(/\/+$/, "")}/${e.replace(/^\/+/, "")}`;
}

export function parseBalanceBody(raw: string): { value: number | null; currency: string | null } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { value: null, currency: null };
  }
  if (typeof parsed === "number") return { value: parsed, currency: null };
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { value: null, currency: null };
  const obj = parsed as Record<string, unknown>;
  let value: number | null = null;
  for (const k of VALUE_KEYS) {
    const v = obj[k];
    if (typeof v === "number") {
      value = v;
      break;
    }
    if (typeof v === "string" && v.trim() !== "" && !Number.isNaN(Number(v))) {
      value = Number(v);
      break;
    }
  }
  let currency: string | null = null;
  for (const k of CURRENCY_KEYS) {
    const v = obj[k];
    if (typeof v === "string" && v) {
      currency = v;
      break;
    }
  }
  return { value, currency };
}

/**
 * One probe. Auth mirrors the profile's completions calls (Bearer key).
 * Keys never leak: not in the URL, not in errors, not in the raw snapshot.
 */
export async function probeBalance(
  baseUrl: string,
  endpoint: string,
  apiKey: string,
): Promise<{ ok: true; info: BalanceInfo } | { ok: false; error: string }> {
  const url = resolveBalanceUrl(baseUrl, endpoint);
  if (!url) return { ok: false, error: "No balance endpoint configured" };
  let res: Response;
  try {
    res = await fetch(url, {
      headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined,
      signal: AbortSignal.timeout(15_000),
    });
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error && e.name === "TimeoutError" ? "balance endpoint timed out (15s)" : e instanceof Error ? e.message : String(e),
    };
  }
  const raw = (await res.text().catch(() => "")).slice(0, 1000);
  if (!res.ok) return { ok: false, error: `HTTP ${res.status}${raw ? `: ${raw.slice(0, 120)}` : ""}` };
  const { value, currency } = parseBalanceBody(raw);
  return {
    ok: true,
    info: {
      value,
      currency,
      checkedAt: Date.now(),
      ...(value === null ? { raw } : {}),
    },
  };
}
