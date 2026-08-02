import assert from "node:assert/strict";
import test from "node:test";
import { tg } from "../src/main/remote/tg-i18n.ts";
import { shouldSendTyping } from "../src/shared/remote-communication.ts";

test("typing pauses while the agent awaits input, including Team runs", () => {
  assert.equal(shouldSendTyping("thinking", false), true);
  assert.equal(shouldSendTyping("tool", false), true);
  assert.equal(shouldSendTyping("awaiting-input", true), false);
  assert.equal(shouldSendTyping("idle", true), true);
  assert.equal(shouldSendTyping("idle", false), false);
});

test("compact completion metadata is localized per recipient", () => {
  assert.equal(tg("ru").files(2), "2 файла");
  assert.equal(tg("ru").passed(4), "4 теста");
  assert.equal(tg("ru").minutes(3), "3м");
  assert.equal(tg("en").files(2), "2 files");
  assert.equal(tg("ru").passed(11), "11 тестов");
  assert.equal(tg("ru").passed(12), "12 тестов");
  assert.equal(tg("ru").passed(14), "14 тестов");
  assert.equal(tg("ru").passed(21), "21 тест");
  assert.equal(tg("en").passed(4), "4 passed");
  assert.equal(tg("en").minutes(3), "3m");
});

test("live Team status phases and row states are localized", () => {
  assert.equal(tg("ru").teamLabel, "команда");
  assert.equal(tg("ru").teamPhase("execute"), "выполнение");
  assert.equal(tg("ru").teamState("active"), "работает");
  assert.equal(tg("en").teamLabel, "team");
  assert.equal(tg("en").teamPhase("verify"), "verifying");
  assert.equal(tg("en").teamState("pending"), "queued");
});
