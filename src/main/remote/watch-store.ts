/**
 * Chat-watch persistence: per-bot chat registry, proposal records,
 * proposed-message memory, approver designation, cooldown setting.
 * Same load/save cache pattern as vault.ts. Everything here is
 * reconstructible except proposal history — best-effort writes.
 */

import { app } from "electron";
import * as fs from "node:fs";
import { join } from "node:path";
import type { ChatCoverage, RemoteProposal } from "../../shared/types";

export interface WatchedChat {
  chatId: number;
  title: string;
  kind: "group" | "supergroup";
  coverage: ChatCoverage;
  watched: boolean;
  listener: boolean;
  left: boolean;
  discoveredAt: number;
  messageCount: number;
  evalCount: number;
  lastEvalAt: number | null;
  /** monotonic JSONL seq counter — survives rotation */
  seq: number;
  /** message ids that already proposed — one proposal per message id, ever */
  proposedIds: number[];
}

/** proposal + Telegram delivery bookkeeping (DM edit on the losing surface) */
export interface StoredProposal extends RemoteProposal {
  dmChatId?: number;
  dmMessageId?: number;
}

export interface WatchStore {
  /** botId -> discovered chats */
  chats: Record<string, WatchedChat[]>;
  proposals: StoredProposal[];
  /** botId -> designated approver telegramId */
  approvers: Record<string, number>;
  cooldownMinutes: number;
}

const MAX_PROPOSED_IDS = 500;
const MAX_PROPOSALS = 200;

let cache: WatchStore | null = null;

function watchStorePath(): string {
  return join(app.getPath("userData"), "watch-store.json");
}

export function loadWatchStore(): WatchStore {
  if (cache) return cache;
  try {
    const parsed = JSON.parse(fs.readFileSync(watchStorePath(), "utf-8")) as Partial<WatchStore>;
    cache = {
      chats: parsed.chats && typeof parsed.chats === "object" ? parsed.chats : {},
      proposals: Array.isArray(parsed.proposals) ? parsed.proposals : [],
      approvers: parsed.approvers && typeof parsed.approvers === "object" ? parsed.approvers : {},
      cooldownMinutes:
        typeof parsed.cooldownMinutes === "number" && parsed.cooldownMinutes >= 1
          ? parsed.cooldownMinutes
          : 10,
    };
  } catch {
    cache = { chats: {}, proposals: [], approvers: {}, cooldownMinutes: 10 };
  }
  return cache;
}

export function saveWatchStore(): void {
  if (!cache) return;
  // bound growth before writing: resolved proposals and id memory are capped
  if (cache.proposals.length > MAX_PROPOSALS) {
    const pending = cache.proposals.filter((p) => p.status === "pending" || p.status === "no-approver");
    const rest = cache.proposals.filter((p) => p.status !== "pending" && p.status !== "no-approver");
    cache.proposals = [...rest.slice(-(MAX_PROPOSALS - pending.length)), ...pending];
  }
  for (const chats of Object.values(cache.chats)) {
    for (const c of chats) {
      if (c.proposedIds.length > MAX_PROPOSED_IDS) c.proposedIds = c.proposedIds.slice(-MAX_PROPOSED_IDS);
    }
  }
  try {
    fs.mkdirSync(app.getPath("userData"), { recursive: true });
    fs.writeFileSync(watchStorePath(), JSON.stringify(cache, null, 2), "utf-8");
  } catch {
    // best effort
  }
}

export function findChat(botId: string, chatId: number): WatchedChat | undefined {
  return loadWatchStore().chats[botId]?.find((c) => c.chatId === chatId);
}

export function upsertChat(botId: string, chat: WatchedChat): void {
  const store = loadWatchStore();
  const list = store.chats[botId] ?? (store.chats[botId] = []);
  const idx = list.findIndex((c) => c.chatId === chat.chatId);
  if (idx >= 0) list[idx] = chat;
  else list.push(chat);
  saveWatchStore();
}
