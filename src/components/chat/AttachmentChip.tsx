import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { File, FileText, Image, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  getCachedAttachmentImageAssetUrl,
  getCachedAttachmentImageFallbackUrl,
  isImageAttachmentMimeType,
  loadAttachmentImageAssetUrl,
  loadAttachmentImageFallbackUrl,
  resolveAttachmentImageMimeType,
} from "../../lib/attachmentImages";
import { ImageAttachmentViewer } from "./ImageAttachmentViewer";

interface AttachmentChipData {
  fileName: string;
  filePath: string;
  sizeBytes?: number;
  mimeType?: string;
}

interface AttachmentChipProps {
  attachment: AttachmentChipData;
  compact?: boolean;
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
  showSize = false,
  removeLabel,
  onRemove,
}: AttachmentChipProps) {
  const { t } = useTranslation("chat");
  const effectiveMimeType = getEffectiveMimeType(attachment);
  const [assetSrc, setAssetSrc] = useState<string | null>(() => (
    getCachedAttachmentImageAssetUrl(attachment.filePath, effectiveMimeType) ?? null
  ));
  const [fallbackSrc, setFallbackSrc] = useState<string | null>(() => (
    getCachedAttachmentImageFallbackUrl(attachment.filePath, effectiveMimeType) ?? null
  ));
  const [sourceState, setSourceState] = useState<"loading" | "asset" | "fallback" | "failed">(
    assetSrc ? "asset" : fallbackSrc ? "fallback" : "loading",
  );
  const [viewerOpen, setViewerOpen] = useState(false);
  const assetRequestRef = useRef<Promise<string | null> | null>(null);
  const fallbackRequestRef = useRef<Promise<string | null> | null>(null);
  const requestTokenRef = useRef(0);
  const isImageAttachment = isImageAttachmentMimeType(effectiveMimeType);

  const requestAsset = useCallback(async (): Promise<string | null> => {
    if (!isImageAttachment || !attachment.filePath) {
      return null;
    }
    const cachedAsset = getCachedAttachmentImageAssetUrl(
      attachment.filePath,
      effectiveMimeType,
    );
    if (cachedAsset !== undefined) {
      if (cachedAsset) {
        setAssetSrc(cachedAsset);
        setSourceState("asset");
      }
      return cachedAsset;
    }
    if (!assetRequestRef.current) {
      const requestToken = requestTokenRef.current;
      assetRequestRef.current = loadAttachmentImageAssetUrl(
        attachment.filePath,
        effectiveMimeType,
      )
        .then((nextAssetSrc) => {
          if (requestTokenRef.current === requestToken && nextAssetSrc) {
            setAssetSrc(nextAssetSrc);
            setSourceState("asset");
          }
          return nextAssetSrc;
        })
        .finally(() => {
          if (requestTokenRef.current === requestToken) {
            assetRequestRef.current = null;
          }
        });
    }
    return assetRequestRef.current;
  }, [attachment.filePath, effectiveMimeType, isImageAttachment]);

  const requestFallback = useCallback(async (): Promise<string | null> => {
    if (!isImageAttachment || !attachment.filePath) {
      return null;
    }
    const cachedFallback = getCachedAttachmentImageFallbackUrl(
      attachment.filePath,
      effectiveMimeType,
    );
    if (cachedFallback !== undefined) {
      if (cachedFallback) {
        setFallbackSrc(cachedFallback);
        setSourceState("fallback");
      }
      return cachedFallback;
    }
    if (!fallbackRequestRef.current) {
      const requestToken = requestTokenRef.current;
      fallbackRequestRef.current = loadAttachmentImageFallbackUrl(
        attachment.filePath,
        effectiveMimeType,
      )
        .then((nextFallbackSrc) => {
          if (requestTokenRef.current === requestToken && nextFallbackSrc) {
            setFallbackSrc(nextFallbackSrc);
            setSourceState("fallback");
          }
          return nextFallbackSrc;
        })
        .finally(() => {
          if (requestTokenRef.current === requestToken) {
            fallbackRequestRef.current = null;
          }
        });
    }
    return fallbackRequestRef.current;
  }, [attachment.filePath, effectiveMimeType, isImageAttachment]);

  const requestViewerSource = useCallback(async (): Promise<string | null> => {
    try {
      const nextAssetSrc = await requestAsset();
      if (nextAssetSrc) {
        return nextAssetSrc;
      }
    } catch {
      // Fall through to the binary fallback.
    }
    return requestFallback();
  }, [requestAsset, requestFallback]);

  useEffect(() => {
    let cancelled = false;
    requestTokenRef.current += 1;
    assetRequestRef.current = null;
    fallbackRequestRef.current = null;
    const cachedAsset = getCachedAttachmentImageAssetUrl(
      attachment.filePath,
      effectiveMimeType,
    );
    const cachedFallback = getCachedAttachmentImageFallbackUrl(
      attachment.filePath,
      effectiveMimeType,
    );
    setAssetSrc(cachedAsset ?? null);
    setFallbackSrc(cachedFallback ?? null);
    setSourceState(cachedAsset ? "asset" : cachedFallback ? "fallback" : "loading");

    if (!isImageAttachment) {
      return () => {
        cancelled = true;
      };
    }

    void requestAsset()
      .then((nextAssetSrc) => {
        if (!cancelled && !nextAssetSrc) {
          return requestFallback();
        }
        return nextAssetSrc;
      })
      .catch(() => requestFallback())
      .then((resolvedSrc) => {
        if (!cancelled && !resolvedSrc) {
          setSourceState("failed");
        }
      })
      .catch(() => {
        if (!cancelled) {
          setSourceState("failed");
        }
      });

    return () => {
      cancelled = true;
    };
  }, [attachment.filePath, effectiveMimeType, isImageAttachment, requestAsset, requestFallback]);

  const thumbnailSrc = sourceState === "asset"
    ? assetSrc
    : sourceState === "fallback"
      ? fallbackSrc
      : null;

  const IconComponent = getAttachmentIcon(effectiveMimeType);
  const sizeBytes = attachment.sizeBytes ?? 0;
  const interactive = isImageAttachment;
  const className = [
    "chat-attachment-chip",
    compact ? "chat-attachment-chip-compact" : "",
    thumbnailSrc ? "chat-attachment-chip-image" : "",
    interactive ? "chat-attachment-chip-openable" : "",
  ]
    .filter(Boolean)
    .join(" ");

  function openViewer() {
    if (!interactive) {
      return;
    }
    setViewerOpen(true);
    if (!thumbnailSrc) {
      void requestViewerSource().catch(() => {});
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

  function handleThumbnailError() {
    if (sourceState === "asset" && fallbackSrc) {
      setSourceState("fallback");
      return;
    }

    if (sourceState === "asset" || sourceState === "loading") {
      void requestFallback()
        .then((nextFallbackSrc) => {
          if (nextFallbackSrc) {
            setSourceState("fallback");
            return;
          }
          setSourceState("failed");
        })
        .catch(() => {
          setSourceState("failed");
        });
      return;
    }

    setSourceState("failed");
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
            onError={handleThumbnailError}
          />
        ) : (
          <IconComponent size={compact ? 10 : 12} />
        )}
        <span className="chat-attachment-chip-name">{attachment.fileName}</span>
        {showSize && sizeBytes > 0 && (
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
          filePath={attachment.filePath}
          fileName={attachment.fileName}
          mimeType={effectiveMimeType}
          originalSrc={sourceState === "asset" ? assetSrc : null}
          previewSrc={thumbnailSrc}
          requestPreview={requestViewerSource}
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
