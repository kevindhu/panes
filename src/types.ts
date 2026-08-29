export type TrustLevel = "trusted" | "standard" | "restricted";

export interface Workspace {
  id: string;
  name: string;
  rootPath: string;
  scanDepth: number;
  createdAt: string;
  lastOpenedAt: string;
}

export interface Repo {
  id: string;
  workspaceId: string;
  name: string;
  path: string;
  defaultBranch: string;
  isActive: boolean;
  trustLevel: TrustLevel;
}

export type ThreadStatus =
  | "idle"
  | "streaming"
  | "awaiting_approval"
  | "error"
  | "completed";

export type ChatEngineId = "codex";

export interface Thread {
  id: string;
  workspaceId: string;
  repoId: string | null;
  engineId: ChatEngineId;
  modelId: string;
  engineThreadId: string | null;
  engineMetadata?: Record<string, unknown>;
  title: string;
  status: ThreadStatus;
  messageCount: number;
  totalTokens: number;
  createdAt: string;
  lastActivityAt: string;
}

export type MessageStatus = "completed" | "streaming" | "interrupted" | "error";

export interface Message {
  id: string;
  threadId: string;
  role: "user" | "assistant";
  content?: string;
  blocks?: ContentBlock[];
  clientTurnId?: string | null;
  nativeTurnId?: string | null;
  turnEngineId?: string | null;
  turnModelId?: string | null;
  turnReasoningEffort?: string | null;
  status: MessageStatus;
  schemaVersion: number;
  tokenUsage?: { input: number; output: number };
  createdAt: string;
  hydration?: "full" | "summary";
  hasDeferredContent?: boolean;
}

export interface MessageWindowCursor {
  createdAt: string;
  id: string;
  rowId?: number;
}

export interface MessageWindow {
  messages: Message[];
  nextCursor: MessageWindowCursor | null;
}

export type ActionType =
  | "file_read"
  | "file_write"
  | "file_edit"
  | "file_delete"
  | "command"
  | "git"
  | "search"
  | "other";

export interface TextBlock {
  type: "text";
  content: string;
  planMode?: boolean;
  isSteer?: boolean;
}

export interface CodeBlock {
  type: "code";
  language: string;
  content: string;
  filename?: string;
}

export interface DiffBlock {
  type: "diff";
  diff: string;
  scope: "turn" | "file" | "workspace";
}

export interface NoticeBlock {
  type: "notice";
  kind: string;
  level: "info" | "warning" | "error";
  title: string;
  message: string;
  details?: string[];
  status?: string;
  source?: TurnCompletionSource;
  durationMs?: number;
}

export interface ActionBlock {
  type: "action";
  actionId: string;
  engineActionId?: string;
  actionType: ActionType;
  summary: string;
  details: Record<string, unknown>;
  outputChunks: Array<{ stream: "stdout" | "stderr" | "stdin"; content: string }>;
  outputDeferred?: boolean;
  outputDeferredLoaded?: boolean;
  status: "pending" | "running" | "done" | "error";
  result?: {
    success: boolean;
    output?: string;
    error?: string;
    diff?: string;
    durationMs: number;
  };
}

export interface ActionOutputPayload {
  found: boolean;
  outputChunks: Array<{ stream: "stdout" | "stderr" | "stdin"; content: string }>;
  truncated: boolean;
}

export interface CodexTurnRecord {
  id: string;
  threadId: string;
  messageId: string;
  nativeThreadId: string;
  nativeTurnId: string | null;
  status: string;
  startedAtMs: number | null;
  completedAtMs: number | null;
  firstEventAtMs: number | null;
  lastEventAtMs: number | null;
  lastSourceSequence: number;
  startedJson: string | null;
  completedJson: string | null;
  planJson: string | null;
  usageJson: string | null;
}

export interface CodexTurnEventRecord {
  id: number;
  sourceSequence: number;
  eventKind: "client_request" | "client_response" | "request" | "notification" | "response";
  method: string;
  requestId: string | null;
  nativeThreadId: string;
  nativeTurnId: string | null;
  paramsJson: string;
  observedAtMs: number;
}

export interface CodexTurnItemRecord {
  itemId: string;
  itemType: string;
  status: string;
  phase: string | null;
  firstSourceSequence: number;
  lastSourceSequence: number;
  startedAtMs: number | null;
  completedAtMs: number | null;
  startedJson: string | null;
  completedJson: string | null;
}

export interface CodexItemStreamChunkRecord {
  id: number;
  eventId: number;
  itemId: string | null;
  sourceSequence: number;
  chunkIndex: number;
  streamKind: string;
  summaryIndex: number | null;
  content: string;
  metadataJson: string | null;
  observedAtMs: number;
}

