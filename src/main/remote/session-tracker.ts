/**
 * Tracks the agent session as seen by remotes: files touched with cumulative
 * old→new content (for /diff and /files), final assistant text, elapsed time.
 * Subscribes to the AgentBridge; resets on new-session/agent lifecycle.
 */

import { createTwoFilesPatch } from "diff";
import type { AgentBridge } from "../omp-service";
import type { OmpTodoPhase, OmpStatus } from "../../shared/types";
import type { FileStat } from "./format";

interface TouchedFile {
  /** workspace-relative path with forward slashes */
  path: string;
  /** content before the FIRST agent edit this session */
  original: string;
  /** content after the latest agent edit */
  latest: string;
}

export class SessionTracker {
  private files = new Map<string, TouchedFile>();
  private finalText = "";
  private streamText = "";
  private taskStartedAt: number | null = null;
  private passedCount: number | null = null;

  constructor(private bridge: AgentBridge) {}

  private disposers: (() => void)[] = [];

  attach(): void {
    this.disposers.push(
      this.bridge.onEvent((e) => {
        switch (e.kind) {
          case "agent-start":
            this.taskStartedAt = Date.now();
            this.streamText = "";
            this.finalText = "";
            this.passedCount = null;
            break;
          case "text-start":
            this.streamText = "";
            break;
          case "text-delta":
            this.streamText += e.delta;
            break;
          case "text-end":
            this.finalText = this.streamText || e.text || this.finalText;
            break;
          case "tool-end":
            if (e.fileEdit && !e.isError) {
              const rel = e.fileEdit.path.replace(/\\/g, "/");
              const existing = this.files.get(rel);
              if (existing) existing.latest = e.fileEdit.newText;
              else
                this.files.set(rel, {
                  path: rel,
                  original: e.fileEdit.oldText,
                  latest: e.fileEdit.newText,
                });
            }
            if (!e.isError) {
              const match = /(?:#\s*)?pass(?:ed)?\s*[:=]?\s*(\d+)|(\d+)\s+passed/i.exec(e.resultText);
              const count = Number(match?.[1] ?? match?.[2]);
              if (Number.isFinite(count) && count > 0) this.passedCount = count;
            }
            break;
          case "user-message":
            // a fresh task begins timing when the agent starts, not here
            break;
        }
      }),
    );
  }

  detach(): void {
    for (const d of this.disposers) d();
    this.disposers = [];
  }

  reset(): void {
    this.files.clear();
    this.finalText = "";
    this.streamText = "";
    this.taskStartedAt = null;
    this.passedCount = null;
  }

  get elapsedMs(): number {
    return this.taskStartedAt ? Date.now() - this.taskStartedAt : 0;
  }

  get lastFinalText(): string {
    return this.finalText;
  }

  get lastPassedCount(): number | null {
    return this.passedCount;
  }

  touchedPaths(): string[] {
    return [...this.files.keys()];
  }

  stats(): FileStat[] {
    const out: FileStat[] = [];
    for (const f of this.files.values()) {
      let add = 0;
      let del = 0;
      const patch = createTwoFilesPatch(f.path, f.path, f.original, f.latest, "", "");
      for (const line of patch.split("\n")) {
        if (line.startsWith("+") && !line.startsWith("+++")) add++;
        else if (line.startsWith("-") && !line.startsWith("---")) del++;
      }
      out.push({ path: f.path, add, del });
    }
    return out;
  }

  totals(): { add: number; del: number; files: number } {
    let add = 0;
    let del = 0;
    for (const s of this.stats()) {
      add += s.add;
      del += s.del;
    }
    return { add, del, files: this.files.size };
  }

  /** unified diff for one touched file, or null */
  patchFor(path: string): string | null {
    const f = this.files.get(path);
    if (!f) return null;
    return createTwoFilesPatch(`a/${f.path}`, `b/${f.path}`, f.original, f.latest, "", "");
  }

  snapshot(): { status: OmpStatus | null; phases: OmpTodoPhase[] } {
    return { status: this.bridge.getStatus(), phases: this.bridge.getTodoPhases() };
  }
}
