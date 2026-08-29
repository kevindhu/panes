import { open } from "@tauri-apps/plugin-dialog";
import {
  ArrowDown,
  Brain,
  Check,
  Copy,
  GitBranch,
  ListChecks,
  LoaderCircle,
  Paperclip,
  RotateCcw,
  Send,
  Settings2,
  Square,
  Zap,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  lazy,
  useMemo,
  useRef,
  useState,
  Suspense,
  type ClipboardEvent,
  type KeyboardEvent,
} from "react";
import { buildCodexInputItems } from "../chat/codexInputItems";
import {
  computeDroppedTurnsForEditedMessage,
  computeTurnsAfterAssistantMessage,
  extractEditableMessageContext,
  isEditableUserTurn,
} from "../chat/messageEditBranching";
import { resolveReasoningEffortForModel } from "../chat/reasoningEffort";
import {
  canEditCodexMessageHistory,
  canUseNativeCodexHistoryTools,
} from "../../lib/codexThreadCapabilities";
import { createAndActivateWorkspaceThread } from "../../lib/newThreadActions";
import { activateThreadContext } from "../../lib/threadActivation";
import { ipc, listenCodexTranscriptUpdated } from "../../lib/codexIpc";
import { useChatStore } from "../../stores/chatStore";
import { useEngineStore } from "../../stores/engineStore";
import { useThreadPlanModeStore } from "../../stores/threadPlanModeStore";
import { useThreadStore } from "../../stores/threadStore";
import { toast } from "../../stores/toastStore";
import { useWorkspaceStore } from "../../stores/workspaceStore";
import type { ApprovalResponse, ChatAttachment, CodexApp, CodexSkill, ContentBlock, Message, Thread } from "../../types";

const MessageBlocks = lazy(() =>
  import("../chat/MessageBlocks").then((module) => ({ default: module.MessageBlocks })),
);
const CodexTurnTranscript = lazy(() =>
  import("../chat/CodexTurnTranscript").then((module) => ({ default: module.CodexTurnTranscript })),
);

function fileNameFromPath(filePath: string): string {
  return filePath.replace(/\\/g, "/").split("/").at(-1) || "attachment";
}

function guessMimeType(fileName: string): string | undefined {
  const extension = fileName.split(".").at(-1)?.toLowerCase();
  const types: Record<string, string> = {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
    webp: "image/webp", pdf: "application/pdf", json: "application/json",
    md: "text/markdown", txt: "text/plain", csv: "text/csv",
  };
  return extension ? types[extension] : undefined;
}

function messageBlocks(message: { content?: string; blocks?: ContentBlock[] }): ContentBlock[] {
  if (message.blocks?.length) return message.blocks;
  return message.content ? [{ type: "text", content: message.content }] : [];
}

function readMetadataString(thread: Thread | null, key: string): string | null {
  const value = thread?.engineMetadata?.[key];
  return typeof value === "string" && value.trim() ? value : null;
}

function CopyMessageButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="codex-copy-message"
      type="button"
      title="Copy message"
      onClick={() => void navigator.clipboard.writeText(text).then(() => {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1200);
      })}
    >
      {copied ? <Check size={12} /> : <Copy size={12} />}
    </button>
  );
}

