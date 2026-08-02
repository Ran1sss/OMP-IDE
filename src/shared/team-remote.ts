import type { TeamRole } from "./types";

export function extractRosterMentions(
  message: string,
  roster: Iterable<string | Pick<TeamRole, "id">>,
): string[] {
  const ids = new Set<string>();
  for (const role of roster) ids.add((typeof role === "string" ? role : role.id).toLowerCase());
  const matches = new Set<string>();
  for (const match of message.matchAll(/@([a-z][\w-]*)/gi)) {
    const id = match[1].toLowerCase();
    if (ids.has(id)) matches.add(id);
  }
  return [...matches];
}
export function stripLeadingMentionsForIntent(message: string): string {
  return message.replace(/^(?:@[a-z][\w-]*\s+)+/i, "").trim();
}


export type ModeTaskParse = { ok: true; task: string } | { ok: false };

export function parseModeCommand(message: string, mode: "solo" | "team"): ModeTaskParse {
  const match = new RegExp(`^/${mode}(?:@[a-z0-9_]+)?(?:\\s+([\\s\\S]*))?$`, "i").exec(message.trim());
  const task = match?.[1]?.trim() ?? "";
  return task ? { ok: true, task } : { ok: false };
}

export const parseSoloTask = (message: string): ModeTaskParse => parseModeCommand(message, "solo");

export type TaskIntake =
  | { kind: "steer" }
  | { kind: "team"; mentions: string[] }
  | { kind: "picker" };

/** One decision for every plain Telegram task: steer, direct Team, or picker. */
export function classifyTaskIntake(input: {
  text: string;
  roster: Iterable<string | Pick<TeamRole, "id">>;
  teamRunActive: boolean;
  agentState?: string;
}): TaskIntake {
  if (input.teamRunActive) return { kind: "steer" };
  if (input.agentState === "thinking" || input.agentState === "tool") return { kind: "steer" };
  const mentions = extractRosterMentions(input.text, input.roster);
  return mentions.length ? { kind: "team", mentions } : { kind: "picker" };
}

export function renderTelegramStartNotice(
  slices: { id: string; worker: string; title: string; deps: string[] }[],
  lang: StatusLang,
): string {
  if (slices.length === 1) {
    const slice = slices[0];
    return lang === "ru"
      ? `⚑ Команда: только ${slice.worker} — ${slice.title}`
      : `⚑ Team: ${slice.worker} only — ${slice.title}`;
  }
  const workers = new Map(slices.map((slice) => [slice.id, slice.worker]));
  const parts = slices.map((slice, index) => {
    const last = index === slices.length - 1;
    const note = last
      ? (lang === "ru" ? "последним" : "last")
      : slice.deps.length
        ? `${lang === "ru" ? "после" : "after"} ${slice.deps.map((id) => workers.get(id) ?? id).join(", ")}`
        : "";
    return `${slice.worker} — ${slice.title}${note ? ` (${note})` : ""}`;
  });
  return `${lang === "ru" ? "⚑ Команда приступила к работе:" : "⚑ Team started working:"} ${parts.join(" · ")}`;
}
type StatusLang = "ru" | "en";
type StatusSlice = {
  id: string;
  title: string;
  worker: string;
  deps: string[];
  state: string;
};

export function renderTelegramTeamStatus(
  run: { phase: string; slices: StatusSlice[] },
  lang: StatusLang,
): string {
  const state = (value: string) => {
    const ru: Record<string, string> = {
      pending: "в очереди",
      active: "работает…",
      done: "готово",
      failed: "ошибка",
      replanned: "переназначено",
      stopped: "остановлено",
    };
    const en: Record<string, string> = {
      pending: "queued",
      active: "working…",
      done: "done",
      failed: "failed",
      replanned: "reassigned",
      stopped: "stopped",
    };
    return (lang === "ru" ? ru : en)[value] ?? value;
  };
  const workers = new Map(run.slices.map((slice) => [slice.id, slice.worker]));
  const header = lang === "ru" ? "агент · задача · статус" : "agent · task · status";
  const rows = run.slices.map((slice, index) => {
    const notes: string[] = [];
    if (slice.state === "pending" && index === run.slices.length - 1 && run.slices.length > 1) {
      notes.push(lang === "ru" ? "последним" : "last");
    } else if (slice.deps.length) {
      const names = slice.deps.map((id) => workers.get(id) ?? id).join(", ");
      notes.push(`${lang === "ru" ? "после" : "after"} ${names}`);
    }
    return [slice.worker, slice.title, state(slice.state), ...notes].join(" · ");
  });
  return [header, ...rows].join("\n");
}
