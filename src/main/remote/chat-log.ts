/**
 * JSONL chat logger. One file per bot+chat under
 * userData/chat-logs/<botId>/<chatId>.jsonl, rotated at 10 MB keeping the
 * last 3 files (.1 = previous, .2 = oldest). Append-only: edits add a new
 * entry flagged `edit`, history is never rewritten.
 */

import { app } from "electron";
import * as fs from "node:fs";
import { join, dirname } from "node:path";
import type { RemoteChatLogEntry } from "../../shared/types";

const ROTATE_BYTES = 10 * 1024 * 1024;
const KEEP = 3;

export function chatLogPath(botId: string, chatId: number): string {
  return join(app.getPath("userData"), "chat-logs", botId, `${chatId}.jsonl`);
}

export function appendChatLog(botId: string, chatId: number, entry: RemoteChatLogEntry): void {
  const path = chatLogPath(botId, chatId);
  try {
    fs.mkdirSync(dirname(path), { recursive: true });
    let size = 0;
    try {
      size = fs.statSync(path).size;
    } catch {
      // fresh file
    }
    if (size >= ROTATE_BYTES) rotate(path);
    fs.appendFileSync(path, JSON.stringify(entry) + "\n", "utf-8");
  } catch {
    // logging must never take down message handling
  }
}

/** shift  base -> .1 -> .2, dropping the oldest */
function rotate(path: string): void {
  try {
    fs.rmSync(`${path}.${KEEP - 1}`, { force: true });
    for (let i = KEEP - 2; i >= 1; i--) {
      try {
        fs.renameSync(`${path}.${i}`, `${path}.${i + 1}`);
      } catch {
        // gap in the chain is fine
      }
    }
    fs.renameSync(path, `${path}.1`);
  } catch {
    // rotation failure degrades to a large file, not data loss
  }
}

/**
 * Newest-first page of log entries with seq < beforeSeq (or the tail when
 * beforeSeq is omitted), reading backwards across rotated files.
 */
export function readChatLogPage(
  botId: string,
  chatId: number,
  beforeSeq: number | undefined,
  limit: number,
): RemoteChatLogEntry[] {
  const base = chatLogPath(botId, chatId);
  const out: RemoteChatLogEntry[] = [];
  // base file is newest; .1, .2 progressively older
  for (let i = 0; i <= KEEP - 1 && out.length < limit; i++) {
    const path = i === 0 ? base : `${base}.${i}`;
    let raw: string;
    try {
      raw = fs.readFileSync(path, "utf-8");
    } catch {
      continue;
    }
    const lines = raw.split("\n");
    for (let j = lines.length - 1; j >= 0 && out.length < limit; j--) {
      const line = lines[j].trim();
      if (!line) continue;
      try {
        const e = JSON.parse(line) as RemoteChatLogEntry;
        if (beforeSeq !== undefined && e.seq >= beforeSeq) continue;
        out.push(e);
      } catch {
        // torn write at rotation boundary — skip the row
      }
    }
  }
  return out;
}

/** remove the chat's JSONL log including rotated generations */
export function deleteChatLog(botId: string, chatId: number): void {
  const base = chatLogPath(botId, chatId);
  for (let i = 0; i <= KEEP - 1; i++) {
    try {
      fs.rmSync(i === 0 ? base : `${base}.${i}`, { force: true });
    } catch {
      // sharing violation etc. — a leftover file is harmless
    }
  }
}
