/**
 * OMP Agent panel: chat, tool-call timeline, todo strip, session controls,
 * status orb, disabled/dead states, agent UI request dialogs.
 */

import { marked } from "marked";
import { el, clear, svgIcon } from "../core/dom";
import { I, toolIcon } from "../core/icons";
import { on, emit } from "../core/bus";
import { state, relPath, baseName, normPath, joinPath, languageForPath } from "../core/state";
import { toast, confirmDialog, inputDialog, selectDialog } from "../core/ui";
import { t } from "../core/i18n";
import type { OmpEvent, OmpStatus, OmpTodoPhase, OmpFileEdit, OmpUiRequest, RemoteVia } from "../../shared/types";
import { switchModelViaPicker, mountUsageStrip, mountModelWarning, openModelsDialog, setSessionThinkingViaPicker } from "./models";
import { openSessionHistory } from "./history";
import { initPromptEnhance, notifyPromptSent } from "./enhance";
import { createTeamToggle, teamConsumesPrompt, initTeamSurface, stripTeamMarkers, teamRun } from "./team";
import {
  initMentionInput,
  serializePrompt,
  mentionSnapshot,
  clearMentions,
  hasMentions,
  removeLastMention,
  renderMentionChips,
  type MentionRef,
} from "./mentions";

type MentionAttachment = MentionRef & { missing: boolean };

marked.setOptions({ gfm: true, breaks: true });

let panelEl: HTMLElement;
let chatEl: HTMLElement;
let todoEl: HTMLElement;
let composerEl: HTMLElement;
let promptInput: HTMLTextAreaElement;
let headOrb: HTMLElement;
let headModel: HTMLElement;
let stopBtn: HTMLButtonElement;
let status: OmpStatus = { state: "starting" };

// -------- silent-model feedback: elapsed ticker + stall nudge ---------------
// Providers that stream nothing (dead endpoint, overloaded proxy) leave only a
// breathing orb; the user can't tell slow from dead. Wall-clock elapsed rides
// on the header label, and after the configured stall threshold (Settings →
// "Agent stall warning", 0 = off) with zero stream events a designed card
// offers the two real remedies: interrupt or switch model.
let turnStartedAt = 0;
let gotTurnData = false;
let headLabel = "";
let elapsedTimer: number | undefined;
let stallCard: HTMLElement | null = null;

function noteTurnData() {
  gotTurnData = true;
  if (stallCard) {
    stallCard.remove();
    stallCard = null;
  }
}

function elapsedTick() {
  const busy = status.state === "thinking" || status.state === "tool";
  if (!busy) return;
  const secs = Math.floor((Date.now() - turnStartedAt) / 1000);
  if (secs >= 3) headModel.textContent = `${headLabel} · ${t("team.elapsedSec", secs)}`;
  const stallMs = state.settings.stallSeconds * 1000;
  if (!gotTurnData && stallMs > 0 && secs * 1000 >= stallMs) {
    if (!stallCard) {
      const counter = el("span", { class: "mono", text: t("team.elapsedSec", secs) });
      stallCard = el(
        "div",
        { class: "stall-card" },
        el("div", { class: "sc-title" }, t("agent.stallTitle"), counter),
        el("p", { text: t("agent.stallBody") }),
        el(
          "div",
          { class: "sc-actions" },
          el("button", { class: "btn", text: t("agent.stallInterrupt"), onClick: () => void interruptAgent() }),
          el("button", { class: "btn", text: t("agent.stallSwitchModel"), onClick: () => switchModelViaPicker("stall-nudge") }),
        ),
      );
      chatEl.append(stallCard);
      stallCard.scrollIntoView({ block: "nearest" });
    } else {
      const counter = stallCard.querySelector(".sc-title .mono");
      if (counter) counter.textContent = t("team.elapsedSec", secs);
    }
  }
}

/** streaming text accumulation per messageId */
const streamBuffers = new Map<number, { el: HTMLElement; text: string }>();
/** tool cards by toolCallId */
const toolCards = new Map<string, { card: HTMLElement; summary: HTMLElement; name: string }>();
/** entrance stagger: cards arriving within one stagger window queue behind each other.
 *  Mirrors --t-card-stagger in tokens.css (CSS animates, TS only schedules). */
const CARD_STAGGER_MS = 350;
let lastCardAt = 0;
let cardChain = 0;

