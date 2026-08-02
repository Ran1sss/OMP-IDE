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

// ------------------------------------------------------- outbound sanitizer
//
// Machine markers NEVER reach Telegram (remote spec §4 outbound). The agent
// stream interleaves protocol lines (`@@TEAM@@ {json}` team events and any
// other `@@…@@` / JSON-line directive) that exist only to drive the IDE's
// own UI. This is THE one shared sanitizer — every sender (digest, summary,
// steering echo, failure alert, question ping) routes through it; per-path
// copies are prohibited. User-relevant facts inside a stripped marker are
// re-expressed as words, never as raw JSON.

/** a protocol marker line: `##NAME##`/`@@NAME@@`/`::NAME::` optionally followed by one JSON object */
const PROTO_LINE = /^(?:##[A-Z][A-Z0-9_]*##|@@[A-Z][A-Z0-9_]*@@|::[A-Z][A-Z0-9_]*::)\s*(\{.*\})?\s*$/;

/** re-express a stripped directive's user-relevant facts as human text */
function humanizeDirective(json: string | undefined): string | null {
  if (!json) return null;
  let ev: Record<string, unknown>;
  try {
    ev = JSON.parse(json) as Record<string, unknown>;
  } catch {
    return null;
  }
  switch (ev.ev) {
    case "slice":
      if (ev.state === "done")
        return `✓ slice ${String(ev.id ?? "?")} готов · +${Number(ev.add ?? 0)} −${Number(ev.del ?? 0)}`;
      if (ev.state === "failed")
        return `✗ slice ${String(ev.id ?? "?")} упал${typeof ev.error === "string" ? `: ${ev.error.slice(0, 140)}` : ""}`;
      return null; // active/pending flips are board fuel, not user facts
    case "verify": {
      const note = typeof ev.note === "string" && ev.note ? ` — ${ev.note.slice(0, 200)}` : "";
      return ev.result === "pass" ? `✓ проверка прошла${note}` : `▲ проверка нашла пробел${note}`;
    }
    case "report":
      // the report text is already prose — never the JSON wrapper
      return typeof ev.text === "string" ? ev.text : null;
    case "converged":
      return "планировщики сошлись";
    case "needs-call":
      return `▲ slice ${String(ev.slice ?? "?")} требует решения${typeof ev.error === "string" ? `: ${ev.error.slice(0, 140)}` : ""}`;
    default:
      // probe/planners/say/round/plan/worker/replan: pure UI bookkeeping —
      // the board renders them; they carry no fact a phone reader loses
      return null;
  }
}

/**
 * Strip protocol marker lines from agent output, re-expressing user-relevant
 * facts as human prose. Fenced code blocks pass through untouched (a report
 * may legitimately quote code); a document that was ONLY markers sanitizes
 * to the empty string.
 */
export function sanitizeOutbound(text: string): string {
  if (!text || !text.includes("@@")) {
    // fast path — still catch bare `{"ev":…}` directive lines below when @@ absent
    if (!text || !text.includes("{\"ev\"")) return text;
  }
  const out: string[] = [];
  let inFence = false;
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (t.startsWith("```")) {
      inFence = !inFence;
      out.push(line);
      continue;
    }
    if (!inFence) {
      const m = PROTO_LINE.exec(t);
      if (m) {
        const human = humanizeDirective(m[1]);
        if (human) out.push(human);
        continue;
      }
      // bare JSON-line directive (no @@ wrapper): only lines that ARE a
      // single object carrying an "ev" discriminator — prose stays intact
      if (t.startsWith("{\"") && t.endsWith("}") && t.includes("\"ev\"")) {
        try {
          const obj = JSON.parse(t) as Record<string, unknown>;
          if (obj && typeof obj.ev === "string") {
            const human = humanizeDirective(t);
            if (human) out.push(human);
            continue;
          }
        } catch {
          // not JSON after all — keep the line
        }
      }
    }
    out.push(line);
  }
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
