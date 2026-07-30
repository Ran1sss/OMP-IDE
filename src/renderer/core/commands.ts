/**
 * Command registry — every IDE command lives here.
 * Keybindings are defined exactly once (in the registration) and rendered
 * from this registry everywhere (palette, menus, tooltips).
 */

export interface Command {
  id: string;
  title: string;
  /** e.g. "Ctrl+Shift+P" — display string, also parsed for matching */
  keybinding?: string;
  category?: string;
  handler: () => void;
  /** commands hidden from the palette (internal) */
  hidden?: boolean;
  /** skip when typing in inputs/textarea (default: false for chords with Ctrl) */
  allowInInput?: boolean;
}

const registry = new Map<string, Command>();

export function registerCommand(cmd: Command): void {
  registry.set(cmd.id, cmd);
}


export function allCommands(): Command[] {
  return [...registry.values()].filter((c) => !c.hidden);
}


// ---------------------------------------------------------------- key matching

interface ParsedKey {
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
  key: string;
}

function parseChord(chord: string): ParsedKey {
  const parts = chord.split("+").map((p) => p.trim().toLowerCase());
  const key = parts[parts.length - 1];
  return {
    ctrl: parts.includes("ctrl"),
    shift: parts.includes("shift"),
    alt: parts.includes("alt"),
    key: key === "`" ? "`" : key,
  };
}

function eventKey(e: KeyboardEvent): string {
  const k = e.key.toLowerCase();
  if (k === " ") return "space";
  if (k === "escape") return "esc";
  return k;
}

function chordMatches(p: ParsedKey, e: KeyboardEvent): boolean {
  return (
    p.ctrl === (e.ctrlKey || e.metaKey) &&
    p.shift === e.shiftKey &&
    p.alt === e.altKey &&
    p.key === eventKey(e)
  );
}

/** Two-step chords like "Ctrl+K Z" */
let pendingPrefix: string | null = null;
let pendingTimer: number | undefined;

export function installKeybindings(): void {
  window.addEventListener(
    "keydown",
    (e) => {
      const target = e.target instanceof HTMLElement ? e.target : null;
      const inInput =
        !!target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.isContentEditable ||
          !!target.closest(".monaco-editor") ||
          !!target.closest(".xterm"));

      if (pendingPrefix) {
        const prefix = pendingPrefix;
        pendingPrefix = null;
        clearTimeout(pendingTimer);
        for (const cmd of registry.values()) {
          if (!cmd.keybinding || !cmd.keybinding.includes(" ")) continue;
          const [first, second] = cmd.keybinding.split(" ");
          if (first.toLowerCase() !== prefix) continue;
          if (chordMatches(parseChord(second), e)) {
            e.preventDefault();
            e.stopPropagation();
            cmd.handler();
            return;
          }
        }
        return;
      }

      for (const cmd of registry.values()) {
        if (!cmd.keybinding) continue;
        if (cmd.keybinding.includes(" ")) {
          const [first] = cmd.keybinding.split(" ");
          if (chordMatches(parseChord(first), e)) {
            e.preventDefault();
            pendingPrefix = first.toLowerCase();
            pendingTimer = window.setTimeout(() => (pendingPrefix = null), 1200);
            return;
          }
          continue;
        }
        const parsed = parseChord(cmd.keybinding);
        if (!chordMatches(parsed, e)) continue;
        if (inInput && !cmd.allowInInput && !parsed.ctrl) continue;
        e.preventDefault();
        e.stopPropagation();
        cmd.handler();
        return;
      }
    },
    { capture: true },
  );
}
