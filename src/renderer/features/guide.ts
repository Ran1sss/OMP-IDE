/**
 * Interactive onboarding tour v2 — first-class feature module (replaces the
 * dist-only v1 script). Spotlight hole + floating card over the live UI,
 * 18 steps in day-workflow order. Absent targets self-skip (dots renumber),
 * hidden surfaces are opened for their step and the pre-tour layout is
 * restored on finish/exit. All strings live in the RU/EN table; all colors,
 * fonts and timings come from tokens.css (styles/guide.css).
 */

import { el } from "../core/dom";
import { on, emit } from "../core/bus";
import { state } from "../core/state";
import { t } from "../core/i18n";
import { openPalette, closePalette } from "./palette";
import { toggleTerminal, isTerminalVisible } from "./terminal";
import { TourRenderGate } from "./tour-render-gate";

const DONE_KEY = "ompGuideDone.v2";

function storeGet(k: string): string | null {
  try { return localStorage.getItem(k); } catch { return null; }
}
function storeSet(k: string, v: string): void {
  try { localStorage.setItem(k, v); } catch { /* best-effort */ }
}

// ---------------------------------------------------------------- DOM helpers

function q(sel: string): HTMLElement | null {
  return document.querySelector<HTMLElement>(sel);
}

function visible(node: HTMLElement | null): boolean {
  if (!node) return false;
  const r = node.getBoundingClientRect();
  return r.width > 2 && r.height > 2;
}

/** side views in DOM order inside .sidepanel (after .panel-title) */
const SIDE_VIEWS = ["explorer", "search", "outline", "git", "remote"] as const;
type SideView = (typeof SIDE_VIEWS)[number];

function activeSideView(): SideView | null {
  const side = q(".sidepanel");
  if (!side || side.classList.contains("collapsed")) return null;
  const kids = [...side.children].filter((c) => !c.classList.contains("panel-title")) as HTMLElement[];
  const i = kids.findIndex((k) => k.style.display !== "none");
  return i >= 0 ? SIDE_VIEWS[i] : null;
}

/** open a side view without toggling it closed when already active */
function openSideView(view: SideView): void {
  if (activeSideView() !== view) emit("view-switch", view);
}

function agentPanelCollapsed(): boolean {
  return q(".agentpanel")?.classList.contains("collapsed") ?? true;
}

function ensureAgentPanel(): void {
  if (agentPanelCollapsed()) emit("view-switch", "agent");
}

// ---------------------------------------------------------------- steps

interface TourStep {
  /** i18n key suffix: tour.<key>Title / tour.<key>Body */
  key: string;
  /** anchor to spotlight; null = centered card over dimmed backdrop */
  target: () => HTMLElement | null;
  /** static availability probe — absent surface drops the step (dots renumber) */
  present: () => boolean;
  /** choreography before measuring (open the surface being shown) */
  before?: () => void;
  /** undo per-step choreography when leaving the step */
  cleanup?: () => void;
  /** label override for the primary button (first/last steps) */
  primary?: () => string;
}

