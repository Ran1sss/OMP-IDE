/** Shared UI primitives: dialogs, toasts, context menus, input prompts. */

import { el, clear, svgIcon } from "./dom";
import { I } from "./icons";
import { t } from "./i18n";

// ---------------------------------------------------------------- toasts

let toastStack: HTMLElement | null = null;
/** visible toasts by message — repeats pulse the existing one instead of stacking twins */
const liveToasts = new Map<string, { node: HTMLElement; timer: number | undefined }>();

// Every toast is also recorded here so the status-bar bell can re-surface
// transient notices after they fade (see features/notifications.ts).
export interface NotificationEntry {
  message: string;
  crit: boolean;
  at: number;
}
const NOTIF_CAP = 100;
const notifLog: NotificationEntry[] = [];
const notifSubscribers = new Set<() => void>();
function notifyLogChange(): void {
  for (const cb of notifSubscribers) cb();
}

/** newest first */
export function notificationLog(): readonly NotificationEntry[] {
  return notifLog;
}
export function clearNotificationLog(): void {
  notifLog.length = 0;
  notifyLogChange();
}
/** subscribe to log changes (new entry or clear); multiple consumers supported */
export function onNotificationLogChange(cb: () => void): void {
  notifSubscribers.add(cb);
}

export function toast(message: string, opts: { crit?: boolean } = {}): void {
  notifLog.unshift({ message, crit: !!opts.crit, at: Date.now() });
  if (notifLog.length > NOTIF_CAP) notifLog.length = NOTIF_CAP;
  notifyLogChange();
  if (!toastStack) {
    toastStack = el("div", { class: "toast-stack" });
    document.body.append(toastStack);
  }
  const existing = liveToasts.get(message);
  if (existing && existing.node.isConnected) {
    // same message already on screen: pulse it and restart its clock
    existing.node.classList.remove("toast-pulse");
    void existing.node.offsetWidth;
    existing.node.classList.add("toast-pulse");
    if (existing.timer !== undefined) {
      clearTimeout(existing.timer);
      existing.timer = window.setTimeout(() => {
        existing.node.remove();
        liveToasts.delete(message);
      }, 5000);
    }
    return;
  }
  while (toastStack.children.length >= 3) toastStack.firstChild?.remove();
  const node = el(
    "div",
    { class: opts.crit ? "toast crit" : "toast" },
    el("span", { class: "toast-dot" }),
    el("span", { text: message, style: { flex: "1" } }),
  );
  const closeBtn = el("button", {
    class: "icon-btn toast-close",
    title: t("ui.close"),
    onClick: () => {
      node.remove();
      liveToasts.delete(message);
    },
  });
  closeBtn.append(svgIcon(I.close));
  node.append(closeBtn);
  toastStack.append(node);
  const timer = opts.crit
    ? undefined
    : window.setTimeout(() => {
        node.remove();
        liveToasts.delete(message);
      }, 5000);
  liveToasts.set(message, { node, timer });
}
/**
 * User-facing text for a caught error. Electron's ipcRenderer.invoke wraps
 * main-process throws as "Error invoking remote method 'chan': Error: <msg>" —
 * plumbing the user must never see. Strip it; keep the real message.
 */
export function errorText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return raw.replace(/^Error invoking remote method '[^']*':\s*(?:Error:\s*)?/, "");
}

// ---------------------------------------------------------------- dialogs

export interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
  /** Non-destructive confirms may default focus to the action button (Enter confirms). */
  focusConfirm?: boolean;
}

export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  const overlay = el("div", { class: "overlay centered" });
  const done = (v: boolean) => {
    overlay.classList.remove("visible");
    setTimeout(() => overlay.remove(), 170);
    resolve(v);
  };
  const confirmBtn = el("button", {
    class: opts.danger ? "btn btn-danger" : "btn btn-primary",
    text: opts.confirmLabel ?? t("ui.confirm"),
    onClick: () => done(true),
  });
  const cancelBtn = el("button", { class: "btn", text: t("ui.cancel"), onClick: () => done(false) });
  const dialog = el(
    "div",
    { class: "dialog" },
    el("h2", { text: opts.title }),
    el("p", { text: opts.message }),
    el("div", { class: "dialog-actions" }, cancelBtn, confirmBtn),
  );
  overlay.append(dialog);
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) done(false);
  });
  overlay.addEventListener("keydown", (e) => {
    if (e.key === "Escape") done(false);
    if (e.key === "Enter" && document.activeElement === confirmBtn) done(true);
  });
  document.body.append(overlay);
  (opts.focusConfirm && !opts.danger ? confirmBtn : cancelBtn).focus(); // destructive default: Cancel; synchronous — rAF throttles when occluded
  requestAnimationFrame(() => overlay.classList.add("visible"));
  return promise;
}
export interface ChoiceDialogOptions {
  title: string;
  message: string;
  /** rendered left-to-right after Cancel; the LAST one is the primary action */
  choices: { label: string; value: string; danger?: boolean }[];
}

