import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeGroupCommand,
  stripGroupCommandSuffix,
  stripBotAddress,
  shouldRouteOwnerGroupMessage,
  shouldLogBlockedGroupUser,
  shouldHintPrivacyMode,
  classifyGroupMessage,
  migrateGroupStore,
} from "../src/shared/telegram-group.ts";

const OWNER = 4242;
const STRANGER = 777;
const GROUP = -1001234567890;

/** the exact shape the manager hands the classifier for a group message */
function group(overrides) {
  return classifyGroupMessage({
    authorId: OWNER,
    ownerIds: [OWNER],
    chatId: GROUP,
    edit: false,
    text: "",
    botUsername: "RanisikTest_bot",
    mentionsBot: false,
    replyToBot: false,
    ...overrides,
  });
}

test("group command parser strips the bot username suffix", () => {
  assert.equal(normalizeGroupCommand("/status@RanisikTest_bot"), "/status");
  assert.equal(normalizeGroupCommand("/status"), "/status");
  assert.equal(normalizeGroupCommand("/team@RanisikTest_bot fix it"), "/team");
  assert.equal(stripGroupCommandSuffix("/team@RanisikTest_bot fix it"), "/team fix it");
  assert.equal(stripGroupCommandSuffix("/status@RanisikTest_bot"), "/status");
});

test("bot mention is stripped before task routing", () => {
  assert.equal(stripBotAddress("@RanisikTest_bot напиши hello.txt", "RanisikTest_bot"), "напиши hello.txt");
  assert.equal(stripBotAddress("напиши @other файл", "RanisikTest_bot"), "напиши @other файл");
});

test("group routing authorizes by owner from.id, never negative chat.id", () => {
  assert.equal(shouldRouteOwnerGroupMessage({ authorId: 42, ownerIds: [42], chatId: -100500, edit: false }), true);
  assert.equal(shouldRouteOwnerGroupMessage({ authorId: 7, ownerIds: [42], chatId: -100500, edit: false }), false);
  assert.equal(shouldRouteOwnerGroupMessage({ authorId: 42, ownerIds: [42], chatId: -100500, edit: true }), false);
});

test("blocked group users are logged once per bot and user", () => {
  const seen = new Set();
  assert.equal(shouldLogBlockedGroupUser(seen, "bot:7"), true);
  assert.equal(shouldLogBlockedGroupUser(seen, "bot:7"), false);
  assert.equal(shouldLogBlockedGroupUser(seen, "bot:8"), true);
});

test("supergroup migration rewrites every stored chat reference", () => {
  const store = {
    chats: { bot1: [{ chatId: -10, title: "group" }, { chatId: -20, title: "other" }] },
    proposals: [
      { botId: "bot1", chatId: -10, dmChatId: -10 },
      { botId: "bot2", chatId: -10 },
    ],
  };
  assert.equal(migrateGroupStore(store, "bot1", -10, -10010), true);
  assert.deepEqual(store.chats.bot1.map((c) => c.chatId), [-10010, -20]);
  assert.equal(store.proposals[0].chatId, -10010);
  assert.equal(store.proposals[0].dmChatId, -10010);
  assert.equal(store.proposals[1].chatId, -10);
  assert.equal(migrateGroupStore(store, "bot1", -999, -1), false);
});

test("the privacy-mode hint fires once per group and only when limited", () => {
  const hinted = new Set();
  assert.equal(shouldHintPrivacyMode({ coverage: "limited", addressed: true, hinted, key: "b:-100" }), true);
  assert.equal(shouldHintPrivacyMode({ coverage: "limited", addressed: true, hinted, key: "b:-100" }), false);
  assert.equal(shouldHintPrivacyMode({ coverage: "limited", addressed: true, hinted, key: "b:-200" }), true);
  assert.equal(shouldHintPrivacyMode({ coverage: "full", addressed: true, hinted, key: "b:-300" }), false);
  assert.equal(shouldHintPrivacyMode({ coverage: "limited", addressed: false, hinted, key: "b:-400" }), false);
  assert.equal(hinted.has("b:-400"), false);
});

test("group commands keep their DM meaning after the @bot suffix", () => {
  assert.deepEqual(group({ text: "/status@RanisikTest_bot" }), {
    action: "route",
    text: "/status",
    addressed: true,
  });
  assert.deepEqual(group({ text: "/team@RanisikTest_bot почини сборку" }), {
    action: "route",
    text: "/team почини сборку",
    addressed: true,
  });
  assert.deepEqual(group({ text: "/solo@RanisikTest_bot создай файл" }), {
    action: "route",
    text: "/solo создай файл",
    addressed: true,
  });
});

test("an @mention task routes with the mention stripped", () => {
  assert.deepEqual(group({ text: "@RanisikTest_bot создай hello.txt", mentionsBot: true }), {
    action: "route",
    text: "создай hello.txt",
    addressed: true,
  });
});

test("a reply to the bot routes as a plain task", () => {
  assert.deepEqual(group({ text: "теперь удали его", replyToBot: true }), {
    action: "route",
    text: "теперь удали его",
    addressed: true,
  });
});

test("a plain owner message routes when privacy mode lets it through", () => {
  assert.deepEqual(group({ text: "почини тесты" }), {
    action: "route",
    text: "почини тесты",
    addressed: false,
  });
});

test("a stranger never routes; only addressed attempts are logged", () => {
  assert.deepEqual(group({ authorId: STRANGER, text: "/status@RanisikTest_bot" }), {
    action: "blocked",
    addressed: true,
  });
  assert.deepEqual(group({ authorId: STRANGER, text: "болтовня в чате" }), { action: "ignore" });
});

test("the negative group id is never mistaken for an owner id", () => {
  assert.deepEqual(group({ authorId: GROUP, ownerIds: [OWNER], text: "/status" }), {
    action: "blocked",
    addressed: true,
  });
});

test("edits never re-route a group task", () => {
  assert.deepEqual(group({ text: "@RanisikTest_bot ещё раз", mentionsBot: true, edit: true }), {
    action: "blocked",
    addressed: true,
  });
});

test("a bare mention with no task is ignored instead of starting an empty run", () => {
  assert.deepEqual(group({ text: "@RanisikTest_bot", mentionsBot: true }), { action: "ignore" });
});

test("a supergroup migration is handled before any authorization check", () => {
  assert.deepEqual(group({ authorId: 0, ownerIds: [OWNER], text: "", migrateToChatId: -100999 }), {
    action: "migrate",
    toChatId: -100999,
  });
});