export interface CodexTurnSnapshot {
  turn: CodexTurnRecord;
  events: CodexTurnEventRecord[];
  items: CodexTurnItemRecord[];
  chunks: CodexItemStreamChunkRecord[];
}

export interface ApprovalBlock {
  type: "approval";
  approvalId: string;
  actionType: ActionType;
  summary: string;
  details: Record<string, unknown>;
  status: "pending" | "answered";
  decision?:
    | "accept"
    | "accept_for_session"
    | "decline"
    | "cancel"
    | "custom";
  responseData?: Record<string, unknown>;
}

export type ApprovalDecision =
  | "accept"
  | "accept_for_session"
  | "decline"
  | "cancel";

export interface AcceptWithExecpolicyAmendmentDecision {
  acceptWithExecpolicyAmendment: {
    execpolicy_amendment: string[];
  };
}

export interface NetworkPolicyAmendment {
  host: string;
  action: "allow" | "deny";
}

export interface ApplyNetworkPolicyAmendmentDecision {
  applyNetworkPolicyAmendment: {
    network_policy_amendment: NetworkPolicyAmendment;
  };
}

export interface PermissionsApprovalResponse {
  permissions: Record<string, unknown>;
  scope?: "turn" | "session";
}

export interface McpServerElicitationResponse {
  action: "accept" | "decline" | "cancel";
  content?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

export interface DynamicToolCallOutputTextItem {
  type: "inputText";
  text: string;
}

export interface DynamicToolCallOutputImageItem {
  type: "inputImage";
  imageUrl: string;
}

export interface DynamicToolCallResponse {
  success: boolean;
  contentItems: Array<DynamicToolCallOutputTextItem | DynamicToolCallOutputImageItem>;
}

export interface ToolInputAnswer {
  answers: string[];
}

export type ApprovalResponse =
  | {
      decision: ApprovalDecision;
    }
  | AcceptWithExecpolicyAmendmentDecision
  | ApplyNetworkPolicyAmendmentDecision
  | PermissionsApprovalResponse
  | McpServerElicitationResponse
  | DynamicToolCallResponse
  | {
      answers: Record<string, ToolInputAnswer>;
    }
  | Record<string, unknown>;

export interface ThinkingBlock {
  type: "thinking";
  content: string;
  startedAt?: number;
  durationMs?: number;
}

export interface ErrorBlock {
  type: "error";
  message: string;
}

export interface AttachmentBlock {
  type: "attachment";
  fileName: string;
  filePath: string;
  sizeBytes: number;
  mimeType?: string;
}

export interface SkillBlock {
  type: "skill";
  name: string;
  path: string;
}

export interface MentionBlock {
  type: "mention";
  name: string;
  path: string;
}

export interface SteerBlock {
  type: "steer";
  steerId: string;
  persistedMessageId?: string;
  content: string;
  planMode?: boolean;
  attachments?: AttachmentBlock[];
  skills?: SkillBlock[];
  mentions?: MentionBlock[];
  sourceSequence?: number;
  observedAtMs?: number;
  status?: "pending" | "accepted" | "failed" | "unconfirmed";
  error?: string;
}

export interface SteerMessageReceipt {
  steerId: string;
  messageId: string;
  nativeTurnId: string;
  sourceSequence: number;
  acceptedSourceSequence: number | null;
}

export type ContentBlock =
  | TextBlock
  | CodeBlock
  | DiffBlock
  | NoticeBlock
  | ActionBlock
  | ApprovalBlock
  | ThinkingBlock
  | ErrorBlock
  | AttachmentBlock
  | SkillBlock
  | MentionBlock
  | SteerBlock;

export interface EngineInfo {
  id: string;
  name: string;
  models: EngineModel[];
  capabilities: EngineCapabilities;
}

export interface EngineCapabilities {
  permissionModes: string[];
  sandboxModes: string[];
  approvalDecisions: string[];
}

export interface EngineModel {
  id: string;
  displayName: string;
  description: string;
  hidden: boolean;
  isDefault: boolean;
  upgrade?: string;
  availabilityNux?: EngineModelAvailabilityNux;
  upgradeInfo?: EngineModelUpgradeInfo;
  inputModalities: string[];
  attachmentModalities: string[];
  limits?: EngineModelLimits;
  supportsPersonality: boolean;
  defaultReasoningEffort: string;
  supportedReasoningEfforts: ReasoningEffortOption[];
}

export interface EngineModelLimits {
  contextTokens?: number | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
}

export interface EngineModelAvailabilityNux {
  message: string;
}

export interface EngineModelUpgradeInfo {
  model: string;
  upgradeCopy?: string;
  modelLink?: string;
  migrationMarkdown?: string;
}

export interface ReasoningEffortOption {
  reasoningEffort: string;
  description: string;
}

export interface EngineHealth {
  id: string;
  available: boolean;
  version?: string;
  details?: string;
  warnings?: string[];
  checks?: string[];
  fixes?: string[];
  protocolDiagnostics?: CodexProtocolDiagnostics;
}

export interface CodexMethodAvailability {
  method: string;
  status: string;
  detail?: string;
}

export interface CodexExperimentalFeature {
  name: string;
  enabled: boolean;
  defaultEnabled: boolean;
  stage: string;
  displayName?: string;
  description?: string;
}

export interface CodexApp {
  id: string;
  name: string;
  description?: string;
  isEnabled: boolean;
  isAccessible: boolean;
}

export interface CodexSkill {
  name: string;
  path: string;
  description: string;
  enabled: boolean;
  scope: string;
}

export interface CodexPluginMarketplace {
  name: string;
  path: string;
  plugins: CodexPlugin[];
}

export interface CodexPlugin {
  id: string;
  name: string;
  enabled: boolean;
  installed: boolean;
  capabilities: string[];
  developerName?: string;
  description?: string;
}

export interface CodexMcpServer {
  name: string;
  authStatus: string;
  toolCount: number;
  resourceCount: number;
  resourceTemplateCount: number;
}

export interface CodexAccountState {
  provider: string;
  authMode?: string;
  email?: string;
  planType?: string;
  requiresOpenaiAuth: boolean;
}

export interface CodexConfigLayer {
  source: string;
  version: string;
}

export type CodexApprovalsReviewer = "user" | "auto_review" | "guardian_subagent";

export interface CodexConfigState {
  model?: string;
  modelProvider?: string;
  serviceTier?: string;
  approvalPolicy?: unknown;
  permissionProfile?: unknown;
  approvalsReviewer?: CodexApprovalsReviewer;
  sandboxMode?: string;
  webSearch?: string;
  profile?: string;
  layers: CodexConfigLayer[];
}

export interface CodexConfigWarning {
  summary: string;
  details?: string;
  path?: string;
  startLine?: number;
  startColumn?: number;
  endLine?: number;
  endColumn?: number;
}

export interface CodexAccountLoginCompleted {
  success: boolean;
  error?: string;
  loginId?: string;
}

export interface CodexMcpOauthCompleted {
  name: string;
  success: boolean;
  error?: string;
}

export interface CodexThreadRealtimeEvent {
  kind: string;
  threadId: string;
  sessionId?: string;
  reason?: string;
  message?: string;
  itemType?: string;
  sampleRate?: number;
  numChannels?: number;
  samplesPerChannel?: number;
}

export interface CodexWindowsSandboxSetup {
  mode: string;
  success: boolean;
  error?: string;
}

export interface CodexWindowsWorldWritableWarning {
  samplePaths: string[];
  extraCount: number;
  failedScan: boolean;
}

export interface CodexProtocolDiagnostics {
  methodAvailability: CodexMethodAvailability[];
  experimentalFeatures: CodexExperimentalFeature[];
  collaborationModes: string[];
  apps: CodexApp[];
  skills: CodexSkill[];
  pluginMarketplaces: CodexPluginMarketplace[];
  mcpServers: CodexMcpServer[];
  account?: CodexAccountState;
  config?: CodexConfigState;
  lastConfigWarning?: CodexConfigWarning;
  lastAccountLogin?: CodexAccountLoginCompleted;
  lastMcpOauth?: CodexMcpOauthCompleted;
  lastThreadRealtime?: CodexThreadRealtimeEvent;
  lastWindowsSandboxSetup?: CodexWindowsSandboxSetup;
  lastWindowsWorldWritableWarning?: CodexWindowsWorldWritableWarning;
  fetchedAt?: string;
  stale: boolean;
}

export interface RuntimeToast {
  variant: "success" | "error" | "warning" | "info";
  message: string;
}

export interface EngineRuntimeUpdatedEvent {
  engineId: string;
  protocolDiagnostics?: CodexProtocolDiagnostics;
  toast?: RuntimeToast;
}

export interface SearchResult {
  threadId: string;
  threadTitle: string;
  workspaceName: string;
  repoId: string | null;
  messageId: string;
  snippet: string;
}

export interface EditorRevealLocation {
  line: number;
  column?: number | null;
}

// ── Stream Events ───────────────────────────────────────────────────

export type TurnCompletionStatus = "completed" | "interrupted" | "failed";

export interface StreamTokenUsage {
  input: number;
  output: number;
  reasoning?: number | null;
  cacheRead?: number | null;
  cacheWrite?: number | null;
  costUsd?: number | null;
}

export interface TurnStartedEvent {
  type: "TurnStarted";
  client_turn_id?: string | null;
  native_turn_id?: string | null;
}

export interface TurnCompletedEvent {
  type: "TurnCompleted";
  token_usage?: StreamTokenUsage | null;
  status?: TurnCompletionStatus;
  diagnostics?: TurnCompletionDiagnostics | null;
  duration_ms?: number | null;
  durationMs?: number | null;
}

export type TurnCompletionSource =
  | "engine"
  | "recovered_snapshot"
  | "reconciled_stream_lost"
  | "reconciled_timeout"
  | "timeout_fallback";

export interface TurnCompletionDiagnostics {
  source: TurnCompletionSource;
}

export interface TextDeltaEvent {
  type: "TextDelta";
  content: string;
}

export interface TurnSnapshotRecoveredEvent {
  type: "TurnSnapshotRecovered";
  blocks: ContentBlock[];
}

export interface ThinkingDeltaEvent {
  type: "ThinkingDelta";
  content: string;
}

export interface ActionStartedEvent {
  type: "ActionStarted";
  action_id: string;
  engine_action_id?: string | null;
  action_type: ActionType;
  summary: string;
  details: Record<string, unknown>;
}

export interface ActionOutputDeltaEvent {
  type: "ActionOutputDelta";
  action_id: string;
  stream: "stdout" | "stderr" | "stdin";
  content: string;
}

export interface ActionProgressUpdatedEvent {
  type: "ActionProgressUpdated";
  action_id: string;
  message: string;
}

export interface ActionCompletedEvent {
  type: "ActionCompleted";
  action_id: string;
  details?: Record<string, unknown> | null;
  result: {
    success: boolean;
    output?: string | null;
    error?: string | null;
    diff?: string | null;
    durationMs: number;
  };
}

export interface DiffUpdatedEvent {
  type: "DiffUpdated";
  diff: string;
  scope: "turn" | "file" | "workspace";
}

export interface ApprovalRequestedEvent {
  type: "ApprovalRequested";
  approval_id: string;
  action_type: ActionType;
  summary: string;
  details: Record<string, unknown>;
}

export interface ApprovalResolvedEvent {
  type: "ApprovalResolved";
  approval_id: string;
}

export interface ErrorEvent {
  type: "Error";
  message: string;
  recoverable: boolean;
}

export interface UsageLimitsUpdatedEvent {
  type: "UsageLimitsUpdated";
  usage: {
    current_tokens?: number | null;
    max_context_tokens?: number | null;
    context_window_percent?: number | null;
    five_hour_percent?: number | null;
    weekly_percent?: number | null;
    five_hour_resets_at?: number | null;
    weekly_resets_at?: number | null;
  };
}

export interface ModelReroutedEvent {
  type: "ModelRerouted";
  from_model: string;
  to_model: string;
  reason: string;
}

export interface NoticeEvent {
  type: "Notice";
  kind: string;
  level: "info" | "warning" | "error";
  title: string;
  message: string;
  details?: string[];
}

export type StreamEvent =
  | TurnStartedEvent
  | TurnCompletedEvent
  | TurnSnapshotRecoveredEvent
  | TextDeltaEvent
  | ThinkingDeltaEvent
  | ActionStartedEvent
  | ActionOutputDeltaEvent
  | ActionProgressUpdatedEvent
  | ActionCompletedEvent
  | DiffUpdatedEvent
  | ApprovalRequestedEvent
  | ApprovalResolvedEvent
  | ModelReroutedEvent
  | NoticeEvent
  | ErrorEvent
  | UsageLimitsUpdatedEvent;

// ── Attachments ─────────────────────────────────────────────────────

export interface ChatAttachment {
  id: string;
  fileName: string;
  filePath: string;
  sizeBytes: number;
  mimeType?: string;
}

export interface PreparedAttachmentImageAsset {
  filePath: string;
  mimeType: string;
  version: string;
}

export type ChatInputItem =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "skill";
      name: string;
      path: string;
    }
  | {
      type: "mention";
      name: string;
      path: string;
    };

// ── Context Usage ───────────────────────────────────────────────────

export interface ContextUsage {
  currentTokens: number | null;
  maxContextTokens: number | null;
  contextPercent: number | null;
  windowFiveHourPercent: number | null;
  windowWeeklyPercent: number | null;
  windowFiveHourResetsAt: string | null;
  windowWeeklyResetsAt: string | null;
}
