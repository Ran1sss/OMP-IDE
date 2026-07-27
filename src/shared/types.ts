/**
 * Shared IPC contract between main, preload and renderer.
 * Every channel is typed here; this file is the single source of truth.
 */

// ---------------------------------------------------------------- fs

export interface DirEntry {
  name: string;
  path: string;
  isDir: boolean;
  isSymlink: boolean;
}

export interface FileStat {
  size: number;
  mtimeMs: number;
  isDir: boolean;
}

export type FsChangeType = "add" | "change" | "unlink" | "addDir" | "unlinkDir";

export interface FsChange {
  type: FsChangeType;
  path: string;
}

export interface ReadFileResult {
  /** utf-8 text, or base64 when binary=true */
  content: string;
  binary: boolean;
  mtimeMs: number;
}

// ---------------------------------------------------------------- pty

export interface PtyCreateOptions {
  id: string;
  cwd: string;
  shell?: string;
  cols: number;
  rows: number;
}

export interface PtyExit {
  id: string;
  exitCode: number;
}

// ---------------------------------------------------------------- search

export interface SearchQuery {
  id: string;
  pattern: string;
  regex: boolean;
  caseSensitive: boolean;
  include: string;
  exclude: string;
  root: string;
}

export interface SearchMatch {
  file: string;
  line: number;
  /** byte column of first submatch start within the line (0-based char approximation) */
  column: number;
  length: number;
  lineText: string;
}

export interface SearchBatch {
  id: string;
  matches: SearchMatch[];
}

export interface SearchDone {
  id: string;
  hitLimit: boolean;
  error?: string;
}

export interface ReplaceEdit {
  file: string;
  line: number;
  column: number;
  matchText: string;
  replaceText: string;
}

export interface ReplaceResult {
  applied: number;
  failed: { file: string; line: number; reason: string }[];
}

// ---------------------------------------------------------------- git

export type GitFileCode = "M" | "A" | "D" | "R" | "C" | "U" | "?";

export interface GitFileStatus {
  path: string;
  origPath?: string;
  index: GitFileCode | " ";
  worktree: GitFileCode | " ";
}

export interface GitStatus {
  isRepo: boolean;
  branch: string;
  ahead: number;
  behind: number;
  files: GitFileStatus[];
}

export interface GitLineRange {
  /** 1-based start line in current buffer */
  start: number;
  /** count of lines; 0 => deletion marker below `start` */
  count: number;
  kind: "added" | "modified" | "deleted";
}

export interface GitCommitInfo {
  hash: string;
  shortHash: string;
  subject: string;
  author: string;
  date: string;
}

// ---------------------------------------------------------------- omp agent

export type OmpStatusState =
  | "unavailable"
  | "starting"
  | "idle"
  | "thinking"
  | "tool"
  | "awaiting-input"
  | "dead";

export interface OmpStatus {
  state: OmpStatusState;
  /** tool name when state === "tool" */
  tool?: string;
  /** human detail (error message when dead / unavailable) */
  detail?: string;
  model?: string;
}

export interface OmpTodoTask {
  id: string;
  content: string;
  status: "pending" | "in_progress" | "completed" | string;
}

export interface OmpTodoPhase {
  id: string;
  name: string;
  tasks: OmpTodoTask[];
}

/** Renderer-facing normalized agent events. */
export type OmpEvent =
  | { kind: "agent-start" }
  | { kind: "agent-end" }
  | { kind: "text-start"; messageId: number }
  | { kind: "text-delta"; messageId: number; delta: string }
  | { kind: "text-end"; messageId: number; text: string }
  | { kind: "thinking-delta"; messageId: number; delta: string }
  | {
      kind: "tool-start";
      toolCallId: string;
      toolName: string;
      args: unknown;
      intent?: string;
    }
  | {
      kind: "tool-end";
      toolCallId: string;
      toolName: string;
      isError: boolean;
      resultText: string;
      /** present for edit/write tools */
      fileEdit?: OmpFileEdit;
    }
  | { kind: "todos"; phases: OmpTodoPhase[] }
  | { kind: "user-message"; text: string; via?: RemoteVia };

/** Attribution for actions arriving through a Telegram bot. */
export interface RemoteVia {
  username: string;
  botName: string;
}

