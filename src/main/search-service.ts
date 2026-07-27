import type { IpcMain } from "electron";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as fs from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type {
  SearchQuery,
  SearchMatch,
  ReplaceEdit,
  ReplaceResult,
} from "../shared/types";

function resolveRipgrep(): string | null {
  try {
    // Bundled binary from @vscode/ripgrep
    const { rgPath } = require("@vscode/ripgrep") as { rgPath: string };
    if (existsSync(rgPath)) return rgPath;
  } catch {}
  return null;
}

const running = new Map<string, ChildProcessWithoutNullStreams>();
const MATCH_LIMIT = 5000;

interface RgSubmatch { start: number; end: number }
interface RgMatchData {
  path: { text: string };
  lines: { text?: string };
  line_number: number;
  submatches?: RgSubmatch[];
}

export function registerSearchHandlers(ipc: IpcMain) {
  ipc.handle("search:start", async (e, q: SearchQuery) => {
    const wc = e.sender;
    const prev = running.get(q.id);
    if (prev) prev.kill();

    const rg = resolveRipgrep();
    if (!rg) {
      // JS fallback: naive scan. Slow but functional.
      await jsFallbackSearch(q, (matches) => {
        if (!wc.isDestroyed()) wc.send("search:batch", { id: q.id, matches });
      });
      if (!wc.isDestroyed()) wc.send("search:done", { id: q.id, hitLimit: false });
      return;
    }

    const args = ["--json", "--max-count", "500", "--max-columns", "500"];
    if (!q.caseSensitive) args.push("--ignore-case");
    if (!q.regex) args.push("--fixed-strings");
    if (q.include.trim()) {
      for (const g of q.include.split(",").map((s) => s.trim()).filter(Boolean)) {
        args.push("--glob", g);
      }
    }
    if (q.exclude.trim()) {
      for (const g of q.exclude.split(",").map((s) => s.trim()).filter(Boolean)) {
        args.push("--glob", `!${g}`);
      }
    }
    args.push("--", q.pattern, q.root);

    const proc = spawn(rg, args, { windowsHide: true });
    running.set(q.id, proc);

    let total = 0;
    let buf = "";
    let batch: SearchMatch[] = [];
    let flushTimer: NodeJS.Timeout | null = null;

    const flush = () => {
      flushTimer = null;
      if (batch.length && !wc.isDestroyed()) {
        wc.send("search:batch", { id: q.id, matches: batch });
        batch = [];
      }
    };

    proc.stdout.setEncoding("utf-8");
    proc.stdout.on("data", (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let obj: { type?: string; data?: RgMatchData };
        try {
          obj = JSON.parse(line) as { type?: string; data?: RgMatchData };
        } catch {
          continue;
        }
        if (obj.type !== "match" || !obj.data) continue;
        const d = obj.data;
        const lineText: string = d.lines.text ?? "";
        for (const sm of d.submatches ?? []) {
          batch.push({
            file: d.path.text,
            line: d.line_number,
            column: sm.start,
            length: sm.end - sm.start,
            lineText: lineText.replace(/\r?\n$/, ""),
          });
          total++;
          if (total >= MATCH_LIMIT) {
            proc.kill();
            break;
          }
        }
      }
      if (!flushTimer) flushTimer = setTimeout(flush, 40);
    });

    let stderr = "";
    proc.stderr.setEncoding("utf-8");
    proc.stderr.on("data", (c: string) => (stderr += c));

    proc.on("close", (code) => {
      running.delete(q.id);
      clearTimeout(flushTimer ?? undefined);
      flush();
      if (!wc.isDestroyed()) {
        // rg exits 1 on "no matches", 2 on error
        const error = code === 2 && total === 0 ? stderr.slice(0, 400) || "search failed" : undefined;
        wc.send("search:done", { id: q.id, hitLimit: total >= MATCH_LIMIT, error });
      }
    });
  });

  ipc.handle("search:cancel", async (_e, id: string) => {
    const p = running.get(id);
    running.delete(id);
    p?.kill();
  });

  ipc.handle("search:replace", async (_e, edits: ReplaceEdit[]): Promise<ReplaceResult> => {
    const byFile = new Map<string, ReplaceEdit[]>();
    for (const ed of edits) {
      const arr = byFile.get(ed.file) ?? [];
      arr.push(ed);
      byFile.set(ed.file, arr);
    }
    let applied = 0;
    const failed: ReplaceResult["failed"] = [];
    for (const [file, fileEdits] of byFile) {
      try {
        const raw = await fs.readFile(file, "utf-8");
        const eol = raw.includes("\r\n") ? "\r\n" : "\n";
        const lines = raw.split(/\r?\n/);
        // Apply bottom-up, right-to-left so offsets stay valid.
        fileEdits.sort((a, b) => b.line - a.line || b.column - a.column);
        for (const ed of fileEdits) {
          const idx = ed.line - 1;
          if (idx < 0 || idx >= lines.length) {
            failed.push({ file, line: ed.line, reason: "line out of range" });
            continue;
          }
          const text = lines[idx];
          if (text.slice(ed.column, ed.column + ed.matchText.length) !== ed.matchText) {
            failed.push({ file, line: ed.line, reason: "content changed since search" });
            continue;
          }
          lines[idx] =
            text.slice(0, ed.column) + ed.replaceText + text.slice(ed.column + ed.matchText.length);
          applied++;
        }
        await fs.writeFile(file, lines.join(eol), "utf-8");
      } catch (err) {
        for (const ed of fileEdits) {
          failed.push({
            file,
            line: ed.line,
            reason: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }
    return { applied, failed };
  });
}

const FALLBACK_SKIP: Record<string, true> = {
  node_modules: true, ".git": true, dist: true, out: true, ".venv": true, __pycache__: true,
};

async function jsFallbackSearch(
  q: SearchQuery,
  emit: (matches: SearchMatch[]) => void,
): Promise<void> {
  let re: RegExp;
  try {
    re = q.regex
      ? new RegExp(q.pattern, q.caseSensitive ? "g" : "gi")
      : new RegExp(q.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), q.caseSensitive ? "g" : "gi");
  } catch {
    return;
  }
  let total = 0;
  async function walk(dir: string) {
    if (total >= MATCH_LIMIT) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of entries) {
      if (total >= MATCH_LIMIT) return;
      if (FALLBACK_SKIP[d.name] === true || d.name.startsWith(".")) continue;
      const p = join(dir, d.name);
      if (d.isDirectory()) {
        await walk(p);
        continue;
      }
      let content: string;
      try {
        const st = await fs.stat(p);
        if (st.size > 2 * 1024 * 1024) continue;
        content = await fs.readFile(p, "utf-8");
        if (content.includes("\u0000")) continue;
      } catch {
        continue;
      }
      const matches: SearchMatch[] = [];
      const lines = content.split(/\r?\n/);
      for (let i = 0; i < lines.length; i++) {
        re.lastIndex = 0;
        let m: RegExpExecArray | null;
        while ((m = re.exec(lines[i]))) {
          matches.push({
            file: p,
            line: i + 1,
            column: m.index,
            length: m[0].length || 1,
            lineText: lines[i],
          });
          total++;
          if (m[0].length === 0) re.lastIndex++;
          if (total >= MATCH_LIMIT) break;
        }
        if (total >= MATCH_LIMIT) break;
      }
      if (matches.length) emit(matches);
    }
  }
  await walk(q.root);
}
