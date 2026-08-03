import assert from "node:assert/strict";
import test from "node:test";
import { TelegramLaunchArbiter } from "../src/main/remote/task-launch-controller.ts";
import {
  PromptImproveController,
  TypingPulse,
  beginPromptEnhance,
  completePromptEnhance,
  failPromptEnhance,
  initialPromptImproveState,
  matchesPickerCallback,
  resolvePromptImproveAction,
  runPromptEnhancement,
} from "../src/main/remote/prompt-improve-controller.ts";
import { ModelPickerLifecycle, ModelSwitchWorkQueue, PickerMessageController } from "../src/main/remote/model-picker-controller.ts";
import { ModelSwitchCoordinator } from "../src/main/models/model-switch-coordinator.ts";
import { runModelActivationTransaction } from "../src/shared/model-selection.ts";

function deferred() {
  const { promise, resolve } = Promise.withResolvers();
  return { promise, resolve };
}

function fakeTimers() {
  let seq = 0;
  const timers = new Map();
  return {
    schedule(fn, ms) {
      const id = ++seq;
      timers.set(id, { fn, ms });
      return id;
    },
    cancel(id) {
      timers.delete(id);
    },
    fireAll() {
      const due = [...timers.values()];
      timers.clear();
      for (const timer of due) timer.fn();
    },
    size() {
      return timers.size;
    },
  };
}

test("two simultaneous Telegram launches start exactly one origin until release", async () => {
  const arbiter = new TelegramLaunchArbiter();
  const starts = [];
  const routes = [];

  const first = arbiter.tryLaunch({
    id: "chat-a",
    isBusy: () => false,
    start: () => {
      starts.push("chat-a");
      return true;
    },
    onAccepted: () => routes.push("chat-a"),
  });
  const second = arbiter.tryLaunch({
    id: "chat-b",
    isBusy: () => false,
    start: () => {
      starts.push("chat-b");
      return true;
    },
    onAccepted: () => routes.push("chat-b"),
  });

  assert.deepEqual(await first, { status: "started", id: "chat-a" });
  assert.deepEqual(await second, { status: "busy", activeId: "chat-a" });
  assert.deepEqual(starts, ["chat-a"]);
  assert.deepEqual(routes, ["chat-a"]);

  arbiter.release("chat-a");
  assert.deepEqual(
    await arbiter.tryLaunch({ id: "chat-b", isBusy: () => false, start: () => true }),
    { status: "started", id: "chat-b" },
  );
});

test("a rejected Telegram launch releases its route even when start throws", async () => {
  const arbiter = new TelegramLaunchArbiter();
  assert.deepEqual(
    await arbiter.tryLaunch({
      id: "broken",
      isBusy: () => false,
      start: () => {
        throw new Error("start failed");
      },
    }),
    { status: "rejected", id: "broken" },
  );
  assert.deepEqual(
    await arbiter.tryLaunch({ id: "healthy", isBusy: () => false, start: () => true }),
    { status: "started", id: "healthy" },
  );
});

test("terminal agent status releases one routed launch without duplicate delivery", async () => {
  const arbiter = new TelegramLaunchArbiter();
  let route = null;
  const deliveries = [];
  const accept = async (id) => {
    const result = await arbiter.tryLaunch({
      id,
      isBusy: () => false,
      start: () => true,
      onAccepted: () => {
        route = id;
      },
    });
    return result;
  };
  const terminal = (state) =>
    arbiter.handleStatus(state, () => {
      if (route !== null) deliveries.push(["error", route]);
      route = null;
    });

  assert.deepEqual(await accept("chat-a"), { status: "started", id: "chat-a" });
  assert.equal(terminal("dead"), true);
  assert.equal(terminal("unavailable"), false);
  assert.equal(route, null);
  assert.deepEqual(deliveries, [["error", "chat-a"]]);
  assert.equal(terminal("idle"), false);

  assert.deepEqual(await accept("chat-b"), { status: "started", id: "chat-b" });
  deliveries.push(["final", route]);
  route = null;
  arbiter.release("chat-b");
  assert.equal(terminal("unavailable"), false);
  assert.deepEqual(deliveries, [["error", "chat-a"], ["final", "chat-b"]]);
});