export interface OmpFileEdit {
  path: string;
  op: string;
  oldText: string;
  newText: string;
  diff?: string;
}

// ---------------------------------------------------------------- settings / workspace

export interface Settings {
  accent: string;
  fontSize: number;
  terminalShell: string;
  ompPath: string;
}

export interface LayoutState {
  sideWidth: number;
  agentWidth: number;
  termHeight: number;
  sideCollapsed: boolean;
  agentCollapsed: boolean;
  termCollapsed: boolean;
  activeView: string;
}

export interface RecentWorkspace {
  path: string;
  name: string;
  openedAt: number;
}

// ---------------------------------------------------------------- remote (telegram bridge)

export type RemoteBotState = "off" | "polling" | "relaying" | "auth-error" | "degraded";

export interface RemotePairedUser {
  telegramId: number;
  username: string;
  firstName: string;
  chatId: number;
  pairedAt: number;
}

export interface RemoteBotInfo {
  id: string;
  /** from getMe */
  name: string;
  username: string;
  enabled: boolean;
  state: RemoteBotState;
  /** error detail when state === "auth-error" / "degraded" */
  detail?: string;
  paired: RemotePairedUser[];
  lastActivity: number | null;
  /** messages relayed this app session */
  sessionMessages: number;
}

export interface RemotePairing {
  botId: string;
  code: string;
  /** epoch ms when the code dies */
  expiresAt: number;
}

export type RemoteEventKind =
  | "task"
  | "steer"
  | "answer"
  | "command"
  | "blocked-unauthorized"
  | "watch"
  | "system";

export interface RemoteActivityEvent {
  time: number;
  botId: string;
  botUsername: string;
  sender: string;
  kind: RemoteEventKind;
  detail: string;
}

export interface RemoteState {
  globalEnabled: boolean;
  digestIntervalMs: number;
  /** telegram proxy url ("" = direct); http(s):// or socks(4/5):// */
  proxyUrl: string;
  bots: RemoteBotInfo[];
  /** live pairing if one is showing */
  pairing: RemotePairing | null;
}

// ---------------------------------------------------------------- remote chat watch (group listener)

/** "full" = privacy mode off or bot is admin; "limited" = only mentions/replies/commands arrive */
export type ChatCoverage = "full" | "limited";

export interface RemoteChatInfo {
  botId: string;
  chatId: number;
  title: string;
  kind: "group" | "supergroup";
  coverage: ChatCoverage;
  /** one-line fix hint when coverage === "limited" */
  coverageHint: string;
  watched: boolean;
  /** smart listener toggle — requires watched */
  listener: boolean;
  /** bot was removed/kicked from the chat; the log survives */
  left: boolean;
  discoveredAt: number;
  /** messages logged to JSONL (lifetime) */
  messageCount: number;
  /** smol oneshot evaluations run for this chat (lifetime) */
  evalCount: number;
  lastEvalAt: number | null;
  /** an evaluation batch is in flight — drives the ear-glyph heartbeat */
  evaluating: boolean;
  /** last oneshot failure; null when healthy */
  evalError: string | null;
  /** listener cooldown end (epoch ms) after a proposal; null when not cooling */
  cooldownUntil: number | null;
  /** absolute JSONL log path (shown in the UI) */
  logPath: string;
}

/** One appended JSONL record. Edits append a new entry (edit: true) — history is never rewritten. */
export interface RemoteChatLogEntry {
  /** monotonic per chat, survives rotation */
  seq: number;
  time: number;
  messageId: number;
  authorId: number;
  author: string;
  /** non-text content as typed stubs: "[photo]", "[voice]", … */
  text: string;
  replyTo?: number;
  /** entry records an edit of messageId */
  edit?: boolean;
}

export type RemoteProposalStatus =
  | "pending"
  | "approved"
  | "skipped"
  | "expired"
  /** queue overflow — never shown as a card, logged only */
  | "dropped"
  /** approver unpaired — frozen until a new approver is designated */
  | "no-approver";

export type RemoteProposalSource = "mention" | "reply" | "prefix" | "listener";