/**
 * Confirm with more than one affirmative action (e.g. Save and Close / Close
 * Anyway). Resolves the chosen value, or null on Cancel/Escape/backdrop.
 * Focus defaults to Cancel — same destructive-default rule as confirmDialog.
 */
export function choiceDialog(opts: ChoiceDialogOptions): Promise<string | null> {
  const { promise, resolve } = Promise.withResolvers<string | null>();
  const overlay = el("div", { class: "overlay centered" });
  const done = (v: string | null) => {
    overlay.classList.remove("visible");
    setTimeout(() => overlay.remove(), 170);
    resolve(v);
  };
  const cancelBtn = el("button", { class: "btn", text: t("ui.cancel"), onClick: () => done(null) });
  const actions = el("div", { class: "dialog-actions" }, cancelBtn);
  opts.choices.forEach((c, i) => {
    actions.append(el("button", {
      class: c.danger ? "btn btn-danger" : i === opts.choices.length - 1 ? "btn btn-primary" : "btn",
      text: c.label,
      onClick: () => done(c.value),
    }));
  });
  const dialog = el(
    "div",
    { class: "dialog" },
    el("h2", { text: opts.title }),
    el("p", { text: opts.message }),
    actions,
  );
  overlay.append(dialog);
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) done(null);
  });
  overlay.addEventListener("keydown", (e) => {
    if (e.key === "Escape") done(null);
  });
  document.body.append(overlay);
  cancelBtn.focus();
  requestAnimationFrame(() => overlay.classList.add("visible"));
  return promise;
}

export interface InputDialogOptions {
  title: string;
  message?: string;
  placeholder?: string;
  value?: string;
  confirmLabel?: string;
}

export function inputDialog(opts: InputDialogOptions): Promise<string | null> {
  const { promise, resolve } = Promise.withResolvers<string | null>();
  const overlay = el("div", { class: "overlay centered" });
  const done = (v: string | null) => {
    overlay.classList.remove("visible");
    setTimeout(() => overlay.remove(), 170);
    resolve(v);
  };
  const input = el("input", {
    class: "input",
    placeholder: opts.placeholder ?? "",
    value: opts.value ?? "",
    onKeyDown: (e) => {
      if (e.key === "Enter") done(input.value.trim() || null);
      if (e.key === "Escape") done(null);
    },
  });
  const dialog = el(
    "div",
    { class: "dialog" },
    el("h2", { text: opts.title }),
    opts.message ? el("p", { text: opts.message }) : null,
    input,
    el(
      "div",
      { class: "dialog-actions" },
      el("button", { class: "btn", text: t("ui.cancel"), onClick: () => done(null) }),
      el("button", {
        class: "btn btn-primary",
        text: opts.confirmLabel ?? t("ui.ok"),
        onClick: () => done(input.value.trim() || null),
      }),
    ),
  );
  overlay.append(dialog);
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) done(null);
  });
  document.body.append(overlay);
  input.focus();
  input.select();
  requestAnimationFrame(() => overlay.classList.add("visible"));
  return promise;
}

export interface FormDialogField {
  key: string;
  label: string;
  placeholder?: string;
  value?: string;
}

export interface FormDialogOptions {
  title: string;
  message?: string;
  fields: FormDialogField[];
  confirmLabel?: string;
}

/**
 * Multi-field input dialog. Tab moves between fields (DOM order), Enter
 * submits from any field, Escape cancels. Submit requires every field
 * non-empty — the first empty one gets focus instead.
 */
export function formDialog(opts: FormDialogOptions): Promise<Record<string, string> | null> {
  const { promise, resolve } = Promise.withResolvers<Record<string, string> | null>();
  const overlay = el("div", { class: "overlay centered" });
  const done = (v: Record<string, string> | null) => {
    overlay.classList.remove("visible");
    setTimeout(() => overlay.remove(), 170);
    resolve(v);
  };
  const inputs = new Map<string, HTMLInputElement>();
  const submit = () => {
    const out: Record<string, string> = {};
    for (const f of opts.fields) {
      const val = inputs.get(f.key)!.value.trim();
      if (!val) {
        inputs.get(f.key)!.focus();
        return;
      }
      out[f.key] = val;
    }
    done(out);
  };
  const form = el("div", { class: "settings-form" });
  for (const f of opts.fields) {
    const input = el("input", {
      class: "input",
      placeholder: f.placeholder ?? "",
      value: f.value ?? "",
      onKeyDown: (e) => {
        if (e.key === "Enter") submit();
        if (e.key === "Escape") done(null);
      },
    }) as HTMLInputElement;
    inputs.set(f.key, input);
    form.append(el("div", { class: "sf-field" }, el("label", { text: f.label }), input));
  }
  const dialog = el(
    "div",
    { class: "dialog", style: { minWidth: "400px" } },
    el("h2", { text: opts.title }),
    opts.message ? el("p", { text: opts.message }) : null,
    form,
    el(
      "div",
      { class: "dialog-actions" },
      el("button", { class: "btn", text: t("ui.cancel"), onClick: () => done(null) }),
      el("button", { class: "btn btn-primary", text: opts.confirmLabel ?? t("ui.ok"), onClick: submit }),
    ),
  );
  overlay.append(dialog);
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) done(null);
  });
  overlay.addEventListener("keydown", (e) => {
    if (e.key === "Escape") done(null);
  });
  document.body.append(overlay);
  inputs.get(opts.fields[0].key)?.focus();
  requestAnimationFrame(() => overlay.classList.add("visible"));
  return promise;
}

