/** Minimal settings UI over the JSON store. */

import { el } from "../core/dom";
import { state } from "../core/state";
import { toast } from "../core/ui";
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

  const save = async () => {
    const patch: Partial<Settings> = {
      accent: accentInput.value.trim() || "#55e6c1",
      fontSize: Math.max(9, Math.min(28, parseInt(fontInput.value, 10) || 13)),
      terminalShell: shellInput.value.trim(),
      ompPath: ompInput.value.trim(),
    };
    state.settings = await window.ide.store.setSettings(patch);
    applyAccent(state.settings.accent);
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
}
