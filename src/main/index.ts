import { app, BrowserWindow, ipcMain, dialog, shell, Menu } from "electron";
import { join, dirname, resolve } from "node:path";
import { existsSync, statSync } from "node:fs";
import { registerFsHandlers, disposeWatchers } from "./fs-service";
import { registerPtyHandlers, disposePtys } from "./pty-service";
import { registerSearchHandlers } from "./search-service";
import { registerGitHandlers } from "./git-service";
import { registerOmpHandlers, disposeOmp } from "./omp-service";
import { registerSessionHistoryHandlers } from "./session-history";
import { registerStoreHandlers } from "./store-service";
import { registerRemoteHandlers, disposeRemote } from "./remote/manager";
import { registerTeamHandlers, disposeTeam } from "./omp-team/team-service";
import { registerModelsHandlers, disposeModels } from "./models/manager";
import { hydrateEnvFromRegistry } from "./env-hydrate";

// Portable mode: a ".portable" marker next to the executable keeps all user
// data (settings, layouts, recents, bot tokens, caches) in ./data beside the
// exe instead of %APPDATA%\omp-ide. Must run before anything touches userData.
const exeDir = dirname(app.getPath("exe"));
if (existsSync(join(exeDir, ".portable"))) {
  app.setPath("userData", join(exeDir, "data"));
}

// Must run before any module resolves provider keys or spawns omp children.
hydrateEnvFromRegistry();

const windows = new Set<BrowserWindow>();

// The default menu owns Ctrl+W/Ctrl+R accelerators; all keybindings live in the renderer registry.
Menu.setApplicationMenu(null);

// Test-harness mode (dev-only): OMP_IDE_TEST_WINDOW=1 keeps the window
// always-on-top and never background-throttled, so CDP-driven runs don't lose
// rAF-dependent behavior when the window is occluded. No effect otherwise.
const TEST_WINDOW = process.env.OMP_IDE_TEST_WINDOW === "1";

function createWindow(workspacePath?: string) {
  const win = new BrowserWindow({
    width: 1500,
    height: 920,
    minWidth: 1280,
    minHeight: 760,
    frame: false,
    backgroundColor: "#05060a",
    show: false,
    alwaysOnTop: TEST_WINDOW,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: !TEST_WINDOW,
    },
  });
  if (TEST_WINDOW) win.setAlwaysOnTop(true, "screen-saver");

  windows.add(win);
  win.on("closed", () => windows.delete(win));

  win.once("ready-to-show", () => win.show());
  win.on("maximize", () => win.webContents.send("win:maximized", true));
  win.on("unmaximize", () => win.webContents.send("win:maximized", false));

  const query = workspacePath ? `?ws=${encodeURIComponent(workspacePath)}` : "";
  win.loadFile(join(__dirname, "../renderer/index.html"), {
    search: query,
  });
  return win;
}

app.whenReady().then(() => {
  registerFsHandlers(ipcMain);
  registerPtyHandlers(ipcMain);
  registerSearchHandlers(ipcMain);
  registerGitHandlers(ipcMain);
  registerOmpHandlers(ipcMain);
  registerSessionHistoryHandlers(ipcMain);
  registerStoreHandlers(ipcMain);
  registerRemoteHandlers(ipcMain);
  registerTeamHandlers(ipcMain);
  registerModelsHandlers(ipcMain);

  ipcMain.handle("dialog:openFolder", async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const res = await dialog.showOpenDialog(win!, {
      properties: ["openDirectory"],
      title: "Open Folder",
    });
    return res.canceled || res.filePaths.length === 0 ? null : res.filePaths[0];
  });

  ipcMain.on("win:minimize", (e) => BrowserWindow.fromWebContents(e.sender)?.minimize());
  ipcMain.on("win:maximize", (e) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (!w) return;
    w.isMaximized() ? w.unmaximize() : w.maximize();
  });
  ipcMain.on("win:close", (e) => BrowserWindow.fromWebContents(e.sender)?.close());
  ipcMain.on("win:openExternal", (_e, url: string) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
  });
  ipcMain.on("win:openWorkspaceWindow", (_e, path: string) => createWindow(path));

  // CLI: `OMP IDE.exe <folder>` opens that folder as the workspace.
  // Args resolve to absolute paths; the app's own path (electron dev launch
  // passes it first) is never mistaken for a workspace.
  const appPath = resolve(app.getAppPath());
  const dirArg = process.argv
    .slice(1)
    .filter((a) => !a.startsWith("-"))
    .map((a) => resolve(a))
    .find((a) => a !== appPath && existsSync(a) && statSync(a).isDirectory());
  createWindow(dirArg);
});

let quitting = false;
app.on("window-all-closed", () => {
  if (quitting) return;
  quitting = true;
  disposeWatchers();
  disposePtys();
  // Flush the "IDE closed, task interrupted" broadcast before the agent dies.
  void disposeRemote().finally(() => {
    disposeTeam();
    disposeModels();
    disposeOmp();
    app.quit();
  });
});
