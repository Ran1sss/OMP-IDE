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
  /** UTF-16 column within lineText, ready for JavaScript slicing and Monaco (0-based). */
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
  /** author time, epoch ms — renderer formats per UI locale */
  at: number;
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
  | { kind: "agent-end"; aborted?: boolean; failed?: boolean }
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
  | { kind: "user-message"; text: string; via?: RemoteVia }
  /** turn ended in a provider error (stopReason "error" in the final message) */
  | { kind: "turn-error"; provider: string; modelId: string; status: number | null; message: string };

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
  /** silent-model stall warning, seconds until the nudge card; 0 = disabled, min 5 */
  stallSeconds: number;
  /** crumb bar: auto = only when a symbol trail can show (TS/JS), on = always, off = never */
  breadcrumbs: "auto" | "on" | "off";
  /** Ctrl+Tab: mru = hold-Ctrl switcher overlay in most-recently-used order (strip fallback at 2 tabs), strip = EVO-29 strip-order cycling */
  tabSwitcher: "mru" | "strip";
  /** motion system: full = events + ambient atmosphere, events = Kinetic Reactor only, minimal = color/opacity snaps ≤80ms.
   *  OS prefers-reduced-motion makes "full" act as "events" (ambient MUST pause under reduced motion — spec §2). */
  motion: "full" | "events" | "minimal";
  /** nebula glass fallback: true = every glass surface renders opaque (auto-on when motion === "minimal") */
  reduceTransparency: boolean;
  /** UI language: auto = OS locale (ru → Russian, else English); global, not per-workspace */
  uiLang: "auto" | "ru" | "en";
}

/** one past conversation on disk (read-only history browser) */
export interface OmpSessionMeta {
  file: string;
  startedAt: number;
  /** omp's own title line; often empty */
  title: string;
  firstPrompt: string;
  model: string;
  sizeKb: number;
}

export type OmpSessionEntry =
  | { kind: "user"; text: string; at: number }
  | { kind: "assistant"; text: string; at: number }
  | { kind: "tool"; name: string; at: number }
  | { kind: "model"; model: string; at: number }
  | { kind: "notice"; text: string; at: number };

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
  /** pinned rows sort first in the switcher + welcome (persisted) */
  pinned?: boolean;
  /** folder no longer exists on disk (switcher renders dimmed, remove-only) */
  missing?: boolean;
}

// ---------------------------------------------------------------- remote (telegram bridge)

export type RemoteBotState = "off" | "polling" | "relaying" | "auth-error" | "degraded";

export interface RemotePairedUser {
  telegramId: number;
  username: string;
  firstName: string;
  chatId: number;
  pairedAt: number;
  /** Telegram language_code at pairing/last message — localizes fixed bot strings (ru → RU, else EN) */
  languageCode?: string;
  /** designated owner (crown): named in group redirects/owner answers; ≥1 required while users are paired */
  owner?: boolean;
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
  | "dialog"
  | "dialog-guard"
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
  /** telegram proxy url; preserved even while the proxy is switched off */
  proxyUrl: string;
  /** true = Telegram traffic routes through proxyUrl; false = direct */
  proxyEnabled: boolean;
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
  /** Chat Dialogue: answer status questions from non-paired members (default OFF) */
  answerMembers: boolean;
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

/** depleted = key valid, wallet/quota empty (--flare, not --crit) */
export type ProviderHealth = "unknown" | "ok" | "auth-error" | "network-error" | "rate-limited" | "depleted";

export interface ModelEntry {
  /** provider-scoped model id, e.g. "claude-sonnet-4-5" */
  id: string;
  name: string;
  contextWindow: number | null;
  favorite: boolean;
}

export type ProfileOrigin = "ide" | "imported" | "readonly";

/** cached wallet readout; never shown without its age */
export interface BalanceInfo {
  /** parsed numeric value; null when the response was unparseable */
  value: number | null;
  /** currency/unit string as provided by the endpoint (e.g. "USD"); null = none */
  currency: string | null;
  checkedAt: number;
  /** raw body (truncated) for the designed `unparseable response` state */
  raw?: string;
}

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
  /** balance probe URL or base-relative path; "" = no probe, no balance UI */
  balanceEndpoint: string;
  /** last successful/attempted probe; null = never probed or no endpoint */
  balance: BalanceInfo | null;
  /** low-balance warning threshold; null = off */
  lowThreshold: number | null;
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
  };
  /** auto-swap master toggle + per-role opt-outs */
  autoSwap: {
    enabled: boolean;
    roleOptOut: Record<ModelRole, boolean>;
  };
  /** periodic balance poll interval in minutes; 0 = off */
  balancePollMinutes: number;
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
  kind: "switch" | "validate" | "health" | "role" | "provider" | "THINK" | "SWAP" | "balance" | "TEST" | "ENHANCE";
  detail: string;
  origin: string;
}

