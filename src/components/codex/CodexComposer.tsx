import { open } from "@tauri-apps/plugin-dialog";
import { Paperclip, Send, Square } from "lucide-react";
import {
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ClipboardEvent,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from "react";
import { ipc } from "../../lib/codexIpc";
import { toast } from "../../stores/toastStore";
import type { ChatAttachment, ChatInputItem, CodexApp, CodexSkill } from "../../types";
import { AttachmentChip } from "../chat/AttachmentChip";
import { buildCodexInputItems } from "../chat/codexInputItems";
import { mergeUniqueChatAttachments } from "../chat/messageEditBranching";

interface ComposerDraft {
  text: string;
  attachments: ChatAttachment[];
}

export interface CodexComposerSubmission extends ComposerDraft {
  inputItems?: ChatInputItem[];
}

export interface CodexComposerHandle {
  setDraft: (draft: ComposerDraft) => void;
  focus: () => void;
}

interface CodexComposerProps {
  ref: Ref<CodexComposerHandle>;
  workspaceRootPath: string;
  disabled: boolean;
  submitDisabled: boolean;
  submitTitle: string;
  placeholder: string;
  streaming: boolean;
  onSubmit: (submission: CodexComposerSubmission, onAccepted: () => void) => Promise<boolean>;
  onTogglePlanMode: () => void;
  onStop: () => Promise<void>;
  prompt: ReactNode;
  children: ReactNode;
}

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

// Draft changes belong below the chat/transcript boundary. The parent is notified
// only on submission; typing and attachments never invalidate message rendering.
export function CodexComposer({
  ref,
  workspaceRootPath,
  disabled,
  submitDisabled,
  submitTitle,
  placeholder,
  streaming,
  onSubmit,
  onTogglePlanMode,
  onStop,
  prompt,
  children,
}: CodexComposerProps) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [input, setInput] = useState("");
  const [attachments, setAttachments] = useState<ChatAttachment[]>([]);
  const [referenceCatalog, setReferenceCatalog] = useState<{ skills: CodexSkill[]; apps: CodexApp[] } | null>(null);
  const needsReferenceCatalog = input.includes("$");

  useImperativeHandle(ref, () => ({
    setDraft: (draft) => {
      setInput(draft.text);
      setAttachments(draft.attachments);
    },
    focus: () => textareaRef.current?.focus(),
  }), []);

  useEffect(() => {
    setReferenceCatalog(null);
  }, [workspaceRootPath]);

  useEffect(() => {
    if (!needsReferenceCatalog || referenceCatalog || !workspaceRootPath) return;
    let cancelled = false;
    void Promise.all([ipc.listCodexSkills(workspaceRootPath), ipc.listCodexApps()])
      .then(([skills, apps]) => { if (!cancelled) setReferenceCatalog({ skills, apps }); })
      .catch(() => { if (!cancelled) setReferenceCatalog({ skills: [], apps: [] }); });
    return () => { cancelled = true; };
  }, [needsReferenceCatalog, referenceCatalog, workspaceRootPath]);

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

  async function savePastedImage(file: File): Promise<ChatAttachment> {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result));
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(file);
    });
    const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
    const saved = await ipc.savePastedImageAttachment(
      file.name || `pasted-${Date.now()}.png`,
      file.type || "image/png",
      base64,
    );
    return { ...saved, id: crypto.randomUUID() };
  }

  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    const images = [...event.clipboardData.files].filter((file) => file.type.startsWith("image/"));
    if (!images.length) return;
    event.preventDefault();
    void Promise.all(images.map(savePastedImage)).then((saved) => {
      setAttachments((current) => [...current, ...saved]);
    }).catch((pasteError) => toast.error(`Could not attach pasted image: ${String(pasteError)}`));
  }

  async function submit() {
    const submittedInput = input;
    const text = input.trim();
    if (disabled || submitDisabled || (!text && !attachments.length)) return;
    const submittedAttachments = attachments;
    const inputItems = referenceCatalog ? buildCodexInputItems(text, referenceCatalog.skills, referenceCatalog.apps) : undefined;
    let composerConsumed = false;
    const consumeSubmittedComposer = () => {
      if (composerConsumed) return;
      composerConsumed = true;
      setInput("");
      setAttachments([]);
      requestAnimationFrame(() => textareaRef.current?.focus());
    };
    const accepted = await onSubmit({ text, attachments: submittedAttachments, inputItems }, consumeSubmittedComposer);
    if (accepted) {
      // The store consumes the draft synchronously with the optimistic turn.
      // Keep the fallback for alternate implementations and test doubles.
      consumeSubmittedComposer();
    } else if (composerConsumed) {
      setInput((current) => {
        if (!current) return submittedInput;
        if (!submittedInput || current === submittedInput) return current;
        return `${submittedInput}${submittedInput.endsWith("\n") ? "" : "\n"}${current}`;
      });
      setAttachments((current) => mergeUniqueChatAttachments(submittedAttachments, current));
    }
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.shiftKey && event.key === "Tab" && !streaming && !disabled) {
      event.preventDefault();
      onTogglePlanMode();
      return;
    }
    if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
      event.preventDefault();
      void submit();
    }
  }

  // Keep the composer mounted when a question or plan prompt takes over so its
  // draft survives until the ordinary input is shown again.
  if (prompt) return prompt;

  return (
    <>
      {attachments.length > 0 && (
        <div className="codex-composer-attachments" aria-label="Attached files">
          {attachments.map((attachment) => (
            <AttachmentChip
              key={attachment.id}
              attachment={attachment}
              composerPreview
              removeLabel={`Remove ${attachment.fileName}`}
              onRemove={() => setAttachments((items) => items.filter((item) => item.id !== attachment.id))}
            />
          ))}
        </div>
      )}
      <textarea
        ref={textareaRef}
        rows={2}
        value={input}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(event) => setInput(event.target.value)}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
      />
      <div className="codex-composer-toolbar">
        <button type="button" onClick={() => void chooseAttachments()} disabled={disabled} title="Attach files"><Paperclip size={14} /></button>
        {children}
        <span className="spacer" />
        {streaming && <button type="button" onClick={() => void onStop()} title="Stop"><Square size={13} /></button>}
        <button className="send" type="button" disabled={disabled || submitDisabled || (!input.trim() && !attachments.length)} onClick={() => void submit()} title={submitTitle}><Send size={14} /></button>
      </div>
    </>
  );
}
