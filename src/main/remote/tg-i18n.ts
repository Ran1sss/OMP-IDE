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
  paired: (bot) => `Готово. Теперь вы управляете агентом OMP через @${bot}. Отправьте задачу обычным сообщением или /help.`,
  alreadyPaired: "Уже подключены. Отправьте задачу обычным сообщением или /help.",
  unknownCommand: "Неизвестная команда. /help покажет всё.",
  help: [
    "Любое обычное сообщение — задача (или подсказка, пока агент работает; или ответ, когда он спрашивает).",
    "",
    "/status — состояние агента, прогресс, рабочая область",
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
  paired: (bot) => `Paired. You now control the OMP agent through @${bot}. Send a task as a plain message, or /help.`,
  alreadyPaired: "Already paired. Send a task as a plain message, or /help.",
  unknownCommand: "Unknown command. /help lists everything.",
  help: [
    "Send any plain message — it becomes a task (or steering while the agent runs, or an answer when it asks).",
    "",
    "/status — agent state, todo progress, workspace",
    "/todo — live todo list",
    "/stop — interrupt the agent (confirm)",
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