// -------- «СЕЙЧАС» zone (redesign §6): pinned above the composer -----------
// Display-only mirror of what the agent does RIGHT NOW: live tool + ticking
// elapsed, active todo, session diffstat. Collapses to one line on idle.
let nowEl: HTMLElement;
let nowLive: { toolCallId: string; name: string; target: string; startedAt: number } | null = null;
let nowTimer: number | undefined;
let sessionAdd = 0;
let sessionDel = 0;
const sessionFiles = new Set<string>();
let lastResultLine = "";
let activeTodo: { content: string; done: number; total: number } | null = null;

function fmtNowElapsed(startedAt: number): string {
  const s = Math.floor((Date.now() - startedAt) / 1000);
  return s < 60 ? t("team.elapsedSec", s) : t("team.elapsedMinSec", Math.floor(s / 60), s % 60);
}

/** NOW-zone phase words for a live team run — state only, never plan/summary prose */
function teamPhaseLabel(phase: string): string {
  switch (phase) {
    case "probe": return t("agent.phaseProbe");
    case "deliberate": return t("agent.phaseDeliberate");
    case "gate": return t("agent.phaseGate");
    case "execute": return t("agent.phaseExecute");
    case "verify": return t("agent.phaseVerify");
    default: return phase;
  }
}

function renderNow(): void {
  if (!nowEl) return;
  const busy = status.state === "thinking" || status.state === "tool";
  const team = teamRun();
  const teamLive = !!team && team.phase !== "done" && team.phase !== "stopped" && team.phase !== "stalled";
  // any ALIVE worker process (working/waking/throttled) owns the zone —
  // never «агент свободен» while a worker process runs (crew-design §3)
  const teamActive = team && (team.phase === "execute" || team.phase === "verify")
    ? team.agents.filter((a) => a.kind === "worker" && (a.state === "working" || a.state === "waking" || a.state === "throttled"))
    : [];

  clear(nowEl);
  nowEl.classList.toggle("collapsed", !busy && teamActive.length === 0);

  if (!busy && teamActive.length === 0) {
    // idle: one line. Team runs never echo plan/summary/report prose here.
    nowEl.append(
      el("div", { class: "now-idle" },
        el("span", { class: "now-dot" }),
        team
          ? el("span", { text: teamLive ? t("agent.nowTeam", teamPhaseLabel(team.phase)) : t("agent.idle") })
          : el("span", { text: `${t("agent.idle")}${lastResultLine ? ` · ${lastResultLine}` : ""}` }),
      ),
    );
    if (nowTimer) { clearInterval(nowTimer); nowTimer = undefined; }
    return;
  }

  if (teamActive.length > 0) {
    // Team mode: one row per ACTIVE worker — sigil + tool + target + ticking elapsed
    for (const w of teamActive) {
      const target =
        w.state === "throttled" ? t("team.rateLimited") :
        w.state === "waking" ? t("team.stWaking") :
        (w.lastActivity ?? (w.slice ? t("team.sliceN", w.slice) : ""));
      nowEl.append(
        el("div", { class: `now-row${w.state === "throttled" ? " throttled" : ""}` },
          el("span", { class: "now-sigil mono", text: w.glyph }),
          el("span", { class: "mono now-name", text: w.name }),
          el("span", { class: "now-target", text: target }),
          el("span", { class: "mono now-elapsed", text: fmtNowElapsed(w.sinceMs) }),
        ),
      );
    }
  } else {
    // solo: the live tool call (or thinking) with ticking elapsed
    const head = el("div", { class: `now-row${nowLive ? " streaming" : ""}` },
      el("span", { class: "now-dot live" }),
      nowLive
        ? el("span", { class: "mono now-name", text: nowLive.name })
        : el("span", { class: "mono now-name", text: t("agent.nowThinking") }),
      nowLive ? el("span", { class: "now-target", text: nowLive.target }) : null,
      el("span", { class: "mono now-elapsed", text: fmtNowElapsed(nowLive?.startedAt ?? turnStartedAt) }),
    );
    head.addEventListener("click", () => {
      // click-to-scroll to the live tool card
      if (nowLive) toolCards.get(nowLive.toolCallId)?.card.scrollIntoView({ block: "center", behavior: "smooth" });
    });
    nowEl.append(head);
  }

  // todo line: active item + counts
  if (activeTodo) {
    nowEl.append(
      el("div", { class: "now-sub" },
        el("span", { class: "now-todo", text: `▶ ${activeTodo.content}` }),
        el("span", { class: "mono dimmer", text: `${activeTodo.done}/${activeTodo.total}` }),
      ),
    );
  }
  // session diffstat line
  if (sessionFiles.size > 0) {
    nowEl.append(
      el("div", { class: "now-sub mono dimmer" },
        el("span", { text: t("agent.filesN", sessionFiles.size) }),
        el("span", { class: "now-add", text: `+${sessionAdd}` }),
        el("span", { class: "now-del", text: `−${sessionDel}` }),
      ),
    );
  }
  if (!nowTimer) nowTimer = window.setInterval(renderNow, 1000);
}

