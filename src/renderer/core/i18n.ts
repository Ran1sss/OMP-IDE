/**
 * UI language (Remote-panel fix spec, Fix 4): ONE string table, two locales.
 * Every fixed chrome/panel string added or touched by the fix prompts goes
 * through t(). Agent-generated content is never translated.
 *
 * The setting is global (Settings.uiLang): "auto" resolves from the OS
 * locale (ru → Russian, else English). Switching re-renders live via the
 * "lang-changed" bus event — subscribers re-apply their fixed strings.
 */

import { emit } from "./bus";

export type UiLang = "ru" | "en";

const RU = {
  // ---- chrome
  "view.explorer": "Проводник",
  "view.search": "Поиск",
  "view.outline": "Структура",
  "view.git": "Контроль версий",
  "view.remote": "Пульт управления",
  "chrome.settings": "Настройки",
  "chrome.collapseFolders": "Свернуть папки",
  "chrome.refresh": "Обновить",
  "chrome.minimize": "Свернуть",
  "chrome.maximize": "Развернуть",
  "chrome.close": "Закрыть",
  "chrome.sourceControl": "Контроль версий",
  "chrome.agentStatus": "Статус агента",
  "chrome.goToLine": "Перейти к строке",
  "chrome.panelResize": "Перетащите, чтобы изменить ширину · двойной клик — сброс (360px)",
  // ---- search panel
  "search.placeholder": "Поиск",
  "search.replace": "Заменить",
  "search.replaceAll": "Заменить все",
  "search.regex": "Регулярное выражение",
  "search.matchCase": "Учитывать регистр",
  "search.noResults": "Ничего не найдено",
  "search.hint": "Введите запрос для поиска по рабочей области",
  // ---- git panel (main labels)
  "git.commit": "Коммит",
  // ---- remote control: global rows
  "rc.remoteControl": "Удалённое управление",
  "rc.worksOnly": "Работает, только пока OMP IDE запущена на этой машине.",
  "rc.master": "Мастер-тумблер: все боты",
  "rc.digestLbl": "дайджест",
  "rc.secSuffix": "с",
  "rc.digestTitle": "Интервал дайджеста, секунды",
  "rc.cooldownLbl": "пауза",
  "rc.minSuffix": "м",
  "rc.cooldownTitle": "Пауза listener'а после запроса, минуты",
  "rc.proxy": "прокси",
  "rc.apply": "Применить",
  "rc.proxyTest": "Тест",
  "rc.proxyTestTitle": "Проверить api.telegram.org через этот прокси, не применяя его",
  "rc.proxyPlaceholder": "socks5://127.0.0.1:1080  (прокси для Telegram, пусто = напрямую)",
  "rc.activity": "Активность",
  "rc.noActivity": "Пока пусто — события появятся здесь",
  "rc.blocked": "блок",
  // ---- add bot
  "rc.addBot": "Добавить бота",
  "rc.addBotNote": "Создайте бота у @BotFather в Telegram и вставьте его токен. Токен хранится в зашифрованном виде (ключница ОС); каждый пользователь приносит своего бота.",
  "rc.tokenPlaceholder": "123456789:AA…  (токен бота)",
  "rc.add": "Добавить",
  "rc.checking": "Проверка…",
  "rc.registerTitle": "Регистрация бота",
  "rc.registerMsg": (name: string, user: string) => `Зарегистрировать «${name}» (@${user})? Токен будет храниться в зашифрованном виде.`,
  "rc.register": "Зарегистрировать",
  "rc.registered": (user: string) => `Бот @${user} добавлен — включите его и подключите пользователя`,
  // ---- bot card
  "rc.pairUser": "Подключить…",
  "rc.requests": "Запросы",
  "rc.delete": "Удалить",
  "rc.deleteTitle": "Удалить бота",
  "rc.deleteMsg": (user: string) => `Убрать @${user}? Токен будет стёрт из хранилища, команды бота в Telegram очищены.`,
  "rc.state": "статус",
  "rc.msgs": "сообщ.",
  "rc.last": "посл.",
  "rc.enableBot": "Включить бота",
  "rc.disableBot": "Выключить бота (остановит поллинг)",
  "rc.revokeTitle": "Отозвать доступ",
  "rc.revokeMsg": (u: string, b: string) => `Убрать @${u} у @${b}? После этого его сообщения молча игнорируются.`,
  "rc.revoke": "Отозвать",
  "rc.revokeUser": (u: string) => `Отозвать @${u}`,
  // ---- group chats / listener
  "rc.groupChats": "Групповые чаты",
  "rc.approver": "одобряет",
  "rc.listener": "listener",
  "rc.listenerTip": "Умное слушание: один smol-oneshot на батч сообщений",
  "rc.viewLog": "Журнал",
  "rc.copyLogPath": "Клик — скопировать полный путь",
  "rc.logPathCopied": "Путь к журналу скопирован",
  "rc.cooling": (m: number) => `пауза · ${m}м`,
  "rc.watchOn": "Наблюдать чат (включает журнал)",
  "rc.watchOff": "Перестать наблюдать (журнал сохраняется)",
  "rc.botLeft": "Бот покинул чат",
  "rc.leftTag": "покинул чат",
  // ---- requests (proposals)
  "rc.noRequests": "Нет ожидающих запросов",
  "rc.accept": "Принять",
  "rc.skip": "Скип",
  "rc.expired": "истёк",
  "rc.decidedBy": (by: string) => `решено: ${by}`,
  "rc.alreadyDecided": (by: string) => `Уже решено: ${by}`,
  "rc.noLongerPending": "Запрос уже не активен",
  "rc.noApprover": "нет одобряющего — подключите пользователя",
  "rc.proposals": "Запросы",
  // ---- pairing dialog
  "rc.pairWith": (bot: string) => `Подключение пользователя к @${bot}`,
  "rc.pairHintPrefix": "Отправьте ",
  "rc.pairHintSuffix": (bot: string, time: string) => ` боту @${bot} — истечёт через ${time}`,
  "rc.clickCopy": "Клик — скопировать",
  "rc.codeCopied": "Код скопирован",
  "rc.cmdCopied": "Команда скопирована",
  "rc.linkCopied": "Ссылка скопирована",
  "rc.copyLink": "Скопировать ссылку",
  "rc.dlgClose": "Закрыть",
  // ---- language picker
  "rc.language": "Язык",
  "set.language": "Язык интерфейса",
  "set.langAuto": "Как в системе",
} as const;