test("model switch work waits for confirmation and deduplicates one picker", async () => {
  const queue = new ModelSwitchWorkQueue();
  const confirmation = deferred();
  const order = [];
  const first = queue.run("chat-a", async () => {
    order.push("switch-a");
    await confirmation.promise;
    order.push("confirm-a");
  });
  const duplicate = queue.run("chat-a", async () => assert.fail("duplicate picker ran"));
  const second = queue.run("chat-b", async () => {
    order.push("switch-b");
    order.push("confirm-b");
  });

  assert.equal(duplicate, first);
  await Promise.resolve();
  assert.deepEqual(order, ["switch-a"]);
  confirmation.resolve();
  await Promise.all([first, second]);
  assert.deepEqual(order, ["switch-a", "confirm-a", "switch-b", "confirm-b"]);
});

test("disposing model switch work skips queued picker operations", async () => {
  const queue = new ModelSwitchWorkQueue();
  const gate = deferred();
  const order = [];
  const first = queue.run("chat-a", async () => {
    order.push("switch-a");
    await gate.promise;
  });
  const second = queue.run("chat-b", async () => order.push("switch-b"));

  await Promise.resolve();
  queue.dispose();
  gate.resolve();
  await Promise.all([first, second]);
  await queue.run("chat-c", async () => order.push("switch-c"));
  assert.deepEqual(order, ["switch-a"]);
});

test("disposing model switch work aborts an in-flight confirmation before it can overwrite lost state", async () => {
  const queue = new ModelSwitchWorkQueue();
  const switched = deferred();
  const events = [];
  const running = queue.run("m1", async (signal) => {
    events.push(["switch", "m1"]);
    await switched.promise;
    if (!signal.aborted) events.push(["edit", 99, "success"]);
  });

  await Promise.resolve();
  queue.dispose();
  events.push(["edit", 99, "lost"], ["close", "m1", "disposed"]);
  switched.resolve();
  await running;
  assert.deepEqual(events, [
    ["switch", "m1"],
    ["edit", 99, "lost"],
    ["close", "m1", "disposed"],
  ]);
});

test("Prompt Improve rejects stale launch callbacks and keeps cancel while enhancing", () => {
  const picker = initialPromptImproveState();
  assert.deepEqual(resolvePromptImproveAction(picker, "solo"), { kind: "launch", choice: "original-solo" });

  const enhancing = beginPromptEnhance(picker);
  assert.equal(enhancing?.kind, "enhancing");
  assert.deepEqual(resolvePromptImproveAction(enhancing, "improved-solo"), { kind: "invalid" });
  assert.deepEqual(resolvePromptImproveAction(enhancing, "cancel"), { kind: "cancel" });

  const first = completePromptEnhance(enhancing, "first wording");
  assert.equal(first?.kind, "enhanced");
  assert.deepEqual(resolvePromptImproveAction(first, "improved-team"), {
    kind: "launch",
    choice: "improved-team",
    improvedText: "first wording",
  });

  const regenerating = beginPromptEnhance(first);
  assert.equal(regenerating?.kind, "enhancing");
  assert.deepEqual(resolvePromptImproveAction(regenerating, "improved-team"), { kind: "invalid" });
  const failed = failPromptEnhance(regenerating);
  assert.equal(failed?.kind, "picker");
  assert.equal(failed?.canImprove, false);
  assert.deepEqual(resolvePromptImproveAction(failed, "improved-team"), { kind: "invalid" });
});

test("Prompt Improve binds callbacks to owner, chat, and picker message", () => {
  const binding = { ownerUserId: 7, chatId: 41, messageId: 99 };
  assert.equal(matchesPickerCallback(binding, { userId: 7, chatId: 41, messageId: 99 }), true);
  assert.equal(matchesPickerCallback(binding, { userId: 8, chatId: 41, messageId: 99 }), false);
  assert.equal(matchesPickerCallback(binding, { userId: 7, chatId: 42, messageId: 99 }), false);
  assert.equal(matchesPickerCallback(binding, { userId: 7, chatId: 41, messageId: 100 }), false);
});