// worker lifecycle changes arrive as team-state pushes, not agent status —
// re-render the NOW zone on each so rows appear/collapse with the processes
on("team-state", () => renderNow());

const EXAMPLE_PROMPT_KEYS = ["agent.example1", "agent.example2", "agent.example3"] as const;

// ---------------------------------------------------------------- status

function applyStatus(s: OmpStatus) {
  const wasBusy = status.state === "thinking" || status.state === "tool";
  status = s;
  emit("agent-status", s);
  headOrb.className = `orb ${s.state}`;
  headLabel =
    s.state === "unavailable" ? t("agent.stUnavailable") :
    s.state === "dead" ? t("agent.stProcessExited") :
    s.state === "tool" && s.tool ? t("agent.stRunningTool", s.tool) :
    s.model ?? "";
  headModel.textContent = headLabel;
  stopBtn.disabled = !(s.state === "thinking" || s.state === "tool");

  const busy = s.state === "thinking" || s.state === "tool";
  if (busy && !wasBusy) {
    // turn boundary: reset the silent-model clock
    turnStartedAt = Date.now();
    gotTurnData = false;
    clearInterval(elapsedTimer);
    elapsedTimer = window.setInterval(elapsedTick, 1000);
  } else if (!busy) {
    clearInterval(elapsedTimer);
    elapsedTimer = undefined;
    if (stallCard) {
      stallCard.remove();
      stallCard = null;
    }
  }
  renderNow();

  if (s.state === "unavailable") renderUnavailable(s.detail);
  else if (s.state === "dead") renderDead(s.detail);
  else {
    panelEl.querySelector(".agent-blank.disabled-state")?.remove();
    composerEl.style.display = "";
  }
}

function renderUnavailable(detail?: string) {
  clearChatSurface();
  composerEl.style.display = "none";
  chatEl.append(
    el(
      "div",
      { class: "agent-blank dead disabled-state" },
      el("div", { class: "ab-orb" }),
      el("h3", { text: t("agent.unavailableTitle") }),
      el("p", { text: detail ?? t("agent.unavailableBody") }),
      el("p", {}, t("agent.installPre"), el("code", { text: "omp" }), t("agent.installPost")),
      el("button", {
        class: "btn btn-agent",
        text: t("agent.retry"),
        onClick: () => void startAgent(),
      }),
    ),
  );
}

function renderDead(detail?: string) {
  composerEl.style.display = "none";
  const card = el(
    "div",
    { class: "agent-blank dead disabled-state", style: { flex: "0 0 auto", padding: "18px" } },
    el("div", { class: "ab-orb" }),
    el("h3", { text: t("agent.deadTitle") }),
    el("p", { class: "mono", text: detail ?? "" }),
    el("button", {
      class: "btn btn-agent",
      text: t("agent.restartBtn"),
      onClick: () => {
        card.remove();
        void window.ide.omp.restart();
      },
    }),
  );
  chatEl.append(card);
  chatEl.scrollTop = chatEl.scrollHeight;
}

function clearChatSurface() {
  clear(chatEl);
  streamBuffers.clear();
  toolCards.clear();
}

function renderWelcomeState() {
  clearChatSurface();
  const prompts = el("div", { class: "example-prompts" });
  for (const k of EXAMPLE_PROMPT_KEYS) {
    const p = t(k);
    prompts.append(
      el("button", {
        class: "example-prompt",
        text: p,
        onClick: () => {
          promptInput.value = p;
          promptInput.focus();
        },
      }),
    );
  }
  const noModel = el("p", { class: "no-model-line", style: { display: "none" } });
  noModel.append(
    t("agent.noModelPre"),
    el("a", {
      text: t("agent.noModelLink"),
      style: { color: "var(--power)", cursor: "pointer" },
      onClick: () => openModelsDialog(),
    }),
  );
  void window.ide.models.getState().then((s) => {
    if (!s.providers.some((p) => p.enabled) && !s.active) noModel.style.display = "";
  });
  chatEl.append(
    el(
      "div",
      { class: "agent-blank" },
      el("div", { class: "grain-layer" }),
      el("div", { class: "ab-orb" }),
      el("h3", { text: "OMP Agent" }),
      el("p", { text: t("agent.heroBody") }),
      noModel,
      prompts,
    ),
  );
}

// ---------------------------------------------------------------- chat rendering

