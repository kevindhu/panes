import {
  memo,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import {
  CheckCircle2,
  Circle,
  AlertTriangle,
  CornerDownRight,
  ChevronRight,
  FileCode2,
  FileDiff,
  Terminal,
  Shield,
  Loader2,
  XCircle,
  Brain,
  Info,
  Layers,
  Copy,
  Check,
  MessageSquare,
  Search,
} from "lucide-react";
import type {
  ActionBlock,
  ApprovalBlock,
  ApprovalResponse,
  AttachmentBlock,
  ContentBlock,
  DiffBlock,
  MessageStatus,
  NoticeBlock,
  SteerBlock,
  ThinkingBlock,
} from "../../types";
import {
  buildDynamicToolCallResponse,
  defaultAdvancedApprovalPayload,
  isDynamicToolCallApproval,
  isMcpElicitationApproval,
  isPermissionsRequestApproval,
  isRequestUserInputApproval,
  parseApprovalCommand,
  parseApprovalReason,
  parseDynamicToolCallArguments,
  parseDynamicToolCallName,
  parseMcpElicitationMessage,
  parseMcpElicitationMode,
  parseMcpElicitationSchema,
  parseMcpElicitationServerName,
  parseMcpElicitationUrl,
  parseProposedExecpolicyAmendment,
  parseProposedNetworkPolicyAmendments,
  parseRequestedPermissions,
  parseToolInputQuestions,
  requiresCustomApprovalPayload,
} from "./toolInputApproval";
import {
  extractDiffFilename,
} from "../../lib/parseDiff";
import { getMessageBlockKey } from "./messageBlockKeys";
import {
  VirtualizedDiffBody,
  useParsedDiff,
} from "../shared/DiffViewer";
import MarkdownContent from "./MarkdownContent";
import { AttachmentChip } from "./AttachmentChip";
import {
  extractTextLinkMatches,
  navigateLinkTarget,
} from "../../lib/fileLinkNavigation";
import {
  recordTranscriptLinkPointerDown,
  transcriptLinkShouldNavigate,
} from "../../lib/transcriptSelection";
import { webSearchDetails } from "../../lib/codexTranscript";
import {
  extractChatImagesFromPayload,
  isLikelyInlineImagePayload,
  redactChatImagePayload,
} from "../../lib/chatImageSources";
import { ChatImageGallery } from "./ChatImage";
interface Props {
  blocks?: ContentBlock[];
  status?: MessageStatus;
  workspaceRootPath?: string | null;
  selectionNamespace?: string;
  onApproval: (approvalId: string, response: ApprovalResponse) => void;
  onLoadActionOutput?: (actionId: string) => Promise<void>;
}

const CONTEXT_COMPACTION_SUMMARY_DETAIL_PREFIX = "summary::";
const CONTEXT_COMPACTION_PROMPT_DETAIL_PREFIX = "prompt::";

function isBlockLike(value: unknown): value is { type: string } {
  return typeof value === "object" && value !== null && "type" in value;
}

function getSelectionBlockScopeKey(
  block: ContentBlock,
  index: number,
  blocks: ContentBlock[],
): string {
  if (block.type === "action") return `action:${block.actionId}`;
  if (block.type === "approval") return `approval:${block.approvalId}`;
  if (block.type === "steer") return `steer:${block.steerId}`;
  let ordinal = 0;
  for (let current = 0; current < index; current += 1) {
    if (blocks[current]?.type === block.type) ordinal += 1;
  }
  return `${block.type}:${ordinal}`;
}

function dedupeDiffBlocksByScope(blocks: ContentBlock[]): ContentBlock[] {
  const latestDiffIndexByScope = new Map<string, number>();
  blocks.forEach((block, index) => {
    if (block.type === "diff") {
      latestDiffIndexByScope.set(String(block.scope ?? "turn"), index);
    }
  });

  if (latestDiffIndexByScope.size === 0) {
    return blocks;
  }

  return blocks.filter((block, index) => {
    if (block.type !== "diff") {
      return true;
    }
    return latestDiffIndexByScope.get(String(block.scope ?? "turn")) === index;
  });
}

function CodeBlockCopyButton({ content }: { content: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = useCallback(() => {
    navigator.clipboard.writeText(content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  }, [content]);
  return (
    <button
      type="button"
      onClick={handleCopy}
      style={{
        marginLeft: "auto", flexShrink: 0, cursor: "pointer",
        background: "none", border: "none", padding: "2px",
        color: copied ? "var(--success)" : "var(--text-3)",
        opacity: copied ? 1 : 0.5,
        transition: "color var(--duration-fast) var(--ease-out), opacity var(--duration-fast) var(--ease-out)",
      }}
      aria-label="Copy code"
    >
      {copied ? <Check size={12} /> : <Copy size={12} />}
    </button>
  );
}

function handleToggleKeyDown(e: React.KeyboardEvent, toggle: () => void) {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    toggle();
  }
}

function handlePlainTextLinkClick(
  event: ReactMouseEvent<HTMLAnchorElement>,
  target: string,
) {
  if (event.defaultPrevented || event.button !== 0) {
    return;
  }

  event.preventDefault();
  if (!transcriptLinkShouldNavigate(event, event.currentTarget)) return;
  event.stopPropagation();
  void navigateLinkTarget(target);
}

export const ACTION_HEADER_MAX_CHARS = 160;

export function truncateActionHeader(text: string): string {
  if (text.length <= ACTION_HEADER_MAX_CHARS) {
    return text;
  }
  return `${text.slice(0, ACTION_HEADER_MAX_CHARS).trimEnd()}\u2026`;
}

export function LinkifiedPlainText({ text }: { text: string }) {
  const matches = useMemo(() => extractTextLinkMatches(text), [text]);
  if (matches.length === 0) {
    return <>{text}</>;
  }

  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (const match of matches) {
    if (match.startIndex > cursor) {
      nodes.push(text.slice(cursor, match.startIndex));
    }
    nodes.push(
      <a
        key={`${match.startIndex}:${match.endIndex}:${match.text}`}
        href={match.text}
        className="chat-plain-link"
        rel="noreferrer noopener"
        onMouseDown={(event) => recordTranscriptLinkPointerDown(event, event.currentTarget)}
        onClick={(event) => handlePlainTextLinkClick(event, match.text)}
      >
        {match.text}
      </a>,
    );
    cursor = match.endIndex;
  }

  if (cursor < text.length) {
    nodes.push(text.slice(cursor));
  }

  return <>{nodes}</>;
}

const actionIcons: Record<string, typeof Terminal> = {
  command: Terminal,
  file_write: FileCode2,
  file_edit: FileCode2,
  file_read: FileCode2,
  file_delete: FileCode2,
  search: Search,
};

/* ── Action Group Segmentation ── */

const ACTION_GROUP_MIN_SIZE = 3;

type InnerSegment =
  | { kind: "single"; block: ContentBlock; index: number }
  | { kind: "action-group"; blocks: ActionBlock[]; indices: number[] };

type BlockSegment =
  | InnerSegment
  | { kind: "action-card"; segments: InnerSegment[] }
  | { kind: "divider" };

function isCardSegment(seg: BlockSegment): seg is InnerSegment {
  if (seg.kind === "action-group") return true;
  if (
    seg.kind === "single" &&
    (
      seg.block.type === "action" ||
      seg.block.type === "diff" ||
      seg.block.type === "thinking" ||
      seg.block.type === "approval"
    )
  ) {
    return true;
  }
  return false;
}

function buildBlockSegments(blocks: ContentBlock[], isStreaming?: boolean): BlockSegment[] {
  // Phase 1: build flat inner segments
  const flat: BlockSegment[] = [];
  let i = 0;
  while (i < blocks.length) {
    const block = blocks[i];
    if (block.type !== "action") {
      flat.push({ kind: "single", block, index: i });
      i++;
      continue;
    }

    // Collect consecutive action blocks
    const runStart = i;
    while (i < blocks.length && blocks[i].type === "action") {
      i++;
    }
    const runEnd = i; // exclusive

    // Split the run: active (running/pending) actions break out as singles,
    // completed sub-runs of 3+ become groups
    let subStart = runStart;
    while (subStart < runEnd) {
      const actionBlock = blocks[subStart] as ActionBlock;
      if (actionBlock.status === "running" || actionBlock.status === "pending") {
        flat.push({ kind: "single", block: actionBlock, index: subStart });
        subStart++;
        continue;
      }

      // Collect consecutive completed/error actions
      let subEnd = subStart;
      while (subEnd < runEnd) {
        const ab = blocks[subEnd] as ActionBlock;
        if (ab.status === "running" || ab.status === "pending") break;
        subEnd++;
      }

      const count = subEnd - subStart;
      if (!isStreaming && count >= ACTION_GROUP_MIN_SIZE) {
        const groupBlocks = blocks.slice(subStart, subEnd) as ActionBlock[];
        const indices = Array.from({ length: count }, (_, k) => subStart + k);
        flat.push({ kind: "action-group", blocks: groupBlocks, indices });
      } else {
        for (let j = subStart; j < subEnd; j++) {
          flat.push({ kind: "single", block: blocks[j], index: j });
        }
      }
      subStart = subEnd;
    }
  }

  // Phase 2: wrap consecutive action segments into action-card containers
  const segments: BlockSegment[] = [];
  let j = 0;
  while (j < flat.length) {
    const seg = flat[j];
    if (!isCardSegment(seg)) {
      segments.push(seg);
      j++;
      continue;
    }
    const cardSegments: InnerSegment[] = [seg];
    j++;
    while (j < flat.length && isCardSegment(flat[j])) {
      cardSegments.push(flat[j] as InnerSegment);
      j++;
    }
    segments.push({
      kind: "action-card",
      // Card styling may span adjacent activity-like blocks, but chronology may
      // not. Completed actions separated by a thought, diff, or approval must
      // remain on their original sides of that boundary.
      segments: cardSegments,
    });
  }
  return segments;
}

/* ── Diff Block ── */

function MessageDiffBlock({ block }: { block: DiffBlock }) {
  const { t } = useTranslation("chat");
  const [expanded, setExpanded] = useState(false);
  const raw = String(block.diff ?? "");
  const fallbackFilename = useMemo(() => extractDiffFilename(raw), [raw]);
  const {
    parseResult,
    loading: loadingParse,
    parseAttempted,
  } = useParsedDiff(raw, {
    enabled: expanded,
  });
  const filename = parseResult?.filename ?? fallbackFilename;
  const adds = parseResult?.adds ?? 0;
  const dels = parseResult?.dels ?? 0;

  const toggleExpanded = useCallback(() => setExpanded((v) => !v), []);
  return (
    <div>
      <div
        className="msg-block-header"
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={toggleExpanded}
        onKeyDown={(e) => handleToggleKeyDown(e, toggleExpanded)}
      >
        <ChevronRight
          size={11}
          className={`msg-block-chevron${expanded ? " msg-block-chevron-open" : ""}`}
        />
        <FileDiff size={12} style={{ color: "var(--text-3)", flexShrink: 0 }} />
        <span style={{ fontSize: 11.5, color: "var(--text-2)", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          <LinkifiedPlainText text={filename ?? t("messageBlocks.diffFallback", { scope: String(block.scope ?? "turn") })} />
        </span>
        {loadingParse && (
          <span style={{ fontSize: 10, color: "var(--text-3)", flexShrink: 0 }}>
            {t("messageBlocks.parsing")}
          </span>
        )}
        {(adds > 0 || dels > 0) && (
          <span style={{ fontSize: 10, fontFamily: '"JetBrains Mono", monospace', display: "flex", gap: 5, flexShrink: 0 }}>
            {adds > 0 && <span style={{ color: "var(--success)" }}>+{adds}</span>}
            {dels > 0 && <span style={{ color: "var(--danger)" }}>-{dels}</span>}
          </span>
        )}
      </div>
      {expanded && (
        !parseResult && (loadingParse || !parseAttempted) ? (
          <div style={{ padding: "4px 14px", fontSize: 11.5, color: "var(--text-3)" }}>
            {t("messageBlocks.parsingDiff")}
          </div>
        ) : parseResult && parseResult.parsed.length > 0 ? (
          <div style={{
            margin: "2px 12px 4px",
            borderRadius: "var(--radius-sm)",
            border: "1px solid var(--border)",
            background: "var(--code-bg)",
          }}>
            <VirtualizedDiffBody parsed={parseResult.parsed} />
          </div>
        ) : (
          <div style={{ padding: "4px 14px", fontSize: 11.5, color: "var(--text-3)" }}>
            {t("messageBlocks.noChanges")}
          </div>
        )
      )}
    </div>
  );
}

/* ── Thinking Block ── */

function ThinkingBlockView({
  block,
  isStreaming,
  workspaceRootPath,
  selectionScopeId,
}: {
  block: ThinkingBlock;
  isStreaming: boolean;
  workspaceRootPath?: string | null;
  selectionScopeId: string;
}) {
  const { t } = useTranslation("chat");
  const [expanded, setExpanded] = useState(false);
  const content = String(block.content ?? "");

  const durationSec = block.durationMs != null ? Math.round(block.durationMs / 1000) : null;
  const thinkingLabel = isStreaming
    ? `${t("messageBlocks.thinking")}\u2026`
    : durationSec != null && durationSec > 0
      ? t("messageBlocks.thinkingDone", { seconds: durationSec })
      : t("messageBlocks.thinking");
  const toggleExpanded = useCallback(() => setExpanded((v) => !v), []);

  return (
    <div>
      <div
        className="msg-block-header"
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={toggleExpanded}
        onKeyDown={(e) => handleToggleKeyDown(e, toggleExpanded)}
      >
        <ChevronRight
          size={11}
          className={`msg-block-chevron${expanded ? " msg-block-chevron-open" : ""}`}
        />
        <Brain
          size={12}
          className={isStreaming ? "thinking-icon-active" : undefined}
          style={{ color: "var(--text-3)", flexShrink: 0, verticalAlign: "middle" }}
        />
        <span style={{ fontSize: 11.5, color: "var(--text-2)", lineHeight: 1 }}>
          {thinkingLabel}
        </span>
      </div>
      {expanded && (
        isStreaming ? (
          <pre
            style={{
              margin: 0,
              fontSize: 12.5,
              color: "var(--text-2)",
              padding: "2px 12px 8px 30px",
              minWidth: 0,
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
              fontFamily: "inherit",
            }}
          >
            {content}
          </pre>
        ) : (
          <MarkdownContent
            content={content}
            className="prose"
            workspaceRootPath={workspaceRootPath}
            selectionScopeId={selectionScopeId}
            style={{
              fontSize: 12.5,
              color: "var(--text-2)",
              padding: "2px 12px 8px 30px",
              minWidth: 0,
            }}
          />
        )
      )}
    </div>
  );
}

function NoticeBlockView({ block }: { block: NoticeBlock }) {
  if (
    block.kind === "context_compacted" ||
    block.kind.startsWith("codex_context_compaction_")
  ) {
    return <ContextCompactionNoticeView block={block} />;
  }

  return (
    <div className="msg-notice-block msg-notice-block--info">
      <Info size={14} style={{ flexShrink: 0, color: "var(--info)", marginTop: 1 }} />
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: "var(--info)", marginBottom: 2 }}>
          {block.title}
        </div>
        <div>{block.message}</div>
      </div>
    </div>
  );
}

function ContextCompactionNoticeView({ block }: { block: NoticeBlock }) {
  const { t } = useTranslation("chat");
  const [expanded, setExpanded] = useState(false);
  const details = (block.details ?? []).filter((detail) => detail.trim().length > 0);
  const toggleExpanded = useCallback(() => setExpanded((value) => !value), []);

  const renderDetail = (detail: string, index: number) => {
    let label: string | null = null;
    let content = detail;

    if (detail.startsWith(CONTEXT_COMPACTION_SUMMARY_DETAIL_PREFIX)) {
      label = t("messageBlocks.contextCompaction.summary");
      content = detail.slice(CONTEXT_COMPACTION_SUMMARY_DETAIL_PREFIX.length);
    } else if (detail.startsWith(CONTEXT_COMPACTION_PROMPT_DETAIL_PREFIX)) {
      label = t("messageBlocks.contextCompaction.prompt");
      content = detail.slice(CONTEXT_COMPACTION_PROMPT_DETAIL_PREFIX.length);
    }

    return (
      <div
        key={`${detail}:${index}`}
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 2,
        }}
      >
        {label && (
          <div style={{ fontSize: 10.5, fontWeight: 600, color: "var(--text-3)" }}>
            {label}
          </div>
        )}
        <div
          style={{
            fontSize: 11.5,
            color: "var(--text-2)",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            fontFamily: '"JetBrains Mono", monospace',
          }}
        >
          <LinkifiedPlainText text={content} />
        </div>
      </div>
    );
  };

  return (
    <div className="msg-notice-block msg-notice-block--info">
      <Layers size={14} style={{ flexShrink: 0, color: "var(--info)", marginTop: 1 }} />
      <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 6 }}>
        <div style={{ fontSize: 11, fontWeight: 600, color: "var(--info)" }}>
          {block.title}
        </div>
        <div>{block.message}</div>
        {details.length > 0 && (
          <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
            <button
              type="button"
              className="acard-toggle"
              onClick={toggleExpanded}
              style={{ alignSelf: "flex-start" }}
            >
              {expanded
                ? t("messageBlocks.approval.hideDetails")
                : t("messageBlocks.approval.showDetails")}
            </button>
            {expanded && (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                {details.map(renderDetail)}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function SteerBlockView({ block }: { block: SteerBlock }) {
  const attachmentBlocks = block.attachments ?? [];
  const skillBlocks = block.skills ?? [];
  const mentionBlocks = block.mentions ?? [];
  const hasContent = block.content.trim().length > 0;

  return (
    <div className="msg-notice-block msg-notice-block--steer">
      <CornerDownRight size={14} style={{ flexShrink: 0, color: "var(--danger)", marginTop: 1 }} />
      <div style={{ minWidth: 0, display: "flex", flexDirection: "column", gap: 6, width: "100%" }}>
        {hasContent && (
          <div
            style={{
              whiteSpace: "pre-wrap",
              wordBreak: "break-word",
            }}
          >
            {block.content}
          </div>
        )}

        {(skillBlocks.length > 0 || mentionBlocks.length > 0 || attachmentBlocks.length > 0) && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
            {skillBlocks.map((skill) => (
              <span
                key={`skill:${skill.path}`}
                className="chat-attachment-chip"
                style={{ display: "inline-flex" }}
              >
                <span className="chat-attachment-chip-name">{`$${skill.name}`}</span>
              </span>
            ))}
            {mentionBlocks.map((mention) => (
              <span
                key={`mention:${mention.path}`}
                className="chat-attachment-chip"
                style={{ display: "inline-flex" }}
              >
                <span className="chat-attachment-chip-name">{`@${mention.name}`}</span>
              </span>
            ))}
            {attachmentBlocks.map((attachment) => {
              return (
                <AttachmentChip
                  key={`attachment:${attachment.filePath}:${attachment.fileName}`}
                  attachment={attachment}
                />
              );
            })}
          </div>
        )}
        {block.status && block.status !== "accepted" && (
          <div className={`msg-steer-status ${block.status}`}>
            {block.status === "pending"
              ? "Sending interruption…"
              : block.status === "failed"
                ? `Interruption failed${block.error ? `: ${block.error}` : "."}`
                : "Interruption delivery was not confirmed."}
          </div>
        )}
      </div>
    </div>
  );
}

/* ── Action Block ── */

function ActionStatusBadge({ status }: { status: string }) {
  const { t } = useTranslation("chat");
  if (status === "done") {
    return (
      <span style={{ display: "flex", alignItems: "center", gap: 3, color: "var(--text-3)", fontSize: 10 }}>
        <CheckCircle2 size={11} />
      </span>
    );
  }
  if (status === "running") {
    return (
      <span style={{ display: "flex", alignItems: "center", gap: 3, color: "var(--warning)", fontSize: 10, fontWeight: 500 }}>
        <Loader2 size={11} className="animate-spin" />
        {t("messageBlocks.actionStatus.running")}
      </span>
    );
  }
  if (status === "error") {
    return (
      <span style={{ display: "flex", alignItems: "center", gap: 3, color: "var(--danger)", fontSize: 10 }}>
        <XCircle size={11} />
        {t("messageBlocks.actionStatus.error")}
      </span>
    );
  }
  return (
    <span style={{ display: "flex", alignItems: "center", gap: 3, color: "var(--text-3)", fontSize: 10 }}>
      <Circle size={11} />
    </span>
  );
}

function ActionBlockView({
  block,
  onLoadDeferredOutput,
  workspaceRootPath,
}: {
  block: ActionBlock;
  onLoadDeferredOutput?: () => Promise<void>;
  workspaceRootPath?: string | null;
}) {
  const { t } = useTranslation("chat");
  const actionDetails = (block.details ?? {}) as Record<string, unknown>;
  const images = useMemo(
    () => extractChatImagesFromPayload(actionDetails, {
      itemId: block.engineActionId ?? block.actionId,
      title: block.summary,
      workspaceRootPath,
    }),
    [actionDetails, block.actionId, block.engineActionId, block.summary, workspaceRootPath],
  );
  const outputChunks = useMemo(() => {
    const chunks = Array.isArray(block.outputChunks) ? block.outputChunks : [];
    if (images.length === 0) {
      return chunks;
    }
    return chunks.filter((chunk) => !isLikelyInlineImagePayload(String(chunk.content ?? "")));
  }, [block.outputChunks, images.length]);
  const outputDeferred = block.outputDeferred === true;
  const outputText = useMemo(
    () => {
      let raw: string;
      if (outputChunks.length === 0) {
        return "";
      }
      if (outputChunks.length === 1) {
        const firstContent = outputChunks[0].content;
        raw = typeof firstContent === "string" ? firstContent : String(firstContent ?? "");
      } else {
        raw = outputChunks.map((chunk) => String(chunk.content ?? "")).join("");
      }
      // Unescape literal \n and \t sequences that come from JSON-encoded engine output
      if (raw.includes("\\n") || raw.includes("\\t")) {
        raw = raw.replace(/\\n/g, "\n").replace(/\\t/g, "\t");
      }
      return raw;
    },
    [outputChunks],
  );
  const Icon = actionIcons[block.actionType] ?? Terminal;
  const searchDetails = useMemo(
    () => block.actionType === "search" ? webSearchDetails(actionDetails) : null,
    [actionDetails, block.actionType],
  );
  const displaySummary = useMemo(() => {
    if (!searchDetails) return block.summary;
    if (searchDetails.queries.length > 1) {
      return `Searched ${searchDetails.queries[0]} +${searchDetails.queries.length - 1} more`;
    }
    if (searchDetails.query) return `Searched ${searchDetails.query}`;
    if (searchDetails.results.length > 0) {
      return `Read ${searchDetails.results.length} ${searchDetails.results.length === 1 ? "source" : "sources"}`;
    }
    return block.summary;
  }, [block.summary, searchDetails]);
  const inputDetail = useMemo(() => {
    const pretty = (value: unknown) => {
      try {
        return JSON.stringify(redactChatImagePayload(value), null, 2) ?? String(value);
      } catch {
        return String(value);
      }
    };
    if (block.actionType === "command") {
      const command = typeof actionDetails.command === "string" ? actionDetails.command : block.summary;
      return { label: "Command", content: command };
    }
    if (block.actionType === "search") {
      if (!searchDetails) return { label: "Web search", content: pretty(actionDetails) };
      const operation = searchDetails.actionType ?? (searchDetails.queries.length > 0 ? "search" : "browse");
      const queryLines = searchDetails.queries.length > 0
        ? searchDetails.queries.map((query) => `- ${query}`).join("\n")
        : "(no textual query emitted)";
      return { label: "Web search", content: `operation: ${operation}\nqueries:\n${queryLines}` };
    }
    if (Object.keys(actionDetails).length > 0) {
      return { label: "Tool input", content: pretty(actionDetails) };
    }
    return { label: "Tool input", content: block.summary };
  }, [actionDetails, block.actionType, block.summary, searchDetails]);
  const outputTruncated =
    "outputTruncated" in actionDetails && actionDetails.outputTruncated === true;
  const progressMessage =
    actionDetails.progressKind === "mcp" && typeof actionDetails.progressMessage === "string"
      ? actionDetails.progressMessage
      : null;
  const [expanded, setExpanded] = useState(() => images.length > 0);
  const previousImageCountRef = useRef(images.length);
  const [loadingDeferredOutput, setLoadingDeferredOutput] = useState(false);
  const [deferredOutputError, setDeferredOutputError] = useState<string | null>(null);
  const deferredOutputRequestedRef = useRef(false);
  const canToggle = true;

  const requestDeferredOutput = useCallback(() => {
    if (!onLoadDeferredOutput || deferredOutputRequestedRef.current) {
      return;
    }

    deferredOutputRequestedRef.current = true;
    setLoadingDeferredOutput(true);
    setDeferredOutputError(null);
    onLoadDeferredOutput()
      .catch((error) => {
        deferredOutputRequestedRef.current = false;
        setDeferredOutputError(String(error));
      })
      .finally(() => {
        setLoadingDeferredOutput(false);
      });
  }, [onLoadDeferredOutput]);

  useEffect(() => {
    if (previousImageCountRef.current === 0 && images.length > 0) {
      setExpanded(true);
    }
    previousImageCountRef.current = images.length;
  }, [images.length]);

  useEffect(() => {
    if (!expanded || !outputDeferred || outputChunks.length > 0) {
      return;
    }
    requestDeferredOutput();
  }, [expanded, outputDeferred, outputChunks.length, requestDeferredOutput]);

  useEffect(() => {
    if (!outputDeferred || outputChunks.length > 0) {
      deferredOutputRequestedRef.current = false;
    }
  }, [outputDeferred, outputChunks.length]);

  const toggleExpanded = useCallback(() => setExpanded((v) => !v), []);
  return (
    <div className="msg-action">
      <div
        className={canToggle ? "msg-block-header msg-block-header--compact" : undefined}
        style={canToggle ? undefined : { display: "flex", alignItems: "center", gap: 6, padding: "3px 12px" }}
        {...(canToggle ? {
          role: "button" as const,
          tabIndex: 0,
          "aria-expanded": expanded,
          onClick: toggleExpanded,
          onKeyDown: (e: React.KeyboardEvent) => handleToggleKeyDown(e, toggleExpanded),
        } : {})}
      >
        {canToggle && (
          <ChevronRight
            size={11}
            className={`msg-block-chevron${expanded ? " msg-block-chevron-open" : ""}`}
          />
        )}
        <Icon size={12} style={{ color: "var(--text-3)", flexShrink: 0 }} />
        <span className="msg-action-title" title={displaySummary}>
          {truncateActionHeader(displaySummary)}
        </span>
        <ActionStatusBadge status={block.status} />
        {block.result?.durationMs != null && block.status === "done" && (
          <span style={{ fontSize: 9.5, color: "var(--text-3)", flexShrink: 0 }}>
            {block.result.durationMs < 1000
              ? `${block.result.durationMs}ms`
              : `${(block.result.durationMs / 1000).toFixed(1)}s`}
          </span>
        )}
      </div>

      {progressMessage && (
        <div
          style={{
            padding: "0 12px 6px 30px",
            fontSize: 11,
            color: "var(--text-3)",
            lineHeight: 1.5,
          }}
        >
          {progressMessage}
        </div>
      )}

      {expanded && images.length > 0 && (
        <ChatImageGallery images={images} className="legacy-action-images" />
      )}

      {expanded && (
        <div className="legacy-action-details">
          <div className="legacy-action-input">
            <span>{inputDetail.label}</span>
            <pre className="action-output-pre"><LinkifiedPlainText text={inputDetail.content} /></pre>
          </div>

          {searchDetails && searchDetails.results.length > 0 && (
            <div className="legacy-web-search-results">
              <span>Results ({searchDetails.results.length})</span>
              <div className="codex-native-search-results">
                {searchDetails.results.map((result, index) => (
                  <details className="codex-native-search-result" key={`${result.refId ?? result.url ?? result.title}:${index}`}>
                    <summary>
                      <span>{result.title}</span>
                      {result.domain && <small>{result.domain}</small>}
                      <ChevronRight size={11} />
                    </summary>
                    <div className="codex-native-search-result-body">
                      {result.snippet && <p>{result.snippet}</p>}
                      {result.url && <div className="codex-native-search-url"><LinkifiedPlainText text={result.url} /></div>}
                      {(result.refId || result.resultType) && (
                        <div className="codex-native-search-result-meta">
                          {result.refId && <span>{result.refId}</span>}
                          {result.resultType && <span>{result.resultType}</span>}
                        </div>
                      )}
                    </div>
                  </details>
                ))}
              </div>
            </div>
          )}

          {outputDeferred && outputChunks.length === 0 && (
            <div
              style={{
                margin: 0,
                padding: "8px 12px",
                background: "var(--code-bg)",
                fontSize: 11.5,
                lineHeight: 1.5,
                color: "var(--text-3)",
                display: "flex",
                alignItems: "center",
                gap: 6,
                justifyContent: "space-between",
              }}
            >
              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                {loadingDeferredOutput && (
                  <Loader2 size={12} className="animate-spin" />
                )}
                {loadingDeferredOutput
                  ? t("messageBlocks.deferredOutput.loadingFull")
                  : deferredOutputError
                    ? t("messageBlocks.deferredOutput.failed")
                    : t("messageBlocks.deferredOutput.loading")}
              </span>
              {!loadingDeferredOutput && deferredOutputError && onLoadDeferredOutput && (
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    deferredOutputRequestedRef.current = false;
                    requestDeferredOutput();
                  }}
                  style={{
                    border: "1px solid var(--border)",
                    borderRadius: "var(--radius-xs)",
                    padding: "3px 8px",
                    background: "var(--bg-2)",
                    color: "var(--text-2)",
                    fontSize: 10.5,
                    cursor: "pointer",
                  }}
                >
                  {t("messageBlocks.deferredOutput.retry")}
                </button>
              )}
            </div>
          )}

          {outputChunks.length > 0 && (
            <pre className="action-output-pre" style={{ maxHeight: 260 }}>
              <LinkifiedPlainText text={outputText} />
            </pre>
          )}

          {outputTruncated && (
            <div style={{
              margin: 0, padding: "5px 12px",
              borderTop: outputChunks.length > 0 ? "1px solid var(--border)" : undefined,
              background: "rgba(148, 163, 184, 0.06)",
              fontSize: 10.5, color: "var(--text-3)",
            }}>
              {t("messageBlocks.outputTruncated")}
            </div>
          )}

          {block.result?.error && (
            <pre
              className="action-output-error"
              style={{
                borderTop: outputChunks.length > 0 || outputTruncated
                  ? "1px solid rgba(248, 113, 113, 0.2)" : undefined,
              }}
            >
              <LinkifiedPlainText text={String(block.result.error)} />
            </pre>
          )}

          {!outputDeferred && outputChunks.length === 0 && !block.result?.error && !searchDetails && (
            <div className="legacy-action-empty-output">No output was emitted.</div>
          )}
          {!outputDeferred && outputChunks.length === 0 && !block.result?.error && searchDetails && searchDetails.results.length === 0 && block.status !== "running" && (
            <div className="legacy-action-empty-output">Codex completed this web action without emitting search results.</div>
          )}
        </div>
      )}
    </div>
  );
}

/* ── Action Group ── */

const actionTypeLabels: Record<string, string> = {
  command: "command",
  file_read: "file_read",
  file_write: "file_write",
  file_edit: "file_edit",
  file_delete: "file_delete",
  git: "git",
  search: "search",
  other: "other",
};

function ActionGroupView({
  blocks,
  onLoadActionOutput,
  workspaceRootPath,
}: {
  blocks: ActionBlock[];
  onLoadActionOutput?: (actionId: string) => Promise<void>;
  workspaceRootPath?: string | null;
}) {
  const { t } = useTranslation("chat");
  const [expanded, setExpanded] = useState(false);

  const typeCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    for (const b of blocks) {
      counts[b.actionType] = (counts[b.actionType] ?? 0) + 1;
    }
    return counts;
  }, [blocks]);

  const errorCount = useMemo(
    () => blocks.filter((b) => b.status === "error").length,
    [blocks],
  );
  const hasAnyError = errorCount > 0;
  const allErrored = errorCount === blocks.length;

  const typeBreakdown = useMemo(() => {
    return Object.entries(typeCounts)
      .map(([type, count]) => {
        const label = t(`messageBlocks.actionGroup.types.${actionTypeLabels[type] ?? "other"}`);
        return `${count} ${label}`;
      })
      .join(" · ");
  }, [typeCounts, t]);

  const baseSummary = t("messageBlocks.actionGroup.summary", { count: blocks.length });
  const summaryText = hasAnyError
    ? `${baseSummary}, ${t("messageBlocks.actionGroup.errorCount", { count: errorCount })}`
    : baseSummary;

  const toggleExpanded = useCallback(() => setExpanded((v) => !v), []);
  return (
    <div className="animate-slide-up action-group">
      <div
        className="msg-block-header"
        role="button"
        tabIndex={0}
        aria-expanded={expanded}
        onClick={toggleExpanded}
        onKeyDown={(e) => handleToggleKeyDown(e, toggleExpanded)}
      >
        <ChevronRight
          size={11}
          className={`msg-block-chevron${expanded ? " msg-block-chevron-open" : ""}`}
        />
        <Layers size={12} style={{ color: "var(--text-3)", flexShrink: 0, opacity: 0.7 }} />
        <span style={{ fontSize: 11.5, color: "var(--text-2)", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
          {summaryText}
        </span>
        <span style={{ fontSize: 10, color: "var(--text-3)", flexShrink: 0 }}>
          {typeBreakdown}
        </span>
        {allErrored ? (
          <XCircle size={11} style={{ color: "var(--danger)", flexShrink: 0 }} />
        ) : hasAnyError ? (
          <AlertTriangle size={11} style={{ color: "var(--text-3)", flexShrink: 0 }} />
        ) : (
          <CheckCircle2 size={11} style={{ color: "var(--text-3)", flexShrink: 0 }} />
        )}
      </div>
      <div className={`action-group-body${expanded ? " action-group-body--expanded" : ""}`}>
        <div
          className="action-group-body-inner"
          style={{
            background: expanded ? "rgba(31, 35, 40, 0.02)" : undefined,
            borderRadius: "var(--radius-sm)",
            display: "flex",
            flexDirection: "column",
            gap: 2,
          }}
        >
          {expanded &&
            blocks.map((block) => (
              <ActionBlockView
                key={block.actionId}
                block={block}
                workspaceRootPath={workspaceRootPath}
                onLoadDeferredOutput={
                  onLoadActionOutput ? () => onLoadActionOutput(block.actionId) : undefined
                }
              />
            ))}
        </div>
      </div>
    </div>
  );
}

/* ── Approval Card ── */

const APPROVAL_INTERNAL_KEYS = new Set([
  "_serverMethod",
  "_rawRequestId",
  "_raw_request_id",
  "threadId",
  "thread_id",
  "turnId",
  "turn_id",
  "itemId",
  "item_id",
  "proposedExecpolicyAmendment",
  "proposed_execpolicy_amendment",
  "proposedNetworkPolicyAmendments",
  "proposed_network_policy_amendments",
  "networkApprovalContext",
  "network_approval_context",
  "questions",
  "command",
  "reason",
  "commandActions",
  "callId",
  "call_id",
  "arguments",
  "tool",
  "name",
  "permissions",
  "serverName",
  "server_name",
  "message",
  "mode",
  "url",
  "requestedSchema",
  "requested_schema",
  "elicitationId",
  "elicitation_id",
]);

function extractApprovalDetails(details: Record<string, unknown>) {
  const command = parseApprovalCommand(details);
  const reason = parseApprovalReason(details);
  const commandActions = Array.isArray(details.commandActions) ? details.commandActions : [];
  const commandActionCount = commandActions.length;
  const remainingDetails: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(details)) {
    if (!APPROVAL_INTERNAL_KEYS.has(k)) remainingDetails[k] = v;
  }
  const hasRemainingDetails = Object.keys(remainingDetails).length > 0;
  return { command, reason, commandActionCount, remainingDetails, hasRemainingDetails };
}

