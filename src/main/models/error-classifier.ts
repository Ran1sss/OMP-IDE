/**
 * Provider failure classifier — the correctness core of auto-swap.
 * The table is data: extend rows, don't fork logic.
 *
 * Real samples this table was built against (echogate, omp v17 turn_end):
 *   auth:    status 401, "401 Invalid API key [err_cac8cabc]\nInvalid API key
 *            [err_cac8cabc] (type=authentication_error)"
 *   quota:   echogate wallet semantics — balance can go NEGATIVE with
 *            blocked:false (grace), then requests fail with 402/403-or-429
 *            bodies phrased "insufficient balance/credits/quota" or
 *            "API key is missing" style messages carry (type=...) tags.
 */

export type ErrorClass =
  | { kind: "quota-depleted" }
  | { kind: "rate-limit-transient"; retryAfterMs: number }
  | { kind: "auth" }
  | { kind: "network" }
  | { kind: "other" };

interface Rule {
  /** matches when status is one of these (empty = any) */
  statuses: number[];
  /** case-insensitive body phrases; any match qualifies */
  phrases: string[];
  classify: (message: string) => ErrorClass;
}

const RETRY_AFTER_RE = /retry[-_ ]?after[":\s]+(\d+(?:\.\d+)?)/i;

/** ordered — first match wins */
const RULES: Rule[] = [
  {
    // hard quota/balance semantics regardless of status code
    statuses: [],
    phrases: [
      "insufficient balance",
      "insufficient credits",
      "insufficient quota",
      "insufficient_quota",
      "balance depleted",
      "balance is too low",
      "credit balance",
      "quota exceeded",
      "quota_exceeded",
      "exceeded your current quota",
      "billing hard limit",
      "payment required",
      "top up",
      "daily limit reached",
      "daily_limit",
      "spending limit",
    ],
    classify: () => ({ kind: "quota-depleted" }),
  },
  {
    statuses: [402],
    phrases: [],
    classify: () => ({ kind: "quota-depleted" }),
  },
  {
    // 429 with retry_after = rate blip; without = quota-ish per spec only
    // when quota phrases matched above, so a bare 429 here is transient.
    statuses: [429],
    phrases: [],
    classify: (message) => {
      const m = message.match(RETRY_AFTER_RE);
      const seconds = m ? parseFloat(m[1]) : 5;
      return { kind: "rate-limit-transient", retryAfterMs: Math.min(seconds, 60) * 1000 };
    },
  },
  {
    statuses: [401, 403],
    phrases: ["invalid api key", "authentication_error", "unauthorized", "forbidden", "permission"],
    classify: () => ({ kind: "auth" }),
  },
  {
    statuses: [],
    phrases: ["econnreset", "enotfound", "etimedout", "socket hang up", "network", "fetch failed", "timed out"],
    classify: () => ({ kind: "network" }),
  },
];

export function classifyProviderError(status: number | null, message: string): ErrorClass {
  const lower = message.toLowerCase();
  for (const rule of RULES) {
    const statusHit = rule.statuses.length > 0 && status !== null && rule.statuses.includes(status);
    const phraseHit = rule.phrases.some((p) => lower.includes(p));
    // rows with statuses match on status (phrases refine); phrase-only rows match on phrases
    if (rule.statuses.length ? statusHit || phraseHit : phraseHit) return rule.classify(message);
  }
  if (status !== null && status >= 500) return { kind: "network" };
  return { kind: "other" };
}