function scrollBottom() {
  chatEl.scrollTop = chatEl.scrollHeight;
}

function nearBottom(): boolean {
  return chatEl.scrollHeight - chatEl.scrollTop - chatEl.clientHeight < 120;
}

function addUserMessage(text: string, via?: RemoteVia, mentions?: MentionAttachment[]) {
  panelEl.querySelector(".agent-blank:not(.disabled-state)")?.remove();
  chatEl.append(el("div", { class: "chat-user", text: stripTeamMarkers(text) }));
  if (mentions?.length) chatEl.append(renderMentionChips(mentions));
  if (via) {
    chatEl.append(
      el(
        "span",
        { class: "remote-chip", title: t("agent.remoteVia", via.botName) },
        el("span", { class: "rc-user", text: `@${via.username}` }),
        el("span", { class: "rc-bot", text: `· ${via.botName}` }),
      ),
    );
  }
  scrollBottom();
}

function ensureStream(messageId: number): { el: HTMLElement; text: string } {
  let buf = streamBuffers.get(messageId);
  if (!buf) {
    const div = el("div", { class: "chat-agent streaming md" });
    chatEl.append(div);
    buf = { el: div, text: "" };
    streamBuffers.set(messageId, buf);
  }
  return buf;
}

// ---------------------------------------------------------------- reasoning block

interface ThinkBlock {
  root: HTMLElement;
  head: HTMLElement;
  body: HTMLElement;
  chars: number;
  startedAt: number;
}

let activeThink: ThinkBlock | null = null;

/** collapsed ∴ block above the answer; real streamed text only, never fabricated */
function ensureThinkBlock(): ThinkBlock {
  if (activeThink) return activeThink;
  const body = el("div", { class: "think-body", style: { display: "none" } });
  const head = el("div", {
    class: "think-head",
    onClick: () => {
      const open = body.style.display !== "none";
      body.style.display = open ? "none" : "";
      root.classList.toggle("open", !open);
    },
  });
  head.textContent = t("agent.thinkingHead");
  const root = el("div", { class: "think-block streaming" }, head, body);
  chatEl.append(root);
  void window.ide.models.getState().then((s) => {
    for (const orb of document.querySelectorAll(".statusbar .orb, .agent-head .orb")) {
      orb.classList.remove("level-low", "level-med", "level-high", "level-xhigh", "level-max");
      orb.classList.add("reasoning");
      if (s.thinking.effective !== "off") orb.classList.add(`level-${s.thinking.effective}`);
    }
  });
  activeThink = { root, head, body, chars: 0, startedAt: Date.now() };
  return activeThink;
}

function closeThinkBlock(): void {
  if (!activeThink) return;
  const tb = activeThink;
  activeThink = null;
  tb.root.classList.remove("streaming");
  const secs = ((Date.now() - tb.startedAt) / 1000).toFixed(1);
  // ~4 chars/token is an estimate — label it as such
  const approxTokens = Math.round(tb.chars / 4);
  tb.head.textContent = tb.chars
    ? t("agent.thinkingDone", approxTokens, secs)
    : t("agent.thinkingLive", secs);
  for (const orb of document.querySelectorAll(".statusbar .orb, .agent-head .orb"))
    orb.classList.remove("reasoning", "level-low", "level-med", "level-high", "level-xhigh", "level-max");
  chipReasoningPulse(false);
}

function chipReasoningPulse(live: boolean): void {
  document.querySelector(".model-chip .mc-think")?.classList.toggle("live", live);
}

function renderMarkdownInto(target: HTMLElement, text: string) {
  // team runs: protocol marker lines feed the board, not the transcript —
  // a bubble that was ONLY markers collapses instead of rendering empty
  const cleaned = stripTeamMarkers(text);
  target.classList.toggle("md-empty", text.length > 0 && cleaned.trim().length === 0);
  target.innerHTML = marked.parse(cleaned, { async: false });
  for (const a of target.querySelectorAll("a")) {
    a.addEventListener("click", (e) => {
      e.preventDefault();
      const href = a.getAttribute("href");
      if (href) window.ide.win.openExternal(href);
    });
  }
}

// ---------------------------------------------------------------- tool cards

function summarizeArgs(toolName: string, args: unknown, intent?: string): string {
  if (intent) return intent;
  if (args && typeof args === "object") {
    const a = args as Record<string, unknown>;
    const cand = a.path ?? a.file ?? a.command ?? a.pattern ?? a.url ?? a.input;
    if (typeof cand === "string") return cand.split("\n")[0].slice(0, 120);
  }
  return "";
}