test("Prompt Improve controller invalidates old matrix wording across regeneration and failure", () => {
  const controller = new PromptImproveController();
  assert.deepEqual(controller.resolve("solo"), { kind: "launch", choice: "original-solo" });
  assert.equal(controller.beginEnhance(), true);
  assert.deepEqual(controller.resolve("improved-team"), { kind: "invalid" });
  assert.equal(controller.complete("first wording"), true);
  assert.deepEqual(controller.resolve("improved-team"), {
    kind: "launch",
    choice: "improved-team",
    improvedText: "first wording",
  });
  assert.equal(controller.beginEnhance(), true);
  assert.deepEqual(controller.resolve("improved-team"), { kind: "invalid" });
  assert.equal(controller.fail(), true);
  assert.deepEqual(controller.resolve("improved-team"), { kind: "invalid" });
  assert.deepEqual(controller.resolve("team"), { kind: "launch", choice: "original-team" });
});

test("enhance typing pulse stops immediately when a pending flow is cancelled", () => {
  const timers = fakeTimers();
  const sent = [];
  const pulse = new TypingPulse(
    () => sent.push("typing"),
    timers.schedule,
    timers.cancel,
  );
  pulse.start();
  assert.deepEqual(sent, ["typing"]);
  assert.equal(timers.size(), 1);
  pulse.stop();
  assert.equal(timers.size(), 0);
  timers.fireAll();
  assert.deepEqual(sent, ["typing"]);
});

test("cancelling while the enhancing edit is pending skips typing and the canonical call", async () => {
  const edit = deferred();
  let active = true;
  const calls = [];
  const running = runPromptEnhancement({
    showEnhancing: () => edit.promise,
    isActive: () => active,
    typing: {
      start: () => calls.push("typing-start"),
      stop: () => calls.push("typing-stop"),
    },
    enhance: async () => {
      calls.push("enhance");
      return "improved";
    },
  });

  active = false;
  edit.resolve();
  assert.deepEqual(await running, { status: "cancelled" });
  assert.deepEqual(calls, []);
});

test("cancelling an in-flight enhancement stops typing and discards its result", async () => {
  const enhance = deferred();
  let active = true;
  const calls = [];
  const running = runPromptEnhancement({
    showEnhancing: async () => calls.push("edit"),
    isActive: () => active,
    typing: {
      start: () => calls.push("typing-start"),
      stop: () => calls.push("typing-stop"),
    },
    enhance: async () => {
      calls.push("enhance");
      return enhance.promise;
    },
  });

  await Promise.resolve();
  active = false;
  enhance.resolve("stale wording");
  assert.deepEqual(await running, { status: "cancelled" });
  assert.deepEqual(calls, ["edit", "typing-start", "enhance", "typing-stop"]);
});

test("canonical model operations are FIFO for immediate and idle-drained requests", async () => {
  const coordinator = new ModelSwitchCoordinator();
  const firstGate = deferred();
  const order = [];
  const a = coordinator.create("a/model", "tg:a");
  const b = coordinator.create("b/model", "tg:b");

  const first = coordinator.run(a, async () => {
    order.push("start-a");
    await firstGate.promise;
    order.push("end-a");
    return { ok: true };
  });
  const firstObserved = first.then((result) => {
    order.push("confirm-a");
    return result;
  });
  const second = coordinator.run(b, async () => {
    order.push("start-b");
    order.push("end-b");
    return { ok: true };
  });
  firstGate.resolve();
  await Promise.all([firstObserved, second]);
  assert.deepEqual(order, ["start-a", "end-a", "confirm-a", "start-b", "end-b"]);

  const c = coordinator.create("c/model", "tg:c");
  const d = coordinator.create("d/model", "tg:d");
  coordinator.waitForIdle(c);
  coordinator.waitForIdle(d);
  assert.deepEqual(coordinator.takeIdle().map((request) => request.id), [c.id, d.id]);
  assert.equal(coordinator.firstIdle(), null);
  assert.equal(coordinator.firstPending(), null);
});