function extractAnswerText(raw: unknown): string | null {
  if (typeof raw === "string") return raw;
  if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
    const obj = raw as Record<string, unknown>;
    // Shape from buildToolInputResponseFromSelections: { answers: string[] }
    if (Array.isArray(obj.answers) && obj.answers.length > 0) {
      return obj.answers.map(String).join(", ");
    }
    if (typeof obj.label === "string") return obj.label;
    if (typeof obj.value === "string") return obj.value;
  }
  if (Array.isArray(raw) && raw.length > 0) {
    return raw.map(String).join(", ");
  }
  return null;
}

function extractApprovalAnswerMap(
  responseData: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!responseData) return undefined;
  const nestedAnswers = responseData.answers;
  if (typeof nestedAnswers === "object" && nestedAnswers !== null && !Array.isArray(nestedAnswers)) {
    return nestedAnswers as Record<string, unknown>;
  }
  return responseData;
}

function ToolInputApprovalCard({
  block,
  questions,
  isPending,
}: {
  block: ApprovalBlock;
  questions: { id: string; question: string; secret?: boolean }[];
  isPending: boolean;
  decisionLabel: string;
  decisionBackground: string;
  decisionColor: string;
}) {
  const { t } = useTranslation("chat");
  if (questions.length <= 0) return null;

  const answers = extractApprovalAnswerMap(block.responseData);
  const isAnswered = block.status === "answered";
  const wasCanceled = isAnswered && block.decision === "cancel";
  const [expanded, setExpanded] = useState(false);
  const toggleExpanded = useCallback(() => setExpanded((v) => !v), []);

  return (
    <div>
      <div
        className="msg-block-header"
        {...(isAnswered ? {
          role: "button" as const,
          tabIndex: 0,
          "aria-expanded": expanded,
          onClick: toggleExpanded,
          onKeyDown: (e: React.KeyboardEvent) => handleToggleKeyDown(e, toggleExpanded),
        } : { style: { cursor: "default" } })}
      >
        {isAnswered && (
          <ChevronRight size={11} className={`msg-block-chevron${expanded ? " msg-block-chevron-open" : ""}`} />
        )}
        <MessageSquare size={12} style={{ color: isPending ? "var(--info)" : "var(--text-3)", flexShrink: 0, opacity: 0.7 }} />
        <span style={{ fontSize: 11.5, color: "var(--text-2)", flex: 1 }}>
          {isPending
            ? t("messageBlocks.approval.pendingQuestions", { count: questions.length })
            : wasCanceled
              ? t("messageBlocks.approval.unsubmittedQuestions", { count: questions.length })
              : t("messageBlocks.approval.answeredQuestions", { count: questions.length })}
        </span>
      </div>
      {isAnswered && expanded && (
        <div className="tool-input-qa-body">
          {questions.map((q) => {
            const text = extractAnswerText(answers?.[q.id] ?? answers?.[q.question]);
            return (
              <div key={q.id} className="tool-input-qa-row">
                {q.question}{text
                  ? <> → <strong>{q.secret ? "••••••" : text}</strong></>
                  : <> — {t("messageBlocks.approval.answerNotSubmitted")}</>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ApprovalCard({
  block,
  onApproval,
}: {
  block: ApprovalBlock;
  onApproval: (approvalId: string, response: ApprovalResponse) => void;
}) {
  const { t } = useTranslation("chat");
  const isPending = block.status === "pending";
  const details = block.details ?? {};
  const isToolInputRequest = isRequestUserInputApproval(details);
  const isDynamicToolCall = isDynamicToolCallApproval(details);
  const isPermissionsRequest = isPermissionsRequestApproval(details);
  const isMcpElicitation = isMcpElicitationApproval(details);
  const requiresCustomPayload = requiresCustomApprovalPayload(details);
  const toolInputQuestions = isToolInputRequest ? parseToolInputQuestions(details) : [];
  const requiresAdvancedJsonFallback =
    requiresCustomPayload || (isToolInputRequest && toolInputQuestions.length === 0);
  const proposedExecpolicyAmendment = parseProposedExecpolicyAmendment(details);
  const proposedNetworkPolicyAmendments = parseProposedNetworkPolicyAmendments(details);
  const requestedPermissions = isPermissionsRequest ? parseRequestedPermissions(details) : null;
  const dynamicToolName = parseDynamicToolCallName(details);
  const dynamicToolArguments = parseDynamicToolCallArguments(details);
  const mcpServerName = parseMcpElicitationServerName(details);
  const mcpMessage = parseMcpElicitationMessage(details);
  const mcpMode = parseMcpElicitationMode(details);
  const mcpUrl = parseMcpElicitationUrl(details);
  const mcpSchema = parseMcpElicitationSchema(details);

  const { command, reason, commandActionCount, remainingDetails, hasRemainingDetails } =
    extractApprovalDetails(details);
  const displayReason = isMcpElicitation ? mcpMessage ?? reason : reason;

  const defaultAdvancedPayload = useMemo(
    () => JSON.stringify(defaultAdvancedApprovalPayload(details), null, 2),
    [details],
  );
  const [advancedJsonPayload, setAdvancedJsonPayload] = useState(defaultAdvancedPayload);
  const [advancedJsonError, setAdvancedJsonError] = useState<string | null>(null);
  const [showRemainingDetails, setShowRemainingDetails] = useState(false);
  const [dynamicToolSuccess, setDynamicToolSuccess] = useState(true);
  const [dynamicToolText, setDynamicToolText] = useState("");
  const [dynamicToolImageUrl, setDynamicToolImageUrl] = useState("");

  useEffect(() => {
    setAdvancedJsonPayload(defaultAdvancedPayload);
  }, [defaultAdvancedPayload, block.approvalId]);

  useEffect(() => {
    setDynamicToolSuccess(true);
    setDynamicToolText("");
    setDynamicToolImageUrl("");
  }, [block.approvalId]);

  let decisionLabel = t("messageBlocks.approval.decision.answered");
  if (block.decision === "decline") {
    decisionLabel = t("messageBlocks.approval.decision.denied");
  } else if (block.decision === "cancel") {
    decisionLabel = t("messageBlocks.approval.decision.canceled");
  } else if (block.decision === "accept" || block.decision === "accept_for_session") {
    decisionLabel = t("messageBlocks.approval.decision.approved");
  }

  let decisionBackground = "rgba(148,163,184,0.12)";
  let decisionColor = "var(--text-2)";
  if (block.decision === "decline" || block.decision === "cancel") {
    decisionBackground = "rgba(248,113,113,0.12)";
    decisionColor = "var(--danger)";
  } else if (block.decision === "accept" || block.decision === "accept_for_session") {
    decisionBackground = "rgba(52,211,153,0.12)";
    decisionColor = "var(--success)";
  }

  if (isToolInputRequest && toolInputQuestions.length > 0) {
    return (
      <div>
        <ToolInputApprovalCard
          block={block}
          questions={toolInputQuestions}
          isPending={isPending}
          decisionLabel={decisionLabel}
          decisionBackground={decisionBackground}
          decisionColor={decisionColor}
        />
      </div>
    );
  }

  function submitAdvancedJsonPayload() {
    let parsedPayload: unknown;
    try {
      parsedPayload = JSON.parse(advancedJsonPayload);
    } catch (error) {
      setAdvancedJsonError(
        t("messageBlocks.approval.invalidJson", { error: String(error) }),
      );
      return;
    }

    if (
      typeof parsedPayload !== "object" ||
      parsedPayload === null ||
      Array.isArray(parsedPayload)
    ) {
      setAdvancedJsonError(t("messageBlocks.approval.payloadMustBeObject"));
      return;
    }

    setAdvancedJsonError(null);
    onApproval(block.approvalId, parsedPayload as ApprovalResponse);
  }

  function submitDynamicToolResponse() {
    onApproval(
      block.approvalId,
      buildDynamicToolCallResponse(dynamicToolText, dynamicToolSuccess, dynamicToolImageUrl),
    );
  }

  return (
    <div className="acard">
      {/* Header */}
      <div className="acard-header">
        <Shield size={12} className="acard-header-icon" />
        <span className="acard-summary">{block.summary}</span>
        <span className="acard-type">{block.actionType}</span>
        {!isPending && block.decision && (
          <span
            className="acard-decision"
            style={{ background: decisionBackground, color: decisionColor }}
          >
            {decisionLabel}
          </span>
        )}
      </div>

      {/* Details — collapsed for resolved approvals */}
      {!isToolInputRequest && (command || displayReason || commandActionCount > 0 || requestedPermissions || mcpUrl || mcpSchema || hasRemainingDetails) && (isPending || !block.decision) && (
        <div className="acard-details">
          {command && (
            <pre className="acard-command">{command}</pre>
          )}
          {!command && displayReason && (
            <p className="acard-reason">{displayReason}</p>
          )}
          {isMcpElicitation && mcpServerName && (
            <p className="acard-meta">{mcpServerName}</p>
          )}
          {isMcpElicitation && mcpMode === "url" && mcpUrl && (
            <pre className="acard-command">{mcpUrl}</pre>
          )}
          {isPermissionsRequest && requestedPermissions && (
            <pre className="acard-remaining-pre">
              {JSON.stringify(requestedPermissions, null, 2)}
            </pre>
          )}
          {isMcpElicitation && mcpMode === "form" && mcpSchema && (
            <pre className="acard-remaining-pre">
              {JSON.stringify(mcpSchema, null, 2)}
            </pre>
          )}
          {commandActionCount > 0 && (
            <p className="acard-meta">
              {t("messageBlocks.approval.actionCount", { count: commandActionCount })}
            </p>
          )}
          {proposedExecpolicyAmendment.length > 0 && (
            <p className="acard-meta">
              {t("messageBlocks.approval.execPolicyAmendment", {
                value: proposedExecpolicyAmendment.join(" "),
              })}
            </p>
          )}
          {proposedNetworkPolicyAmendments.length > 0 && (
            <p className="acard-meta">
              {t("messageBlocks.approval.networkAmendment", {
                value: proposedNetworkPolicyAmendments
                  .map((amendment) => `${amendment.action} ${amendment.host}`)
                  .join(", "),
              })}
            </p>
          )}
          {isDynamicToolCall && dynamicToolName && (
            <p className="acard-meta">
              {t("messageBlocks.approval.dynamicTool", { name: dynamicToolName })}
            </p>
          )}
          {hasRemainingDetails && (
            <div className="acard-remaining">
              <button
                type="button"
                className="acard-toggle"
                onClick={() => setShowRemainingDetails((v) => !v)}
              >
                {showRemainingDetails
                  ? t("messageBlocks.approval.hideDetails")
                  : t("messageBlocks.approval.showDetails")}
              </button>
              {showRemainingDetails && (
                <pre className="acard-remaining-pre">
                  {JSON.stringify(remainingDetails, null, 2)}
                </pre>
              )}
            </div>
          )}
        </div>
      )}
      {isPending && isDynamicToolCall && (
        <div className="acard-section">
          <div className="acard-advanced" style={{ gap: 10 }}>
            <p className="acard-reason">
              {t("messageBlocks.approval.dynamicToolPrompt")}
            </p>
            {dynamicToolArguments && (
              <pre className="acard-remaining-pre">
                {JSON.stringify(dynamicToolArguments, null, 2)}
              </pre>
            )}
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button
                type="button"
                className={`approval-btn ${dynamicToolSuccess ? "approval-btn-allow" : "approval-btn-deny"}`}
                onClick={() => setDynamicToolSuccess((current) => !current)}
              >
                {dynamicToolSuccess
                  ? t("messageBlocks.approval.dynamicToolSuccess")
                  : t("messageBlocks.approval.dynamicToolFailure")}
              </button>
            </div>
            <textarea
              className="acard-textarea"
              value={dynamicToolText}
              onChange={(event) => setDynamicToolText(event.target.value)}
              rows={4}
              placeholder={t("messageBlocks.approval.toolResponsePlaceholder")}
            />
            <input
              className="acard-textarea"
              value={dynamicToolImageUrl}
              onChange={(event) => setDynamicToolImageUrl(event.target.value)}
              placeholder={t("messageBlocks.approval.imageUrlPlaceholder")}
            />
            <div className="acard-advanced-footer">
              <button
                type="button"
                className="approval-btn approval-btn-allow"
                onClick={submitDynamicToolResponse}
              >
                {t("messageBlocks.approval.sendToolResponse")}
              </button>
            </div>
          </div>
        </div>
      )}

      {isPending && requiresAdvancedJsonFallback && (
        <div className="acard-section">
          <p className="acard-reason">
            {t("messageBlocks.approval.customPayloadHint")}
          </p>
        </div>
      )}

      {/* Standard approval — no inline buttons; the approval banner handles it */}

      {/* Advanced JSON — for custom payload requests and malformed tool-input fallbacks */}
      {isPending && requiresAdvancedJsonFallback && (
        <div className="acard-section">
          <div className="acard-advanced">
            <textarea
              className="acard-textarea"
              value={advancedJsonPayload}
              onChange={(event) => {
                setAdvancedJsonPayload(event.target.value);
                if (advancedJsonError) {
                  setAdvancedJsonError(null);
                }
              }}
              rows={6}
            />
            {advancedJsonError && (
              <p className="acard-error">{advancedJsonError}</p>
            )}
            <div className="acard-advanced-footer">
              <button
                type="button"
                className="approval-btn approval-btn-allow"
                onClick={submitAdvancedJsonPayload}
              >
                {t("messageBlocks.approval.sendPayload")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── Main Component ── */

function renderSingleBlock(
  block: ContentBlock,
  index: number,
  sourceBlocks: ContentBlock[],
  status: MessageStatus | undefined,
  workspaceRootPath: string | null | undefined,
  onApproval: (approvalId: string, response: ApprovalResponse) => void,
  onLoadActionOutput: ((actionId: string) => Promise<void>) | undefined,
  selectionNamespace: string,
) {
  const blockKey = getMessageBlockKey(block, index, sourceBlocks);
  const selectionScopeId = `${selectionNamespace}:${getSelectionBlockScopeKey(block, index, sourceBlocks)}`;

  /* ── Text ── */
  if (block.type === "text") {
    const textContent = String(block.content ?? "");
    const isLastBlock = index === sourceBlocks.length - 1;
    const isStreamingText = status === "streaming" && isLastBlock;

    if (isStreamingText) {
      return (
        <MarkdownContent
          key={blockKey}
          content={textContent}
          streaming
          className="prose chat-message-prose"
          workspaceRootPath={workspaceRootPath}
          selectionScopeId={selectionScopeId}
          style={{ padding: "6px 14px" }}
        />
      );
    }

    return (
      <MarkdownContent
        key={blockKey}
        content={textContent}
        className="prose chat-message-prose"
        workspaceRootPath={workspaceRootPath}
        selectionScopeId={selectionScopeId}
        style={{ padding: "6px 14px" }}
      />
    );
  }

  /* ── Code ── */
  if (block.type === "code") {
    const lang = String(block.language ?? "text");
    return (
      <div
        key={blockKey}
        style={{
          borderRadius: "var(--radius-sm)",
          border: "1px solid var(--border)",
          overflow: "hidden",
          background: "var(--code-bg)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            padding: "6px 12px",
            borderBottom: "1px solid var(--border)",
            fontSize: 11,
            color: "var(--text-3)",
            fontFamily: '"JetBrains Mono", monospace',
          }}
        >
          <FileCode2 size={12} style={{ opacity: 0.5 }} />
          <span style={{ flex: 1 }}>
            <LinkifiedPlainText text={block.filename || lang} />
          </span>
          <CodeBlockCopyButton content={String(block.content ?? "")} />
        </div>
        <pre
          style={{
            margin: 0,
            padding: "12px 14px",
            fontSize: 12.5,
            lineHeight: 1.6,
            fontFamily: '"JetBrains Mono", monospace',
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            overflow: "auto",
            maxHeight: 400,
          }}
        >
          <code className={`language-${lang}`}>{String(block.content ?? "")}</code>
        </pre>
      </div>
    );
  }

  /* ── Diff ── */
  if (block.type === "diff") {
    return (
      <div key={blockKey} className="msg-action-card">
        <MessageDiffBlock block={block} />
      </div>
    );
  }

  /* ── Notice ── */
  if (block.type === "notice") {
    return <NoticeBlockView key={blockKey} block={block} />;
  }

  /* ── Steer ── */
  if (block.type === "steer") {
    return <SteerBlockView key={blockKey} block={block} />;
  }

  /* ── Action ── */
  if (block.type === "action") {
    return (
      <div key={blockKey} >
        <ActionBlockView
          block={block}
          workspaceRootPath={workspaceRootPath}
          onLoadDeferredOutput={
            onLoadActionOutput ? () => onLoadActionOutput(block.actionId) : undefined
          }
        />
      </div>
    );
  }

  /* ── Approval ── */
  if (block.type === "approval") {
    return (
      <ApprovalCard
        key={blockKey}
        block={block}
        onApproval={onApproval}
      />
    );
  }

  /* ── Thinking ── */
  if (block.type === "thinking") {
    const isLastBlock = index === sourceBlocks.length - 1;
    const thinkingActive = status === "streaming" && isLastBlock;
    return (
      <div key={blockKey} >
        <ThinkingBlockView
          block={block}
          isStreaming={thinkingActive}
          workspaceRootPath={workspaceRootPath}
          selectionScopeId={selectionScopeId}
        />
      </div>
    );
  }

  /* ── Attachment ── */
  if (block.type === "attachment") {
    const attachmentBlock = block as AttachmentBlock;
    return (
      <div key={blockKey} style={{ margin: "2px 12px", display: "inline-flex" }}>
        <AttachmentChip attachment={attachmentBlock} />
      </div>
    );
  }

  /* ── Error ── */
  if (block.type === "error") {
    return (
      <div key={blockKey} className="msg-error-block">
        <AlertTriangle size={14} style={{ flexShrink: 0, marginTop: 2 }} />
        {block.message}
      </div>
    );
  }

  return null;
}

function MessageBlocksView({
  blocks = [],
  status,
  workspaceRootPath,
  selectionNamespace,
  onApproval,
  onLoadActionOutput,
}: Props) {
  const generatedSelectionNamespace = useId();
  const resolvedSelectionNamespace = selectionNamespace ?? `message-blocks:${generatedSelectionNamespace}`;
  const safeBlocks = useMemo(
    () => dedupeDiffBlocksByScope(
      (Array.isArray(blocks) ? blocks : [])
        .filter(isBlockLike)
        .filter(
          (block) =>
            block.type !== "notice" ||
            block.kind !== "turn_status",
        ) as ContentBlock[],
    ),
    [blocks],
  );

  const isStreaming = status === "streaming";
  const blockSegments = useMemo(
    () => buildBlockSegments(safeBlocks, isStreaming),
    [safeBlocks, isStreaming],
  );

  return (
    <div
      className="message-blocks"
      data-transcript-selection-scope={resolvedSelectionNamespace}
      style={{ display: "flex", flexDirection: "column", gap: 4 }}
    >
      {blockSegments.map((segment, segIdx) => {
        if (segment.kind === "divider") {
          return <div key={`divider-${segIdx}`} className="msg-section-divider" />;
        }

        if (segment.kind === "action-card") {
          return (
            <div key={`action-card-${segIdx}`} className="msg-action-card">
              {segment.segments.map((inner, innerIdx) => {
                if (inner.kind === "action-group") {
                  const first = inner.blocks[0];
                  const last = inner.blocks[inner.blocks.length - 1];
                  return (
                    <ActionGroupView
                      key={`action-group:${first.actionId}:${last.actionId}`}
                      blocks={inner.blocks}
                      onLoadActionOutput={onLoadActionOutput}
                      workspaceRootPath={workspaceRootPath}
                    />
                  );
                }
                if (inner.block.type === "thinking") {
                  const thinkingBlock = inner.block as ThinkingBlock;
                  const isLastBlock = inner.index === safeBlocks.length - 1;
                  const thinkingActive = status === "streaming" && isLastBlock;
                  const blockKey = getMessageBlockKey(inner.block, inner.index, safeBlocks);
                  const selectionBlockKey = getSelectionBlockScopeKey(
                    inner.block,
                    inner.index,
                    safeBlocks,
                  );
                  return (
                    <ThinkingBlockView
                      key={blockKey}
                      block={thinkingBlock}
                      isStreaming={thinkingActive}
                      workspaceRootPath={workspaceRootPath}
                      selectionScopeId={`${resolvedSelectionNamespace}:${selectionBlockKey}`}
                    />
                  );
                }
                if (inner.block.type === "approval") {
                  return (
                    <ApprovalCard
                      key={(inner.block as ApprovalBlock).approvalId}
                      block={inner.block as ApprovalBlock}
                      onApproval={onApproval}
                    />
                  );
                }
                if (inner.block.type === "diff") {
                  return (
                    <MessageDiffBlock
                      key={getMessageBlockKey(inner.block, inner.index, safeBlocks)}
                      block={inner.block as DiffBlock}
                    />
                  );
                }
                return (
                  <ActionBlockView
                    key={inner.block.type === "action" ? (inner.block as ActionBlock).actionId : `inner-${innerIdx}`}
                    block={inner.block as ActionBlock}
                    workspaceRootPath={workspaceRootPath}
                    onLoadDeferredOutput={
                      onLoadActionOutput ? () => onLoadActionOutput((inner.block as ActionBlock).actionId) : undefined
                    }
                  />
                );
              })}
            </div>
          );
        }

        if (segment.kind === "action-group") {
          const first = segment.blocks[0];
          const last = segment.blocks[segment.blocks.length - 1];
          return (
            <ActionGroupView
              key={`action-group:${first.actionId}:${last.actionId}`}
              blocks={segment.blocks}
              onLoadActionOutput={onLoadActionOutput}
              workspaceRootPath={workspaceRootPath}
            />
          );
        }

        return renderSingleBlock(
          segment.block,
          segment.index,
          safeBlocks,
          status,
          workspaceRootPath,
          onApproval,
          onLoadActionOutput,
          resolvedSelectionNamespace,
        );
      })}
    </div>
  );
}

export const MessageBlocks = memo(
  MessageBlocksView,
  (prev, next) =>
    prev.blocks === next.blocks &&
    prev.status === next.status &&
    prev.workspaceRootPath === next.workspaceRootPath &&
    prev.selectionNamespace === next.selectionNamespace &&
    prev.onApproval === next.onApproval &&
    prev.onLoadActionOutput === next.onLoadActionOutput,
);
