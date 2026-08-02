import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyTaskIntake,
  extractRosterMentions,
  parseModeCommand,
  parseSoloTask,
  renderTelegramStartNotice,
  renderTelegramTeamStatus,
  stripLeadingMentionsForIntent,
} from "../src/shared/team-remote.ts";
import { isTaskImperative } from "../src/shared/task-intent.ts";
import { telegramCommands, tg } from "../src/main/remote/tg-i18n.ts";

const roster = [
  { id: "coder", desc: "writes code" },
  { id: "tester", desc: "runs tests" },
  { id: "reviewer", desc: "reviews" },
];

test("Telegram role mentions match only the Team roster", () => {
  assert.deepEqual(
    extractRosterMentions("@tester проверь edge-кейсы @nonexistent @Tester", roster),
    ["tester"],
  );
  assert.deepEqual(extractRosterMentions("fix @nonexistent token", roster), []);
});

test("leading Telegram mentions do not hide the task intent", () => {
  assert.equal(stripLeadingMentionsForIntent("@tester проверь edge-кейсы"), "проверь edge-кейсы");
  assert.equal(stripLeadingMentionsForIntent("@nonexistent поправь README"), "поправь README");
  assert.equal(stripLeadingMentionsForIntent("поправь @nonexistent token"), "поправь @nonexistent token");
});

test("tester verification wording is classified as a task after mention stripping", () => {
  const normalized = stripLeadingMentionsForIntent("@tester проверь только edge-кейсы auth");
  assert.equal(isTaskImperative(normalized), true);
});

test("solo command extracts a task and rejects an empty task", () => {
  assert.deepEqual(parseSoloTask("/solo напиши hello.txt"), { ok: true, task: "напиши hello.txt" });
  assert.deepEqual(parseSoloTask("/solo@my_bot   hello"), { ok: true, task: "hello" });
  assert.deepEqual(parseSoloTask("/solo"), { ok: false });
  assert.deepEqual(parseSoloTask("/solo   "), { ok: false });
});

test("team command extracts a task and rejects an empty task", () => {
  assert.deepEqual(parseModeCommand("/team поправь README", "team"), { ok: true, task: "поправь README" });
  assert.deepEqual(parseModeCommand("/team@my_bot   hello", "team"), { ok: true, task: "hello" });
  assert.deepEqual(parseModeCommand("/team", "team"), { ok: false });
});

test("start notice is built from the real routed composition", () => {
  const multi = renderTelegramStartNotice([
    { id: "A", worker: "coder", title: "UI и запросы к API", deps: [] },
    { id: "B", worker: "tester", title: "тесты", deps: ["A"] },
    { id: "C", worker: "reviewer", title: "ревью", deps: ["A", "B"] },
  ], "ru");
  assert.equal(multi, "⚑ Команда приступила к работе: coder — UI и запросы к API · tester — тесты (после coder) · reviewer — ревью (последним)");
  assert.equal(
    renderTelegramStartNotice([{ id: "A", worker: "coder", title: "опечатка", deps: [] }], "ru"),
    "⚑ Команда: только coder — опечатка",
  );
});

test("Team status mirrors dispatch rows with role dependency notes", () => {
  const text = renderTelegramTeamStatus(
    {
      phase: "execute",
      slices: [
        { id: "A", title: "Код", worker: "coder", deps: [], state: "done" },
        { id: "B", title: "Тесты", worker: "tester", deps: ["A"], state: "active" },
        { id: "C", title: "Ревью", worker: "reviewer", deps: ["A", "B"], state: "pending" },
      ],
    },
    "ru",
  );
  assert.equal(
    text,
    [
      "агент · задача · статус",
      "coder · Код · готово",
      "tester · Тесты · работает… · после coder",
      "reviewer · Ревью · в очереди · последним",
    ].join("\n"),
  );
});

test("Telegram command menu exposes solo, status and stop in RU and EN", () => {
  const ru = telegramCommands("ru");
  const en = telegramCommands("en");
  for (const name of ["solo", "status", "stop"]) {
    assert.ok(ru.some((c) => c.command === name));
    assert.ok(en.some((c) => c.command === name));
  }
  assert.equal(ru.find((c) => c.command === "solo")?.description, "Запустить задачу одним агентом");
  assert.equal(ru.find((c) => c.command === "status")?.description, "Статус агента или команды");
  assert.equal(ru.find((c) => c.command === "stop")?.description, "Остановить текущую задачу или команду");
  assert.equal(en.find((c) => c.command === "solo")?.description, "Run a task with one agent");
});

test("Telegram command menu exposes direct team mode", () => {
  assert.equal(telegramCommands("ru").find((c) => c.command === "team")?.description, "Запустить задачу через команду");
  assert.equal(telegramCommands("en").find((c) => c.command === "team")?.description, "Run a task through Team routing");
});

test("Telegram Team command errors are localized", () => {
  assert.equal(tg("ru").teamAlreadyActive, "Команда уже выполняется — сначала используйте /stop.");
  assert.equal(tg("en").teamAlreadyActive, "A Team run is already active. Use /stop first.");
  assert.equal(tg("ru").teamStartFailed, "Не удалось запустить команду.");
  assert.equal(tg("en").teamStartFailed, "Failed to start the Team run.");
});

test("picker lifecycle strings are localized", () => {
  assert.equal(tg("ru").modePicker, "Задачу принял. Как выполнить? (через минуту запущу соло)");
  assert.equal(tg("ru").soloStarted, "⚡ Взял соло");
  assert.equal(tg("ru").pickerCancelled, "Отменено");
  assert.equal(tg("en").lostPendingTask, "IDE closed, task was not started — send it again.");
});

test("plain Telegram tasks reach the Solo/Team picker", () => {
  assert.deepEqual(
    classifyTaskIntake({ text: "почини сборку", roster, teamRunActive: false, agentState: "idle" }),
    { kind: "picker" },
  );
});

test("roster mentions skip the picker and start Team directly", () => {
  assert.deepEqual(
    classifyTaskIntake({ text: "@tester прогони тесты", roster, teamRunActive: false, agentState: "idle" }),
    { kind: "team", mentions: ["tester"] },
  );
});

test("a busy agent or live Team run steers instead of opening a picker", () => {
  assert.deepEqual(
    classifyTaskIntake({ text: "@tester ещё раз", roster, teamRunActive: true, agentState: "idle" }),
    { kind: "steer" },
  );
  assert.deepEqual(
    classifyTaskIntake({ text: "почини сборку", roster, teamRunActive: false, agentState: "tool" }),
    { kind: "steer" },
  );
});