test("model picker lifecycle expires browse, closes replacement, and preserves queued correlation", () => {
  const timers = fakeTimers();
  const closed = [];
  const lifecycle = new ModelPickerLifecycle({
    schedule: timers.schedule,
    cancel: timers.cancel,
    onClose: (id, reason) => closed.push([id, reason]),
  });

  assert.deepEqual(lifecycle.open("m1", "bot:chat"), { ok: true, replacedId: null });
  lifecycle.browse("m1", 60_000);
  assert.equal(timers.size(), 1);
  assert.deepEqual(lifecycle.open("m2", "bot:chat"), { ok: true, replacedId: "m1" });
  assert.deepEqual(closed, [["m1", "replaced"]]);

  lifecycle.browse("m2", 60_000);
  timers.fireAll();
  assert.deepEqual(closed.at(-1), ["m2", "expired"]);

  assert.deepEqual(lifecycle.open("m3", "bot:chat"), { ok: true, replacedId: null });
  lifecycle.setPhase("m3", "queued");
  assert.deepEqual(lifecycle.open("m4", "bot:chat"), { ok: false, activeId: "m3" });
  assert.equal(lifecycle.getPhase("m3"), "queued");
  lifecycle.close("m3", "cancelled");
  assert.deepEqual(closed.at(-1), ["m3", "cancelled"]);

  assert.deepEqual(lifecycle.open("m5", "bot:chat"), { ok: true, replacedId: null });
  lifecycle.browse("m5", 60_000);
  lifecycle.dispose();
  assert.deepEqual(closed.at(-1), ["m5", "disposed"]);
  assert.equal(timers.size(), 0);
});

test("picker transport sends once with the group reply id and edits only the bound message", async () => {
  const calls = [];
  const picker = new PickerMessageController(41, 7, {
    send: async (text, keyboard, replyToMessageId) => {
      calls.push(["send", text, keyboard, replyToMessageId]);
      return 99;
    },
    edit: async (messageId, text, keyboard) => {
      calls.push(["edit", messageId, text, keyboard]);
      return true;
    },
  });

  assert.equal(await picker.send("pick", "buttons"), 99);
  assert.equal(await picker.send("duplicate", "ignored"), 99);
  assert.equal(await picker.edit("enhancing", "cancel"), true);
  assert.equal(await picker.edit("improved", "matrix"), true);
  assert.equal(picker.matches(41, 99), true);
  assert.equal(picker.matches(42, 99), false);
  assert.deepEqual(calls, [
    ["send", "pick", "buttons", 7],
    ["edit", 99, "enhancing", "cancel"],
    ["edit", 99, "improved", "matrix"],
  ]);
});

test("concurrent picker send attempts share one transport request", async () => {
  const gate = deferred();
  let sends = 0;
  const picker = new PickerMessageController(41, 7, {
    send: async () => {
      sends++;
      await gate.promise;
      return 99;
    },
    edit: async () => true,
  });
  const first = picker.send("pick");
  const second = picker.send("duplicate");
  assert.equal(sends, 1);
  gate.resolve();
  assert.deepEqual(await Promise.all([first, second]), [99, 99]);
  assert.equal(sends, 1);
});

test("activation transaction rolls back changed live state and degrades on rollback failure", async () => {
  const steps = [];
  const restored = await runModelActivationTransaction({
    activate: async () => ({ ok: false, error: "verification timed out", liveMayHaveChanged: true }),
    rollback: async () => {
      steps.push("rollback");
      return { ok: true };
    },
    commit: () => steps.push("commit"),
    degrade: () => steps.push("degrade"),
  });
  assert.deepEqual(restored, { ok: false, error: "verification timed out", degraded: false });
  assert.deepEqual(steps, ["rollback"]);

  const degraded = await runModelActivationTransaction({
    activate: async () => ({ ok: false, error: "target restart failed", liveMayHaveChanged: true }),
    rollback: async () => ({ ok: false, error: "prior restart failed" }),
    commit: () => assert.fail("failure committed"),
    degrade: (detail) => steps.push(detail),
  });
  assert.equal(degraded.ok, false);
  assert.equal(degraded.degraded, true);
  assert.match(degraded.error, /rollback failed/i);
});
