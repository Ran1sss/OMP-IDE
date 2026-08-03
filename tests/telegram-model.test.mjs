import assert from "node:assert/strict";
import test from "node:test";
import { telegramCommands, telegramModelSwitchActivityDetail, tg } from "../src/main/remote/tg-i18n.ts";
import {
  buildModelCatalog,
  buildQuickModels,
  filterModelPairs,
  activateThenCommitModelRole,
  isModelSwitchBusy,
  paginateModelMatches,
  paginateProfileModels,
  recordModelRecent,
} from "../src/shared/model-selection.ts";

const state = {
  active: { provider: "echogate", id: "claude-fable-5", name: "Claude Fable 5" },
  providers: [
    {
      id: "echogate",
      enabled: true,
      health: "ok",
      models: [
        { id: "claude-fable-5", favorite: true },
        { id: "claude-opus-5", favorite: false },
        { id: "kimi-k3", favorite: true },
        ...Array.from({ length: 10 }, (_, i) => ({ id: `echo-${i}`, favorite: false })),
      ],
    },
    {
      id: "claude",
      enabled: true,
      health: "ok",
      models: [
        { id: "claude-opus-5", favorite: false },
        { id: "claude-haiku-5", favorite: false },
      ],
    },
    { id: "disabled", enabled: false, health: "ok", models: [{ id: "hidden", favorite: true }] },
  ],
};

test("quick screen keeps pinned pairs first then unique recents with profile suffixes", () => {
  const catalog = buildModelCatalog(state);
  const quick = buildQuickModels(catalog, ["claude/claude-opus-5", "echogate/claude-fable-5"], 5);

  assert.deepEqual(quick.map((m) => m.selector), [
    "echogate/claude-fable-5",
    "echogate/kimi-k3",
    "claude/claude-opus-5",
    "echogate/claude-opus-5",
    "echogate/echo-0",
  ]);
  assert.equal(quick[0].label, "★ claude-fable-5 · echogate");
  assert.equal(quick[2].label, "claude-opus-5 · claude");
  assert.equal(catalog.some((m) => m.profile === "disabled"), false);
});

test("fuzzy matching treats duplicate model ids in different profiles as distinct pairs", () => {
  const catalog = buildModelCatalog(state);
  assert.deepEqual(filterModelPairs(catalog, "fable").map((m) => m.selector), ["echogate/claude-fable-5"]);
  assert.deepEqual(filterModelPairs(catalog, "opus").map((m) => m.selector), [
    "echogate/claude-opus-5",
    "claude/claude-opus-5",
  ]);
  assert.deepEqual(filterModelPairs(catalog, "zzz"), []);
});

test("profile catalogs paginate above ten rows and preserve pair identity", () => {
  const catalog = buildModelCatalog(state);
  const page = paginateProfileModels(catalog, "echogate", 0, 8);
  assert.equal(page.items.length, 8);
  assert.equal(page.pages, 2);
  assert.equal(page.items.every((m) => m.profile === "echogate"), true);
});

test("profiles with at most ten models stay on one page", () => {
  const catalog = buildModelCatalog({
    active: null,
    providers: [{ ...state.providers[0], models: state.providers[0].models.slice(0, 10) }],
  });
  const page = paginateProfileModels(catalog, "echogate", 0, 8);
  assert.equal(page.items.length, 10);
  assert.equal(page.pages, 1);
});

test("broad model searches stay paginated", () => {
  const catalog = buildModelCatalog(state);
  const matches = Array.from({ length: 19 }, (_, index) => ({
    ...catalog[0],
    selector: `profile/model-${index}`,
    modelId: `model-${index}`,
  }));
  const page = paginateModelMatches(matches, 0, 8);
  assert.equal(page.items.length, 8);
  assert.equal(page.pages, 3);
});

test("model switches wait for either an agent turn or a Team run", () => {
  assert.equal(isModelSwitchBusy("idle", false), false);
  assert.equal(isModelSwitchBusy("thinking", false), true);
  assert.equal(isModelSwitchBusy("tool", false), true);
  assert.equal(isModelSwitchBusy("awaiting-input", false), true);
  assert.equal(isModelSwitchBusy("idle", true), true);
});

test("canonical model use moves the qualified pair to the recents front", () => {
  assert.deepEqual(recordModelRecent(["a/one", "b/two", "a/one"], "c/three", 3), [
    "c/three",
    "a/one",
    "b/two",
  ]);
  assert.deepEqual(recordModelRecent(["a/one", "b/two"], "b/two", 3), ["b/two", "a/one"]);
  assert.deepEqual(recordModelRecent(["a/one", "b/two", "a/one"], "c/three"), [
    "c/three",
    "a/one",
    "b/two",
  ]);
});

test("failed activation leaves the default role uncommitted", async () => {
  const failedSteps = [];
  const failure = await activateThenCommitModelRole(
    async () => {
      failedSteps.push("activate");
      return { ok: false, error: "agent process is not running" };
    },
    () => failedSteps.push("commit"),
  );
  assert.deepEqual(failure, { ok: false, error: "agent process is not running" });
  assert.deepEqual(failedSteps, ["activate"]);

  const successfulSteps = [];
  const success = await activateThenCommitModelRole(
    async () => {
      successfulSteps.push("activate");
      return { ok: true };
    },
    () => successfulSteps.push("commit"),
  );
  assert.deepEqual(success, { ok: true });
  assert.deepEqual(successfulSteps, ["activate", "commit"]);
});

test("Telegram model-switch activity names its visible provenance", () => {
  assert.equal(
    telegramModelSwitchActivityDetail("echogate/claude-fable-5"),
    "model switched via Telegram → echogate/claude-fable-5",
  );
});

test("Telegram model command and switch copy are localized", () => {
  assert.equal(telegramCommands("ru").find((c) => c.command === "model")?.description, "Выбрать модель и профиль");
  assert.equal(telegramCommands("en").find((c) => c.command === "model")?.description, "Choose model and profile");
  assert.match(tg("ru").modelNotFound("zzz"), /zzz/);
  assert.match(tg("en").modelSwitchFailed("offline"), /offline/);
  assert.equal(tg("ru").modelInterrupt, "Прервать и переключить");
  assert.equal(tg("en").modelQueue, "Queue");
});

test("Telegram model presentation copy includes active state, guidance, and model-profile order", () => {
  assert.equal(tg("ru").modelAlreadyActive("gpt-5", "echo"), "Уже активна: gpt-5 (echo)");
  assert.equal(tg("en").modelAlreadyActive("gpt-5", "echo"), "Already active: gpt-5 (echo)");
  assert.equal(tg("ru").modelProfileRow("echo", 2, true), "echo · 2 модели · активен");
  assert.equal(tg("en").modelProfileRow("echo", 2, false), "echo · 2 models");
  assert.equal(tg("ru").modelStatus("gpt-5", "echo"), "модель: gpt-5 (echo)");
  assert.equal(tg("en").modelStatus("gpt-5", "echo"), "model: gpt-5 (echo)");
  assert.equal(tg("ru").modelSwitched("gpt-5", "echo"), "✓ Модель: gpt-5 (echo)");
  assert.equal(tg("en").modelSwitched("gpt-5", "echo"), "✓ Model: gpt-5 (echo)");
  assert.match(tg("ru").modelNotFound("zzz"), /\/model/);
  assert.match(tg("en").modelNotFound("zzz"), /\/model/);
});
