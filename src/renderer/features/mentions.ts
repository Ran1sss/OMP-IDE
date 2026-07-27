/**
 * File mentions: chip model for the agent prompt input, drag ghost shared by
 * tabs and tree rows, drop-target wiring, serialization into the send path.
 * Mentions are a user act — all accents are --power blue.
 */

import { el, clear, svgIcon } from "../core/dom";
import { I } from "../core/icons";
import { on } from "../core/bus";
import { state, normPath, baseName, relPath, SEP } from "../core/state";
import { toast } from "../core/ui";

export const MENTION_MIME = "application/x-omp-file-ref";

export interface MentionRef {
  /** absolute, normalized */
  path: string;
  kind: "file" | "folder";
}

interface Chip extends MentionRef {
  missing: boolean;
  el: HTMLElement;
}

// ---------------------------------------------------------------- icons

const CODE_EXT: Record<string, true> = {
  ts: true, tsx: true, js: true, jsx: true, mjs: true, cjs: true, py: true, rs: true,
  go: true, java: true, c: true, h: true, cpp: true, cs: true, rb: true, php: true,
  sh: true, ps1: true, lua: true, swift: true, kt: true,
};
const IMG_EXT: Record<string, true> = {
  png: true, jpg: true, jpeg: true, gif: true, webp: true, bmp: true, ico: true, svg: true, avif: true,
};

function glyphFor(ref: MentionRef): HTMLElement {
  if (ref.kind === "folder") return svgIcon(I.folder);
  const b = baseName(ref.path);
  const i = b.lastIndexOf(".");
  const ext = i < 0 ? "" : b.slice(i + 1).toLowerCase();
  if (IMG_EXT[ext]) return svgIcon(I.fileImage);
  if (CODE_EXT[ext]) return svgIcon(I.fileCode);
  return svgIcon(I.file);
}

function chipLabel(ref: MentionRef): string {
  return ref.kind === "folder" ? `${baseName(ref.path)}/` : baseName(ref.path);
}

// ---------------------------------------------------------------- drag ghost (shared)

let ghostEl: HTMLElement | null = null;

/**
 * Attach the custom drag image — the would-be chip itself — to a dragstart.
 * Shared by editor tabs and tree rows.
 */
export function setMentionDragData(e: DragEvent, refs: MentionRef[]): void {
  if (!e.dataTransfer || !refs.length) return;
  e.dataTransfer.setData(MENTION_MIME, JSON.stringify(refs));
  ghostEl?.remove();
  const first = refs[0];
  ghostEl = el("div", { class: "mention-ghost" }, glyphFor(first), el("span", { text: chipLabel(first) }));
  if (refs.length > 1) ghostEl.append(el("span", { class: "mg-count", text: `+${refs.length - 1}` }));
  document.body.append(ghostEl);
  e.dataTransfer.setDragImage(ghostEl, 12, 12);
  // remove after the browser has snapshotted it
  setTimeout(() => {
    ghostEl?.remove();
    ghostEl = null;
  });
}

// ---------------------------------------------------------------- chip store (input view model)

let chips: Chip[] = [];
let stripEl: HTMLElement | null = null;
let openFile: ((path: string) => void) | null = null;

function renderChipInto(host: HTMLElement, ref: MentionRef, opts: { removable: boolean; missing?: boolean }): HTMLElement {
  const chip = el(
    "span",
    {
      class: `mention-chip${opts.missing ? " missing" : ""}`,
      title: opts.missing ? `${relPath(ref.path)} — missing (deleted on disk)` : relPath(ref.path),
      onClick: () => {
        if (ref.kind === "file" && openFile) openFile(ref.path);
      },
    },
    glyphFor(ref),
    el("span", { class: "mc-label", text: chipLabel(ref) }),
  );
  if (opts.removable) {
    const x = el("span", {
      class: "mc-x",
      title: "Remove mention",
      onClick: (e) => {
        e.stopPropagation();
        removeChip(ref.path);
      },
    });
    x.append(svgIcon(I.close));
    chip.append(x);
  }
  host.append(chip);
  return chip;
}

function refreshStrip(): void {
  if (!stripEl) return;
  stripEl.style.display = chips.length ? "" : "none";
}

export function addMention(ref: MentionRef): void {
  if (!stripEl) return;
  const n = normPath(ref.path);
  const existing = chips.find((c) => c.path === n);
  if (existing) {
    // dedup: pulse the existing chip
    existing.el.classList.remove("pulse");
    void existing.el.offsetWidth;
    existing.el.classList.add("pulse");
    setTimeout(() => existing.el.classList.remove("pulse"), 300);
    return;
  }
  const node = renderChipInto(stripEl, { ...ref, path: n }, { removable: true });
  node.classList.add("land");
  node.addEventListener("animationend", () => node.classList.remove("land"), { once: true });
  chips.push({ path: n, kind: ref.kind, missing: false, el: node });
  refreshStrip();
}

function removeChip(path: string): void {
  const i = chips.findIndex((c) => c.path === path);
  if (i < 0) return;
  chips[i].el.remove();
  chips.splice(i, 1);
  refreshStrip();
}

export function removeLastMention(): boolean {
  if (!chips.length) return false;
  removeChip(chips[chips.length - 1].path);
  return true;
}

export function clearMentions(): void {
  chips = [];
  if (stripEl) clear(stripEl);
  refreshStrip();
}

export function hasMentions(): boolean {
  return chips.length > 0;
}

/** snapshot for the transcript rendering at send time */
export function mentionSnapshot(): (MentionRef & { missing: boolean })[] {
  return chips.map((c) => ({ path: c.path, kind: c.kind, missing: c.missing }));
}

