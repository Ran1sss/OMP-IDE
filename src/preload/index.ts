import { contextBridge, ipcRenderer, webUtils } from "electron";
import type {
  IdeApi,
  DirEntry,
  ReadFileResult,
  FileStat,
  FsChange,
  PtyCreateOptions,
  PtyExit,
  SearchQuery,
  SearchBatch,
  SearchDone,
  ReplaceEdit,
  ReplaceResult,
  GitStatus,
  GitLineRange,
  GitCommitInfo,
  OmpStatus,
  OmpEvent,
  OmpUiRequest,
  Settings,
  LayoutState,
  RecentWorkspace,
  RemoteState,
  RemotePairing,
  RemoteActivityEvent,
  RemoteWatchState,
  RemoteChatLogEntry,
  ModelRole,
  ModelsState,
  ModelsUsage,
  ModelEvent,
  ValidateResult,
} from "../shared/types";

function on<T extends unknown[]>(channel: string, cb: (...args: T) => void): () => void {
  const listener = (_e: Electron.IpcRendererEvent, ...args: unknown[]) => cb(...(args as T));
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

const api: IdeApi = {
  fs: {
    readDir: (path): Promise<DirEntry[]> => ipcRenderer.invoke("fs:readDir", path),
    readFile: (path): Promise<ReadFileResult> => ipcRenderer.invoke("fs:readFile", path),
    writeFile: (path, content) => ipcRenderer.invoke("fs:writeFile", path, content),
    stat: (path): Promise<FileStat | null> => ipcRenderer.invoke("fs:stat", path),
    rename: (oldPath, newPath) => ipcRenderer.invoke("fs:rename", oldPath, newPath),
    createFile: (path) => ipcRenderer.invoke("fs:createFile", path),
    createDir: (path) => ipcRenderer.invoke("fs:createDir", path),
    trash: (path) => ipcRenderer.invoke("fs:trash", path),
    move: (src, destDir): Promise<string> => ipcRenderer.invoke("fs:move", src, destDir),
    watch: (root) => ipcRenderer.invoke("fs:watch", root),
    unwatch: () => ipcRenderer.invoke("fs:unwatch"),
    listAllFiles: (root): Promise<string[]> => ipcRenderer.invoke("fs:listAllFiles", root),
    onChanged: (cb) => on<[FsChange[]]>("fs:changed", cb),
  },
  pty: {
    create: (opts: PtyCreateOptions) => ipcRenderer.invoke("pty:create", opts),
    write: (id, data) => ipcRenderer.invoke("pty:write", id, data),
    resize: (id, cols, rows) => ipcRenderer.invoke("pty:resize", id, cols, rows),
    kill: (id) => ipcRenderer.invoke("pty:kill", id),
    onData: (cb) => on<[string, string]>("pty:data", cb),
    onExit: (cb) => on<[PtyExit]>("pty:exit", cb),
  },
  search: {
    start: (q: SearchQuery) => ipcRenderer.invoke("search:start", q),
    cancel: (id) => ipcRenderer.invoke("search:cancel", id),
    replace: (edits: ReplaceEdit[]): Promise<ReplaceResult> =>
      ipcRenderer.invoke("search:replace", edits),
    onBatch: (cb) => on<[SearchBatch]>("search:batch", cb),
    onDone: (cb) => on<[SearchDone]>("search:done", cb),
  },
  git: {
    status: (root): Promise<GitStatus> => ipcRenderer.invoke("git:status", root),
    stage: (root, paths) => ipcRenderer.invoke("git:stage", root, paths),
    unstage: (root, paths) => ipcRenderer.invoke("git:unstage", root, paths),
    commit: (root, message): Promise<string> => ipcRenderer.invoke("git:commit", root, message),
    branches: (root): Promise<string[]> => ipcRenderer.invoke("git:branches", root),
    checkout: (root, branch): Promise<string> => ipcRenderer.invoke("git:checkout", root, branch),
    discard: (root, paths) => ipcRenderer.invoke("git:discard", root, paths),
    headContent: (root, path): Promise<string | null> =>
      ipcRenderer.invoke("git:headContent", root, path),
    diffRanges: (root, path): Promise<GitLineRange[]> =>
      ipcRenderer.invoke("git:diffRanges", root, path),
    log: (root, limit): Promise<GitCommitInfo[]> => ipcRenderer.invoke("git:log", root, limit),
    init: (root) => ipcRenderer.invoke("git:init", root),
  },
  omp: {
    start: (root) => ipcRenderer.invoke("omp:start", root),
    prompt: (message) => ipcRenderer.invoke("omp:prompt", message),
    abort: () => ipcRenderer.invoke("omp:abort"),
    newSession: () => ipcRenderer.invoke("omp:newSession"),
    restart: () => ipcRenderer.invoke("omp:restart"),
    dispose: () => ipcRenderer.invoke("omp:dispose"),
    uiResponse: (id, payload) => ipcRenderer.invoke("omp:uiResponse", id, payload),
    onStatus: (cb) => on<[OmpStatus]>("omp:status", cb),
    onEvent: (cb) => on<[OmpEvent]>("omp:event", cb),
    onUiRequest: (cb) => on<[OmpUiRequest]>("omp:uiRequest", cb),
  },
  dialog: {
    openFolder: (): Promise<string | null> => ipcRenderer.invoke("dialog:openFolder"),
  },
  win: {
    minimize: () => ipcRenderer.send("win:minimize"),
    maximize: () => ipcRenderer.send("win:maximize"),
    close: () => ipcRenderer.send("win:close"),
    onMaximized: (cb) => on<[boolean]>("win:maximized", cb),
    openExternal: (url) => ipcRenderer.send("win:openExternal", url),
    openWorkspaceWindow: (path) => ipcRenderer.send("win:openWorkspaceWindow", path),
    pathForFile: (file) => {
      try {
        return webUtils.getPathForFile(file) || null;
      } catch {
        return null;
      }
    },
  },
  store: {
    getSettings: (): Promise<Settings> => ipcRenderer.invoke("store:getSettings"),
    setSettings: (s): Promise<Settings> => ipcRenderer.invoke("store:setSettings", s),
    getRecents: (): Promise<RecentWorkspace[]> => ipcRenderer.invoke("store:getRecents"),
    addRecent: (path) => ipcRenderer.invoke("store:addRecent", path),
    getLayout: (workspace): Promise<LayoutState | null> =>
      ipcRenderer.invoke("store:getLayout", workspace),
    setLayout: (workspace, l: LayoutState) => ipcRenderer.invoke("store:setLayout", workspace, l),
  },
  remote: {
    getState: (): Promise<RemoteState> => ipcRenderer.invoke("remote:getState"),
    checkToken: (token) => ipcRenderer.invoke("remote:checkToken", token),
    addBot: (token) => ipcRenderer.invoke("remote:addBot", token),
    removeBot: (botId) => ipcRenderer.invoke("remote:removeBot", botId),
    setBotEnabled: (botId, enabled) => ipcRenderer.invoke("remote:setBotEnabled", botId, enabled),
    setGlobalEnabled: (enabled) => ipcRenderer.invoke("remote:setGlobalEnabled", enabled),
    setDigestInterval: (ms) => ipcRenderer.invoke("remote:setDigestInterval", ms),
    setProxyUrl: (url) => ipcRenderer.invoke("remote:setProxyUrl", url),
    startPairing: (botId): Promise<RemotePairing> => ipcRenderer.invoke("remote:startPairing", botId),
    cancelPairing: () => ipcRenderer.invoke("remote:cancelPairing"),
    revokeUser: (botId, telegramId) => ipcRenderer.invoke("remote:revokeUser", botId, telegramId),
    getActivity: (): Promise<RemoteActivityEvent[]> => ipcRenderer.invoke("remote:getActivity"),
    onState: (cb) => on<[RemoteState]>("remote:state", cb),
    onActivity: (cb) => on<[RemoteActivityEvent]>("remote:activity", cb),
    onRelay: (cb) => on<[string]>("remote:relay", cb),
    getWatchState: (): Promise<RemoteWatchState> => ipcRenderer.invoke("remote:getWatchState"),
    setChatWatched: (botId, chatId, watched) =>
      ipcRenderer.invoke("remote:setChatWatched", botId, chatId, watched),
    setChatListener: (botId, chatId, listener) =>
      ipcRenderer.invoke("remote:setChatListener", botId, chatId, listener),
    removeChat: (botId, chatId, deleteLog) =>
      ipcRenderer.invoke("remote:removeChat", botId, chatId, deleteLog),
    setApprover: (botId, telegramId) => ipcRenderer.invoke("remote:setApprover", botId, telegramId),
    setCooldownMinutes: (minutes) => ipcRenderer.invoke("remote:setCooldownMinutes", minutes),
    readChatLog: (botId, chatId, beforeSeq, limit): Promise<RemoteChatLogEntry[]> =>
      ipcRenderer.invoke("remote:readChatLog", botId, chatId, beforeSeq, limit),
    decideProposal: (id, approve) => ipcRenderer.invoke("remote:decideProposal", id, approve),
    onWatchState: (cb) => on<[RemoteWatchState]>("remote:watchState", cb),
  },
  models: {
    getState: (): Promise<ModelsState> => ipcRenderer.invoke("models:getState"),
    getUsage: (): Promise<ModelsUsage> => ipcRenderer.invoke("models:getUsage"),
    addProvider: (input) => ipcRenderer.invoke("models:addProvider", input),
    renameProfile: (oldName, newName) => ipcRenderer.invoke("models:renameProfile", oldName, newName),
    validateProvider: (id): Promise<ValidateResult> => ipcRenderer.invoke("models:validateProvider", id),
    removeProvider: (id) => ipcRenderer.invoke("models:removeProvider", id),
    setProviderEnabled: (id, enabled) => ipcRenderer.invoke("models:setProviderEnabled", id, enabled),
    setProviderKey: (id, key) => ipcRenderer.invoke("models:setProviderKey", id, key),
    addCustomModel: (id, modelId) => ipcRenderer.invoke("models:addCustomModel", id, modelId),
    setFavorite: (id, modelId, fav) => ipcRenderer.invoke("models:setFavorite", id, modelId, fav),
    assignRole: (role, selector, origin) => ipcRenderer.invoke("models:assignRole", role, selector, origin),
    switchModel: (selector, origin) => ipcRenderer.invoke("models:switchModel", selector, origin),
    setRoleThinking: (role, level, origin) => ipcRenderer.invoke("models:setRoleThinking", role, level, origin),
    setSessionThinking: (level, origin) => ipcRenderer.invoke("models:setSessionThinking", level, origin),
    boostOnce: (origin) => ipcRenderer.invoke("models:boostOnce", origin),
    getEvents: (): Promise<ModelEvent[]> => ipcRenderer.invoke("models:getEvents"),
    onState: (cb) => on<[ModelsState]>("models:state", cb),
    onUsage: (cb) => on<[ModelsUsage]>("models:usage", cb),
    onThinkRejected: (cb) => on<[string]>("models:thinkRejected", cb),
    onRolesOrphaned: (cb) => on<[ModelRole[]]>("models:rolesOrphaned", cb),
  },
};

contextBridge.exposeInMainWorld("ide", api);
