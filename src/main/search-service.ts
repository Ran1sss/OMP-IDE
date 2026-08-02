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

export const SEARCH_RESULT_LIMIT = 500;

/** Retain a bounded result set while using the next match as proof of truncation. */
export class SearchMatchCap {
  readonly limit: number;
  kept = 0;
  hitLimit = false;

  constructor(limit = SEARCH_RESULT_LIMIT) {
    this.limit = limit;
  }

  accept(): boolean {
    if (this.kept < this.limit) {
      this.kept++;
      return true;
    }
    this.hitLimit = true;
    return false;
  }
}

/** Convert ripgrep's UTF-8 byte offsets to JavaScript/Monaco UTF-16 offsets. */
export function utf8SpanToUtf16(text: string, byteStart: number, byteEnd: number): { column: number; length: number } {
  let bytes = 0;
  let start = text.length;
  let end = text.length;
  for (let i = 0; i <= text.length;) {
    if (bytes === byteStart) start = i;
    if (bytes === byteEnd) {
      end = i;
      break;
    }
    if (i === text.length) break;
    const cp = text.codePointAt(i)!;
    bytes += cp <= 0x7f ? 1 : cp <= 0x7ff ? 2 : cp <= 0xffff ? 3 : 4;
    i += cp > 0xffff ? 2 : 1;
  }
  return { column: start, length: Math.max(0, end - start) };
}

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
      const hitLimit = await jsFallbackSearch(q, (matches) => {
        if (!wc.isDestroyed()) wc.send("search:batch", { id: q.id, matches });
      });
      if (!wc.isDestroyed()) wc.send("search:done", { id: q.id, hitLimit });
      return;
    }

    const args = ["--json", "--max-count", String(SEARCH_RESULT_LIMIT + 1), "--max-columns", "500"];
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

    const cap = new SearchMatchCap();
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
      if (cap.hitLimit) return;
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
        const rawLineText: string = d.lines.text ?? "";
        const lineText = rawLineText.replace(/\r?\n$/, "");
        for (const sm of d.submatches ?? []) {
          if (!cap.accept()) {
            proc.kill();
            break;
          }
          const span = utf8SpanToUtf16(rawLineText, sm.start, sm.end);
          batch.push({
            file: d.path.text,
            line: d.line_number,
            column: span.column,
            length: span.length,
            lineText,
          });
        }
        if (cap.hitLimit) break;
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
        const error = code === 2 && cap.kept === 0 ? stderr.slice(0, 400) || "search failed" : undefined;
        wc.send("search:done", { id: q.id, hitLimit: cap.hitLimit, error });
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
): Promise<boolean> {
  let re: RegExp;
  try {
    re = q.regex
      ? new RegExp(q.pattern, q.caseSensitive ? "g" : "gi")
      : new RegExp(q.pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), q.caseSensitive ? "g" : "gi");
  } catch {
    return false;
  }
  const cap = new SearchMatchCap();
  async function walk(dir: string) {
    if (cap.hitLimit) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of entries) {
      if (cap.hitLimit) return;
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
          if (!cap.accept()) break;
          matches.push({
            file: p,
            line: i + 1,
            column: m.index,
            length: m[0].length || 1,
            lineText: lines[i],
          });
          if (m[0].length === 0) re.lastIndex++;
        }
        if (cap.hitLimit) break;
      }
      if (matches.length) emit(matches);
    }
  }
  await walk(q.root);
  return cap.hitLimit;
}
