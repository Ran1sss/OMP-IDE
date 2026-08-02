/**
 * Telegram-side fixed strings, localized PER RECIPIENT (remote-fix 4):
 * the paired user's Telegram `language_code` decides (ru → Russian,
 * anything else → English). Agent-generated content is never translated —
 * the dialogue already answers in the asker's language.
 */

export type TgLang = "ru" | "en";

export function tgLangFor(languageCode: string | undefined): TgLang {
  return languageCode?.toLowerCase().startsWith("ru") ? "ru" : "en";
}

export interface TelegramCommand {
  command: string;
  description: string;
}

const COMMAND_NAMES = ["solo", "team", "status", "stop", "todo", "new", "diff", "files", "who", "think", "help"] as const;
export function telegramCommands(lang: TgLang): TelegramCommand[] {
  const descriptions: Record<(typeof COMMAND_NAMES)[number], [ru: string, en: string]> = {
    solo: ["Запустить задачу одним агентом", "Run a task with one agent"],
    team: ["Запустить задачу через команду", "Run a task through Team routing"],
    status: ["Статус агента или команды", "Agent or Team status"],
    stop: ["Остановить текущую задачу или команду", "Stop the current task or Team run"],
    todo: ["Живой список задач", "Live todo list"],
    new: ["Начать новую сессию агента", "Start a fresh agent session"],
    diff: ["Изменения файлов за сессию", "Diffstat for touched files"],
    files: ["Файлы, изменённые агентом", "Files touched by the agent"],
    who: ["Подключённые пользователи", "Connected remote users"],
    think: ["Показать или задать уровень размышлений", "Show or set the thinking level"],
    help: ["Справка по командам", "Command reference"],
  };
  const index = lang === "ru" ? 0 : 1;
  return COMMAND_NAMES.map((command) => ({ command, description: descriptions[command][index] }));
}

interface TgStrings {
  doIt: string;
  skip: string;
  onIt: string;
  agentNotRunning: string;
  approvedBy: (by: string) => string;
  skippedBy: (by: string) => string;
  approve: string;
  openInIde: string;
  yes: string;
  no: string;
  restartSession: string;
  files: (n: number) => string;
  minutes: (n: number) => string;
  passed: (n: number) => string;
  teamLabel: string;
  teamPhase: (phase: string) => string;
  teamState: (state: string) => string;
  taskDoneFallback: string;
  agentError: string;
  freeTextReply: string;
  soloUsage: string;
  teamStopped: string;
  teamAlreadyActive: string;
  teamStartFailed: string;
  taskStopped: string;
  modePicker: string;
  soloStarted: string;
  pickerCancelled: string;
  lostPendingTask: string;
  pickerExpired: string;
  pickerNotYours: string;
  pickerSolo: string;
  pickerTeam: string;
  /** shown once per group when privacy mode hides plain messages */
  privacyModeHint: string;
  teamUsage: string;
  nothingToStop: string;
  paired: (bot: string) => string;
  alreadyPaired: string;
  unknownCommand: string;
  help: string;
  /** Chat Dialogue: paired-DM nudge for noise/greetings */
  dialogNudge: string;
  /** Chat Dialogue: honest one-liner when the answer oneshot fails */
  dialogFailed: string;
  /** group privacy: rotated playful redirects — WITH a designated owner to point at */
  dialogRedirectsOwner: ((mention: string) => string)[];
  /** ownerless fallback redirects (no dead-end mystery text) */
  dialogRedirects: string[];
  /** stock small-talk line when the no-leak guard rejects twice */
  dialogStock: string;
  /** «кто твой владелец?» — deterministic answers from the owner set */
  ownerAnswerOne: (name: string, username: string) => string;
  ownerAnswerMany: (list: string) => string;
  ownerAnswerNone: string;
  /** list separator for ownerAnswerMany */
  ownerListAnd: string;
}

