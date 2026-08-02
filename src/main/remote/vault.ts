/**
 * Remote module persistence.
 * - Bot tokens: encrypted via Electron safeStorage, stored in remote-vault.json
 *   as base64 ciphertext. Never plaintext on disk, never logged.
 * - Non-secret registry (bot metadata, allowlists, toggles): remote-store.json.
 */

import { app, safeStorage } from "electron";
import * as fs from "node:fs";
import { join } from "node:path";
import type { RemotePairedUser } from "../../shared/types";

export interface StoredBot {
  id: string;
  name: string;
  username: string;
  enabled: boolean;
  paired: RemotePairedUser[];
}

export interface RemoteStore {
  globalEnabled: boolean;
  /** telegram proxy url; kept verbatim when the proxy is switched off */
  proxyUrl: string;
  /** route Telegram through proxyUrl; false = direct, url preserved */
  proxyEnabled: boolean;
  bots: StoredBot[];
}

const DEFAULT_STORE: RemoteStore = {
  globalEnabled: true,
  proxyUrl: "",
  proxyEnabled: false,
  bots: [],
};

function storePath(): string {
  return join(app.getPath("userData"), "remote-store.json");
}

function vaultPath(): string {
  return join(app.getPath("userData"), "remote-vault.json");
}

let storeCache: RemoteStore | null = null;

export function loadStore(): RemoteStore {
  if (storeCache) return storeCache;
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath(), "utf-8")) as Partial<RemoteStore>;
    storeCache = {
      globalEnabled: parsed.globalEnabled !== false,
      proxyUrl: typeof parsed.proxyUrl === "string" ? parsed.proxyUrl : "",
      // pre-toggle installs stored a url only when they wanted it used
      proxyEnabled: typeof parsed.proxyEnabled === "boolean" ? parsed.proxyEnabled : !!parsed.proxyUrl,
      bots: Array.isArray(parsed.bots) ? parsed.bots : [],
    };
  } catch {
    storeCache = { ...DEFAULT_STORE, bots: [] };
  }
  return storeCache;
}

export function saveStore(): void {
  if (!storeCache) return;
  try {
    fs.mkdirSync(app.getPath("userData"), { recursive: true });
    fs.writeFileSync(storePath(), JSON.stringify(storeCache, null, 2), "utf-8");
  } catch {
    // best effort; registry is reconstructible
  }
}

// ---------------------------------------------------------------- token vault

type VaultShape = Record<string, string>; // botId -> base64 ciphertext

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

export function vaultAvailable(): boolean {
  return safeStorage.isEncryptionAvailable();
}

export function putToken(botId: string, token: string): void {
  const v = readVault();
  v[botId] = safeStorage.encryptString(token).toString("base64");
  writeVault(v);
}

export function getToken(botId: string): string | null {
  const v = readVault();
  const enc = v[botId];
  if (!enc) return null;
  try {
    return safeStorage.decryptString(Buffer.from(enc, "base64"));
  } catch {
    return null;
  }
}

export function dropToken(botId: string): void {
  const v = readVault();
  delete v[botId];
  writeVault(v);
}