/**
 * The one serialization function (every send path uses it): appends a
 * `Files:` line with backticked workspace-relative paths.
 */
export function serializePrompt(text: string): string {
  if (!chips.length) return text;
  const parts = chips.map((c) => {
    const rel = relPath(c.path) + (c.kind === "folder" ? "/" : "");
    return `\`${rel}\`${c.missing ? " (deleted)" : ""}`;
  });
  const line = `Files: ${parts.join(", ")}`;
  return text.trim() ? `${text}\n\n${line}` : line;
}

/** read-only chip strip for the chat transcript */
export function renderMentionChips(refs: (MentionRef & { missing?: boolean })[]): HTMLElement {
  const strip = el("span", { class: "mention-strip readonly" });
  for (const ref of refs) renderChipInto(strip, ref, { removable: false, missing: ref.missing });
  return strip;
}

// ---------------------------------------------------------------- watcher sync

function onFsChanges(changes: { type: string; path: string }[]): void {
  for (const c of changes) {
    const n = normPath(c.path);
    for (const chip of chips) {
      if (chip.path !== n) continue;
      if (c.type === "unlink" || c.type === "unlinkDir") {
        chip.missing = true;
        chip.el.classList.add("missing");
        chip.el.title = `${relPath(chip.path)} — missing (deleted on disk)`;
      } else if (c.type === "add" || c.type === "addDir") {
        // rename lands as unlink+add of different paths; a re-add of the SAME
        // path means the file is back
        chip.missing = false;
        chip.el.classList.remove("missing");
        chip.el.title = relPath(chip.path);
      }
    }
  }
}

// ---------------------------------------------------------------- drop target

function parseRefs(dt: DataTransfer): MentionRef[] | null {
  const raw = dt.getData(MENTION_MIME);
  if (raw) {
    try {
      const arr = JSON.parse(raw) as MentionRef[];
      if (Array.isArray(arr)) return arr.filter((r) => typeof r.path === "string");
    } catch {}
  }
  return null;
}

/** legacy tree drag (omp/path, newline-joined) → file/folder refs, resolved via stat */
async function refsFromTreePaths(raw: string): Promise<MentionRef[]> {
  const refs: MentionRef[] = [];
  for (const p of raw.split("\n")) {
    const path = normPath(p);
    const st = await window.ide.fs.stat(path);
    refs.push({ path, kind: st?.isDir ? "folder" : "file" });
  }
  return refs;
}

function isMentionDrag(dt: DataTransfer | null): boolean {
  if (!dt) return false;
  return dt.types.includes(MENTION_MIME) || dt.types.includes("omp/path") || dt.types.includes("Files");
}

/**
 * Wire the composer as a drop target. `zone` is the visual host (gets the
 * ring), `hint` shows the chip preview while hovering.
 */
export function initMentionInput(opts: {
  strip: HTMLElement;
  zone: HTMLElement;
  openFileAction: (path: string) => void;
}): void {
  stripEl = opts.strip;
  openFile = opts.openFileAction;
  refreshStrip();
  on("fs-changed", onFsChanges);

  const hint = el("span", { class: "drop-hint", style: { display: "none" } });
  opts.zone.append(hint);
  const zone = opts.zone;

  zone.addEventListener("dragover", (e) => {
    if (!isMentionDrag(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    zone.classList.add("drop-armed");
    // preview: internal drags expose the payload types only; label what we can
    const refs = e.dataTransfer ? parseRefs(e.dataTransfer) : null;
    const label = refs?.length
      ? `+ ${chipLabel(refs[0])}${refs.length > 1 ? ` +${refs.length - 1}` : ""}`
      : "+ mention";
    hint.textContent = label;
    hint.style.display = "";
  });
  zone.addEventListener("dragleave", (e) => {
    if (e.target === zone || !zone.contains(e.relatedTarget as Node)) {
      zone.classList.remove("drop-armed", "drop-invalid");
      hint.style.display = "none";
    }
  });
  zone.addEventListener("drop", (e) => {
    if (!isMentionDrag(e.dataTransfer)) return;
    e.preventDefault();
    e.stopPropagation();
    zone.classList.remove("drop-armed", "drop-invalid");
    hint.style.display = "none";
    const dt = e.dataTransfer!;

    const refs = parseRefs(dt);
    if (refs?.length) {
      for (const r of refs) addMention(r);
      return;
    }
    const treePaths = dt.getData("omp/path");
    if (treePaths) {
      void refsFromTreePaths(treePaths).then((refs) => refs.forEach(addMention));
      return;
    }
    // OS file drop from Explorer/Finder
    if (dt.files.length) {
      void handleOsFiles(dt.files, zone);
    }
  });
}

async function handleOsFiles(files: FileList, zone: HTMLElement): Promise<void> {
  const root = state.root ? normPath(state.root) : null;
  let rejected = 0;
  for (const f of files) {
    const abs = window.ide.win.pathForFile(f);
    if (!abs) {
      rejected++;
      continue;
    }
    const n = normPath(abs);
    if (!root || (!n.startsWith(root + SEP) && n !== root)) {
      rejected++;
      continue;
    }
    const st = await window.ide.fs.stat(n);
    addMention({ path: n, kind: st?.isDir ? "folder" : "file" });
  }
  if (rejected) {
    toast("Outside workspace", { crit: true });
    zone.classList.add("drop-invalid");
    setTimeout(() => zone.classList.remove("drop-invalid"), 600);
  }
}