export interface ValidateResult {
  ok: boolean;
  /** e.g. "OK — 47 models" or "401 Unauthorized — key rejected by api.anthropic.com" */
  message: string;
  models: ModelEntry[];
}

// ---------------------------------------------------------------- api tester

/** wire protocol family for the API tester probe */
export type TesterProtocol = "anthropic" | "openai-chat" | "openai-responses" | "gemini";
export const TESTER_PROTOCOLS: TesterProtocol[] = ["anthropic", "openai-chat", "openai-responses", "gemini"];

export type TesterVerdict =
  | "ok"
  | "auth"
  | "quota"
  | "rate-limited"
  /** HTTP error outside the auth/quota/rate families — provider message shown verbatim */
  | "http-error"
  | "network"
  | "model-mismatch"
  | "unparseable";

export interface TesterTarget {
  /** profile name when testing a profile; null = free-form */
  profileId: string | null;
  baseUrl: string;
  /** free-form only; profile targets resolve the key in main */
  apiKey?: string;
  protocol: TesterProtocol;
  model: string;
  streaming: boolean;
  /** probe timeout; default 30 s */
  timeoutSeconds?: number;
}

export interface TesterResult {
  verdict: TesterVerdict;
  /** null on non-HTTP failures (the layer that failed is in `detail`) */
  httpStatus: number | null;
  /** provider's error message verbatim, or the failed layer for network errors */
  detail: string;
  /** ms; null when the phase never happened */
  ttfbMs: number | null;
  totalMs: number | null;
  /** streaming probes only */
  firstTokenMs: number | null;
  chunkCount: number | null;
  /** from the response's usage block ONLY; null = not reported */
  usage: { input: number | null; output: number | null; reasoning: number | null } | null;
  modelRequested: string;
  /** model id the response claims; null when the response carries none */
  modelReturned: string | null;
  /** request preview with the key REDACTED (never the full key) */
  rawRequest: string;
  /** verbatim response body, pretty-printed when JSON (truncated) */
  rawResponse: string;
  /** echo of the target minus the key (history restore + save-as-profile) */
  target: { profileId: string | null; baseUrl: string; protocol: TesterProtocol; model: string; streaming: boolean };
  at: number;
}

/** «Оценка»: named check ids of the hvoy-style battery */
export type TesterCheckId =
  | "identity"
  | "signature"
  | "consistency"
  | "knowledge"
  | "character"
  | "structured"
  | "protocol"
  | "completeness"
  | "roles"
  | "limit";

export type TesterCheckStatus = "pass" | "fail" | "skip";

export interface TesterCheckResult {
  id: TesterCheckId;
  status: TesterCheckStatus;
  /** engine-technical reason, same register as TesterResult.detail */
  detail: string;
  /** style-fingerprint signal: a fail renders as «подозрение», never proof */
  heuristic: boolean;
  /** raw exchanges backing this check (key redacted) */
  raw: { request: string; response: string }[];
}

export interface TesterBatteryResult {
  kind: "battery";
  checks: TesterCheckResult[];
  passed: number;
  /** ring denominator: checks minus skips — skips NEVER count as passes */
  applicable: number;
  /** passed/applicable, 0-100; 0 when nothing was applicable */
  percent: number;
  /** median TTFB across all battery requests */
  medianTtfbMs: number | null;
  /** output tokens / generation time of the largest ok response */
  tokensPerSec: number | null;
  /** summed over requests; null = the usage block never reported the field */
  inputTokens: number | null;
  outputTokens: number | null;
  cachedTokens: number | null;
  requestCount: number;
  target: TesterResult["target"];
  at: number;
}

