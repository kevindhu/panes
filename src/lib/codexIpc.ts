import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type {
  ActionOutputPayload,
  ApprovalResponse,
  ChatAttachment,
  ChatEngineId,
  ChatInputItem,
  CodexApp,
  CodexApprovalsReviewer,
  CodexSkill,
  CodexTurnSnapshot,
  EngineHealth,
  EngineInfo,
  EngineRuntimeUpdatedEvent,
  MessageWindow,
  MessageWindowCursor,
  PreparedAttachmentImageAsset,
  Repo,
  SearchResult,
  StreamEvent,
  Thread,
  ThreadStatus,
  TrustLevel,
  Workspace,
  SteerMessageReceipt,
} from "../types";

export const ipc = {
  listWorkspaces: () => invoke<Workspace[]>("list_workspaces"),
  listArchivedWorkspaces: () => invoke<Workspace[]>("list_archived_workspaces"),
  openWorkspace: (path: string, scanDepth?: number) => invoke<Workspace>("open_workspace", { path, scanDepth: scanDepth ?? null }),
  retargetWorkspace: (workspaceId: string, path: string) => invoke<Workspace>("retarget_workspace", { workspaceId, path }),
  setWorkspaceOrder: (workspaceIds: string[]) => invoke<void>("set_workspace_order", { workspaceIds }),
  archiveWorkspace: (workspaceId: string) => invoke<void>("archive_workspace", { workspaceId }),
  restoreWorkspace: (workspaceId: string) => invoke<Workspace>("restore_workspace", { workspaceId }),
  getRepos: (workspaceId: string) => invoke<Repo[]>("get_repos", { workspaceId }),
  setRepoTrustLevel: (repoId: string, trustLevel: TrustLevel) => invoke<void>("set_repo_trust_level", { repoId, trustLevel }),
  listThreads: (workspaceId: string) => invoke<Thread[]>("list_threads", { workspaceId }),
  listArchivedThreads: (workspaceId: string) => invoke<Thread[]>("list_archived_threads", { workspaceId }),
  attachCodexRemoteThread: (workspaceId: string, engineThreadId: string, modelId: string) => invoke<Thread>("attach_codex_remote_thread", { workspaceId, engineThreadId, modelId }),
  createThread: (workspaceId: string, repoId: string | null, engineId: string, modelId: string, title: string, reasoningEffort?: string | null, serviceTier?: string | null) =>
    invoke<Thread>("create_thread", { workspaceId, repoId, engineId, modelId, title, reasoningEffort: reasoningEffort ?? null, serviceTier: serviceTier ?? null }),
  renameThread: (threadId: string, title: string) => invoke<Thread>("rename_thread", { threadId, title }),
  setThreadExecutionPolicy: (threadId: string, patch: { approvalPolicy?: unknown; sandboxMode?: string | null; allowNetwork?: boolean | null; permissionProfile?: Record<string, unknown> | null; approvalsReviewer?: CodexApprovalsReviewer | null }) =>
    invoke<Thread>("set_thread_execution_policy", {
      threadId,
      updateApprovalPolicy: Object.prototype.hasOwnProperty.call(patch, "approvalPolicy"), approvalPolicy: patch.approvalPolicy ?? null,
      updateSandboxMode: Object.prototype.hasOwnProperty.call(patch, "sandboxMode"), sandboxMode: patch.sandboxMode ?? null,
      updateAllowNetwork: Object.prototype.hasOwnProperty.call(patch, "allowNetwork"), allowNetwork: patch.allowNetwork ?? null,
      updatePermissionProfile: Object.prototype.hasOwnProperty.call(patch, "permissionProfile"), permissionProfile: patch.permissionProfile ?? null,
      updateApprovalsReviewer: Object.prototype.hasOwnProperty.call(patch, "approvalsReviewer"), approvalsReviewer: patch.approvalsReviewer ?? null,
    }),
  setThreadCodexConfig: (threadId: string, patch: { personality?: string | null; serviceTier?: string | null; outputSchema?: unknown }) =>
    invoke<Thread>("set_thread_codex_config", {
      threadId,
      updatePersonality: Object.prototype.hasOwnProperty.call(patch, "personality"), personality: patch.personality ?? null,
      updateServiceTier: Object.prototype.hasOwnProperty.call(patch, "serviceTier"), serviceTier: patch.serviceTier ?? null,
      updateOutputSchema: Object.prototype.hasOwnProperty.call(patch, "outputSchema"), outputSchema: patch.outputSchema ?? null,
    }),
  archiveThread: (threadId: string) => invoke<void>("archive_thread", { threadId }),
  restoreThread: (threadId: string) => invoke<Thread>("restore_thread", { threadId }),
  syncThreadFromEngine: (threadId: string) => invoke<Thread>("sync_thread_from_engine", { threadId }),
  refreshThreadUsageLimits: (threadId: string) =>
    invoke<RefreshThreadUsageLimitsResult>("refresh_thread_usage_limits", { threadId }),
  forkCodexThread: (threadId: string, profileOperationId?: string | null) => invoke<Thread>("fork_codex_thread", { threadId, profileOperationId: profileOperationId ?? null }),
  forkCodexThreadAtTurn: (threadId: string, sourceMessageId: string, lastTurnId: string | null, turnsAfter: number, profileOperationId?: string | null) => invoke<Thread>("fork_codex_thread_at_turn", { threadId, sourceMessageId, lastTurnId, turnsAfter, profileOperationId: profileOperationId ?? null }),
  rollbackCodexThread: (threadId: string, numTurns: number, profileOperationId?: string | null) => invoke<Thread>("rollback_codex_thread", { threadId, numTurns, profileOperationId: profileOperationId ?? null }),
  compactCodexThread: (threadId: string) => invoke<Thread>("compact_codex_thread", { threadId }),
  sendMessage: (threadId: string, message: string, modelId?: string | null, reasoningEffort?: string | null, attachments?: ChatAttachment[] | null, inputItems?: ChatInputItem[] | null, planMode?: boolean | null, clientTurnId?: string | null) =>
    invoke<string>("send_message", { threadId, message, modelId: modelId ?? null, reasoningEffort: reasoningEffort ?? null, attachments: attachments ?? null, inputItems: inputItems ?? null, planMode: planMode ?? null, clientTurnId: clientTurnId ?? null }),
  steerMessage: (threadId: string, message: string, attachments?: ChatAttachment[] | null, inputItems?: ChatInputItem[] | null, planMode?: boolean | null, steerId?: string | null) =>
    invoke<SteerMessageReceipt>("steer_message", { threadId, message, attachments: attachments ?? null, inputItems: inputItems ?? null, planMode: planMode ?? null, steerId: steerId ?? null }),
  cancelTurn: (threadId: string) => invoke<void>("cancel_turn", { threadId }),
  respondApproval: (threadId: string, approvalId: string, response: ApprovalResponse) => invoke<void>("respond_to_approval", { threadId, approvalId, response }),
  getThreadMessagesWindow: (threadId: string, cursor?: MessageWindowCursor | null, limit?: number | null) => invoke<MessageWindow>("get_thread_messages_window", { threadId, cursor: cursor ?? null, limit: limit ?? null }),
  getActionOutput: (messageId: string, actionId: string) => invoke<ActionOutputPayload>("get_action_output", { messageId, actionId }),
  getCodexTurnSnapshot: (assistantMessageId: string, afterSourceSequence?: number | null) =>
    invoke<CodexTurnSnapshot | null>("get_codex_turn_snapshot", {
      assistantMessageId,
      afterSourceSequence: afterSourceSequence ?? null,
    }),
  searchMessages: (workspaceId: string, query: string) => invoke<SearchResult[]>("search_messages", { workspaceId, query }),
  listEngines: () => invoke<EngineInfo[]>("list_engines"),
  engineHealth: (engineId: string) => invoke<EngineHealth>("engine_health", { engineId }),
  listCodexSkills: (cwd: string) => invoke<CodexSkill[]>("list_codex_skills", { cwd }),
  listCodexApps: () => invoke<CodexApp[]>("list_codex_apps"),
  savePastedImageAttachment: (fileName: string, mimeType: string, dataBase64: string) => invoke<Omit<ChatAttachment, "id">>("save_pasted_image_attachment", { fileName, mimeType, dataBase64 }),
  cacheEmbeddedChatImage: (mimeType: string, dataBase64: string) => invoke<PreparedAttachmentImageAsset>("cache_embedded_chat_image", { mimeType, dataBase64 }),
  prepareAttachmentImageAsset: (filePath: string, mimeType?: string | null, maxWidth?: number | null, maxHeight?: number | null) => invoke<PreparedAttachmentImageAsset>("prepare_attachment_image_asset", { filePath, mimeType: mimeType ?? null, maxWidth: maxWidth ?? null, maxHeight: maxHeight ?? null }),
  readAttachmentImageBytes: (filePath: string, mimeType?: string | null) => invoke<ArrayBuffer | number[]>("read_attachment_image_bytes", { filePath, mimeType: mimeType ?? null }),
  copyAttachmentImageToClipboard: (filePath: string, mimeType?: string | null) => invoke<void>("copy_attachment_image_to_clipboard", { filePath, mimeType: mimeType ?? null }),
  openPathWithDefaultApp: (path: string) => invoke<void>("open_path_with_default_app", { path }),
  showAgentNotification: (title: string, body: string) => invoke<void>("show_agent_notification", { title, body }),
};

