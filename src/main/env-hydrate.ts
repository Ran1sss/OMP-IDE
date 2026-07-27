/**
 * Windows env hydration. A GUI app inherits Explorer's environment block,
 * which is frozen at Explorer's start — env vars added or changed since then
 * (e.g. ECHOGATE_API_KEY that models.yml profiles reference by name) are
 * missing, and providers fail with "401 API key is missing" even though a
 * fresh terminal sees the key. Reading HKCU/HKLM Environment at startup and
 * filling ONLY missing names makes launches equivalent to a fresh shell.
 */

import { execFileSync } from "node:child_process";

const SCOPES = [
  "HKCU\\Environment",
  "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment",
];

/** %VAR% expansion against the current (partially hydrated) environment */
function expand(value: string): string {
  return value.replace(/%([^%]+)%/g, (whole, name: string) => process.env[name] ?? whole);
}

export function hydrateEnvFromRegistry(): void {
  if (process.platform !== "win32") return;
  for (const key of SCOPES) {
    let out: string;
    try {
      out = execFileSync("reg", ["query", key], { encoding: "utf-8", windowsHide: true });
    } catch {
      continue; // scope unreadable — nothing to hydrate from
    }
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/^\s{4}(\S+)\s+REG_(EXPAND_)?SZ\s+(.*)$/);
      if (!m) continue;
      const [, name, isExpand, raw] = m;
      // fill gaps only: never override what the launcher already provided
      // (PATH etc. always exist and are skipped)
      if (process.env[name] !== undefined) continue;
      process.env[name] = isExpand ? expand(raw) : raw;
    }
  }
}
