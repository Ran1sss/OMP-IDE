/** Minimal settings UI over the JSON store. */

import { el } from "../core/dom";
import { state } from "../core/state";
import { toast } from "../core/ui";
import { refreshCrumbs } from "./editor";
import { applyMotion } from "../core/motion";
import { t, applyLang, resolveLang } from "../core/i18n";
import type { Settings } from "../../shared/types";

let settingsClose: (() => void) | null = null;

export function openSettingsDialog(): void {
  // singleton: re-invoking closes the existing dialog first
  settingsClose?.();
  const overlay = el("div", { class: "overlay centered" });
  const close = () => {
    if (settingsClose === close) settingsClose = null;
    overlay.classList.remove("visible");
    setTimeout(() => overlay.remove(), 170);
  };
  settingsClose = close;

  const accentInput = el("input", { class: "input mono", value: state.settings.accent }) as HTMLInputElement;
  const fontInput = el("input", { class: "input mono", type: "number", value: String(state.settings.fontSize) }) as HTMLInputElement;
  const shellInput = el("input", { class: "input mono", value: state.settings.terminalShell, placeholder: "powershell.exe (default)" }) as HTMLInputElement;
  const ompInput = el("input", { class: "input mono", value: state.settings.ompPath, placeholder: "resolved from PATH" }) as HTMLInputElement;
  const stallInput = el("input", { class: "input mono", type: "number", value: String(state.settings.stallSeconds) }) as HTMLInputElement;
  const crumbSelect = el("select", { class: "input" }) as HTMLSelectElement;
  for (const [value, label] of [
    ["auto", "Auto — only when a symbol trail can show"],
    ["on", "On — always"],
    ["off", "Off"],
  ] as const) {
    const opt = el("option", { text: label }) as HTMLOptionElement;
    opt.value = value;
    crumbSelect.append(opt);
  }
  crumbSelect.value = state.settings.breadcrumbs;

  const switcherSelect = el("select", { class: "input" }) as HTMLSelectElement;
  for (const [value, label] of [
    ["mru", "Most recently used (hold Ctrl for switcher)"],
    ["strip", "Tab-strip order (plain cycle)"],
  ] as const) {
    switcherSelect.append(el("option", { value, text: label }));
  }
  switcherSelect.value = state.settings.tabSwitcher;

  const motionSelect = el("select", { class: "input" }) as HTMLSelectElement;
  for (const [value, label] of [
    ["full", "Full — events + ambient atmosphere"],
    ["events", "Events — Kinetic Reactor only, no ambient"],
    ["minimal", "Minimal — color snaps, no movement"],
  ] as const) {
    motionSelect.append(el("option", { value, text: label }));
  }
  motionSelect.value = state.settings.motion;

  const glassSelect = el("select", { class: "input" }) as HTMLSelectElement;
  for (const [value, label] of [
    ["off", "Glass — floating layers blur (default)"],
    ["on", "Reduce transparency — opaque surfaces"],
  ] as const) {
    glassSelect.append(el("option", { value, text: label }));
  }
  glassSelect.value = state.settings.reduceTransparency ? "on" : "off";

  // UI language (remote-fix 4): global, default = OS locale
  const langSelect = el("select", { class: "input" }) as HTMLSelectElement;
  for (const [value, label] of [
    ["auto", t("set.langAuto")],
    ["ru", "Русский"],
    ["en", "English"],
  ] as const) {
    langSelect.append(el("option", { value, text: label }));
  }
  langSelect.value = state.settings.uiLang ?? "auto";

  const save = async () => {
    const stallRaw = parseInt(stallInput.value, 10);
    const crumbRaw = crumbSelect.value;
    const patch: Partial<Settings> = {
      accent: accentInput.value.trim() || "#34e0f7",
      fontSize: Math.max(9, Math.min(28, parseInt(fontInput.value, 10) || 13)),
      terminalShell: shellInput.value.trim(),
      ompPath: ompInput.value.trim(),
      // 0 disables the stall nudge entirely; anything else clamps to ≥5 s
      stallSeconds: Number.isNaN(stallRaw) ? 20 : stallRaw === 0 ? 0 : Math.max(5, stallRaw),
      breadcrumbs: crumbRaw === "auto" || crumbRaw === "off" ? crumbRaw : "on",
      tabSwitcher: switcherSelect.value === "strip" ? "strip" : "mru",
      motion: motionSelect.value === "events" || motionSelect.value === "minimal" ? motionSelect.value : "full",
      reduceTransparency: glassSelect.value === "on",
      uiLang: langSelect.value === "ru" || langSelect.value === "en" ? langSelect.value : "auto",
    };
    state.settings = await window.ide.store.setSettings(patch);
    applyAccent(state.settings.accent);
    applyMotion(state.settings.motion, state.settings.reduceTransparency);
    applyLang(resolveLang(state.settings.uiLang));
    refreshCrumbs();
    toast("Settings saved");
    close();
  };

  const field = (label: string, input: HTMLElement, note?: string) =>
    el(
      "div",
      { class: "sf-field" },
      el("label", { text: label }),
      input,
      note ? el("span", { class: "sf-note", text: note }) : null,
    );

  const dialog = el(
    "div",
    { class: "dialog", style: { minWidth: "440px" } },
    el("h2", { text: "Settings" }),
    el(
      "div",
      { class: "settings-form" },
      field("Theme accent (agent color)", accentInput, "Hex color; drives the energy palette"),
      field("Editor font size", fontInput, "9–28 px, also Ctrl+= / Ctrl+-"),
      field("Terminal shell", shellInput, "Full path to shell executable; blank = system default"),
      field("omp binary path", ompInput, "Blank = resolve from PATH. Restart the agent after changing."),
      field("Agent stall warning (seconds)", stallInput, "Nudge card when the model streams nothing. 0 = off, minimum 5. Default 20."),
      field("Breadcrumbs", crumbSelect, "Auto hides the bar when only the file path would show (non-TS/JS files)."),
      field("Ctrl+Tab order", switcherSelect, "MRU shows a switcher while Ctrl is held (2-tab groups always plain-cycle)."),
      field("Motion", motionSelect, "Ambient nebulae pause on blur/battery; OS reduced-motion demotes Full to Events."),
      field("Transparency", glassSelect, "Reduce = every glass surface goes opaque. Auto-engages when Motion is Minimal."),
      field(t("set.language"), langSelect, ""),
    ),
    el(
      "div",
      { class: "dialog-actions" },
      el("button", { class: "btn", text: "Cancel", onClick: close }),
      el("button", { class: "btn btn-primary", text: "Save", onClick: () => void save() }),
    ),
  );
  overlay.append(dialog);
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) close();
  });
  overlay.addEventListener("keydown", (e) => {
    if (e.key === "Escape") close();
  });
  document.body.append(overlay);
  accentInput.focus();
  requestAnimationFrame(() => overlay.classList.add("visible"));
}

export function applyAccent(hex: string): void {
  if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return;
  const root = document.documentElement;
  root.style.setProperty("--energy", hex);
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  root.style.setProperty("--energy-15", `rgba(${r}, ${g}, ${b}, 0.15)`);
  root.style.setProperty("--energy-25", `rgba(${r}, ${g}, ${b}, 0.25)`);
  root.style.setProperty("--energy-40", `rgba(${r}, ${g}, ${b}, 0.4)`);
  root.style.setProperty("--energy-60", `rgba(${r}, ${g}, ${b}, 0.6)`);
  root.style.setProperty("--energy-85", `rgba(${r}, ${g}, ${b}, 0.85)`);
}
