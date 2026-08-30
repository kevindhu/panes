import {
  useMemo,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { File, FileText, Image, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  isImageAttachmentMimeType,
  resolveAttachmentImageMimeType,
} from "../../lib/attachmentImages";
import type { ChatImageDescriptor } from "../../lib/chatImageSources";
import { useChatImageAsset } from "./ChatImage";
import { ImageAttachmentViewer } from "./ImageAttachmentViewer";

const ATTACHMENT_THUMBNAIL_OPTIONS = { maxWidth: 256, maxHeight: 256 };

interface AttachmentChipData {
  fileName: string;
  filePath: string;
  sizeBytes?: number;
  mimeType?: string;
}

interface AttachmentChipProps {
  attachment: AttachmentChipData;
  compact?: boolean;
  composerPreview?: boolean;
  showSize?: boolean;
  removeLabel?: string;
  onRemove?: () => void;
}

function getFileExtension(fileName: string): string {
  const lastDot = fileName.lastIndexOf(".");
  return lastDot >= 0 ? fileName.slice(lastDot + 1).toLowerCase() : "";
}

function guessAttachmentMimeType(fileName: string): string | undefined {
  switch (getFileExtension(fileName)) {
    case "txt":
      return "text/plain";
    case "md":
      return "text/markdown";
    case "json":
      return "application/json";
    case "js":
      return "text/javascript";
    case "ts":
    case "tsx":
      return "text/typescript";
    case "jsx":
      return "text/javascript";
    case "py":
      return "text/x-python";
    case "rs":
      return "text/x-rust";
    case "go":
      return "text/x-go";
    case "css":
      return "text/css";
    case "html":
      return "text/html";
    case "svg":
      return "image/svg+xml";
    case "png":
      return "image/png";
    case "jpg":
    case "jpeg":
      return "image/jpeg";
    case "gif":
      return "image/gif";
    case "webp":
      return "image/webp";
    case "bmp":
      return "image/bmp";
    case "pdf":
      return "application/pdf";
    case "yaml":
    case "yml":
      return "text/yaml";
    case "toml":
      return "text/toml";
    case "xml":
      return "text/xml";
    case "sql":
      return "text/x-sql";
    case "sh":
      return "text/x-shellscript";
    case "csv":
      return "text/csv";
    default:
      return undefined;
  }
}

function getEffectiveMimeType(attachment: AttachmentChipData): string | undefined {
  const guessedMimeType = guessAttachmentMimeType(attachment.fileName);
  const resolvedImageMimeType = resolveAttachmentImageMimeType(
    attachment.fileName,
    attachment.mimeType,
  );
  if (isImageAttachmentMimeType(resolvedImageMimeType)) {
    return resolvedImageMimeType;
  }
  return attachment.mimeType ?? guessedMimeType;
}

function getAttachmentIcon(mimeType?: string) {
  if (!mimeType) return File;
  const normalized = mimeType.toLowerCase();
  if (normalized.startsWith("image/")) return Image;
  if (
    normalized.startsWith("text/") ||
    normalized.includes("json") ||
    normalized.includes("javascript") ||
    normalized.includes("typescript")
  ) {
    return FileText;
  }
  return File;
}

export function AttachmentChip({
  attachment,
  compact = false,
  composerPreview = false,
  showSize = false,
  removeLabel,
  onRemove,
}: AttachmentChipProps) {
  const { t } = useTranslation("chat");
  const effectiveMimeType = getEffectiveMimeType(attachment);
  const isImageAttachment = isImageAttachmentMimeType(effectiveMimeType);
  const image = useMemo<ChatImageDescriptor>(() => ({
    id: `attachment:${attachment.filePath}:${attachment.fileName}`,
    origin: "attachment",
    fileName: attachment.fileName,
    alt: attachment.fileName,
    ...(isImageAttachment ? { filePath: attachment.filePath } : {}),
    ...(effectiveMimeType ? { mimeType: effectiveMimeType } : {}),
  }), [attachment.fileName, attachment.filePath, effectiveMimeType, isImageAttachment]);
  const imageAsset = useChatImageAsset(image, ATTACHMENT_THUMBNAIL_OPTIONS, false);
  const [viewerOpen, setViewerOpen] = useState(false);
  const thumbnailSrc = isImageAttachment ? imageAsset.thumbnailSrc : null;

  const IconComponent = getAttachmentIcon(effectiveMimeType);
  const sizeBytes = attachment.sizeBytes ?? 0;
  const interactive = isImageAttachment;
  const className = [
    "chat-attachment-chip",
    compact ? "chat-attachment-chip-compact" : "",
    thumbnailSrc ? "chat-attachment-chip-image" : "",
    interactive ? "chat-attachment-chip-openable" : "",
    composerPreview ? "chat-attachment-chip-composer" : "",
    composerPreview && interactive ? "chat-attachment-chip-composer-image" : "",
  ]
    .filter(Boolean)
    .join(" ");

  function openViewer() {
    if (!interactive) {
      return;
    }
    setViewerOpen(true);
    if (!thumbnailSrc) {
      void imageAsset.requestViewerSource().catch(() => {});
    }
  }

  function handlePreviewKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (!interactive) {
      return;
    }
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openViewer();
    }
  }

  return (
    <div className={className}>
      <div
        className="chat-attachment-chip-preview"
        role={interactive ? "button" : undefined}
        tabIndex={interactive ? 0 : undefined}
        onClick={interactive ? openViewer : undefined}
        onKeyDown={interactive ? handlePreviewKeyDown : undefined}
        title={interactive ? t("attachments.viewer.open") : undefined}
        aria-label={interactive ? t("attachments.viewer.open") : undefined}
      >
        {thumbnailSrc ? (
          <img
            src={thumbnailSrc}
            alt=""
            className="chat-attachment-thumbnail"
            draggable={false}
            loading="lazy"
            decoding="async"
            onError={imageAsset.handleThumbnailError}
          />
        ) : (
          <IconComponent size={compact ? 10 : 12} />
        )}
        {(!composerPreview || !interactive) && (
          <span className="chat-attachment-chip-name">{attachment.fileName}</span>
        )}
        {showSize && !composerPreview && sizeBytes > 0 && (
          <span className="chat-attachment-chip-size">{formatFileSize(sizeBytes)}</span>
        )}
      </div>
      {onRemove && (
        <button
          type="button"
          className="chat-attachment-chip-remove"
          onClick={onRemove}
          title={removeLabel}
          aria-label={removeLabel}
        >
          <X size={10} />
        </button>
      )}
      {interactive && (
        <ImageAttachmentViewer
          open={viewerOpen}
          filePath={imageAsset.resolvedFilePath}
          fileName={attachment.fileName}
          mimeType={effectiveMimeType}
          originalSrc={imageAsset.originalSrc}
          previewSrc={thumbnailSrc}
          requestPreview={imageAsset.requestViewerSource}
          onClose={() => setViewerOpen(false)}
        />
      )}
    </div>
  );
}

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
