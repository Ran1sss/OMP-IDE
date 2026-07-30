/**
 * Read-only browser over OMP's on-disk session transcripts
 * (`~/.omp/agent/sessions/<workspace-slug>/*.jsonl`). List + parse only —
 * no IPC here mutates anything. Subdirectories next to a session file hold
 * subagent transcripts and are not sessions themselves.
 */

import type { IpcMain } from "electron";
import * as fs from "node:fs";
import { join, resolve } from "node:path";
import { homedir } from "node:os";
import type { OmpSessionMeta, OmpSessionEntry } from "../shared/types";

const META_SCAN_BYTES = 64 * 1024;
const MAX_SESSIONS = 50;
const MAX_ENTRIES = 2000;

function sessionsRoot(): string {
  return join(homedir(), ".omp", "agent", "sessions");
}

/** OMP's directory naming: every non-alphanumeric byte of the cwd becomes "-", wrapped in "--". */
function slugFor(root: string): string {
  return "--" + root.replace(/[^A-Za-z0-9]/g, "-") + "--";
}

/** case/separator-insensitive path equality (win32) */
function samePath(a: string, b: string): boolean {
  return a.replace(/\//g, "\\").toLowerCase() === b.replace(/\//g, "\\").toLowerCase();
}

interface SessionLine {
  type?: string;
  title?: string;
  timestamp?: string;
  cwd?: string;
  model?: string;
  message?: {
    role?: string;
    content?: Array<{ type?: string; text?: string; name?: string }>;
  };
}

function parseLines(raw: string): SessionLine[] {
  const out: SessionLine[] = [];
  for (const ln of raw.split("\n")) {
    if (!ln.trim()) continue;
    try {
      out.push(JSON.parse(ln) as SessionLine);
    } catch {
      // partial tail of a bounded read, or a corrupt line — skip
    }
  }
  return out;
}

function metaFor(file: string, root: string): OmpSessionMeta | null {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return null;
  }
  let raw = "";
  try {
    const fd = fs.openSync(file, "r");
    const buf = Buffer.alloc(Math.min(META_SCAN_BYTES, stat.size));
    fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    raw = buf.toString("utf-8");
  } catch {
    return null;
  }
  const lines = parseLines(raw);
  const session = lines.find((l) => l.type === "session");
  if (!session) return null;
  // Sessions are grouped by slug, but the slug is lossy — verify the real cwd.
  if (session.cwd && !samePath(session.cwd, root)) return null;
  const title = lines.find((l) => l.type === "title")?.title?.trim() ?? "";
  const model = lines.find((l) => l.type === "model_change")?.model ?? "";
  let firstPrompt = "";
  for (const l of lines) {
    if (l.type === "message" && l.message?.role === "user") {
      firstPrompt = (l.message.content ?? []).map((c) => (c.type === "text" ? c.text ?? "" : "")).join(" ").trim();
      if (firstPrompt) break;
    }
  }
  return {
    file,
    startedAt: session.timestamp ? Date.parse(session.timestamp) : stat.mtimeMs,
    title,
    firstPrompt,
    model,
    sizeKb: Math.max(1, Math.round(stat.size / 1024)),
  };
}

export function registerSessionHistoryHandlers(ipc: IpcMain) {
  ipc.handle("omp:listSessions", async (_e, root: string): Promise<OmpSessionMeta[]> => {
    const dir = join(sessionsRoot(), slugFor(root));
    let names: string[];
    try {
      names = fs.readdirSync(dir).filter((n) => n.endsWith(".jsonl"));
    } catch {
      return []; // no history for this workspace yet — designed empty state
    }
    const metas: OmpSessionMeta[] = [];
    for (const n of names) {
      const m = metaFor(join(dir, n), root);
      if (m) metas.push(m);
    }
    metas.sort((a, b) => b.startedAt - a.startedAt);
    return metas.slice(0, MAX_SESSIONS);
  });

  ipc.handle("omp:readSession", async (_e, file: string): Promise<OmpSessionEntry[]> => {
    // read-only, and only from inside the sessions root
    const full = resolve(file);
    if (!samePath(full.slice(0, sessionsRoot().length), sessionsRoot()))
      throw new Error("Not a session file");
    const raw = fs.readFileSync(full, "utf-8");
    const entries: OmpSessionEntry[] = [];
    for (const l of parseLines(raw)) {
      const at = l.timestamp ? Date.parse(l.timestamp) : 0;
      if (l.type === "model_change" && l.model) {
        entries.push({ kind: "model", model: l.model, at });
      } else if (l.type === "message" && l.message) {
        const role = l.message.role;
        const parts = l.message.content ?? [];
        const text = parts.map((c) => (c.type === "text" ? c.text ?? "" : "")).join("").trim();
        if (role === "user") {
          if (text) entries.push({ kind: "user", text, at });
        } else if (role === "assistant") {
          if (text) entries.push({ kind: "assistant", text, at });
          for (const c of parts) {
            if (c.type === "toolCall" && c.name) entries.push({ kind: "tool", name: c.name, at });
          }
        }
      }
    }
    if (entries.length > MAX_ENTRIES) {
      const dropped = entries.length - MAX_ENTRIES;
      return [
        { kind: "notice", text: `${dropped} earlier entries omitted (session too large)`, at: 0 },
        ...entries.slice(dropped),
      ];
    }
    return entries;
  });
}
