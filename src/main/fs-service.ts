import type { IpcMain, WebContents } from "electron";
import { shell } from "electron";
import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, basename, dirname, sep } from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import type { DirEntry, FsChange, ReadFileResult } from "../shared/types";

const BINARY_EXT: Record<string, true> = {
  png: true, jpg: true, jpeg: true, gif: true, webp: true, bmp: true, ico: true, avif: true,
  woff: true, woff2: true, ttf: true, otf: true, eot: true,
  zip: true, gz: true, tar: true, "7z": true, rar: true, jar: true,
  exe: true, dll: true, so: true, dylib: true, node: true, wasm: true,
  pdf: true, mp3: true, mp4: true, mov: true, avi: true, webm: true, ogg: true, wav: true,
  db: true, sqlite: true, bin: true, dat: true, pyc: true, class: true,
};

const SKIP_DIRS: Record<string, true> = {
  node_modules: true, ".git": true, dist: true, out: true, ".venv": true,
  __pycache__: true, ".idea": true, ".vs": true,
};

/** One watcher per window (webContents). */
const watchers = new Map<number, FSWatcher>();
/** Debounce buffers per window. */
const pending = new Map<number, FsChange[]>();
const timers = new Map<number, NodeJS.Timeout>();

function queueChange(wc: WebContents, change: FsChange) {
  const id = wc.id;
  let buf = pending.get(id);
  if (!buf) {
    buf = [];
    pending.set(id, buf);
  }
  buf.push(change);
  if (!timers.has(id)) {
    timers.set(
      id,
      setTimeout(() => {
        timers.delete(id);
        const out = pending.get(id) ?? [];
        pending.set(id, []);
        if (!wc.isDestroyed()) wc.send("fs:changed", out);
      }, 80),
    );
  }
}

export function registerFsHandlers(ipc: IpcMain) {
  ipc.handle("fs:readDir", async (_e, path: string): Promise<DirEntry[]> => {
    const entries = await fs.readdir(path, { withFileTypes: true });
    const out: DirEntry[] = entries.map((d) => ({
      name: d.name,
      path: join(path, d.name),
      isDir: d.isDirectory(),
      isSymlink: d.isSymbolicLink(),
    }));
    out.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name) : a.isDir ? -1 : 1));
    return out;
  });

  ipc.handle("fs:readFile", async (_e, path: string): Promise<ReadFileResult> => {
    const st = await fs.stat(path);
    const b = basename(path);
    const dot = b.lastIndexOf(".");
    const fileExt = dot < 0 ? "" : b.slice(dot + 1).toLowerCase();
    const isBinary = BINARY_EXT[fileExt] === true || st.size > 8 * 1024 * 1024;
    if (isBinary) {
      const buf = await fs.readFile(path);
      return { content: buf.toString("base64"), binary: true, mtimeMs: st.mtimeMs };
    }
    const content = await fs.readFile(path, "utf-8");
    return { content, binary: false, mtimeMs: st.mtimeMs };
  });

  ipc.handle("fs:writeFile", async (_e, path: string, content: string) => {
    await fs.writeFile(path, content, "utf-8");
  });

  ipc.handle("fs:stat", async (_e, path: string) => {
    try {
      const st = await fs.stat(path);
      return { size: st.size, mtimeMs: st.mtimeMs, isDir: st.isDirectory() };
    } catch {
      return null;
    }
  });

  ipc.handle("fs:rename", async (_e, oldPath: string, newPath: string) => {
    if (existsSync(newPath)) throw new Error(`Already exists: ${basename(newPath)}`);
    await fs.rename(oldPath, newPath);
  });

  ipc.handle("fs:createFile", async (_e, path: string) => {
    if (existsSync(path)) throw new Error(`Already exists: ${basename(path)}`);
    await fs.mkdir(dirname(path), { recursive: true });
    await fs.writeFile(path, "", "utf-8");
  });

  ipc.handle("fs:createDir", async (_e, path: string) => {
    if (existsSync(path)) throw new Error(`Already exists: ${basename(path)}`);
    await fs.mkdir(path, { recursive: true });
  });

  ipc.handle("fs:trash", async (_e, path: string) => {
    await shell.trashItem(path);
  });

  ipc.handle("fs:move", async (_e, src: string, destDir: string): Promise<string> => {
    const dest = join(destDir, basename(src));
    if (existsSync(dest)) throw new Error(`Already exists in target: ${basename(src)}`);
    if ((dest + sep).startsWith(src + sep)) throw new Error("Cannot move a folder into itself");
    await fs.rename(src, dest);
    return dest;
  });

  ipc.handle("fs:watch", async (e, root: string) => {
    const wc = e.sender;
    const prev = watchers.get(wc.id);
    if (prev) await prev.close();
    const watcher = chokidar.watch(root, {
      ignored: (path, stats) => {
        const parts = path.split(/[\\/]/);
        return parts.some((p) => SKIP_DIRS[p] === true);
      },
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 60, pollInterval: 20 },
      depth: 25,
    });
    watcher.on("all", (event, path) => {
      queueChange(wc, { type: event as FsChange["type"], path });
    });
    watchers.set(wc.id, watcher);
    wc.once("destroyed", () => {
      const w = watchers.get(wc.id);
      watchers.delete(wc.id);
      w?.close();
    });
  });

  ipc.handle("fs:unwatch", async (e) => {
    const w = watchers.get(e.sender.id);
    watchers.delete(e.sender.id);
    await w?.close();
  });

  ipc.handle("fs:listAllFiles", async (_e, root: string): Promise<string[]> => {
    const out: string[] = [];
    const LIMIT = 40000;
    async function walk(dir: string) {
      if (out.length >= LIMIT) return;
      let entries;
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const d of entries) {
        if (out.length >= LIMIT) return;
        if (d.name.startsWith(".") && d.name !== ".github") continue;
        if (SKIP_DIRS[d.name] === true) continue;
        const p = join(dir, d.name);
        if (d.isDirectory()) await walk(p);
        else out.push(p);
      }
    }
    await walk(root);
    return out;
  });
}

export function disposeWatchers() {
  for (const w of watchers.values()) w.close();
  watchers.clear();
}