function diffStat(edit: OmpFileEdit): { add: number; del: number } {
  const o = edit.oldText.split("\n");
  const n = edit.newText.split("\n");
  // cheap estimate: line count delta + changed proportion via diff text if present
  if (edit.diff) {
    let add = 0, del = 0;
    for (const line of edit.diff.split("\n")) {
      if (line.startsWith("+")) add++;
      else if (line.startsWith("-")) del++;
    }
    return { add, del };
  }
  return { add: Math.max(0, n.length - o.length) || 1, del: Math.max(0, o.length - n.length) };
}

function addToolCard(toolCallId: string, toolName: string, args: unknown, intent?: string) {
  const summaryText = summarizeArgs(toolName, args, intent);
  const ico = el("span", { class: "tc-ico" });
  ico.innerHTML = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round">${toolIcon(toolName)}</svg>`;
  const summary = el("span", { class: "tc-summary", text: summaryText });
  const spinner = el("span", { class: "tc-spin" });
  const body = el("div", { class: "tc-body", style: { display: "none" } });
  let argsText: string;
  try {
    argsText = typeof args === "string" ? args : JSON.stringify(args, null, 2);
  } catch {
    argsText = String(args);
  }
  body.textContent = argsText?.slice(0, 3000) ?? "";

  const head = el(
    "div",
    {
      class: "tc-head",
      onClick: () => {
        body.style.display = body.style.display === "none" ? "" : "none";
      },
    },
    ico,
    el("span", { class: "tc-name", text: toolName }),
    summary,
    spinner,
  );
  const card = el("div", { class: "tool-card running enter" }, head, body);
  // stagger burst arrivals: cards landing within one stagger window of the
  // previous one chain behind it (lab timing); a later lone card starts fresh
  const now = performance.now();
  cardChain = now - lastCardAt < CARD_STAGGER_MS ? cardChain + 1 : 0;
  lastCardAt = now;
  if (cardChain > 0) card.style.setProperty("--card-delay", `${Math.min(cardChain, 4) * CARD_STAGGER_MS}ms`);
  card.addEventListener("animationend", (e) => {
    if (e.animationName !== "glow-sweep") return;
    // entrance done: drop the class so scrollback/toggling never replays it
    card.classList.remove("enter");
    card.style.removeProperty("--card-delay");
  });
  chatEl.append(card);
  toolCards.set(toolCallId, { card, summary, name: toolName });
  if (nearBottom()) scrollBottom();
}

function finishToolCard(
  toolCallId: string,
  isError: boolean,
  resultText: string,
  fileEdit?: OmpFileEdit,
) {
  const entry = toolCards.get(toolCallId);
  if (!entry) return;
  const { card } = entry;
  card.classList.remove("running");
  card.querySelector(".tc-spin")?.remove();
  if (isError) card.classList.add("error");

  const body = card.querySelector(".tc-body") as HTMLElement | null;
  if (body && resultText) {
    body.textContent = `${body.textContent}\n\n${t("agent.resultDivider")}\n${resultText.slice(0, 2500)}`;
  }

  if (fileEdit && state.root) {
    const abs = normPath(
      /^(?:[A-Za-z]:)?[\\/]/.test(fileEdit.path) ? fileEdit.path : joinPath(state.root, fileEdit.path),
    );
    emit("agent-edited", abs);
    const { add, del } = diffStat(fileEdit);
    const total = Math.max(1, add + del);
    const bar = el("span", { class: "diffstat" });
    bar.append(
      el("span", { class: "add", style: { width: `${Math.round((add / total) * 100)}%` } }),
      el("span", { class: "del", style: { width: `${Math.round((del / total) * 100)}%` } }),
    );
    card.append(
      el(
        "div",
        { class: "tc-edit-row" },
        el("span", { class: "tc-path", text: relPath(abs) }),
        el("span", { class: "mono dimmer", text: `+${add} −${del}` }),
        bar,
        el("button", {
          class: "btn btn-agent",
          text: t("agent.viewDiff"),
          style: { padding: "2px 10px", fontSize: "11px" },
          onClick: () => {
            emit("open-diff", {
              title: t("agent.diffTitle", baseName(abs)),
              path: abs,
              original: fileEdit.oldText,
              modified: fileEdit.newText,
              language: languageForPath(abs),
            });
          },
        }),
      ),
    );
  }
  if (nearBottom()) scrollBottom();
}

// ---------------------------------------------------------------- todos