/** live row fill-in while the battery runs */
export interface TesterBatteryProgress {
  done: number;
  total: number;
  check: TesterCheckResult;
}

export interface TesterApi {
  /** run one probe; free-form keys live only in this call and the session history */
  run(target: TesterTarget): Promise<TesterResult>;
  /** deep-test every enabled profile (serialized per base URL+key); results stream via onResult */
  runAll(): Promise<void>;
  /** known-model suggestions per protocol (matrix hints) */
  modelHints(): Promise<Record<TesterProtocol, string[]>>;
  /** verdicts land here as they finish (both run and runAll) */
  onResult(cb: (r: TesterResult) => void): () => void;
  /** «Оценка»: run the named check battery — several real sequential requests */
  runBattery(target: TesterTarget): Promise<TesterBatteryResult>;
  /** static battery shape per protocol: request cost + check count (cost honesty) */
  batteryInfo(): Promise<Record<TesterProtocol, { requests: number; checks: number }>>;
  /** battery rows land here as each check completes */
  onBatteryCheck(cb: (p: TesterBatteryProgress) => void): () => void;
}

// ---------------------------------------------------------------- team mode
//
// OMP multi-agent surface (discovered from omp v17.1.3, 2026-07-30):
//   - `task` tool: batch-spawns background subagents (tasks[], agent types);
//     results auto-deliver as async notices into the root session.
//   - `hub` tool: inter-agent messaging (send/wait/jobs/cancel) and parked
//     wait states — the sleep/wake primitive.
//   - Stream visibility: subagent lifecycle appears in the root RPC stream
//     ONLY as task/hub tool_execution frames; there are no dedicated spawn/
//     state frames. The orchestrating agent therefore narrates team state
//     through @@TEAM@@ marker lines (single-line JSON) in its text stream;
//     the main process parses them and drives the board. The IDE never
//     simulates agents.
//   - Capability probe result in this environment (2026-07-30): a trivial
//     scout spawn produced zero model turns ("exited without calling yield
//     after 3 reminders") — solo fallback is the expected live path here.

export type TeamPhase =
  /** lead is assigning roles from the roster to the request (auto-routing) */
  | "route"
  /** dispatch card shown — grace window before auto-start; editable */
  | "gate"
  | "execute"
  | "verify"
  | "done"
  /** user stopped/discarded or new session killed the run */
  | "stopped"
  /** agent turn ended mid-run without protocol completion — resumable by the user, never auto */
  | "stalled";

export type TeamAgentState = "deliberating" | "working" | "sleeping" | "waking" | "done" | "failed" | "throttled";

export interface TeamAgent {
  name: string;
  glyph: string;
  kind: "planner" | "worker";
  state: TeamAgentState;
  /** slice id currently worked (workers) */
  slice?: string;
  /** slice ids a sleeper waits for */
  waitingFor?: string[];
  /** epoch ms of the last state flip — elapsed-on-slice ticker */
  sinceMs: number;
  filesTouched: number;
  /** cumulative diffstat across this worker's finished slices */
  add?: number;
  del?: number;
  /** last activity line (read-only chip card) */
  lastActivity?: string;
}

export type TeamSliceState = "pending" | "active" | "done" | "failed" | "replanned" | "stopped";

export interface TeamSlice {
  id: string;
  title: string;
  scope: string;
  worker: string;
  deps: string[];
  contract?: string;
  state: TeamSliceState;
  /** one-paragraph hand-off note written by the finisher */
  handoff?: string;
  add: number;
  del: number;
  /** planned write-set (files this slice owns); drives disjoint-files validation */
  files?: string[];
  /** dep ids auto-added by the orchestrator because write-sets overlap ("serialized: both touch X") */
  autoDeps?: string[];
}

/** one attributed tool call in the shared team timeline */
export interface TeamTimelineEntry {
  worker: string;
  glyph: string;
  tool: string;
  summary: string;
  sliceId?: string;
  at: number;
}

export interface TeamFeedEntry {
  author: string;
  glyph?: string;
  text: string;
  at: number;
  kind: "argument" | "note" | "system";
}

