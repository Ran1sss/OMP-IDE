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
  paired: (bot: string) => string;
  alreadyPaired: string;
  unknownCommand: string;
  help: string;
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
};

export function tg(lang: TgLang): TgStrings {
  return lang === "ru" ? RU : EN;
}
