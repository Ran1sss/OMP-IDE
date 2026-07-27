/** Shared UI primitives: dialogs, toasts, context menus, input prompts. */

import { el, clear, svgIcon } from "./dom";
import { I } from "./icons";

// ---------------------------------------------------------------- toasts

let toastStack: HTMLElement | null = null;

export function toast(message: string, opts: { crit?: boolean } = {}): void {
  if (!toastStack) {
    toastStack = el("div", { class: "toast-stack" });
    document.body.append(toastStack);
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
    onClick: () => node.remove(),
  });
  closeBtn.append(svgIcon(I.close));
  node.append(closeBtn);
  toastStack.append(node);
  if (!opts.crit) setTimeout(() => node.remove(), 5000);
}

// ---------------------------------------------------------------- dialogs

export interface ConfirmOptions {
  title: string;
  message: string;
  confirmLabel?: string;
  danger?: boolean;
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
    text: opts.confirmLabel ?? "Confirm",
    onClick: () => done(true),
  });
  const cancelBtn = el("button", { class: "btn", text: "Cancel", onClick: () => done(false) });
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
  cancelBtn.focus(); // destructive default: Cancel; synchronous — rAF throttles when occluded
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
      el("button", { class: "btn", text: "Cancel", onClick: () => done(null) }),
      el("button", {
        class: "btn btn-primary",
        text: opts.confirmLabel ?? "OK",
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
      el("button", { class: "btn", text: "Cancel", onClick: () => done(null) }),
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
