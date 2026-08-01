import type { FsChange, OmpStatus } from "../../shared/types";

/** Typed pub/sub bus — the renderer's nervous system. */
export interface BusEvents {
  /** open a file in the editor area */
  "open-file": { path: string; line?: number; column?: number; selectLength?: number; focus?: boolean };
  /** open a read-only side-by-side diff */
  "open-diff": { title: string; path: string; original: string; modified: string; language?: string; live?: boolean };
  /** batched watcher events, already debounced in main */
  "fs-changed": FsChange[];
  /** something touched git state; panels should refresh */
  "git-refresh": void;
  /** active editor cursor / language for the status bar; line/column null = non-text tab (image/preview) or empty group */
  "editor-status": { path: string | null; line: number | null; column: number | null; language: string };
  /** agent status for orb + seam + statusbar */
  "agent-status": OmpStatus;
  /** a file was saved from the editor (user action) */
  "user-saved": string;
  /** the agent edited a file (from tool timeline) */
  "agent-edited": string;
  /** switch the side panel view (or toggle the agent panel) */
  "view-switch": "explorer" | "search" | "outline" | "git" | "remote" | "agent";
  /** panel geometry changed; editors/terminals must relayout */
  "relayout": void;
  /** focus + reveal a path in the explorer */
  "reveal-in-tree": string;
  /** run a global search seeded with this query */
  "seed-search": string;
  /** the consumer-visible active tab changed (focused group id + active key; same-tab re-mounts filtered at the source) */
  "active-tab-changed": void;
  /** the team run state changed (any push) — glance surfaces re-read teamRun() */
  "team-state": void;
  /** UI language switched — subscribers re-apply their fixed strings */
  "lang-changed": void;
}

type Handler<T> = (payload: T) => void;

const handlers = new Map<string, Set<Handler<never>>>();

export function on<K extends keyof BusEvents>(
  event: K,
  handler: Handler<BusEvents[K]>,
): () => void {
  let set = handlers.get(event);
  if (!set) {
    set = new Set();
    handlers.set(event, set);
  }
  set.add(handler as Handler<never>);
  return () => set.delete(handler as Handler<never>);
}

export function emit<K extends keyof BusEvents>(event: K, payload: BusEvents[K]): void {
  const set = handlers.get(event);
  if (!set) return;
  for (const h of [...set]) {
    try {
      (h as Handler<BusEvents[K]>)(payload);
    } catch (err) {
      console.error(`bus handler for "${event}" failed`, err);
    }
  }
}