export function CodexChat() {
  const viewportRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const nearBottomRef = useRef(true);
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [selectedModelId, setSelectedModelId] = useState("");
  const [reasoningEffort, setReasoningEffort] = useState<string | null>(null);
  const [policyOpen, setPolicyOpen] = useState(false);
  const [forkingMessageId, setForkingMessageId] = useState<string | null>(null);
  const [rollingBackMessageId, setRollingBackMessageId] = useState<string | null>(null);
  const [referenceCatalog, setReferenceCatalog] = useState<{ skills: CodexSkill[]; apps: CodexApp[] } | null>(null);
  const [transcriptSequences, setTranscriptSequences] = useState<Record<string, number>>({});

  const activeWorkspaceId = useWorkspaceStore((state) => state.activeWorkspaceId);
  const workspace = useWorkspaceStore((state) => state.workspaces.find((item) => item.id === state.activeWorkspaceId) ?? null);
  const activeThreadId = useThreadStore((state) => state.activeThreadId);
  const activeThread = useThreadStore((state) => state.threads.find((item) => item.id === state.activeThreadId) ?? null);
  const applyThreadUpdateLocal = useThreadStore((state) => state.applyThreadUpdateLocal);
  const forkCodexThreadAtTurn = useThreadStore((state) => state.forkCodexThreadAtTurn);
  const rollbackCodexThread = useThreadStore((state) => state.rollbackCodexThread);
  const renameThread = useThreadStore((state) => state.renameThread);
  const engine = useEngineStore((state) => state.engines.find((item) => item.id === "codex") ?? null);
  const messages = useChatStore((state) => state.messages);
  const boundThreadId = useChatStore((state) => state.threadId);
  const streaming = useChatStore((state) => state.streaming);
  const status = useChatStore((state) => state.status);
  const error = useChatStore((state) => state.error);
  const hasOlderMessages = useChatStore((state) => state.hasOlderMessages);
  const loadingOlderMessages = useChatStore((state) => state.loadingOlderMessages);
  const loadOlderMessages = useChatStore((state) => state.loadOlderMessages);
  const send = useChatStore((state) => state.send);
  const steer = useChatStore((state) => state.steer);
  const cancel = useChatStore((state) => state.cancel);
  const respondApproval = useChatStore((state) => state.respondApproval);
  const hydrateActionOutput = useChatStore((state) => state.hydrateActionOutput);
  const usage = useChatStore((state) => state.usageLimits);
  const threadModes = useThreadPlanModeStore((state) => state.threadModes);
  const newThreadModes = useThreadPlanModeStore((state) => state.newThreadModesByWorkspaceId);
  const setThreadMode = useThreadPlanModeStore((state) => state.setThreadMode);
  const setNewThreadMode = useThreadPlanModeStore((state) => state.setNewThreadMode);

  const models = useMemo(() => engine?.models.filter((model) => !model.hidden) ?? [], [engine]);
  const selectedModel = models.find((model) => model.id === selectedModelId) ?? models[0] ?? null;
  const planMode = activeThreadId
    ? threadModes[activeThreadId] === "plan"
    : Boolean(activeWorkspaceId && newThreadModes[activeWorkspaceId] === "plan");
  const canForkMessages = canUseNativeCodexHistoryTools(activeThread, streaming);
  const canRollbackMessages = canEditCodexMessageHistory(activeThread, streaming);

  useEffect(() => {
    const preferredModel = readMetadataString(activeThread, "lastModelId") ?? activeThread?.modelId;
    const nextModel = models.find((model) => model.id === preferredModel) ?? models.find((model) => model.isDefault) ?? models[0];
    if (!nextModel) return;
    setSelectedModelId(nextModel.id);
    setReasoningEffort(resolveReasoningEffortForModel(nextModel, readMetadataString(activeThread, "reasoningEffort")));
  }, [activeThread?.id, models]);

  useEffect(() => {
    setReferenceCatalog(null);
  }, [workspace?.rootPath]);

  useEffect(() => {
    setForkingMessageId(null);
    setRollingBackMessageId(null);
    setTranscriptSequences({});
  }, [activeThreadId]);

  useEffect(() => {
    let disposed = false;
    let stopListening: (() => void) | undefined;
    void listenCodexTranscriptUpdated((event) => {
      setTranscriptSequences((current) => {
        if ((current[event.assistantMessageId] ?? 0) >= event.lastSourceSequence) return current;
        return { ...current, [event.assistantMessageId]: event.lastSourceSequence };
      });
    }).then((unlisten) => {
      if (disposed) unlisten();
      else stopListening = unlisten;
    }).catch((listenError) => {
      console.error("Could not listen for Codex transcript updates", listenError);
    });
    return () => {
      disposed = true;
      stopListening?.();
    };
  }, []);

  useEffect(() => {
    if (!input.includes("$") || referenceCatalog || !workspace?.rootPath) return;
    let cancelled = false;
    void Promise.all([ipc.listCodexSkills(workspace.rootPath), ipc.listCodexApps()])
      .then(([skills, apps]) => { if (!cancelled) setReferenceCatalog({ skills, apps }); })
      .catch(() => { if (!cancelled) setReferenceCatalog({ skills: [], apps: [] }); });
    return () => { cancelled = true; };
  }, [input, referenceCatalog, workspace?.rootPath]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (viewport && nearBottomRef.current) viewport.scrollTop = viewport.scrollHeight;
  }, [messages, streaming]);

  const approval = useCallback((approvalId: string, response: ApprovalResponse) => {
    void respondApproval(approvalId, response);
  }, [respondApproval]);

  const forkFromMessage = useCallback(async (message: Message) => {
    if (
      !activeThread ||
      !canForkMessages ||
      forkingMessageId !== null ||
      rollingBackMessageId !== null ||
      message.role !== "assistant" ||
      message.status === "streaming"
    ) {
      return;
    }

    const turnsAfter = computeTurnsAfterAssistantMessage(messages, message.id);
    if (turnsAfter === null) {
      toast.error("Could not identify the Codex turn to fork.");
      return;
    }

    setForkingMessageId(message.id);
    try {
      const forked = await forkCodexThreadAtTurn(
        activeThread.id,
        message.nativeTurnId?.trim() || null,
        turnsAfter,
      );
      if (!forked) {
        throw new Error(useThreadStore.getState().error ?? "Codex did not return a forked thread.");
      }
      await activateThreadContext(forked);
      toast.success("Forked conversation from here.");
    } catch (forkError) {
      toast.error(`Could not fork this message: ${String(forkError)}`);
    } finally {
      setForkingMessageId((current) => (current === message.id ? null : current));
    }
  }, [activeThread, canForkMessages, forkingMessageId, forkCodexThreadAtTurn, messages, rollingBackMessageId]);

  const rollbackToMessage = useCallback(async (message: Message) => {
    if (
      !activeThread ||
      !canRollbackMessages ||
      forkingMessageId !== null ||
      rollingBackMessageId !== null ||
      !isEditableUserTurn(message)
    ) {
      return;
    }

    const context = extractEditableMessageContext(message);
    const numTurns = computeDroppedTurnsForEditedMessage(messages, message.id);
    if (!context || !numTurns) {
      toast.error("Could not identify the Codex turn to roll back.");
      return;
    }

    const confirmed = window.confirm(
      `Roll back to before this message? This removes ${numTurns} ${numTurns === 1 ? "turn" : "turns"} from the chat history and does not undo file changes.`,
    );
    if (!confirmed) return;

    setRollingBackMessageId(message.id);
    try {
      const rolledBack = await rollbackCodexThread(activeThread.id, numTurns);
      if (!rolledBack) {
        throw new Error(useThreadStore.getState().error ?? "Codex did not return the rolled-back thread.");
      }

      await activateThreadContext(rolledBack, { forceChatReload: true });
      setInput(context.text);
      setAttachments(context.attachments);
      if (activeThreadId) {
        setThreadMode(activeThreadId, context.planMode ? "plan" : "default");
      }
      nearBottomRef.current = true;
      requestAnimationFrame(() => textareaRef.current?.focus());
      toast.success("Rolled back conversation. Edit the restored message and send when ready.");
    } catch (rollbackError) {
      toast.error(`Could not roll back to this message: ${String(rollbackError)}`);
    } finally {
      setRollingBackMessageId((current) => (current === message.id ? null : current));
    }
  }, [
    activeThread,
    activeThreadId,
    canRollbackMessages,
    forkingMessageId,
    messages,
    rollbackCodexThread,
    rollingBackMessageId,
    setThreadMode,
  ]);

  function setPlanMode(enabled: boolean) {
    if (activeThreadId) setThreadMode(activeThreadId, enabled ? "plan" : "default");
    else if (activeWorkspaceId) setNewThreadMode(activeWorkspaceId, enabled ? "plan" : "default");
  }

  function addPaths(paths: string[]) {
    setAttachments((current) => {
      const known = new Set(current.map((item) => item.filePath.toLowerCase()));
      const added = paths
        .map((filePath) => filePath.trim())
        .filter((filePath) => filePath && !known.has(filePath.toLowerCase()))
        .map((filePath) => {
          const fileName = fileNameFromPath(filePath);
          return { id: crypto.randomUUID(), fileName, filePath, sizeBytes: 0, mimeType: guessMimeType(fileName) };
        });
      return [...current, ...added];
    });
  }

  async function chooseAttachments() {
    const selected = await open({ multiple: true, directory: false, title: "Attach files" });
    if (!selected) return;
    addPaths(Array.isArray(selected) ? selected : [selected]);
  }

  async function savePastedImage(file: File): Promise<ChatAttachment | null> {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
    const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
    return ipc.savePastedImageAttachment(file.name || `pasted-${Date.now()}.png`, file.type || "image/png", base64);
  }

  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const images = [...event.clipboardData.files].filter((file) => file.type.startsWith("image/"));
    if (!images.length) return;
    event.preventDefault();
    void Promise.all(images.map(savePastedImage)).then((saved) => {
      setAttachments((current) => [...current, ...saved.filter((item): item is ChatAttachment => Boolean(item))]);
    }).catch((pasteError) => toast.error(`Could not attach pasted image: ${String(pasteError)}`));
  }

  async function submit() {
    const text = input.trim();
    if ((!text && !attachments.length) || !activeWorkspaceId) return;
    let targetThreadId = activeThreadId;
    if (!targetThreadId) targetThreadId = await createAndActivateWorkspaceThread(activeWorkspaceId);
    if (!targetThreadId) return;

    const submittedAttachments = attachments;
    const inputItems = referenceCatalog ? buildCodexInputItems(text, referenceCatalog.skills, referenceCatalog.apps) : undefined;
    const accepted = streaming
      ? await steer(text, { threadIdOverride: targetThreadId, attachments: submittedAttachments, inputItems, planMode })
      : await send(text, {
          threadIdOverride: targetThreadId,
          engineId: "codex",
          modelId: selectedModel?.id ?? null,
          reasoningEffort,
          attachments: submittedAttachments,
          inputItems,
          planMode,
        });
    if (accepted) {
      setInput("");
      setAttachments([]);
      nearBottomRef.current = true;
      requestAnimationFrame(() => textareaRef.current?.focus());
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  }

  async function updatePolicy(patch: Parameters<typeof ipc.setThreadExecutionPolicy>[1]) {
    if (!activeThread) return;
    try {
      const updated = await ipc.setThreadExecutionPolicy(activeThread.id, patch);
      applyThreadUpdateLocal(updated);
    } catch (policyError) {
      toast.error(`Could not update execution policy: ${String(policyError)}`);
    }
  }

  async function updateServiceTier(value: string) {
    if (!activeThread) return;
    try {
      const updated = await ipc.setThreadCodexConfig(activeThread.id, { serviceTier: value === "inherit" ? null : value });
      applyThreadUpdateLocal(updated);
    } catch (configError) {
      toast.error(`Could not update Codex mode: ${String(configError)}`);
    }
  }

  if (!workspace) {
    return <main className="codex-empty"><div className="codex-mark large">C</div><h1>Open a workspace</h1><p>Choose a folder to start working with Codex.</p></main>;
  }

  return (
    <main className="codex-chat">
      <header className="codex-chat-header">
        <div>
          <button
            className="codex-title-button"
            type="button"
            disabled={!activeThread}
            onDoubleClick={() => {
              if (!activeThread) return;
              const title = window.prompt("Rename conversation", activeThread.title)?.trim();
              if (title) void renameThread(activeThread.id, title);
            }}
          >
            {activeThread?.title ?? "New conversation"}
          </button>
          <span>{workspace.name} · {status === "streaming" ? "Codex is working" : status.replace("_", " ")}</span>
        </div>
        <button type="button" className={policyOpen ? "active" : ""} onClick={() => setPolicyOpen((open) => !open)} title="Execution settings">
          <Settings2 size={15} />
        </button>
      </header>

      {policyOpen && activeThread && (
        <div className="codex-policy-bar">
          <label>Approvals<select value={readMetadataString(activeThread, "sandboxApprovalPolicy") ?? "inherit"} onChange={(event) => void updatePolicy({ approvalPolicy: event.target.value === "inherit" ? null : event.target.value })}>
            <option value="inherit">Config default</option><option value="untrusted">Untrusted commands</option><option value="on-failure">On failure</option><option value="on-request">On request</option><option value="never">Never</option>
          </select></label>
          <label>Sandbox<select value={readMetadataString(activeThread, "sandboxMode") ?? "inherit"} onChange={(event) => void updatePolicy({ sandboxMode: event.target.value === "inherit" ? null : event.target.value })}>
            <option value="inherit">Config default</option><option value="read-only">Read only</option><option value="workspace-write">Workspace write</option><option value="danger-full-access">Full access</option>
          </select></label>
          <label>Network<select value={activeThread.engineMetadata?.sandboxAllowNetwork === true ? "enabled" : activeThread.engineMetadata?.sandboxAllowNetwork === false ? "restricted" : "inherit"} onChange={(event) => void updatePolicy({ allowNetwork: event.target.value === "inherit" ? null : event.target.value === "enabled" })}>
            <option value="inherit">Config default</option><option value="enabled">Enabled</option><option value="restricted">Restricted</option>
          </select></label>
          <label>Service<select value={readMetadataString(activeThread, "serviceTier") ?? "inherit"} onChange={(event) => void updateServiceTier(event.target.value)}>
            <option value="inherit">Standard</option><option value="fast">Fast</option><option value="flex">Flex</option>
          </select></label>
        </div>
      )}

      <div
        ref={viewportRef}
        className="codex-message-viewport"
        onScroll={(event) => {
          const element = event.currentTarget;
          nearBottomRef.current = element.scrollHeight - element.scrollTop - element.clientHeight < 160;
        }}
      >
        {hasOlderMessages && (
          <button className="codex-load-older" type="button" disabled={loadingOlderMessages} onClick={() => void loadOlderMessages()}>
            <ArrowDown size={13} className="rotate" /> {loadingOlderMessages ? "Loading…" : "Load older messages"}
          </button>
        )}
        {!activeThread && <div className="codex-welcome"><h1>What should we work on?</h1><p>Codex can inspect, edit, test, and explain anything in {workspace.name}.</p></div>}
        {activeThread && boundThreadId !== activeThread.id && <div className="codex-loading">Loading conversation…</div>}
        {messages.map((message) => {
          const blocks = messageBlocks(message);
          const copyText = message.content ?? blocks.filter((block) => block.type === "text").map((block) => block.content).join("\n\n");
          const canForkMessage =
            message.role === "assistant" &&
            message.status !== "streaming" &&
            canForkMessages;
          const canRollbackMessage =
            message.role === "user" &&
            canRollbackMessages &&
            isEditableUserTurn(message);
          const isForkingMessage = forkingMessageId === message.id;
          const isRollingBackMessage = rollingBackMessageId === message.id;
          return (
            <article key={message.id} className={`codex-message ${message.role}`} data-message-id={message.id}>
              <div className="codex-message-label">
                {message.role === "user" ? "You" : "Codex"}
                {message.role === "user" && <CopyMessageButton text={copyText} />}
                {canRollbackMessage && (
                  <button
                    className="codex-rollback-message"
                    type="button"
                    title={isRollingBackMessage ? "Rolling back conversation" : "Roll back to here"}
                    aria-label={isRollingBackMessage ? "Rolling back conversation" : "Roll back to here"}
                    disabled={forkingMessageId !== null || rollingBackMessageId !== null}
                    onClick={() => void rollbackToMessage(message)}
                  >
                    {isRollingBackMessage
                      ? <LoaderCircle size={12} className="codex-spin" />
                      : <RotateCcw size={12} />}
                  </button>
                )}
              </div>
              <Suspense fallback={<div className="codex-loading">Rendering…</div>}>
                {message.role === "assistant" ? (
                  <CodexTurnTranscript
                    messageId={message.id}
                    blocks={blocks}
                    status={message.status}
                    tokenUsage={message.tokenUsage}
                    workspaceRootPath={workspace.rootPath}
                    refreshSequence={transcriptSequences[message.id] ?? 0}
                    onApproval={approval}
                    onLoadActionOutput={(actionId) => hydrateActionOutput(message.id, actionId)}
                  />
                ) : (
                  <MessageBlocks
                    blocks={blocks}
                    status={message.status}
                    messageRole={message.role}
                    workspaceRootPath={workspace.rootPath}
                    onApproval={approval}
                    onLoadActionOutput={(actionId) => hydrateActionOutput(message.id, actionId)}
                  />
                )}
              </Suspense>
              {message.role === "assistant" && message.status !== "streaming" && (
                <div className="codex-message-actions">
                  <CopyMessageButton text={copyText} />
                  {canForkMessage && (
                    <button
                      className="codex-fork-message"
                      type="button"
                      title={isForkingMessage ? "Forking conversation" : "Fork from here"}
                      aria-label={isForkingMessage ? "Forking conversation" : "Fork from here"}
                      disabled={forkingMessageId !== null || rollingBackMessageId !== null}
                      onClick={() => void forkFromMessage(message)}
                    >
                      {isForkingMessage
                        ? <LoaderCircle size={12} className="codex-spin" />
                        : <GitBranch size={12} />}
                    </button>
                  )}
                </div>
              )}
            </article>
          );
        })}
        {error && <div className="codex-error">{error}</div>}
      </div>

      <div className={`codex-composer-wrap ${planMode ? "plan" : ""}`}>
        {attachments.length > 0 && (
          <div className="codex-attachments">
            {attachments.map((attachment) => <button key={attachment.id} type="button" title="Remove" onClick={() => setAttachments((items) => items.filter((item) => item.id !== attachment.id))}>{attachment.fileName} ×</button>)}
          </div>
        )}
        <div className="codex-composer">
          <textarea
            ref={textareaRef}
            rows={2}
            value={input}
            disabled={!activeWorkspaceId}
            placeholder={planMode ? "Ask Codex to make a plan…" : streaming ? "Steer the current turn…" : "Message Codex…"}
            onChange={(event) => setInput(event.target.value)}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
          />
          <div className="codex-composer-toolbar">
            <button type="button" onClick={() => void chooseAttachments()} title="Attach files"><Paperclip size={14} /></button>
            <button type="button" className={planMode ? "active" : ""} onClick={() => setPlanMode(!planMode)} disabled={streaming} title="Plan mode"><ListChecks size={14} /> Plan</button>
            <select value={selectedModel?.id ?? ""} onChange={(event) => {
              const model = models.find((item) => item.id === event.target.value) ?? null;
              setSelectedModelId(event.target.value);
              setReasoningEffort(resolveReasoningEffortForModel(model, reasoningEffort));
            }} aria-label="Model">
              {models.map((model) => <option key={model.id} value={model.id}>{model.displayName || model.id}</option>)}
            </select>
            {selectedModel && selectedModel.supportedReasoningEfforts.length > 0 && (
              <label className="codex-effort"><Brain size={13} /><select value={reasoningEffort ?? ""} onChange={(event) => setReasoningEffort(event.target.value || null)} aria-label="Reasoning effort">
                {selectedModel.supportedReasoningEfforts.map((option) => <option key={option.reasoningEffort} value={option.reasoningEffort}>{option.reasoningEffort}</option>)}
              </select></label>
            )}
            {readMetadataString(activeThread, "serviceTier") === "fast" && <span className="codex-fast"><Zap size={12} /> Fast</span>}
            {usage?.contextPercent !== null && usage?.contextPercent !== undefined && <span className="codex-usage">{Math.round(usage.contextPercent)}% context</span>}
            <span className="spacer" />
            {streaming && <button type="button" onClick={() => void cancel()} title="Stop"><Square size={13} /></button>}
            <button className="send" type="button" disabled={(!input.trim() && !attachments.length) || !selectedModel} onClick={() => void submit()} title={streaming ? "Steer" : "Send"}><Send size={14} /></button>
          </div>
        </div>
      </div>
    </main>
  );
}