/** Select-from-list dialog (used for branch switching & agent UI selects). */
export function selectDialog(title: string, options: string[]): Promise<string | null> {
  const { promise, resolve } = Promise.withResolvers<string | null>();
  const overlay = el("div", { class: "overlay centered" });
  const done = (v: string | null) => {
    overlay.classList.remove("visible");
    setTimeout(() => overlay.remove(), 170);
    resolve(v);
  };
  const list = el("div", { class: "pal-list", style: { maxHeight: "300px", overflowY: "auto" } });
  for (const opt of options) {
    list.append(
      el("div", {
        class: "pal-row",
        text: opt,
        onClick: () => done(opt),
      }),
    );
  }
  const dialog = el(
    "div",
    { class: "dialog", style: { padding: "16px" } },
    el("h2", { text: title }),
    list,
    el(
      "div",
      { class: "dialog-actions" },
      el("button", { class: "btn", text: t("ui.cancel"), onClick: () => done(null) }),
    ),
  );
  overlay.append(dialog);
  overlay.addEventListener("mousedown", (e) => {
    if (e.target === overlay) done(null);
  });
  overlay.addEventListener("keydown", (e) => {
    if (e.key === "Escape") done(null);
  });
  document.body.append(overlay);
  requestAnimationFrame(() => overlay.classList.add("visible"));
  return promise;
}

// ---------------------------------------------------------------- context menu

export interface CtxItem {
  label?: string;
  key?: string;
  danger?: boolean;
  separator?: boolean;
  action?: () => void;
}

let openMenu: HTMLElement | null = null;

export function contextMenu(x: number, y: number, items: CtxItem[]): void {
  closeContextMenu();
  const menu = el("div", { class: "ctx-menu" });
  for (const item of items) {
    if (item.separator) {
      menu.append(el("div", { class: "ctx-sep" }));
      continue;
    }
    menu.append(
      el(
        "div",
        {
          class: item.danger ? "ctx-item danger" : "ctx-item",
          onClick: () => {
            closeContextMenu();
            item.action?.();
          },
        },
        el("span", { text: item.label ?? "" }),
        item.key ? el("span", { class: "ctx-key", text: item.key }) : null,
      ),
    );
  }
  document.body.append(menu);
  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, window.innerWidth - rect.width - 8)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - rect.height - 8)}px`;
  openMenu = menu;
  setTimeout(() => {
    window.addEventListener("mousedown", onGlobalDown, { capture: true });
    window.addEventListener("keydown", onGlobalKey, { capture: true });
  });
}

function onGlobalDown(e: MouseEvent) {
  if (openMenu && !openMenu.contains(e.target as Node)) closeContextMenu();
}
function onGlobalKey(e: KeyboardEvent) {
  if (e.key === "Escape") closeContextMenu();
}

export function closeContextMenu(): void {
  if (!openMenu) return;
  openMenu.remove();
  openMenu = null;
  window.removeEventListener("mousedown", onGlobalDown, { capture: true });
  window.removeEventListener("keydown", onGlobalKey, { capture: true });
}

/**
 * Dialogs bind Escape on their own overlay, which only fires while focus is
 * INSIDE it. Mouse-opened dialogs (Settings via activity bar, Models via chip)
 * leave focus on the opener, so Escape went nowhere. Forward it to the topmost
 * visible overlay — each dialog's own handler keeps its close semantics.
 * Installed once at boot, alongside installKeybindings().
 */
export function installDialogEscape(): void {
  window.addEventListener(
    "keydown",
    (e) => {
      if (e.key !== "Escape") return;
      // NOT ".overlay.visible": the visible class lands via rAF, which is
      // throttled to zero while the window is occluded — the dialog would be
      // un-closeable until repaint. DOM order still gives the topmost overlay.
      const overlays = document.querySelectorAll<HTMLElement>("body > .overlay");
      const top = overlays[overlays.length - 1];
      if (!top || top.contains(e.target as Node)) return; // dialog handles its own
      e.preventDefault();
      top.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
    },
    { capture: true },
  );
}