export interface RemoteProposal {
  id: string;
  botId: string;
  botUsername: string;
  chatId: number;
  chatTitle: string;
  /** trigger message id — one proposal per message id, ever */
  messageId: number;
  author: string;
  /** quoted trigger message */
  quote: string;
  /** the headline: listener's one-line imperative read, or the raw body on the fast path */
  headline: string;
  source: RemoteProposalSource;
  createdAt: number;
  expiresAt: number;
  status: RemoteProposalStatus;
  /** who decided ("@user" or "IDE") when approved/skipped */
  decidedBy?: string;
  decidedAt?: number;
}

export interface RemoteWatchState {
  chats: RemoteChatInfo[];
  /** pending + recently resolved proposals (markers for the log viewer) */
  proposals: RemoteProposal[];
  /** null = oneshot mechanism available; else the designed disabled reason */
  oneshotUnavailable: string | null;
  /** smol-role binding warning shown on listener toggles; null = healthy */
  smolWarning: string | null;
  /** listener cooldown after a proposal, minutes (default 10) */
  cooldownMinutes: number;
  /** designated approver per botId (telegramId); absent = first paired user */
  approvers: Record<string, number>;
}

// ---------------------------------------------------------------- models (provider & model control)

export type ModelRole = "default" | "smol" | "slow";
export const MODEL_ROLES: ModelRole[] = ["default", "smol", "slow"];

export type ThinkingLevel = "off" | "low" | "med" | "high" | "xhigh" | "max";
export const THINKING_LEVELS: ThinkingLevel[] = ["off", "low", "med", "high", "xhigh", "max"];

export type ThinkingCapability = "supported" | "no-thinking" | "unknown";

export type ProviderTemplateId = "anthropic" | "openai" | "google" | "openrouter" | "custom";

export type ProviderHealth = "unknown" | "ok" | "auth-error" | "network-error" | "rate-limited";

export interface ModelEntry {
  /** provider-scoped model id, e.g. "claude-sonnet-4-5" */
  id: string;
  name: string;
  contextWindow: number | null;
  favorite: boolean;
}

export type ProfileOrigin = "ide" | "imported" | "readonly";

export interface ProviderInfo {
  /** OMP profile name — the models.yml `providers:` key and the selector qualifier */
  id: string;
  template: ProviderTemplateId;
  displayName: string;
  baseUrl: string;
  enabled: boolean;
  health: ProviderHealth;
  healthDetail?: string;
  models: ModelEntry[];
  hasKey: boolean;
  /** ide = created here · imported = found in OMP config · readonly = unparseable/managed outside */
  origin: ProfileOrigin;
  /** note for readonly/imported cards (e.g. "managed outside IDE") */
  note?: string;
}

export interface RoleAssignment {
  /** "providerId/modelId" or null when unassigned */
  selector: string | null;
}

export interface ModelsState {
  providers: ProviderInfo[];
  roles: Record<ModelRole, RoleAssignment>;
  /** active model of the live agent session, from get_state (ground truth) */
  active: { provider: string; id: string; name: string } | null;
  /** switch requested while the agent runs; applied at the session boundary */
  pending: { selector: string; label: string } | null;
  thinking: {
    /** per-role default level (persists with model settings) */
    roles: Record<ModelRole, ThinkingLevel>;
    /** session-only override; null = role default applies */
    sessionOverride: ThinkingLevel | null;
    /** effective = override ?? role default (resolver output, single source) */
    effective: ThinkingLevel;
    /** capability of the ACTIVE model */
    capability: ThinkingCapability;
    /** level change queued to the run boundary */
    pending: ThinkingLevel | null;
    /** one-shot boost armed for the in-flight send; cleared at turn end */
    boost: ThinkingLevel | null;
  };
}

export interface ModelsUsage {
  requests: number;
  inputTokens: number;
  outputTokens: number;
  /** reasoning tokens when omp reports them separately; 0 = not reported */
  reasoningTokens: number;
  /** null when omp does not report usage */
  hasTokenData: boolean;
}

export interface ModelEvent {
  time: number;
  kind: "switch" | "validate" | "health" | "role" | "provider" | "THINK";
  detail: string;
  origin: string;
}

export interface ValidateResult {
  ok: boolean;
  /** e.g. "OK — 47 models" or "401 Unauthorized — key rejected by api.anthropic.com" */
  message: string;
  models: ModelEntry[];
}