const RU: TgStrings = {
  doIt: "Сделать",
  skip: "Скип",
  onIt: "✓ взял в работу",
  agentNotRunning: "Агент в OMP IDE не запущен — задача не стартовала.",
  approvedBy: (by) => `✓ одобрено: ${by}`,
  skippedBy: (by) => `· пропущено: ${by}`,
  approve: "Одобрить",
  openInIde: "Открыть в IDE",
  yes: "Да",
  no: "Нет",
  restartSession: "Перезапустить сессию",
  files: (n) => `${n} ${n === 1 ? "файл" : n > 1 && n < 5 ? "файла" : "файлов"}`,
  minutes: (n) => `${n}м`,
  passed: (n) => `${n} ${n % 10 === 1 && n % 100 !== 11 ? "тест" : n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14) ? "теста" : "тестов"}`,
  teamLabel: "команда",
  teamPhase: (phase) => ({ route: "маршрутизация", gate: "ожидание запуска", execute: "выполнение", verify: "проверка" })[phase] ?? phase,
  teamState: (state) => ({ pending: "в очереди", active: "работает", done: "готово", failed: "ошибка", replanned: "перепланировано" })[state] ?? state,
  taskDoneFallback: "Задача завершена.",
  agentError: "Задача остановилась: агент завершился с ошибкой.",
  freeTextReply: "Ответьте обычным сообщением.",
  soloUsage: "Использование: /solo <задача>",
  teamStopped: "Команда остановлена.",
  teamAlreadyActive: "Команда уже выполняется — сначала используйте /stop.",
  teamStartFailed: "Не удалось запустить команду.",
  taskStopped: "Задача остановлена.",
  nothingToStop: "Сейчас ничего не выполняется.",
  modePicker: "Задачу принял. Как выполнить? (через минуту запущу соло)",
  soloStarted: "⚡ Взял соло",
  pickerCancelled: "Отменено",
  lostPendingTask: "IDE закрылся, задача не запущена — пришли заново.",
  pickerExpired: "Выбор больше не активен",
  pickerNotYours: "Это не ваша задача",
  teamUsage: "Использование: /team <задача>",
  pickerSolo: "⚡ Соло",
  pickerTeam: "⚑ Команда",
  privacyModeHint:
    "Здесь у меня приватный режим: обычные сообщения группы до меня не доходят. Пиши через @упоминание, ответом на моё сообщение или командой — либо выключи Group Privacy у @BotFather (или сделай меня админом).",
  paired: (bot) => `Готово. Теперь вы управляете агентом OMP через @${bot}. Отправьте задачу обычным сообщением или /help.`,
  alreadyPaired: "Уже подключены. Отправьте задачу обычным сообщением или /help.",
  unknownCommand: "Неизвестная команда. /help покажет всё.",
  help: [
    "Любое обычное сообщение — задача (или подсказка, пока агент работает; или ответ, когда он спрашивает).",
    "",
    "/solo <задача> — выполнить одним агентом без маршрутизации",
    "/status — состояние агента, прогресс, рабочая область",
    "/team <задача> — выполнить через маршрутизацию команды",
    "/todo — живой список задач",
    "/stop — прервать агента (с подтверждением)",
    "/new — новая сессия агента (с подтверждением)",
    "/diff — диффстат; кнопки возвращают патчи по файлам",
    "/files — файлы, затронутые за сессию",
    "/who — подключённые пользователи",
    "/think — уровень размышлений; /think high задаёт его для сессии",
    "",
    "Пульт работает, только пока OMP IDE запущена на компьютере.",
  ].join("\n"),
  dialogNudge: "Я на связи — спросите о статусе или дайте задачу.",
  dialogFailed: "Не смог собрать ответ (модель недоступна) — попробуйте ещё раз.",
  dialogRedirectsOwner: [
    (m) => `Об этом лучше у ${m} в личке :)`,
    (m) => `Подробности — у ${m} в личке 🙂`,
    (m) => `Это к ${m} — пишите в личку!`,
  ],
  dialogRedirects: [
    "Это не для общего чата :)",
    "Подробности — не для группы 🙂",
    "Про такое я в группе молчу :)",
  ],
  dialogStock: "Всё идёт своим чередом 🙂 Подробности — в личке.",
  ownerAnswerOne: (name, username) => `Мой владелец — ${name} (@${username}), пишите ему в личку!`,
  ownerAnswerMany: (list) => `Мои владельцы — ${list}. По вопросам — им в личку.`,
  ownerAnswerNone: "Владелец пока не настроен — но я на связи :)",
  ownerListAnd: " и ",
};