function renderTodos(phases: OmpTodoPhase[]) {
  clear(todoEl);
  const hasAny = phases.some((p) => p.tasks.length > 0);
  todoEl.style.display = hasAny ? "" : "none";
  for (const phase of phases) {
    if (!phase.tasks.length) continue;
    const ph = el("div", { class: "todo-phase" });
    if (phase.name && phase.name !== "Todos") ph.append(el("div", { class: "tp-name", text: phase.name }));
    for (const t of phase.tasks) {
      const cls =
        t.status === "completed" ? "todo-item done" :
        t.status === "in_progress" ? "todo-item active" : "todo-item";
      ph.append(el("div", { class: cls }, el("span", { class: "ti-dot" }), el("span", { text: t.content })));
    }
    todoEl.append(ph);
  }
}

// ---------------------------------------------------------------- event handling

function handleEvent(e: OmpEvent) {
  switch (e.kind) {
    case "user-message": {
      const mentions = !e.via && pendingLocalMentions ? pendingLocalMentions : undefined;
      if (mentions) pendingLocalMentions = null;
      addUserMessage(e.text, e.via, mentions);
      break;
    }
    case "agent-start":
      break;
    case "text-start":
      noteTurnData();
      closeThinkBlock(); // reasoning phase ends when the answer starts
      ensureStream(e.messageId);
      break;
    case "text-delta": {
      noteTurnData();
      const buf = ensureStream(e.messageId);
      buf.text += e.delta;
      renderMarkdownInto(buf.el, buf.text);
      if (nearBottom()) scrollBottom();
      break;
    }
    case "text-end": {
      const buf = streamBuffers.get(e.messageId);
      if (buf) {
        buf.el.classList.remove("streaming");
        if (e.text && !buf.text) renderMarkdownInto(buf.el, e.text);
      } else if (e.text) {
        const div = el("div", { class: "chat-agent md" });
        renderMarkdownInto(div, e.text);
        chatEl.append(div);
      }
      if (nearBottom()) scrollBottom();
      break;
    }
    case "thinking-delta": {
      noteTurnData();
      const tb = ensureThinkBlock();
      tb.chars += e.delta.length;
      tb.body.textContent += e.delta;
      tb.head.textContent = t("agent.thinkingLive", ((Date.now() - tb.startedAt) / 1000).toFixed(0));
      chipReasoningPulse(true);
      if (nearBottom()) scrollBottom();
      break;
    }
    case "tool-start": {
      noteTurnData();
      addToolCard(e.toolCallId, e.toolName, e.args, e.intent);
      // NOW zone: this call is what the agent does right now
      const target = summarizeArgs(e.toolName, e.args, e.intent);
      nowLive = { toolCallId: e.toolCallId, name: e.toolName, target, startedAt: Date.now() };
      renderNow();
      break;
    }
    case "tool-end": {
      finishToolCard(e.toolCallId, e.isError, e.resultText, e.fileEdit);
      if (e.fileEdit) {
        const { add, del } = diffStat(e.fileEdit);
        sessionAdd += add;
        sessionDel += del;
        sessionFiles.add(normPath(e.fileEdit.path));
      }
      if (nowLive?.toolCallId === e.toolCallId) nowLive = null;
      renderNow();
      break;
    }
    case "todos": {
      noteTurnData();
      renderTodos(e.phases);
      // NOW zone todo mirror: active item + done/total counts
      let done = 0, total = 0;
      let active: string | null = null;
      for (const p of e.phases) for (const t of p.tasks) {
        total++;
        if (t.status === "completed") done++;
        if (t.status === "in_progress" && !active) active = t.content;
      }
      activeTodo = total > 0 ? { content: active ?? "…", done, total } : null;
      renderNow();
      break;
    }
    case "agent-end":
      closeThinkBlock();
      for (const buf of streamBuffers.values()) buf.el.classList.remove("streaming");
      // Marks BOTH interrupt origins (IDE button/stall card AND remote /stop):
      // without a trace an aborted turn later reads as "the model never answered".
      if (e.aborted) {
        chatEl.append(el("div", { class: "turn-marker", text: "· turn interrupted ·" }));
        if (nearBottom()) scrollBottom();
      } else if (!gotTurnData) {
        // HTTP 200 with ZERO content (no text/thinking/tool events): a broken
        // proxy upstream answers "stop" with an empty completion. Without a
        // visible trace this reads as "the IDE ate my reply" (user report).
        chatEl.append(el("div", { class: "turn-marker crit", text: t("agent.emptyTurn") }));
        if (nearBottom()) scrollBottom();
      }
      // NOW zone: idle summary line = last agent text, one line
      {
        const last = [...chatEl.querySelectorAll(".chat-agent")].pop()?.textContent ?? "";
        lastResultLine = e.aborted
          ? t("agent.interrupted")
          : !gotTurnData
            ? t("agent.emptyTurnShort")
            : last.trim().split("\n")[0].slice(0, 80);
        nowLive = null;
        renderNow();
      }
      break;
  }
}