/** live execution mechanism — the honesty badge states it verbatim (crew-rail §2) */
export interface TeamMechanism {
  kind: "parallel" | "solo";
  /** concurrent worker processes right now (parallel) */
  active: number;
  /** workers currently paused by rate-limit */
  throttled: number;
  /** parallel with exactly ONE live worker: why only one (rate-limit / staggered start / deps / 1 slice ready) — the badge renders `solo (…)`, never `parallel ×1` */
  singleReason?: string;
  /** solo: the actual reason ("omp not found", "probe: …") — never generic */
  reason?: string;
}

/** a team role the auto-router may assign (crew roster; user agents extend it) */
export interface TeamRole {
  /** stable id used in @mentions and slice.worker ("coder", "tester", …) */
  id: string;
  /** one-line description the router reads ("tester — пишет и гоняет тесты") */
  desc: string;
}

export interface TeamRunState {
  runId: string;
  goal: string;
  phase: TeamPhase;
  /** capability probe failed → single agent plays the roles sequentially */
  solo: boolean;
  /** live mechanism readout for the panel-header badge */
  mechanism?: TeamMechanism;
  /** epoch ms when the grace window auto-approves the dispatch (gate phase); null = manual */
  graceUntil?: number | null;
  /** the roster the router chose from (role id → description), for the «изменить» sheet */
  roster?: TeamRole[];
  /** explicit @role manual overrides fixed for this run */
  pinnedRoles?: string[];
  /** Telegram-originated runs skip the IDE-only dispatch grace window. */
  immediateStart?: boolean;
  /** user-facing source of an externally started run (renders on the goal bubble). */
  originVia?: RemoteVia;
  /** malformed transport payload intercepted before rendering; raw stays collapsed */
  protocolError?: { raw: string; at: number };
  agents: TeamAgent[];
  slices: TeamSlice[];
  planSummary: string;
  feed: TeamFeedEntry[];
  /** shared attributed timeline (every worker's tool calls, interleaved) */
  timeline?: TeamTimelineEntry[];
  /** two failures on one slice → paused, waiting for the user's call */
  needsCall: { sliceId: string; error: string } | null;
  /** "IDE" | "@username via Telegram" once approved */
  approvedVia: string | null;
  startedAt: number;
  /** persisted run found on boot that was live when the app died */
  didNotSurvive?: boolean;
  report: string | null;
}

