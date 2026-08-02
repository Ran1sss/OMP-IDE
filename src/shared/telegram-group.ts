export function normalizeGroupCommand(text: string): string | null {
  const match = /^(\/[a-z0-9_]+)(?:@[a-z0-9_]+)?(?:\s|$)/i.exec(text.trim());
  return match?.[1].toLowerCase() ?? null;
}
export function stripGroupCommandSuffix(text: string): string {
  return text.trim().replace(/^(\/[a-z0-9_]+)@[a-z0-9_]+(?=\s|$)/i, "$1");
}


export function stripBotAddress(text: string, botUsername: string): string {
  const escaped = botUsername.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return text.replace(new RegExp(`^@${escaped}\\b\\s*`, "i"), "").trim();
}

export function shouldRouteOwnerGroupMessage(input: {
  authorId: number;
  ownerIds: readonly number[];
  chatId: number;
  edit: boolean;
}): boolean {
  return !input.edit && input.ownerIds.includes(input.authorId);
}

export function shouldLogBlockedGroupUser(seen: Set<string>, key: string): boolean {
  if (seen.has(key)) return false;
  seen.add(key);
  return true;
}

/**
 * With privacy mode on, only commands, @mentions and replies reach the bot, so
 * a plain group task never arrives. The hint fires once per chat: it explains
 * the silence the owner would otherwise blame on the IDE.
 */
export function shouldHintPrivacyMode(input: {
  coverage: "full" | "limited";
  addressed: boolean;
  hinted: Set<string>;
  key: string;
}): boolean {
  if (input.coverage === "full" || !input.addressed) return false;
  if (input.hinted.has(input.key)) return false;
  input.hinted.add(input.key);
  return true;
}

type MigratableChat = { chatId: number };
type MigratableProposal = { botId: string; chatId: number; dmChatId?: number };

export function migrateGroupStore(
  store: { chats: Record<string, MigratableChat[]>; proposals: MigratableProposal[] },
  botId: string,
  fromChatId: number,
  toChatId: number,
): boolean {
  let changed = false;
  for (const chat of store.chats[botId] ?? []) {
    if (chat.chatId !== fromChatId) continue;
    chat.chatId = toChatId;
    changed = true;
  }
  for (const proposal of store.proposals) {
    if (proposal.botId !== botId) continue;
    if (proposal.chatId === fromChatId) {
      proposal.chatId = toChatId;
      changed = true;
    }
    if (proposal.dmChatId === fromChatId) {
      proposal.dmChatId = toChatId;
      changed = true;
    }
  }
  return changed;
}

export type GroupIntake =
  | { action: "migrate"; toChatId: number }
  | { action: "ignore" }
  | { action: "blocked"; addressed: boolean }
  | { action: "route"; text: string; addressed: boolean };

/**
 * One decision for every group message: migration service, stranger, or an
 * owner task. Owner authorization is per-author (`from.id`) — the negative
 * chat id is never an identity. Command suffixes and a leading privacy-safe
 * @mention are stripped before routing, so `/status@bot` and `@bot fix it`
 * behave exactly like their DM forms.
 */
export function classifyGroupMessage(input: {
  authorId: number;
  ownerIds: readonly number[];
  chatId: number;
  edit: boolean;
  text: string;
  botUsername: string;
  mentionsBot: boolean;
  replyToBot: boolean;
  migrateToChatId?: number;
}): GroupIntake {
  if (input.migrateToChatId !== undefined) return { action: "migrate", toChatId: input.migrateToChatId };
  const addressed = normalizeGroupCommand(input.text) !== null || input.mentionsBot || input.replyToBot;
  if (!shouldRouteOwnerGroupMessage(input)) return addressed ? { action: "blocked", addressed } : { action: "ignore" };
  const text = stripBotAddress(stripGroupCommandSuffix(input.text), input.botUsername);
  return text ? { action: "route", text, addressed } : { action: "ignore" };
}
