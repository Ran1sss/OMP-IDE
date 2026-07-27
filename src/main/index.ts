import { app, BrowserWindow, ipcMain, dialog, shell, Menu } from "electron";
import { join } from "node:path";
import { registerFsHandlers, disposeWatchers } from "./fs-service";
import { registerPtyHandlers, disposePtys } from "./pty-service";
import { registerSearchHandlers } from "./search-service";
import { registerGitHandlers } from "./git-service";
import { registerOmpHandlers, disposeOmp } from "./omp-service";
import { registerStoreHandlers } from "./store-service";
import { registerRemoteHandlers, disposeRemote } from "./remote/manager";
import { registerModelsHandlers, disposeModels } from "./models/manager";
import { hydrateEnvFromRegistry } from "./env-hydrate";

// Must run before any module resolves provider keys or spawns omp children.
hydrateEnvFromRegistry();

const windows = new Set<BrowserWindow>();

// The default menu owns Ctrl+W/Ctrl+R accelerators; all keybindings live in the renderer registry.
Menu.setApplicationMenu(null);

function createWindow(workspacePath?: string) {
  const win = new BrowserWindow({
    width: 1500,
    height: 920,
    minWidth: 1280,
    minHeight: 760,
    frame: false,
    backgroundColor: "#05060a",
    show: false,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

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
  registerStoreHandlers(ipcMain);
  registerRemoteHandlers(ipcMain);
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

  createWindow();
});

let quitting = false;
app.on("window-all-closed", () => {
  if (quitting) return;
  quitting = true;
  disposeWatchers();
  disposePtys();
  // Flush the "IDE closed, task interrupted" broadcast before the agent dies.
  void disposeRemote().finally(() => {
    disposeModels();
    disposeOmp();
    app.quit();
  });
});