type Entries = typeof RU;
export type StrKey = keyof Entries;
/** widen literal strings so the EN table can hold its own text */
type StrTable = { [K in StrKey]: Entries[K] extends string ? string : Entries[K] };

const EN: StrTable = {
  "view.explorer": "Explorer",
  "view.search": "Search",
  "view.outline": "Outline",
  "view.git": "Source Control",
  "view.remote": "Remote Control",
  "chrome.settings": "Settings",
  "chrome.collapseFolders": "Collapse folders",
  "chrome.refresh": "Refresh",
  "chrome.minimize": "Minimize",
  "chrome.maximize": "Maximize",
  "chrome.close": "Close",
  "chrome.sourceControl": "Source control",
  "chrome.agentStatus": "Agent status",
  "chrome.goToLine": "Go to line",
  "chrome.panelResize": "Drag to resize · double-click resets (360px)",
  "search.placeholder": "Search",
  "search.replace": "Replace",
  "search.replaceAll": "Replace All",
  "search.regex": "Use regular expression",
  "search.matchCase": "Match case",
  "search.noResults": "No results",
  "search.hint": "Type to search across the workspace",
  "git.commit": "Commit",
  "rc.remoteControl": "Remote control",
  "rc.worksOnly": "Works only while OMP IDE is running on this machine.",
  "rc.master": "Master toggle: all bots",
  "rc.digestLbl": "digest",
  "rc.secSuffix": "s",
  "rc.digestTitle": "Digest interval, seconds",
  "rc.cooldownLbl": "cooldown",
  "rc.minSuffix": "m",
  "rc.cooldownTitle": "Listener cooldown after a proposal, minutes",
  "rc.proxy": "proxy",
  "rc.apply": "Apply",
  "rc.proxyTest": "Test",
  "rc.proxyTestTitle": "Probe api.telegram.org through this proxy without applying it",
  "rc.proxyPlaceholder": "socks5://127.0.0.1:1080  (proxy for Telegram, empty = direct)",
  "rc.activity": "Activity",
  "rc.noActivity": "Nothing yet — events will appear here",
  "rc.blocked": "blocked",
  "rc.addBot": "Add Bot",
  "rc.addBotNote": "Create a bot with @BotFather in Telegram, then paste its token. The token is stored encrypted (OS keychain); each remote user brings their own bot.",
  "rc.tokenPlaceholder": "123456789:AA…  (bot token)",
  "rc.add": "Add",
  "rc.checking": "Checking…",
  "rc.registerTitle": "Register bot",
  "rc.registerMsg": (name: string, user: string) => `Register "${name}" (@${user})? Its token will be stored encrypted.`,
  "rc.register": "Register",
  "rc.registered": (user: string) => `Registered @${user} — enable it and pair a user`,
  "rc.pairUser": "Pair user…",
  "rc.requests": "Requests",
  "rc.delete": "Delete",
  "rc.deleteTitle": "Delete bot",
  "rc.deleteMsg": (user: string) => `Remove @${user}? Its token is wiped from secure storage and its Telegram commands are cleaned up.`,
  "rc.state": "state",
  "rc.msgs": "msgs",
  "rc.last": "last",
  "rc.enableBot": "Enable bot",
  "rc.disableBot": "Disable bot (stops polling)",
  "rc.revokeTitle": "Revoke access",
  "rc.revokeMsg": (u: string, b: string) => `Remove @${u} from @${b}? They will be silently ignored afterwards.`,
  "rc.revoke": "Revoke",
  "rc.revokeUser": (u: string) => `Revoke @${u}`,
  "rc.groupChats": "Group chats",
  "rc.approver": "approver",
  "rc.listener": "listener",
  "rc.listenerTip": "Smart listening: one smol oneshot per message batch",
  "rc.viewLog": "View log",
  "rc.copyLogPath": "Click to copy the full path",
  "rc.logPathCopied": "Log path copied",
  "rc.cooling": (m: number) => `cooling · ${m}m`,
  "rc.watchOn": "Watch this chat (starts logging)",
  "rc.watchOff": "Stop watching (logging stops; log kept)",
  "rc.botLeft": "Bot left this chat",
  "rc.leftTag": "left chat",
  "rc.noRequests": "No pending requests",
  "rc.accept": "Do it",
  "rc.skip": "Skip",
  "rc.expired": "expired",
  "rc.decidedBy": (by: string) => `decided: ${by}`,
  "rc.alreadyDecided": (by: string) => `Already decided by ${by}`,
  "rc.noLongerPending": "Proposal is no longer pending",
  "rc.noApprover": "no approver — pair a user",
  "rc.proposals": "Requests",
  "rc.pairWith": (bot: string) => `Pair a user with @${bot}`,
  "rc.pairHintPrefix": "Send ",
  "rc.pairHintSuffix": (bot: string, time: string) => ` to @${bot} — expires in ${time}`,
  "rc.clickCopy": "Click to copy",
  "rc.codeCopied": "Code copied",
  "rc.cmdCopied": "Command copied",
  "rc.linkCopied": "Link copied",
  "rc.copyLink": "Copy link",
  "rc.dlgClose": "Close",
  "rc.language": "Language",
  "set.language": "UI language",
  "set.langAuto": "System default",
} as const;

let current: UiLang = navigator.language.toLowerCase().startsWith("ru") ? "ru" : "en";

export function uiLang(): UiLang {
  return current;
}

export function resolveLang(setting: string | undefined): UiLang {
  if (setting === "ru" || setting === "en") return setting;
  return navigator.language.toLowerCase().startsWith("ru") ? "ru" : "en";
}

/** apply without persisting (boot + settings pushes); fires lang-changed on real change */
export function applyLang(lang: UiLang): void {
  if (lang === current) return;
  current = lang;
  emit("lang-changed", undefined);
}

/** fixed-string lookup; function entries are called with their args */
export function t<K extends StrKey>(key: K, ...args: StrTable[K] extends (...a: infer A) => string ? A : []): string {
  const entry = (current === "ru" ? (RU as StrTable) : EN)[key];
  return typeof entry === "function" ? (entry as (...a: unknown[]) => string)(...args) : (entry as string);
}
