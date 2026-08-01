import * as esbuild from "esbuild";
import { cpSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, "dist");
mkdirSync(dist, { recursive: true });

const watch = process.argv.includes("--watch");

/** Main process + preload: CommonJS, node platform, externals stay native. */
const mainCtx = {
  entryPoints: [
    { in: join(root, "src/main/index.ts"), out: "main/index" },
    { in: join(root, "src/preload/index.ts"), out: "preload/index" },
  ],
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node20",
  outdir: dist,
  external: ["electron", "@lydell/node-pty", "@vscode/ripgrep"],
  // grammY ships an abort-controller polyfill whose class must keep the name
  // "AbortSignal": node-fetch@2 validates signals by constructor NAME
  // (proto.constructor.name === "AbortSignal"). Without keepNames, any
  // reference to the global AbortSignal elsewhere in the bundle makes esbuild
  // rename the polyfill to AbortSignal2 and every Telegram API call throws
  // "Expected signal to be an instanceof AbortSignal".
  keepNames: true,
  sourcemap: "inline",
  logLevel: "info",
};

/** Renderer: browser bundle. Monaco is loaded via its own AMD-free ESM workers. */
const rendererCtx = {
  entryPoints: [
    { in: join(root, "src/renderer/index.ts"), out: "renderer/index" },
  ],
  bundle: true,
  platform: "browser",
  format: "esm",
  target: "es2022",
  outdir: dist,
  loader: {
    ".css": "css",
  },
  // Font URLs in CSS point at files copied by copyStatic(); leave them untouched.
  external: ["*.woff2", "*.ttf"],
  sourcemap: "inline",
  logLevel: "info",
};

/** Monaco workers must be separate bundles. */
const workerCtx = {
  entryPoints: {
    "renderer/workers/editor.worker": "monaco-editor/editor/editor.worker.js",
    "renderer/workers/json.worker": "monaco-editor/language/json/json.worker.js",
    "renderer/workers/css.worker": "monaco-editor/language/css/css.worker.js",
    "renderer/workers/html.worker": "monaco-editor/language/html/html.worker.js",
    "renderer/workers/ts.worker": "monaco-editor/language/typescript/ts.worker.js",
  },
  bundle: true,
  platform: "browser",
  format: "iife",
  target: "es2022",
  outdir: dist,
  sourcemap: false,
  logLevel: "warning",
};

function copyStatic() {
  cpSync(join(root, "src/renderer/index.html"), join(dist, "renderer/index.html"));
  const fontsOut = join(dist, "renderer/fonts");
  mkdirSync(fontsOut, { recursive: true });
  for (const [pkg, files] of [
    ["@fontsource/sora", ["files/sora-latin-400-normal.woff2", "files/sora-latin-600-normal.woff2", "files/sora-latin-700-normal.woff2", "files/sora-latin-800-normal.woff2"]],
    ["@fontsource/manrope", ["files/manrope-latin-400-normal.woff2", "files/manrope-latin-500-normal.woff2", "files/manrope-latin-600-normal.woff2", "files/manrope-latin-700-normal.woff2", "files/manrope-latin-800-normal.woff2"]],
    ["@fontsource/jetbrains-mono", ["files/jetbrains-mono-latin-400-normal.woff2", "files/jetbrains-mono-latin-500-normal.woff2", "files/jetbrains-mono-latin-700-normal.woff2"]],
  ]) {
    for (const f of files) {
      const src = join(root, "node_modules", pkg, f);
      if (existsSync(src)) cpSync(src, join(fontsOut, f.split("/").pop()));
    }
  }
  // xterm css is imported through esbuild css loader; codicon font for monaco:
  const codicon = join(root, "node_modules/monaco-editor/esm/vs/base/browser/ui/codicons/codicon/codicon.ttf");
  if (existsSync(codicon)) cpSync(codicon, join(dist, "renderer/codicon.ttf"));
}

if (watch) {
  const c1 = await esbuild.context(mainCtx);
  const c2 = await esbuild.context(rendererCtx);
  const c3 = await esbuild.context(workerCtx);
  copyStatic();
  await Promise.all([c1.watch(), c2.watch(), c3.watch()]);
  console.log("watching...");
} else {
  await Promise.all([esbuild.build(mainCtx), esbuild.build(rendererCtx), esbuild.build(workerCtx)]);
  copyStatic();
}