function buildSteps(): TourStep[] {
  const act = (i: number) => (q(".activitybar")?.querySelectorAll<HTMLElement>(".act-btn")[i] ?? null);
  const steps: TourStep[] = [
    {
      key: "s1",
      target: () => (visible(q(".welcome")) ? q(".welcome .wk-work") ?? q(".welcome") : null),
      present: () => true,
      primary: () => t("tour.start"),
    },
    { key: "s2", target: () => q(".titlebar"), present: () => !!q(".titlebar") },
    { key: "s3", target: () => q(".activitybar"), present: () => !!q(".activitybar") },
    {
      key: "s4",
      target: () => q(".sidepanel"),
      present: () => !!act(0),
      before: () => openSideView("explorer"),
    },
    {
      key: "s5",
      target: () => q(".omnibar"),
      present: () => true,
      before: () => void openPalette("files"),
      cleanup: () => closePalette(),
    },
    { key: "s6", target: () => q(".editor-area"), present: () => !!q(".editor-area") },
    {
      key: "s7",
      target: () => q(".sidepanel"),
      present: () => !!act(1),
      before: () => openSideView("search"),
    },
    {
      key: "s8",
      target: () => q(".sidepanel"),
      present: () => !!act(3),
      before: () => openSideView("git"),
    },
    {
      key: "s9",
      target: () => q(".term-region"),
      present: () => !!q(".term-region"),
      before: () => {
        if (!isTerminalVisible()) {
          openedTerminal = true;
          toggleTerminal();
        }
      },
    },
    {
      key: "s10",
      target: () => q(".agentpanel"),
      present: () => !!q(".agentpanel"),
      before: () => ensureAgentPanel(),
    },
    { key: "s11", target: () => q(".agent-now"), present: () => !!q(".agent-now"), before: () => ensureAgentPanel() },
    { key: "s12", target: () => q(".agent-composer"), present: () => !!q(".agent-composer"), before: () => ensureAgentPanel() },
    { key: "s13", target: () => q(".team-toggle"), present: () => !!q(".team-toggle"), before: () => ensureAgentPanel() },
    { key: "s14", target: () => q(".model-chip"), present: () => !!q(".model-chip") },
    {
      key: "s15",
      target: () => q(".sidepanel"),
      present: () => !!act(4),
      before: () => openSideView("remote"),
    },
    { key: "s16", target: () => q(".statusbar"), present: () => !!q(".statusbar") },
    {
      key: "s17",
      target: () => {
        const btns = q(".activitybar")?.querySelectorAll<HTMLElement>(".act-btn");
        return btns?.length ? btns[btns.length - 1] : null;
      },
      present: () => !!q(".activitybar .act-btn"),
    },
    { key: "s18", target: () => null, present: () => true, primary: () => t("tour.finish") },
  ];
  return steps.filter((s) => s.present());
}

// step body strings carry <kbd>/<b>/dot markup — typed lookup by suffix
function stepTitle(key: string): string {
  return t(`tour.${key}Title` as Parameters<typeof t>[0]) as string;
}
function stepBody(key: string): string {
  return t(`tour.${key}Body` as Parameters<typeof t>[0]) as string;
}

// ---------------------------------------------------------------- engine

let active = false;
let openedTerminal = false;

export function tourActive(): boolean {
  return active;
}