// ---------------------------------------------------------------- api surface

export interface IdeApi {
  fs: {
    readDir(path: string): Promise<DirEntry[]>;
    readFile(path: string): Promise<ReadFileResult>;
    writeFile(path: string, content: string): Promise<void>;
    stat(path: string): Promise<FileStat | null>;
    rename(oldPath: string, newPath: string): Promise<void>;
    createFile(path: string): Promise<void>;
    createDir(path: string): Promise<void>;
    trash(path: string): Promise<void>;
    move(src: string, destDir: string): Promise<string>;
    watch(root: string): Promise<void>;
    unwatch(): Promise<void>;
    listAllFiles(root: string): Promise<string[]>;
    onChanged(cb: (changes: FsChange[]) => void): () => void;
  };
  pty: {
    create(opts: PtyCreateOptions): Promise<{ ok: boolean; error?: string }>;
    write(id: string, data: string): Promise<void>;
    resize(id: string, cols: number, rows: number): Promise<void>;
    kill(id: string): Promise<void>;
    onData(cb: (id: string, data: string) => void): () => void;
    onExit(cb: (e: PtyExit) => void): () => void;
  };
  search: {
    start(q: SearchQuery): Promise<void>;
    cancel(id: string): Promise<void>;
    replace(edits: ReplaceEdit[]): Promise<ReplaceResult>;
    onBatch(cb: (b: SearchBatch) => void): () => void;
    onDone(cb: (d: SearchDone) => void): () => void;
  };
  git: {
    status(root: string): Promise<GitStatus>;
    stage(root: string, paths: string[]): Promise<void>;
    unstage(root: string, paths: string[]): Promise<void>;
    commit(root: string, message: string): Promise<string>;
    branches(root: string): Promise<string[]>;
    checkout(root: string, branch: string): Promise<string>;
    discard(root: string, paths: string[]): Promise<void>;
    headContent(root: string, path: string): Promise<string | null>;
    diffRanges(root: string, path: string): Promise<GitLineRange[]>;
    log(root: string, limit: number): Promise<GitCommitInfo[]>;
    init(root: string): Promise<void>;
  };
  omp: {
    start(root: string): Promise<void>;
    prompt(message: string): Promise<void>;
    abort(): Promise<void>;
    newSession(): Promise<void>;
    restart(): Promise<void>;
    dispose(): Promise<void>;
    uiResponse(id: string, payload: Record<string, unknown>): Promise<void>;
    onStatus(cb: (s: OmpStatus) => void): () => void;
    onEvent(cb: (e: OmpEvent) => void): () => void;
    onUiRequest(cb: (req: OmpUiRequest) => void): () => void;
  };
  dialog: {
    openFolder(): Promise<string | null>;
  };
  win: {
    minimize(): void;
    maximize(): void;
    close(): void;
    onMaximized(cb: (max: boolean) => void): () => void;
    openExternal(url: string): void;
    openWorkspaceWindow(path: string): void;
    /** absolute OS path for a DataTransfer File (Electron webUtils); null when unavailable */
    pathForFile(file: File): string | null;
  };
  store: {
    getSettings(): Promise<Settings>;
    setSettings(s: Partial<Settings>): Promise<Settings>;
    getRecents(): Promise<RecentWorkspace[]>;
    addRecent(path: string): Promise<void>;
    getLayout(workspace: string): Promise<LayoutState | null>;
    setLayout(workspace: string, l: LayoutState): Promise<void>;
  };
  remote: {
    getState(): Promise<RemoteState>;
    /** live getMe probe WITHOUT registering — powers the add-bot confirm step */
    checkToken(token: string): Promise<{ ok: true; name: string; username: string } | { ok: false; error: string }>;
    addBot(token: string): Promise<{ ok: true; bot: RemoteBotInfo } | { ok: false; error: string }>;
    removeBot(botId: string): Promise<void>;
    setBotEnabled(botId: string, enabled: boolean): Promise<void>;
    setGlobalEnabled(enabled: boolean): Promise<void>;
    setDigestInterval(ms: number): Promise<void>;
    /** telegram proxy ("" = direct); validates AND live-probes the proxy before committing */
    setProxyUrl(url: string): Promise<{ ok: boolean; error?: string; probe?: string }>;
    startPairing(botId: string): Promise<RemotePairing>;
    cancelPairing(): Promise<void>;
    revokeUser(botId: string, telegramId: number): Promise<void>;
    getActivity(): Promise<RemoteActivityEvent[]>;
    onState(cb: (s: RemoteState) => void): () => void;
    onActivity(cb: (e: RemoteActivityEvent) => void): () => void;
    /** fires on every relayed message so the beacon/card can pulse in sync */
    onRelay(cb: (botId: string) => void): () => void;
    // ---- chat watch (group listener)
    getWatchState(): Promise<RemoteWatchState>;
    setChatWatched(botId: string, chatId: number, watched: boolean): Promise<void>;
    setChatListener(botId: string, chatId: number, listener: boolean): Promise<{ ok: boolean; error?: string }>;
    /** drop a chat from the registry (unwatched or left only); optionally delete its JSONL log */
    removeChat(botId: string, chatId: number, deleteLog: boolean): Promise<{ ok: boolean; error?: string }>;
    /** designate the approver among a bot's paired users */
    setApprover(botId: string, telegramId: number): Promise<void>;
    setCooldownMinutes(minutes: number): Promise<void>;
    /** newest-first page of the chat log; beforeSeq omitted = tail */
    readChatLog(botId: string, chatId: number, beforeSeq?: number, limit?: number): Promise<RemoteChatLogEntry[]>;
    /** resolve a pending proposal from the IDE surface (first decision wins) */
    decideProposal(id: string, approve: boolean): Promise<{ ok: boolean; decidedBy?: string }>;
    onWatchState(cb: (s: RemoteWatchState) => void): () => void;
  };
  models: {
    getState(): Promise<ModelsState>;
    getUsage(): Promise<ModelsUsage>;
    addProvider(input: {
      template: ProviderTemplateId;
      /** profile name (slug) — the selector qualifier; ignored for built-ins */
      name: string;
      apiKey: string;
      baseUrl: string;
    }): Promise<{ ok: true; provider: ProviderInfo } | { ok: false; error: string }>;
    /** rename an OMP profile — propagates atomically to config + references */
    renameProfile(oldName: string, newName: string): Promise<{ ok: boolean; error?: string }>;
    validateProvider(providerId: string): Promise<ValidateResult>;
    removeProvider(providerId: string): Promise<{ needsReassign: ModelRole[] } | null>;
    setProviderEnabled(providerId: string, enabled: boolean): Promise<void>;
    setProviderKey(providerId: string, apiKey: string): Promise<void>;
    addCustomModel(providerId: string, modelId: string): Promise<void>;
    setFavorite(providerId: string, modelId: string, fav: boolean): Promise<void>;
    assignRole(role: ModelRole, selector: string, origin: string): Promise<{ ok: boolean; error?: string }>;
    /** switch the default role — the routine "switch model" action */
    switchModel(selector: string, origin: string): Promise<{ ok: boolean; pending: boolean; error?: string }>;
    /** role default thinking level (persists) */
    setRoleThinking(role: ModelRole, level: ThinkingLevel, origin: string): Promise<void>;
    /** session-only override; null clears back to the role default */
    setSessionThinking(level: ThinkingLevel | null, origin: string): Promise<{ pending: boolean }>;
    /** one-shot boost: raises thinking one level for exactly the next send */
    boostOnce(origin: string): Promise<{ armed: boolean; level: ThinkingLevel | null; pending: boolean }>;
    getEvents(): Promise<ModelEvent[]>;
    onState(cb: (s: ModelsState) => void): () => void;
    onUsage(cb: (u: ModelsUsage) => void): () => void;
    /** active model rejected the thinking param — flipped to no-thinking */
    onThinkRejected(cb: (modelId: string) => void): () => void;
    /** external models.yml edit removed the profile/model an assigned role points at */
    onRolesOrphaned(cb: (roles: ModelRole[]) => void): () => void;
  };
}

export interface OmpUiRequest {
  id: string;
  method: string;
  title?: string;
  message?: string;
  placeholder?: string;
  options?: string[];
}

export const DEFAULT_SETTINGS: Settings = {
  accent: "#55e6c1",
  fontSize: 13,
  terminalShell: "",
  ompPath: "",
};