export interface RefreshThreadUsageLimitsResult {
  refreshed: boolean;
  missingContext: boolean;
}

export interface ThreadUpdatedEvent { threadId: string; workspaceId: string; thread?: Thread | null }
export interface ChatTurnFinishedEvent {
  threadId: string; workspaceId: string; repoId: string | null; engineId: ChatEngineId;
  threadTitle: string; assistantMessageId: string; clientTurnId?: string | null;
  threadStatus: ThreadStatus; status: "completed" | "interrupted" | "error"; preview?: string | null;
}

export interface CodexTranscriptUpdatedEvent {
  threadId: string;
  assistantMessageId: string;
  lastSourceSequence: number;
}

export interface CodexRollbackMaterializedEvent {
  threadId: string;
}

export interface CodexCompatibilityForkMaterializedEvent {
  threadId: string;
}

export interface CodexHistoryMutationFailedEvent {
  threadId: string;
  operation: "fork" | "rollback";
  message: string;
}

export async function listenThreadEvents(threadId: string, onEvent: (event: StreamEvent) => void): Promise<UnlistenFn> {
  return listen<StreamEvent>(`stream-event-${threadId}`, ({ payload }) => onEvent(payload));
}
export async function listenThreadUpdated(onEvent: (event: ThreadUpdatedEvent) => void): Promise<UnlistenFn> {
  return listen<ThreadUpdatedEvent>("thread-updated", ({ payload }) => onEvent(payload));
}
export async function listenChatTurnFinished(onEvent: (event: ChatTurnFinishedEvent) => void): Promise<UnlistenFn> {
  return listen<ChatTurnFinishedEvent>("chat-turn-finished", ({ payload }) => onEvent(payload));
}
export async function listenCodexTranscriptUpdated(onEvent: (event: CodexTranscriptUpdatedEvent) => void): Promise<UnlistenFn> {
  return listen<CodexTranscriptUpdatedEvent>("codex-transcript-updated", ({ payload }) => onEvent(payload));
}
export async function listenCodexRollbackMaterialized(onEvent: (event: CodexRollbackMaterializedEvent) => void): Promise<UnlistenFn> {
  return listen<CodexRollbackMaterializedEvent>("codex-rollback-materialized", ({ payload }) => onEvent(payload));
}
export async function listenCodexCompatibilityForkMaterialized(onEvent: (event: CodexCompatibilityForkMaterializedEvent) => void): Promise<UnlistenFn> {
  return listen<CodexCompatibilityForkMaterializedEvent>("codex-compatibility-fork-materialized", ({ payload }) => onEvent(payload));
}
export async function listenCodexHistoryMutationFailed(onEvent: (event: CodexHistoryMutationFailedEvent) => void): Promise<UnlistenFn> {
  return listen<CodexHistoryMutationFailedEvent>("codex-history-mutation-failed", ({ payload }) => onEvent(payload));
}
export async function listenEngineRuntimeUpdated(onEvent: (event: EngineRuntimeUpdatedEvent) => void): Promise<UnlistenFn> {
  return listen<EngineRuntimeUpdatedEvent>("engine-runtime-updated", ({ payload }) => onEvent(payload));
}
export async function listenMenuAction(onEvent: (action: string) => void): Promise<UnlistenFn> {
  return listen<string>("menu-action", ({ payload }) => onEvent(payload));
}