export function startTour(): void {
  if (active) return;
  active = true;
  openedTerminal = false;

  // pre-tour layout snapshot (restored on ANY exit path)
  const snap = {
    sideView: activeSideView(),
    agentCollapsed: agentPanelCollapsed(),
    termVisible: isTerminalVisible(),
  };

  let steps = buildSteps();
  let idx = 0;
  let dir: 1 | -1 = 1;
  /** welcome pause: waiting for a folder before walking workspace surfaces */
  let paused = false;
  let pausePoll: number | undefined;
  /** Esc pressed once — inline exit confirm row */
  let confirmExit = false;
  let renderGen = 0;
  const renderGate = new TourRenderGate();

  const root = el("div", { class: "og-root" });
  const hole = el("div", { class: "og-hole" });
  const card = el("div", { class: "og-card" });
  root.append(hole, card);
  document.body.append(root);

  function placeCard(rect: DOMRect | null): void {
    const cw = card.offsetWidth;
    const ch = card.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let top: number;
    let left: number;
    if (!rect) {
      top = (vh - ch) / 2;
      left = (vw - cw) / 2;
    } else if (rect.right + 16 + cw <= vw) {
      left = rect.right + 16;
      top = rect.top + rect.height / 2 - ch / 2;
    } else if (rect.left - 16 - cw >= 0) {
      left = rect.left - 16 - cw;
      top = rect.top + rect.height / 2 - ch / 2;
    } else if (rect.bottom + 16 + ch <= vh) {
      left = rect.left + rect.width / 2 - cw / 2;
      top = rect.bottom + 16;
    } else {
      left = rect.left + rect.width / 2 - cw / 2;
      top = rect.top - 16 - ch;
    }
    card.style.top = `${Math.max(8, Math.min(top, vh - ch - 8))}px`;
    card.style.left = `${Math.max(8, Math.min(left, vw - cw - 8))}px`;
  }

  function stopPausePoll(): void {
    if (pausePoll !== undefined) {
      clearInterval(pausePoll);
      pausePoll = undefined;
    }
  }

  /** welcome pause card: wait for a workspace, walk on without one, or leave */
  function renderPause(): void {
    paused = true;
    root.classList.add("og-dim");
    hole.style.display = "none";
    card.innerHTML = "";
    card.append(
      el("div", { class: "og-step mono", text: t("tour.pauseTag") }),
      el("div", { class: "og-title", text: t("tour.pauseTitle") }),
      el("div", { class: "og-body", html: t("tour.pauseBody") }),
      el(
        "div",
        { class: "og-actions" },
        el("button", { class: "og-btn og-primary", text: t("tour.continueNoFolder"), onClick: () => resumeAfterPause(true) }),
        el("button", { class: "og-skip", text: t("tour.skip"), onClick: () => finish() }),
      ),
    );
    placeCard(null);
    (card.querySelector("button") as HTMLElement)?.focus();
    renderGate.settle();
    // a folder opened from the welcome screen resumes the tour by itself
    stopPausePoll();
    pausePoll = window.setInterval(() => {
      if (state.root) resumeAfterPause(false);
    }, 400);
  }

  function resumeAfterPause(withoutFolder: boolean): void {
    stopPausePoll();
    paused = false;
    if (withoutFolder) {
      const w = q(".welcome");
      if (w) w.style.display = "none";
    }
    steps = buildSteps(); // availability may have changed with the new root
    idx = Math.min(1, steps.length - 1);
    dir = 1;
    render();
  }

  function render(): void {
    const s = steps[idx];
    if (!s) {
      finish();
      return;
    }
    confirmExit = false;
    const gen = ++renderGen;
    try {
      s.before?.();
    } catch { /* surface may be gone — runtime skip below */ }

    // target may appear after before() (panel open animation) — measure late
    window.setTimeout(() => {
      if (!active || gen !== renderGen) return;
      let target: HTMLElement | null = null;
      try {
        target = s.target();
      } catch { /* treat as absent */ }
      const isAnchored = s.key !== "s1" && s.key !== "s18";
      const rect = target && visible(target) ? target.getBoundingClientRect() : null;

      // runtime self-skip: an anchored step whose target vanished mid-run
      if (isAnchored && !rect) {
        s.cleanup?.();
        steps.splice(idx, 1);
        if (idx >= steps.length) idx = steps.length - 1;
        else if (dir === -1) idx = Math.max(0, idx - 1);
        render();
        return;
      }

      if (rect) {
        root.classList.remove("og-dim");
        hole.style.display = "";
        const pad = 4;
        hole.style.top = `${rect.top - pad}px`;
        hole.style.left = `${rect.left - pad}px`;
        hole.style.width = `${rect.width + pad * 2}px`;
        hole.style.height = `${rect.height + pad * 2}px`;
      } else {
        root.classList.add("og-dim");
        hole.style.display = "none";
      }

      card.innerHTML = "";
      const dots = el("div", { class: "og-dots" });
      for (let i = 0; i < steps.length; i++) {
        dots.append(el("span", { class: i === idx ? "on" : i < idx ? "past" : "" }));
      }
      const actions = el("div", { class: "og-actions" });
      if (idx > 0) actions.append(el("button", { class: "og-btn", text: t("tour.back"), onClick: () => back() }));
      actions.append(
        el("button", {
          class: "og-btn og-primary",
          text: s.primary?.() ?? (idx === steps.length - 1 ? t("tour.finish") : t("tour.next")),
          onClick: () => next(),
        }),
      );
      if (idx < steps.length - 1) actions.append(el("button", { class: "og-skip", text: t("tour.skip"), onClick: () => askExit() }));
      card.append(
        el("div", { class: "og-step mono", text: t("tour.step", idx + 1, steps.length) }),
        el("div", { class: "og-title", text: stepTitle(s.key) }),
        el("div", { class: "og-body", html: stepBody(s.key) }),
        dots,
        actions,
      );

      const rect2 = target && visible(target) ? target.getBoundingClientRect() : null;
      placeCard(rect2);
      (card.querySelector(".og-primary") as HTMLElement)?.focus();
      renderGate.settle();
    }, s.before ? 320 : 0);
  }

  function askExit(): void {
    if (confirmExit) {
      finish();
      return;
    }
    confirmExit = true;
    const actions = card.querySelector(".og-actions");
    if (!actions) {
      finish();
      return;
    }
    actions.innerHTML = "";
    actions.append(
      el("span", { class: "og-confirm", text: t("tour.exitConfirm") }),
      el("button", { class: "og-btn og-danger", text: t("tour.exitYes"), onClick: () => finish() }),
      el("button", { class: "og-btn og-primary", text: t("tour.exitNo"), onClick: () => render() }),
    );
    (actions.querySelector(".og-primary") as HTMLElement)?.focus();
  }

  function leaveStep(): void {
    steps[idx]?.cleanup?.();
  }

  function next(): void {
    if (paused) return;
    renderGate.tryNavigate(() => {
      leaveStep();
      dir = 1;
      // welcome pause gate: no workspace → hold after the intro step
      if (idx === 0 && !state.root && visible(q(".welcome"))) {
        renderPause();
        return;
      }
      if (idx < steps.length - 1) {
        idx++;
        render();
      } else {
        finish();
      }
    });
  }

  function back(): void {
    if (paused || idx === 0) return;
    renderGate.tryNavigate(() => {
      leaveStep();
      dir = -1;
      idx--;
      render();
    });
  }

  function onKey(e: KeyboardEvent): void {
    if (e.key === "Escape") {
      e.stopPropagation();
      e.preventDefault();
      if (paused) finish();
      else askExit();
    } else if (e.key === "ArrowRight" || e.key === "Enter") {
      // let the focused card button consume its own Enter (confirm row)
      if (e.key === "Enter" && card.contains(document.activeElement) && document.activeElement?.tagName === "BUTTON") return;
      e.stopPropagation();
      e.preventDefault();
      if (confirmExit) render();
      else next();
    } else if (e.key === "ArrowLeft") {
      e.stopPropagation();
      e.preventDefault();
      if (confirmExit) render();
      else back();
    } else if (e.key === "Tab" && card.contains(document.activeElement)) {
      // focus trap: Tab cycles the card's buttons
      const btns = [...card.querySelectorAll<HTMLElement>("button")];
      if (!btns.length) return;
      e.preventDefault();
      const cur = btns.indexOf(document.activeElement as HTMLElement);
      btns[(cur + (e.shiftKey ? -1 : 1) + btns.length) % btns.length].focus();
    }
  }

  function onResize(): void {
    if (!paused) render();
  }

  const offLang = on("lang-changed", () => {
    // live language switch mid-tour: current card re-renders in the new language
    if (paused) renderPause();
    else render();
  });

  function finish(): void {
    if (!active) return;
    active = false;
    renderGate.settle();
    stopPausePoll();
    leaveStep();
    document.removeEventListener("keydown", onKey, true);
    window.removeEventListener("resize", onResize);
    offLang();
    root.remove();
    storeSet(DONE_KEY, "1");

    // restore the pre-tour layout
    const w = q(".welcome");
    if (w) w.style.display = "";
    if (isTerminalVisible() !== snap.termVisible) toggleTerminal();
    if (agentPanelCollapsed() !== snap.agentCollapsed) emit("view-switch", "agent");
    const nowView = activeSideView();
    if (snap.sideView === null) {
      // side was collapsed: collapse it back (toggle on the active view)
      if (nowView) emit("view-switch", nowView);
    } else if (nowView !== snap.sideView) {
      emit("view-switch", snap.sideView);
    }
  }

  document.addEventListener("keydown", onKey, true);
  window.addEventListener("resize", onResize);
  render();
}

// ---------------------------------------------------------------- boot hook

/** Auto-start once per profile (v2 key; the v1 key intentionally counts as not-done). */
export function initGuide(): void {
  if (storeGet(DONE_KEY)) return;
  let tries = 0;
  const poll = window.setInterval(() => {
    if (++tries > 50) {
      clearInterval(poll);
      return;
    }
    if (q(".activitybar") && q(".statusbar")) {
      clearInterval(poll);
      window.setTimeout(() => startTour(), 600);
    }
  }, 100);
}