export interface TeamApi {
  getState(): Promise<TeamRunState | null>;
  /** the default team roster (roles the router assigns) + any user-defined agents */
  roster(): Promise<TeamRole[]>;
  /** kick off a team run (route → gate → execute); `mentions` = pinned role ids (@-override) */
  start(goal: string, mentions?: string[]): Promise<{ ok: boolean; error?: string }>;
  /** mid-run message; target = named worker, omitted = team note */
  steer(text: string, target?: string): Promise<boolean>;
  /** approve the dispatch now (skips the remaining grace window) */
  /** hold the dispatch at the gate before editing; cancels auto-start */
  hold(): Promise<void>;
  approve(): Promise<{ ok: boolean; error?: string }>;
  discard(): Promise<void>;
  stop(): Promise<void>;
  // ---- plan gate editing (graph re-validated in main; cycles rejected)
  editSlice(id: string, patch: { title?: string; scope?: string }): Promise<{ ok: boolean; error?: string }>;
  addSlice(input: { title: string; scope: string; deps: string[] }): Promise<{ ok: boolean; error?: string }>;
  deleteSlice(id: string): Promise<{ ok: boolean; error?: string }>;
  setDeps(id: string, deps: string[]): Promise<{ ok: boolean; error?: string }>;
  /** resolve the two-failures pause */
  needsCall(choice: "retry" | "abort", editedScope?: string): Promise<void>;
  /** drop a finished/stopped/stalled run from the board */
  clear(): Promise<void>;
  /** re-run the same goal from scratch (restart-honesty affordance) */
  restartRun(): Promise<{ ok: boolean; error?: string }>;
  onState(cb: (s: TeamRunState | null) => void): () => void;
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
    /** repo-local `git config user.name/email` — the commit identity rescue flow */
    setIdentity(root: string, name: string, email: string): Promise<void>;
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
    /** read-only browser over on-disk session transcripts */
    listSessions(root: string): Promise<OmpSessionMeta[]>;
    readSession(file: string): Promise<OmpSessionEntry[]>;
    onStatus(cb: (s: OmpStatus) => void): () => void;
    onEvent(cb: (e: OmpEvent) => void): () => void;
    onUiRequest(cb: (req: OmpUiRequest) => void): () => void;
  };
  team: TeamApi;
  tester: TesterApi;
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
    /** ambient-motion pause discipline: true while the machine runs on battery */
    isOnBattery(): Promise<boolean>;
    onBattery(cb: (onBattery: boolean) => void): () => void;
  };
  store: {
    getSettings(): Promise<Settings>;
    setSettings(s: Partial<Settings>): Promise<Settings>;
    getRecents(): Promise<RecentWorkspace[]>;
    addRecent(path: string): Promise<void>;
    removeRecent(path: string): Promise<void>;
    togglePin(path: string): Promise<void>;
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
    /** telegram proxy ("" = direct); validates AND live-probes the proxy before committing */
    setProxyUrl(url: string): Promise<{ ok: boolean; error?: string; probe?: string }>;
    /** flip the proxy on/off without erasing the url; refuses ON with an unusable url */
    setProxyEnabled(enabled: boolean): Promise<{ ok: boolean; error?: string }>;
    /** probe api.telegram.org through a proxy URL ("" = direct) without committing or bouncing bots */
    testProxy(url: string): Promise<{ ok: boolean; detail: string }>;
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
    /** Chat Dialogue: per-chat «отвечать участникам» toggle */
    setChatAnswerMembers(botId: string, chatId: number, enabled: boolean): Promise<void>;
    /** drop a chat from the registry (unwatched or left only); optionally delete its JSONL log */
    removeChat(botId: string, chatId: number, deleteLog: boolean): Promise<{ ok: boolean; error?: string }>;
    /** designate the approver among a bot's paired users */
    setApprover(botId: string, telegramId: number): Promise<void>;
    /** crown/uncrown a paired user as bot owner (IDE-only, never via Telegram) */
    setUserOwner(botId: string, telegramId: number, owner: boolean): Promise<{ ok: boolean; error?: string }>;
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
    /** drop the active model's no-thinking mark and re-probe capability */
    recheckThinking(origin: string): Promise<void>;
    getEvents(): Promise<ModelEvent[]>;
    // ---- auto-swap & balance
    /** balance probe endpoint (URL or base-relative path; "" clears) */
    setBalanceEndpoint(providerId: string, endpoint: string): Promise<void>;
    /** one probe; returns the parsed result or the raw body on parse failure */
    checkBalance(providerId: string): Promise<{ ok: boolean; value?: number; currency?: string; raw?: string; error?: string }>;
    /** probe every enabled profile with a configured endpoint, concurrently */
    checkAllBalances(): Promise<void>;
    /** low-balance warning threshold; null = off */
    setLowThreshold(providerId: string, threshold: number | null): Promise<void>;
    setAutoSwap(enabled: boolean): Promise<void>;
    setRoleSwapOptOut(role: ModelRole, optOut: boolean): Promise<void>;
    setBalancePollMinutes(minutes: number): Promise<void>;
    /** re-enable a depleted profile manually */
    clearDepleted(providerId: string): Promise<void>;
    /** Prompt Improve: one stateless smol-role oneshot per call (never the agent session) */
    enhance(draft: string, origin: string): Promise<{ ok: true; text: string; model: string } | { ok: false; error: string }>;
    /** wand availability: oneshot support + smol assignment + smol profile health */
    enhanceStatus(): Promise<{ ok: boolean; reason?: string; model?: string }>;
    onState(cb: (s: ModelsState) => void): () => void;
    onUsage(cb: (u: ModelsUsage) => void): () => void;
    /** active model rejected the thinking param — flipped to no-thinking */
    onThinkRejected(cb: (modelId: string) => void): () => void;
    /** external models.yml edit removed the profile/model an assigned role points at */
    onRolesOrphaned(cb: (roles: ModelRole[]) => void): () => void;
    /** auto-swap / low-balance toast payloads from the swap engine */
    onSwapNotice(cb: (n: { message: string; crit: boolean }) => void): () => void;
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
  accent: "#34e0f7",
  reduceTransparency: false,
  fontSize: 13,
  terminalShell: "",
  ompPath: "",
  stallSeconds: 20,
  breadcrumbs: "on",
  tabSwitcher: "mru",
  motion: "full",
  uiLang: "auto",
};
