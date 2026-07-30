/**
 * Proxy support for Telegram traffic (api.telegram.org is blocked for many
 * RF users). One installation-wide proxy URL — http(s):// or socks(4/5):// —
 * applied to grammY's fetch (baseFetchConfig.agent) and to the direct getMe
 * validation probe. Empty URL = direct connection.
 */

import { HttpsProxyAgent } from "https-proxy-agent";
import { SocksProxyAgent } from "socks-proxy-agent";
import type { Agent } from "node:http";
import { loadStore } from "./vault";

/** null = valid (or empty); otherwise the human-readable problem */
export function validateProxyUrl(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) return null;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return "Not a valid URL — expected e.g. socks5://127.0.0.1:1080";
  }
  const proto = parsed.protocol.replace(/:$/, "");
  if (!["http", "https", "socks", "socks4", "socks5"].includes(proto))
    return `Unsupported scheme "${proto}" — use http, https, socks4 or socks5`;
  if (!parsed.hostname) return "Proxy host is missing";
  return null;
}

/** agent for an arbitrary proxy URL; undefined = direct/invalid */
export function agentForUrl(url: string): Agent | undefined {
  const trimmed = url.trim();
  if (!trimmed || validateProxyUrl(trimmed) !== null) return undefined;
  return trimmed.startsWith("socks")
    ? new SocksProxyAgent(trimmed)
    : new HttpsProxyAgent(trimmed);
}

/** agent for the CURRENT stored proxy; undefined = direct */
export function currentProxyAgent(): Agent | undefined {
  return agentForUrl(loadStore().proxyUrl);
}