const EN: TgStrings = {
  doIt: "Do it",
  skip: "Skip",
  onIt: "✓ on it",
  agentNotRunning: "Agent is not running in OMP IDE — task not started.",
  approvedBy: (by) => `✓ approved by ${by}`,
  skippedBy: (by) => `· skipped by ${by}`,
  approve: "Approve",
  openInIde: "Open in IDE",
  yes: "Yes",
  no: "No",
  restartSession: "Restart session",
  files: (n) => `${n} ${n === 1 ? "file" : "files"}`,
  minutes: (n) => `${n}m`,
  passed: (n) => `${n} passed`,
  teamLabel: "team",
  teamPhase: (phase) => ({ route: "routing", gate: "awaiting start", execute: "running", verify: "verifying" })[phase] ?? phase,
  teamState: (state) => ({ pending: "queued", active: "working", done: "done", failed: "failed", replanned: "replanned" })[state] ?? state,
  taskDoneFallback: "Task completed.",
  agentError: "The task stopped because the agent failed.",
  freeTextReply: "Reply with a plain message.",
  soloUsage: "Usage: /solo <task>",
  teamStopped: "Team run stopped.",
  teamAlreadyActive: "A Team run is already active. Use /stop first.",
  teamStartFailed: "Failed to start the Team run.",
  taskStopped: "Task stopped.",
  nothingToStop: "Nothing is running.",
  paired: (bot) => `Paired. You now control the OMP agent through @${bot}. Send a task as a plain message, or /help.`,
  modePicker: "Task accepted. How should I run it? (I’ll start solo in one minute)",
  soloStarted: "⚡ Running solo",
  pickerCancelled: "Cancelled",
  lostPendingTask: "IDE closed, task was not started — send it again.",
  pickerExpired: "That choice is no longer active",
  pickerNotYours: "Not your task",
  teamUsage: "Usage: /team <task>",
  pickerSolo: "⚡ Solo",
  pickerTeam: "⚑ Team",
  alreadyPaired: "Already paired. Send a task as a plain message, or /help.",
  privacyModeHint:
    "Privacy mode is on here, so plain group messages never reach me. Use an @mention, a reply to my message, or a command — or turn Group Privacy off in @BotFather (or make me an admin).",
  unknownCommand: "Unknown command. /help lists everything.",
  help: [
    "Send any plain message — it becomes a task (or steering while the agent runs, or an answer when it asks).",
    "",
    "/solo <task> — run with one agent and bypass routing",
    "/status — agent state, todo progress, workspace",
    "/todo — live todo list",
    "/team <task> — run through Team routing",
    "/stop — interrupt the current task or Team run",
    "/new — fresh agent session (confirm)",
    "/diff — diffstat; buttons return per-file patches",
    "/files — files touched this session",
    "/who — connected remote users",
    "/think — show thinking level; /think high sets it for this session",
    "",
    "Remote works only while OMP IDE runs on the desktop.",
  ].join("\n"),
  dialogNudge: "I'm here — ask about the status or send a task.",
  dialogFailed: "Couldn't compose an answer (model unavailable) — try again.",
  dialogRedirectsOwner: [
    (m) => `Better ask ${m} in DM :)`,
    (m) => `Details live in ${m}'s DM 🙂`,
    (m) => `That's one for ${m} — drop them a DM!`,
  ],
  dialogRedirects: [
    "That's not for the group chat :)",
    "Details aren't for the group 🙂",
    "I keep that out of group chats :)",
  ],
  dialogStock: "All going smoothly 🙂 Details in DM.",
  ownerAnswerOne: (name, username) => `My owner is ${name} (@${username}) — DM them!`,
  ownerAnswerMany: (list) => `My owners are ${list}. Questions go to their DMs.`,
  ownerAnswerNone: "No owner designated yet — but I'm around :)",
  ownerListAnd: " and ",
};

export function tg(lang: TgLang): TgStrings {
  return lang === "ru" ? RU : EN;
}
