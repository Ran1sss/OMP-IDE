import type { IpcMain, WebContents } from "electron";
import * as os from "node:os";
import * as pty from "@lydell/node-pty";
import type { PtyCreateOptions } from "../shared/types";

interface PtySession {
  proc: pty.IPty;
  owner: WebContents;
}

const sessions = new Map<string, PtySession>();

export function defaultShell(): string {
  if (process.platform === "win32") {
    return process.env.COMSPEC && /powershell|pwsh/i.test(process.env.COMSPEC)
      ? process.env.COMSPEC
      : "powershell.exe";
  }
  return process.env.SHELL || "/bin/bash";
}

export function registerPtyHandlers(ipc: IpcMain) {
  ipc.handle("pty:create", async (e, opts: PtyCreateOptions) => {
    const wc = e.sender;
    const existing = sessions.get(opts.id);
    if (existing) {
      try {
        existing.proc.kill();
      } catch {}
      sessions.delete(opts.id);
    }
    try {
      const shell = opts.shell || defaultShell();
      const proc = pty.spawn(shell, [], {
        name: "xterm-256color",
        cols: opts.cols,
        rows: opts.rows,
        cwd: opts.cwd || os.homedir(),
        env: { ...process.env, TERM_PROGRAM: "omp-ide" } as Record<string, string>,
      });
      sessions.set(opts.id, { proc, owner: wc });
      proc.onData((data) => {
        if (!wc.isDestroyed()) wc.send("pty:data", opts.id, data);
      });
      proc.onExit(({ exitCode }) => {
        sessions.delete(opts.id);
        if (!wc.isDestroyed()) wc.send("pty:exit", { id: opts.id, exitCode });
      });
      wc.once("destroyed", () => {
        const s = sessions.get(opts.id);
        if (s && s.owner === wc) {
          sessions.delete(opts.id);
          try {
            s.proc.kill();
          } catch {}
        }
      });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  });

  ipc.handle("pty:write", async (_e, id: string, data: string) => {
    sessions.get(id)?.proc.write(data);
  });

  ipc.handle("pty:resize", async (_e, id: string, cols: number, rows: number) => {
    if (cols > 0 && rows > 0) {
      try {
        sessions.get(id)?.proc.resize(cols, rows);
      } catch {}
    }
  });

  ipc.handle("pty:kill", async (_e, id: string) => {
    const s = sessions.get(id);
    sessions.delete(id);
    try {
      s?.proc.kill();
    } catch {}
  });
}

export function disposePtys() {
  for (const s of sessions.values()) {
    try {
      s.proc.kill();
    } catch {}
  }
  sessions.clear();
}
