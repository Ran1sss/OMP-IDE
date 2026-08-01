/**
 * Prompt Improve («улучшить промпт»): one-click draft enhancement on the
 * smol role via the stateless OMP oneshot — the exact mechanism the Telegram
 * chat listener uses (src/main/oneshot-runner.ts). The main agent session is
 * NEVER touched; the suggestion is advisory and the user always gates.
 *
 * Deletable: this module + its two hooks in agent.ts (init + notifyPromptSent)
 * leave the prompt input untouched.
 */

import { el } from "../core/dom";
import { registerCommand } from "../core/commands";
import { t } from "../core/i18n";
import { on } from "../core/bus";

let input: HTMLTextAreaElement;
let composerEl: HTMLElement;
let wrapEl: HTMLElement;
let btn: HTMLButtonElement;
let card: HTMLElement | null = null;
let inFlight = false;
let avail: { ok: boolean; reason?: string; model?: string } = { ok: false };
/** false until the first enhanceStatus() answer — tooltip shows «checking» */
let statusKnown = false;

export function initPromptEnhance(opts: { composer: HTMLElement; input: HTMLTextAreaElement }): void {
  composerEl = opts.composer;
  input = opts.input;

  // dock the wand INSIDE the input, top-right: wrap the textarea in a
  // positioning context (removing this module leaves the input untouched)
  wrapEl = el("div", { class: "enhance-wrap" });
  input.replaceWith(wrapEl);
  wrapEl.append(input);

  btn = el("button", {
    class: "enhance-btn",
    text: "✦",
    onClick: () => void run(),
  }) as HTMLButtonElement;
  wrapEl.append(btn);

  input.addEventListener("input", () => {
    refreshVisibility();
    // continuing to type dismisses the advisory card
    if (card && !inFlight) closeCard();
  });
  input.addEventListener(
    "keydown",
    (e) => {
      if (!card) return;
      if (e.key === "Escape") {
        e.stopPropagation();
        e.preventDefault();
        closeCard();
      } else if (e.key === "Enter" && !e.shiftKey) {
        // Enter sends the CURRENT draft — the card never blocks sending
        closeCard();
      }
    },
    { capture: true },
  );

  void refreshStatus();
  window.ide.models.onState(() => void refreshStatus());

  registerImproveCommand();
  // live language switch: re-apply the tooltip + palette title; the advisory
  // card is transient and closes rather than re-rendering stale text
  on("lang-changed", () => {
    applyTitle();
    registerImproveCommand();
    if (card && !inFlight) closeCard();
  });

  refreshVisibility();
}

function registerImproveCommand(): void {
  registerCommand({
    id: "agent.improveDraft",
    title: t("enh.cmdImprove"),
    keybinding: "Ctrl+E",
    category: "Agent",
    allowInInput: true,
    handler: () => void run(),
  });
}

/** agent.ts calls this from its send path: sending always closes the card */
export function notifyPromptSent(): void {
  closeCard();
}

function draftLength(): number {
  return input.value.replace(/\s/g, "").length;
}

function refreshVisibility(): void {
  btn.style.display = draftLength() >= 8 ? "" : "none";
}

function applyTitle(): void {
  btn.title = avail.ok
    ? t("enh.tipOk")
    : t("enh.tipUnavailable", statusKnown ? (avail.reason ?? t("enh.unavailableWord")) : t("enh.checking"));
}

async function refreshStatus(): Promise<void> {
  avail = await window.ide.models.enhanceStatus();
  statusKnown = true;
  btn.classList.toggle("unavailable", !avail.ok);
  applyTitle();
}

async function run(): Promise<void> {
  // cost honesty: one click = at most one oneshot; in-flight clicks ignored
  if (inFlight || draftLength() < 8) return;
  if (!avail.ok) {
    await refreshStatus();
    if (!avail.ok) return;
  }
  const draft = input.value;
  inFlight = true;
  btn.classList.add("busy");
  const res = await window.ide.models.enhance(draft, "prompt-input");
  inFlight = false;
  btn.classList.remove("busy");
  if (res.ok) showCard(res.text, res.model, draft);
  else showError(res.error);
}

function ensureCard(): HTMLElement {
  card?.remove();
  card = el("div", { class: "enhance-card materialize" });
  // attached above the input, inside the composer
  composerEl.insertBefore(card, composerEl.firstChild);
  return card;
}

function closeCard(): void {
  card?.remove();
  card = null;
}

function showCard(text: string, model: string, draftAtRequest: string): void {
  const c = ensureCard();
  c.append(
    el("div", { class: "ec-head mono", text: t("enh.head", model) }),
    el("div", { class: "ec-body", text }),
    el("div", { class: "ec-actions" },
      el("button", {
        class: "btn btn-primary ec-btn", text: t("enh.replace"),
        onClick: () => {
          // mention chips live outside the textarea — untouched by design
          input.value = text;
          closeCard();
          input.focus();
        },
      }),
      el("button", {
        class: "btn btn-ghost ec-btn", text: t("enh.insertBelow"),
        onClick: () => {
          input.value = `${input.value.trimEnd() || draftAtRequest.trimEnd()}\n\n${text}`;
          closeCard();
          input.focus();
        },
      }),
      el("button", { class: "btn btn-ghost ec-btn", text: t("enh.dismiss"), onClick: () => closeCard() }),
    ),
  );
}

function showError(reason: string): void {
  const c = ensureCard();
  c.classList.add("error");
  c.append(
    el("div", { class: "ec-err" },
      el("span", { class: "ec-err-text", text: t("enh.failed", reason) }),
      el("button", { class: "btn btn-ghost ec-btn", text: t("enh.retry"), onClick: () => { closeCard(); void run(); } }),
    ),
  );
}

