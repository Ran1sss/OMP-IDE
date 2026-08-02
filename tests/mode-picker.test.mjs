import assert from "node:assert/strict";
import test from "node:test";
import { PendingModeRegistry } from "../src/main/remote/mode-picker.ts";

/** deterministic clock: timers fire only when the test says so */
function fakeTimers() {
  const pending = new Map();
  let seq = 0;
  return {
    schedule: (fn, ms) => {
      const id = ++seq;
      pending.set(id, { fn, ms });
      return id;
    },
    unschedule: (id) => void pending.delete(id),
    fireAll: () => {
      const due = [...pending.values()];
      pending.clear();
      for (const t of due) t.fn();
    },
    size: () => pending.size,
  };
}

function registry() {
  const timers = fakeTimers();
  return { timers, reg: new PendingModeRegistry(timers.schedule, timers.unschedule) };
}

test("a chat holds one pending choice; a new task evicts the old one", () => {
  const { reg } = registry();
  const first = reg.open("bot:1", 7, "старая задача");
  reg.setPickerMessageId(first.entry.id, 100);
  const second = reg.open("bot:1", 7, "новая задача");
  assert.equal(second.evicted?.id, first.entry.id);
  assert.equal(second.evicted?.pickerMessageId, 100);
  assert.equal(reg.get(first.entry.id), null);
  assert.equal(reg.get(second.entry.id)?.payload, "новая задача");
});

test("a different chat keeps its own pending choice", () => {
  const { reg } = registry();
  const a = reg.open("bot:1", 7, "A");
  const b = reg.open("bot:2", 7, "B");
  assert.equal(b.evicted, null);
  assert.equal(reg.get(a.entry.id)?.payload, "A");
});

test("only the asking user claims the choice, and only once", () => {
  const { reg } = registry();
  const { entry } = reg.open("bot:1", 7, "task");
  assert.deepEqual(reg.claim(entry.id, 8), { ok: false, reason: "foreign" });
  const mine = reg.claim(entry.id, 7);
  assert.equal(mine.ok, true);
  assert.deepEqual(reg.claim(entry.id, 7), { ok: false, reason: "missing" });
});

test("the armed timeout starts the task once and then disarms", () => {
  const { timers, reg } = registry();
  const { entry } = reg.open("bot:1", 7, "task");
  reg.setPickerMessageId(entry.id, 10);
  const started = [];
  reg.arm(entry.id, 60_000, (expired) => started.push(expired.payload));
  timers.fireAll();
  assert.deepEqual(started, ["task"]);
  timers.fireAll();
  assert.deepEqual(started, ["task"]);
});

test("claiming by button cancels the pending timeout", () => {
  const { timers, reg } = registry();
  const { entry } = reg.open("bot:1", 7, "task");
  reg.arm(entry.id, 60_000, () => assert.fail("timeout fired after a manual claim"));
  assert.equal(reg.claim(entry.id, 7).ok, true);
  assert.equal(timers.size(), 0);
  timers.fireAll();
});

test("a claimed task no longer accepts a picker message id", () => {
  const { reg } = registry();
  const { entry } = reg.open("bot:1", 7, "task");
  assert.equal(reg.claim(entry.id, 7).ok, true);
  assert.equal(reg.setPickerMessageId(entry.id, 42), false);
});

test("draining reports every pending choice and leaves nothing behind", () => {
  const { timers, reg } = registry();
  const a = reg.open("bot:1", 7, "A");
  const b = reg.open("bot:2", 9, "B");
  reg.setPickerMessageId(a.entry.id, 1);
  reg.arm(b.entry.id, 60_000, () => assert.fail("timeout fired after drain"));
  const drained = reg.drain().map((e) => e.payload).sort();
  assert.deepEqual(drained, ["A", "B"]);
  assert.deepEqual(reg.drain(), []);
  assert.equal(timers.size(), 0);
  assert.equal(reg.cancelByChat("bot:1"), null);
});

test("/stop cancels the pending choice for that chat only", () => {
  const { reg } = registry();
  reg.open("bot:1", 7, "A");
  const other = reg.open("bot:2", 7, "B");
  const cancelled = reg.cancelByChat("bot:1");
  assert.equal(cancelled?.payload, "A");
  assert.equal(reg.cancelByChat("bot:1"), null);
  assert.equal(reg.get(other.entry.id)?.payload, "B");
});