async function handleUiRequest(req: OmpUiRequest) {
  if (req.method === "confirm") {
    const ok = await confirmDialog({
      title: req.title ?? t("agent.asksTitle"),
      message: req.message ?? "",
      confirmLabel: t("agent.yes"),
    });
    void window.ide.omp.uiResponse(req.id, { confirmed: ok });
  } else if (req.method === "input" || req.method === "editor") {
    const value = await inputDialog({
      title: req.title ?? t("agent.asksTitle"),
      message: req.message,
      placeholder: req.placeholder,
    });
    void window.ide.omp.uiResponse(
      req.id,
      value === null ? { cancelled: true } : { value },
    );
  } else if (req.method === "select") {
    const pick = await selectDialog(req.title ?? t("agent.asksTitle"), req.options ?? []);
    void window.ide.omp.uiResponse(
      req.id,
      pick === null ? { cancelled: true } : { value: pick },
    );
  }
}

// ---------------------------------------------------------------- actions

function sendPrompt() {
  notifyPromptSent(); // sending always closes the advisory enhance card
  const text = promptInput.value.trim();
  if (!text && !hasMentions()) return;
  if (status.state === "unavailable" || status.state === "dead" || status.state === "starting") {
    toast(t("agent.notRunning"), { crit: true });
    return;
  }
  const mentions = mentionSnapshot();
  const message = serializePrompt(text);
  promptInput.value = "";
  clearMentions();
  // Team mode intercepts: goal start or mid-run steering (never a plain prompt)
  if (teamConsumesPrompt(message)) return;
  // Chips are rendered locally with the snapshot; suppress the plain echo by
  // rendering here and letting the main-process user-message event carry text.
  pendingLocalMentions = mentions.length ? mentions : null;
  void window.ide.omp.prompt(message);
}

/** mentions attached to the message currently in flight (renders on echo) */
let pendingLocalMentions: MentionAttachment[] | null = null;

async function interruptAgent() {
  if (status.state === "thinking" || status.state === "tool") {
    await window.ide.omp.abort();
    toast(t("agent.interruptSent"));
    // transcript marker arrives with the agent-end {aborted} event
  }
}

async function newSession() {
  const busy = status.state === "thinking" || status.state === "tool";
  if (busy) {
    const ok = await confirmDialog({
      title: t("agent.busyTitle"),
      message: t("agent.newSessionMsg"),
      confirmLabel: t("agent.newSessionBtn"),
      danger: true,
    });
    if (!ok) return;
    await window.ide.omp.abort();
  }
  await window.ide.omp.newSession();
  renderWelcomeState();
  renderTodos([]);
  // NOW zone session counters reset with the session
  sessionAdd = 0;
  sessionDel = 0;
  sessionFiles.clear();
  lastResultLine = "";
  activeTodo = null;
  nowLive = null;
  renderNow();
  toast(t("agent.newSessionToast"));
}

export async function startAgent() {
  if (!state.root) return;
  // NOW-zone counters and todo strip are per-session surfaces: a workspace
  // switch (repeated startAgent) must not carry the previous root's numbers
  renderTodos([]);
  sessionAdd = 0;
  sessionDel = 0;
  sessionFiles.clear();
  lastResultLine = "";
  activeTodo = null;
  nowLive = null;
  renderNow();
  renderWelcomeState();
  await window.ide.omp.start(state.root);
}

/** Is a turn or team run in flight? (workspace-switch busy guard) */
export function agentBusy(): boolean {
  return status.state === "thinking" || status.state === "tool";
}

// ---------------------------------------------------------------- init

