/**
 * Telegram-side formatting: MarkdownV2 escaping, message chunking,
 * digest skeleton, todo/diffstat rendering. Pure functions.
 */

import type { OmpStatus, OmpTodoPhase } from "../../shared/types";

export const TG_LIMIT = 4096;

// ---------------------------------------------------------------- markdownv2

/** Characters MarkdownV2 requires escaping outside entities. */
const MDV2_SPECIALS = /[_*[\]()~`>#+\-=|{}.!\\]/g;

export function escapeMd(text: string): string {
  return text.replace(MDV2_SPECIALS, (c) => `\\${c}`);
}

function escapeCode(text: string): string {
  // Inside pre/code entities only ` and \ need escaping.
  return text.replace(/[`\\]/g, (c) => `\\${c}`);
}

/**
 * Convert common markdown (agent output) to Telegram MarkdownV2.
 * Handles fenced code blocks, inline code, bold/italic markers; everything
 * else is escaped literally. Conservative: unknown constructs degrade to
 * escaped plain text rather than broken entities.
 */
export function mdToTelegram(src: string): string {
  const out: string[] = [];
  const lines = src.split("\n");
  let inFence = false;
  let fenceLang = "";
  let fenceBuf: string[] = [];

  const flushFence = () => {
    out.push("```" + fenceLang + "\n" + escapeCode(fenceBuf.join("\n")) + "\n```");
    fenceBuf = [];
    fenceLang = "";
  };

  for (const line of lines) {
    const fence = line.match(/^\s*```(\w*)\s*$/);
    if (fence) {
      if (inFence) {
        flushFence();
        inFence = false;
      } else {
        inFence = true;
        fenceLang = fence[1] ?? "";
      }
      continue;
    }
    if (inFence) {
      fenceBuf.push(line);
      continue;
    }
    out.push(inlineMdToTelegram(line));
  }
  if (inFence) flushFence(); // unterminated fence — close it
  return out.join("\n");
}

function inlineMdToTelegram(line: string): string {
  let result = "";
  let i = 0;
  while (i < line.length) {
    // inline code span
    if (line[i] === "`") {
      const end = line.indexOf("`", i + 1);
      if (end > i) {
        result += "`" + escapeCode(line.slice(i + 1, end)) + "`";
        i = end + 1;
        continue;
      }
    }
    // bold **x**
    if (line.startsWith("**", i)) {
      const end = line.indexOf("**", i + 2);
      if (end > i) {
        result += "*" + escapeMd(line.slice(i + 2, end)) + "*";
        i = end + 2;
        continue;
      }
    }
    // headings → bold
    if (i === 0) {
      const h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) {
        return "*" + escapeMd(h[2]) + "*";
      }
    }
    result += escapeMd(line[i]);
    i++;
  }
  return result;
}

// ---------------------------------------------------------------- chunking

/** Split text at line boundaries into chunks of at most `limit` chars. */
export function chunkText(text: string, limit = TG_LIMIT): string[] {
  if (text.length <= limit) return [text];
  const chunks: string[] = [];
  let current = "";
  for (const line of text.split("\n")) {
    // A single line longer than the limit is hard-split.
    if (line.length > limit) {
      if (current) {
        chunks.push(current);
        current = "";
      }
      for (let i = 0; i < line.length; i += limit) chunks.push(line.slice(i, i + limit));
      continue;
    }
    if (current.length + line.length + 1 > limit) {
      chunks.push(current);
      current = line;
    } else {
      current = current ? current + "\n" + line : line;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

// ---------------------------------------------------------------- digest skeleton

export interface DigestData {
  status: OmpStatus;
  phases: OmpTodoPhase[];
  filesTouched: number;
  add: number;
  del: number;
  remotes: number;
}

function todoProgress(phases: OmpTodoPhase[]): { done: number; total: number; current: string } {
  let done = 0;
  let total = 0;
  let current = "";
  for (const p of phases) {
    for (const t of p.tasks) {
      total++;
      if (t.status === "completed") done++;
      if (t.status === "in_progress" && !current) current = t.content;
    }
  }
  return { done, total, current };
}

export function renderDigest(d: DigestData): string {
  const st = d.status;
  const stateLine =
    st.state === "tool" && st.tool ? `running · ${st.tool}` :
    st.state === "thinking" ? "thinking" :
    st.state === "awaiting-input" ? "waiting for input" :
    st.state;
  const { done, total, current } = todoProgress(d.phases);
  const lines = [`◉ ${stateLine}`];
  if (total > 0) {
    const width = 7;
    const filled = Math.round((done / total) * width);
    const bar = "▰".repeat(filled) + "▱".repeat(width - filled);
    lines.push(`${bar} ${done}/${total}${current ? ` · ${current.slice(0, 40)}` : ""}`);
  }
  lines.push(`files: ${d.filesTouched} touched · +${d.add} −${d.del}`);
  lines.push(`remotes: ${d.remotes} connected`);
  return "```\n" + escapeCode(lines.join("\n")) + "\n```";
}

// ---------------------------------------------------------------- todo & diffstat text

export function renderTodoLines(phases: OmpTodoPhase[]): string {
  const lines: string[] = [];
  for (const p of phases) {
    if (!p.tasks.length) continue;
    if (p.name && p.name !== "Todos") lines.push(`— ${p.name} —`);
    for (const t of p.tasks) {
      const glyph = t.status === "completed" ? "✔" : t.status === "in_progress" ? "▶" : "○";
      lines.push(`${glyph} ${t.content}`);
    }
  }
  return lines.length ? lines.join("\n") : "No todos yet.";
}

export interface FileStat {
  path: string;
  add: number;
  del: number;
}

export function renderDiffstat(stats: FileStat[]): string {
  if (!stats.length) return "No files touched this session.";
  return stats.map((s) => `${s.path} +${s.add} −${s.del}`).join("\n");
}

export function formatElapsed(ms: number): string {
  const sec = Math.floor(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m ${sec % 60}s`;
  return `${Math.floor(min / 60)}h ${min % 60}m`;
}
