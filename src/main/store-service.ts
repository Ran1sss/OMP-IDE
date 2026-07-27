import type { IpcMain } from "electron";
import { app } from "electron";
import * as fs from "node:fs";
import { join, basename } from "node:path";
import {
  DEFAULT_SETTINGS,
  type Settings,
  type LayoutState,
  type RecentWorkspace,
} from "../shared/types";

interface StoreShape {
  settings: Settings;
  recents: RecentWorkspace[];
  layouts: Record<string, LayoutState>;
}

let cache: StoreShape | null = null;

function storePath(): string {
  return join(app.getPath("userData"), "omp-ide-store.json");
}

function load(): StoreShape {
  if (cache) return cache;
  try {
    const raw = fs.readFileSync(storePath(), "utf-8");
    const parsed = JSON.parse(raw) as Partial<StoreShape>;
    cache = {
      settings: { ...DEFAULT_SETTINGS, ...(parsed.settings ?? {}) },
      recents: Array.isArray(parsed.recents) ? parsed.recents : [],
      layouts: parsed.layouts && typeof parsed.layouts === "object" ? parsed.layouts : {},
    };
  } catch {
    cache = { settings: { ...DEFAULT_SETTINGS }, recents: [], layouts: {} };
  }
  return cache;
}

function persist() {
  if (!cache) return;
  try {
    fs.mkdirSync(app.getPath("userData"), { recursive: true });
    fs.writeFileSync(storePath(), JSON.stringify(cache, null, 2), "utf-8");
  } catch {
    // best-effort persistence
  }
}

/** Read the persisted omp binary path directly (used by the omp process manager). */
export function currentOmpPath(): string {
  return load().settings.ompPath;
}

export function registerStoreHandlers(ipc: IpcMain) {
  ipc.handle("store:getSettings", async (): Promise<Settings> => load().settings);

  ipc.handle("store:setSettings", async (_e, patch: Partial<Settings>): Promise<Settings> => {
    const s = load();
    s.settings = { ...s.settings, ...patch };
    persist();
    return s.settings;
  });

  ipc.handle("store:getRecents", async (): Promise<RecentWorkspace[]> => {
    const s = load();
    return s.recents.filter((r) => fs.existsSync(r.path)).slice(0, 8);
  });

  ipc.handle("store:addRecent", async (_e, path: string) => {
    const s = load();
    s.recents = [
      { path, name: basename(path), openedAt: Date.now() },
      ...s.recents.filter((r) => r.path !== path),
    ].slice(0, 12);
    persist();
  });

  ipc.handle("store:getLayout", async (_e, workspace: string): Promise<LayoutState | null> => {
    return load().layouts[workspace] ?? null;
  });

  ipc.handle("store:setLayout", async (_e, workspace: string, l: LayoutState) => {
    const s = load();
    s.layouts[workspace] = l;
    persist();
  });
}