export function initAgentPanel(container: HTMLElement) {
  panelEl = container;

  headOrb = el("span", { class: "orb starting" });
  headModel = el("span", { class: "agent-model" });
  stopBtn = el("button", {
    class: "icon-btn",
    title: t("agent.tipInterrupt"),
    onClick: () => void interruptAgent(),
  }) as HTMLButtonElement;
  stopBtn.append(svgIcon(I.stop));
  const newBtn = el("button", {
    class: "icon-btn",
    title: t("agent.tipNewSession"),
    onClick: () => void newSession(),
  });
  newBtn.append(svgIcon(I.plus));
  const restartBtn = el("button", {
    class: "icon-btn",
    title: t("agent.tipRestart"),
    onClick: () => void window.ide.omp.restart(),
  });
  restartBtn.append(svgIcon(I.restart2));
  const historyBtn = el("button", {
    class: "icon-btn",
    title: t("agent.tipHistory"),
    onClick: () => openSessionHistory(),
  });
  historyBtn.append(svgIcon(I.history));
  // Compact model selector: omp supports live per-session set_model (applies
  // next turn), so this button IS the per-session override surface.
  const modelBtn = el("button", {
    class: "icon-btn",
    title: t("agent.tipSwitchModel"),
    onClick: () => switchModelViaPicker("agent-header"),
  });
  modelBtn.append(svgIcon(I.zap));
  // Session thinking dial — override for THIS session only (clears on /new)
  const thinkBtn = el("button", {
    class: "icon-btn",
    title: t("agent.tipThinking"),
    onClick: () => setSessionThinkingViaPicker("agent-header"),
  });
  thinkBtn.append(svgIcon(I.sparkle));

  const head = el(
    "div",
    { class: "agent-head" },
    headOrb,
    el("span", { class: "agent-title", text: "OMP AGENT" }),
    headModel,
    el("span", { class: "agent-actions" }, modelBtn, thinkBtn, stopBtn, historyBtn, newBtn, restartBtn),
  );

  chatEl = el("div", { class: "agent-chat" });
  todoEl = el("div", { class: "todo-strip", style: { display: "none" } });

  promptInput = el("textarea", {
    class: "input",
    placeholder: t("agent.placeholder"),
    onKeyDown: (e) => {
      if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
        // Enter sends; Shift+Enter inserts a newline (default behavior)
        e.preventDefault();
        sendPrompt();
      } else if (
        e.key === "Backspace" &&
        promptInput.selectionStart === 0 &&
        promptInput.selectionEnd === 0
      ) {
        // caret at start (covers empty text too) → remove the last chip
        if (removeLastMention()) e.preventDefault();
      }
    },
  }) as HTMLTextAreaElement;

  const mentionStrip = el("div", { class: "mention-strip", style: { display: "none" } });
  const sendBtn = el("button", { class: "btn btn-agent", text: t("agent.send"), onClick: () => sendPrompt() });
  composerEl = el(
    "div",
    { class: "agent-composer" },
    mentionStrip,
    promptInput,
    el(
      "div",
      { class: "composer-row" },
      el("span", { style: { flex: "1" } }),
      createTeamToggle(),
      sendBtn,
    ),
  );

  // live language switch: the persistent panel re-applies its fixed strings.
  // Registered BEFORE initTeamSurface so the team handler (placeholder for
  // armed/live runs) always wins over the plain agent placeholder.
  on("lang-changed", () => {
    promptInput.placeholder = t("agent.placeholder");
    sendBtn.textContent = t("agent.send");
    stopBtn.title = t("agent.tipInterrupt");
    newBtn.title = t("agent.tipNewSession");
    restartBtn.title = t("agent.tipRestart");
    historyBtn.title = t("agent.tipHistory");
    modelBtn.title = t("agent.tipSwitchModel");
    thinkBtn.title = t("agent.tipThinking");
    // stall card rebuilds translated on the next tick (≤1s while stalled)
    if (stallCard) { stallCard.remove(); stallCard = null; }
    // header label + NOW zone + dead/unavailable cards re-derive from status;
    // drop the old disabled-state card first so dead never duplicates
    panelEl.querySelector(".agent-blank.disabled-state")?.remove();
    applyStatus(status);
    if (chatEl.querySelector(".agent-blank:not(.disabled-state)")) renderWelcomeState();
  });
  initMentionInput({
    strip: mentionStrip,
    zone: composerEl,
    openFileAction: (path) => emit("open-file", { path }),
  });

  nowEl = el("div", { class: "agent-now collapsed" });
  panelEl.append(head, chatEl, todoEl, nowEl, composerEl);
  renderNow();
  mountUsageStrip(panelEl);
  mountModelWarning(panelEl);
  initTeamSurface({ panel: panelEl, input: promptInput });
  initPromptEnhance({ composer: composerEl, input: promptInput });
  renderWelcomeState();

  window.ide.omp.onStatus((s) => applyStatus(s));
  window.ide.omp.onEvent((e) => handleEvent(e));
  window.ide.omp.onUiRequest((req) => void handleUiRequest(req));
}

export function focusAgentInput() {
  promptInput?.focus();
}

/** Omnibar «Agent» row: insert the query into the composer WITHOUT sending. */
export function setAgentDraft(text: string) {
  if (!promptInput) return;
  promptInput.value = text;
  promptInput.dispatchEvent(new Event("input", { bubbles: true }));
}

