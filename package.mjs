/**
 * Portable packaging: assembles a ready-to-run distribution in release/OMP-IDE
 * from the local Electron binary — no electron-builder, no network.
 *
 *   node build.mjs && node package.mjs
 *
 * Layout:
 *   release/OMP-IDE/
 *     OMP IDE.exe                ← renamed electron.exe
 *     resources/app/
 *       package.json             ← main: dist/main/index.js
 *       dist/                    ← esbuild output (main/preload/renderer)
 *       node_modules/            ← ONLY runtime externals (node-pty, ripgrep)
 */

import { cpSync, mkdirSync, rmSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const out = join(root, "release", "OMP-IDE");
const appDir = join(out, "resources", "app");

const electronDist = join(root, "node_modules", "electron", "dist");
if (!existsSync(join(electronDist, "electron.exe"))) {
  console.error("electron.exe not found — run npm install first");
  process.exit(1);
}
if (!existsSync(join(root, "dist", "main", "index.js"))) {
  console.error("dist/ missing — run `node build.mjs` first");
  process.exit(1);
}

console.log("cleaning release/OMP-IDE …");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

console.log("copying electron runtime …");
cpSync(electronDist, out, { recursive: true });
// default_app would take precedence messaging; remove it so resources/app loads
rmSync(join(out, "resources", "default_app.asar"), { force: true });
renameSync(join(out, "electron.exe"), join(out, "OMP IDE.exe"));
// Portable marker: main process redirects userData to ./data next to the exe.
writeFileSync(join(out, ".portable"), "");

console.log("copying app bundles …");
mkdirSync(appDir, { recursive: true });
cpSync(join(root, "dist"), join(appDir, "dist"), { recursive: true });

writeFileSync(
  join(appDir, "package.json"),
  JSON.stringify(
    {
      name: "omp-ide",
      productName: "OMP IDE",
      version: "1.0.0",
      main: "dist/main/index.js",
    },
    null,
    2,
  ),
);

console.log("copying runtime externals …");
// externals of the main bundle (see build.mjs) minus electron itself
const externals = [
  "@lydell/node-pty",
  "@lydell/node-pty-win32-x64",
  "@vscode/ripgrep",
  "@vscode/ripgrep-win32-x64",
];
for (const pkg of externals) {
  const src = join(root, "node_modules", pkg);
  if (!existsSync(src)) {
    console.error(`missing external package: ${pkg}`);
    process.exit(1);
  }
  cpSync(src, join(appDir, "node_modules", pkg), { recursive: true });
}

console.log(`done → ${join(out, "OMP IDE.exe")}`);
