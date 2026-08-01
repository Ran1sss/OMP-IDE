/** Minimal settings UI over the JSON store. */

import { el } from "../core/dom";
import { on } from "../core/bus";
import { state } from "../core/state";
import { toast } from "../core/ui";
import { refreshCrumbs } from "./editor";
import { applyMotion } from "../core/motion";
import { startTour } from "./guide";
import { t, applyLang, resolveLang } from "../core/i18n";
import type { Settings } from "../../shared/types";

let settingsClose: (() => void) | null = null;

/** raw field snapshot — carries unsaved edits across a live language switch */
interface SettingsDraft {
  accent: string; font: string; shell: string; omp: string; stall: string;
  crumb: string; switcher: string; motion: string; glass: string; lang: string;
}

export function openSettingsDialog(initial?: SettingsDraft): void {
  // singleton: re-invoking closes the existing dialog first
  settingsClose?.();
  const overlay = el("div", { class: "overlay centered" });
  let offLang: (() => void) | null = null;
  const close = () => {
    offLang?.();
    offLang = null;
    if (settingsClose === close) settingsClose = null;
    overlay.classList.remove("visible");
    setTimeout(() => overlay.remove(), 170);
  };
  settingsClose = close;

  const accentInput = el("input", { class: "input mono", value: initial?.accent ?? state.settings.accent }) as HTMLInputElement;
  const fontInput = el("input", { class: "input mono", type: "number", value: initial?.font ?? String(state.settings.fontSize) }) as HTMLInputElement;
  const shellInput = el("input", { class: "input mono", value: initial?.shell ?? state.settings.terminalShell, placeholder: t("set.shellPh") }) as HTMLInputElement;
  const ompInput = el("input", { class: "input mono", value: initial?.omp ?? state.settings.ompPath, placeholder: t("set.ompPh") }) as HTMLInputElement;
  const stallInput = el("input", { class: "input mono", type: "number", value: initial?.stall ?? String(state.settings.stallSeconds) }) as HTMLInputElement;
  const crumbSelect = el("select", { class: "input" }) as HTMLSelectElement;
  for (const [value, label] of [
    ["auto", t("set.crumbAuto")],
    ["on", t("set.crumbOn")],
    ["off", t("set.crumbOff")],
  ] as const) {
    const opt = el("option", { text: label }) as HTMLOptionElement;
    opt.value = value;
    crumbSelect.append(opt);
  }
  crumbSelect.value = initial?.crumb ?? state.settings.breadcrumbs;

  const switcherSelect = el("select", { class: "input" }) as HTMLSelectElement;
  for (const [value, label] of [
    ["mru", t("set.switcherMru")],
    ["strip", t("set.switcherStrip")],
  ] as const) {
    switcherSelect.append(el("option", { value, text: label }));
  }
  switcherSelect.value = initial?.switcher ?? state.settings.tabSwitcher;

  const motionSelect = el("select", { class: "input" }) as HTMLSelectElement;
  for (const [value, label] of [
    ["full", t("set.motionFull")],
    ["events", t("set.motionEvents")],
    ["minimal", t("set.motionMinimal")],
  ] as const) {
    motionSelect.append(el("option", { value, text: label }));
  }
  motionSelect.value = initial?.motion ?? state.settings.motion;

  const glassSelect = el("select", { class: "input" }) as HTMLSelectElement;
  for (const [value, label] of [
    ["off", t("set.glassOff")],
    ["on", t("set.glassOn")],
  ] as const) {
    glassSelect.append(el("option", { value, text: label }));
  }
  glassSelect.value = initial?.glass ?? (state.settings.reduceTransparency ? "on" : "off");

  // UI language (remote-fix 4): global, default = OS locale
  const langSelect = el("select", { class: "input" }) as HTMLSelectElement;
  for (const [value, label] of [
    ["auto", t("set.langAuto")],
    ["ru", "Русский"],
    ["en", "English"],
  ] as const) {
    langSelect.append(el("option", { value, text: label }));
  }
  langSelect.value = initial?.lang ?? state.settings.uiLang ?? "auto";

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
    // close BEFORE applyLang: lang-changed would otherwise re-open the dialog
    // through the live-rebuild subscription (save = the dialog is done)
    close();
    applyLang(resolveLang(state.settings.uiLang));
    refreshCrumbs();
    toast(t("set.saved"));
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
    el("h2", { text: t("chrome.settings") }),
    el(
      "div",
      { class: "settings-form" },
      field(t("set.accent"), accentInput, t("set.accentHint")),
      field(t("set.fontSize"), fontInput, t("set.fontSizeHint")),
      field(t("set.shell"), shellInput, t("set.shellHint")),
      field(t("set.ompPath"), ompInput, t("set.ompHint")),
      field(t("set.stall"), stallInput, t("set.stallHint")),
      field(t("set.crumbs"), crumbSelect, t("set.crumbsHint")),
      field(t("set.tabOrder"), switcherSelect, t("set.tabOrderHint")),
      field(t("set.motion"), motionSelect, t("set.motionHint")),
      field(t("set.transparency"), glassSelect, t("set.transparencyHint")),
      field(t("set.language"), langSelect, ""),
      field(
        t("set.tour"),
        el("button", {
          class: "btn",
          text: t("set.tourBtn"),
          onClick: () => {
            close();
            startTour();
          },
        }),
        t("set.tourHint"),
      ),
    ),
    el(
      "div",
      { class: "dialog-actions" },
      el("button", { class: "btn", text: t("ui.cancel"), onClick: close }),
      el("button", { class: "btn btn-primary", text: t("ui.save"), onClick: () => void save() }),
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
  // live language switch (e.g. from the Remote header selector) rebuilds the
  // open dialog in the new language, carrying unsaved edits (audit Part B)
  offLang = on("lang-changed", () => {
    const draft: SettingsDraft = {
      accent: accentInput.value, font: fontInput.value, shell: shellInput.value,
      omp: ompInput.value, stall: stallInput.value, crumb: crumbSelect.value,
      switcher: switcherSelect.value, motion: motionSelect.value,
      glass: glassSelect.value, lang: langSelect.value,
    };
    close();
    openSettingsDialog(draft);
  });
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
