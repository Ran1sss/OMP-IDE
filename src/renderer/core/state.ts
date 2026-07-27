import type { Settings } from "../../shared/types";
import { DEFAULT_SETTINGS } from "../../shared/types";

/** Global workspace state — single source of truth for root + settings. */

export const state = {
  root: null as string | null,
  settings: { ...DEFAULT_SETTINGS } as Settings,
  /** recently opened files, most recent first (fuzzy-opener ranking) */
  recentFiles: [] as string[],
  zen: false,
};

export const SEP = navigator.platform.startsWith("Win") ? "\\" : "/";

export function normPath(p: string): string {
  return p.replace(/\//g, SEP).replace(/\\/g, SEP);
}

export function joinPath(...parts: string[]): string {
  return parts
    .map((p, i) => (i === 0 ? p.replace(/[\\/]+$/, "") : p.replace(/^[\\/]+|[\\/]+$/g, "")))
    .filter(Boolean)
    .join(SEP);
}

export function baseName(p: string): string {
  const n = normPath(p);
  const i = n.lastIndexOf(SEP);
  return i < 0 ? n : n.slice(i + 1);
}

export function dirName(p: string): string {
  const n = normPath(p);
  const i = n.lastIndexOf(SEP);
  return i <= 0 ? n : n.slice(0, i);
}

/** workspace-relative display path with forward slashes */
export function relPath(p: string): string {
  const n = normPath(p);
  if (state.root && n.startsWith(normPath(state.root) + SEP)) {
    return n.slice(normPath(state.root).length + 1).replace(/\\/g, "/");
  }
  if (state.root && n === normPath(state.root)) return "";
  return n.replace(/\\/g, "/");
}

export function noteRecentFile(path: string) {
  const n = normPath(path);
  state.recentFiles = [n, ...state.recentFiles.filter((f) => f !== n)].slice(0, 60);
}

const EXT_LANG: Record<string, string> = {
  ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
  js: "javascript", jsx: "javascript", mjs: "javascript", cjs: "javascript",
  json: "json", jsonc: "json",
  css: "css", scss: "scss", less: "less",
  html: "html", htm: "html", xml: "xml", svg: "xml", vue: "html",
  md: "markdown", markdown: "markdown",
  py: "python", rs: "rust", go: "go", java: "java", kt: "kotlin",
  c: "c", h: "c", cpp: "cpp", hpp: "cpp", cc: "cpp", cs: "csharp",
  rb: "ruby", php: "php", swift: "swift", lua: "lua", r: "r",
  sh: "shell", bash: "shell", zsh: "shell",
  ps1: "powershell", psm1: "powershell",
  bat: "bat", cmd: "bat",
  yml: "yaml", yaml: "yaml", toml: "ini", ini: "ini", cfg: "ini", conf: "ini",
  sql: "sql", graphql: "graphql", proto: "protobuf",
  dockerfile: "dockerfile", tf: "hcl",
};

export function languageForPath(path: string): string {
  const b = baseName(path).toLowerCase();
  if (b === "dockerfile") return "dockerfile";
  const i = b.lastIndexOf(".");
  const ext = i < 0 ? "" : b.slice(i + 1);
  return EXT_LANG[ext] ?? "plaintext";
}

const IMAGE_EXT: Record<string, string> = {
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
  webp: "image/webp", bmp: "image/bmp", ico: "image/x-icon", avif: "image/avif",
  svg: "image/svg+xml",
};

export function imageMime(path: string): string | null {
  const b = baseName(path).toLowerCase();
  const i = b.lastIndexOf(".");
  const ext = i < 0 ? "" : b.slice(i + 1);
  return IMAGE_EXT[ext] ?? null;
}
