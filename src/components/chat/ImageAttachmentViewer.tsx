import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import { createPortal } from "react-dom";
import { Copy, RotateCcw, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import {
  copyAttachmentImage,
  getAttachmentImageSources,
  prewarmImageBlobFromSources,
} from "../../lib/attachmentImages";
import { toast } from "../../stores/toastStore";

interface ImageAttachmentViewerProps {
  open: boolean;
  filePath: string;
  fileName: string;
  mimeType?: string;
  originalSrc: string | null;
  previewSrc: string | null;
  requestPreview?: () => Promise<string | null>;
  onClose: () => void;
}

type SourceState = "preferred" | "fallback" | "failed";

interface DragState {
  startX: number;
  startY: number;
  originX: number;
  originY: number;
}

const DEFAULT_OFFSET = { x: 0, y: 0 };
const MIN_SCALE = 1;
const MAX_SCALE = 6;
const SCALE_STEP = 0.18;

export function ImageAttachmentViewer({
  open,
  filePath,
  fileName,
  mimeType,
  originalSrc,
  previewSrc,
  requestPreview,
  onClose,
}: ImageAttachmentViewerProps) {
  const { t } = useTranslation("chat");
  const dialogRef = useRef<HTMLDivElement>(null);
  const dragStateRef = useRef<DragState | null>(null);
  const [scale, setScale] = useState(MIN_SCALE);
  const [offset, setOffset] = useState(DEFAULT_OFFSET);
  const [copying, setCopying] = useState(false);
  const [sourceState, setSourceState] = useState<SourceState>("preferred");
  const [dragging, setDragging] = useState(false);
  const [imageLoaded, setImageLoaded] = useState(false);

  const { primarySrc, fallbackSrc } = useMemo(
    () => getAttachmentImageSources(originalSrc, previewSrc),
    [originalSrc, previewSrc],
  );
  const hasAnySource = Boolean(primarySrc || fallbackSrc);

  const currentSrc = sourceState === "preferred"
    ? primarySrc
    : sourceState === "fallback"
      ? fallbackSrc
      : null;

  useEffect(() => {
    if (!open) {
      return;
    }
    setScale(MIN_SCALE);
    setOffset(DEFAULT_OFFSET);
    setCopying(false);
    setSourceState("preferred");
    setDragging(false);
    setImageLoaded(false);
    dragStateRef.current = null;
  }, [fileName, filePath, open]);

  useEffect(() => {
    if (!open || !currentSrc) {
      return;
    }
    setImageLoaded(false);
  }, [currentSrc, open]);

  useEffect(() => {
    if (!open || !currentSrc || !imageLoaded) {
      return;
    }
    prewarmImageBlobFromSources(
      sourceState === "fallback"
        ? [fallbackSrc, primarySrc]
        : [primarySrc, fallbackSrc],
      mimeType,
    );
  }, [currentSrc, fallbackSrc, imageLoaded, mimeType, open, primarySrc, sourceState]);

  useEffect(() => {
    if (!open || currentSrc || !requestPreview) {
      return;
    }

    let cancelled = false;
    void requestPreview()
      .then((nextPreviewSrc) => {
        if (!cancelled && !nextPreviewSrc) {
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
  }, [currentSrc, open, requestPreview]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const timer = window.setTimeout(() => {
      dialogRef.current?.focus();
    }, 30);
    return () => window.clearTimeout(timer);
  }, [open]);

  useEffect(() => {
    if (!open) {
      return;
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }

      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "c") {
        event.preventDefault();
        event.stopPropagation();
        void handleCopy();
      }
    }

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [copying, currentSrc, fallbackSrc, filePath, mimeType, onClose, open, primarySrc, sourceState, t]);

  useEffect(() => {
    if (!open || !dragging) {
      return;
    }

    function onMouseMove(event: MouseEvent) {
      const dragState = dragStateRef.current;
      if (!dragState) {
        return;
      }
      setOffset({
        x: dragState.originX + (event.clientX - dragState.startX),
        y: dragState.originY + (event.clientY - dragState.startY),
      });
    }

    function onMouseUp() {
      setDragging(false);
      dragStateRef.current = null;
    }

    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);

    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, [dragging, open]);

  if (!open || typeof document === "undefined") {
    return null;
  }

  async function handleCopy() {
    if (copying) {
      return;
    }
    setCopying(true);
    try {
      await copyAttachmentImage(
        filePath,
        sourceState === "fallback"
          ? [currentSrc, primarySrc]
          : [currentSrc, fallbackSrc],
        mimeType,
      );
      toast.success(t("attachments.viewer.copySuccess"));
    } catch {
      toast.error(t("attachments.viewer.copyFailed"));
    } finally {
      setCopying(false);
    }
  }

  function resetZoom() {
    setScale(MIN_SCALE);
    setOffset(DEFAULT_OFFSET);
    setDragging(false);
    dragStateRef.current = null;
  }

  function handleWheel(event: ReactWheelEvent<HTMLDivElement>) {
    if (!currentSrc) {
      return;
    }
    event.preventDefault();
    const nextScale = clampScale(
      scale + (event.deltaY < 0 ? SCALE_STEP : -SCALE_STEP),
    );
    setScale(nextScale);
    if (nextScale === MIN_SCALE) {
      setOffset(DEFAULT_OFFSET);
    }
  }

  function handleMouseDown(event: ReactMouseEvent<HTMLDivElement>) {
    if (scale <= MIN_SCALE || !currentSrc) {
      return;
    }
    event.preventDefault();
    dragStateRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      originX: offset.x,
      originY: offset.y,
    };
    setDragging(true);
  }

  async function handleImageError() {
    if (sourceState === "preferred" && fallbackSrc) {
      setSourceState("fallback");
      return;
    }

    if (sourceState === "preferred" && requestPreview) {
      try {
        const nextPreviewSrc = await requestPreview();
        if (nextPreviewSrc) {
          setSourceState(originalSrc ? "fallback" : "preferred");
          return;
        }
      } catch {
        // Ignore and fall through to the failure state below.
      }
    }

    setSourceState("failed");
  }

  return createPortal(
    <div className="chat-image-viewer-backdrop" onMouseDown={onClose}>
      <div
        ref={dialogRef}
        className="chat-image-viewer-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t("attachments.viewer.open")}
        tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="chat-image-viewer-toolbar">
          <div className="chat-image-viewer-meta">
            <span className="chat-image-viewer-file-name">{fileName}</span>
            <span className="chat-image-viewer-zoom-label">{Math.round(scale * 100)}%</span>
          </div>
          <div className="chat-image-viewer-actions">
            <button
              type="button"
              className="chat-image-viewer-action"
              onClick={() => void handleCopy()}
              disabled={copying || !currentSrc}
              title={t("attachments.viewer.copy")}
              aria-label={t("attachments.viewer.copy")}
            >
              <Copy size={14} />
              <span>{t("attachments.viewer.copy")}</span>
            </button>
            <button
              type="button"
              className="chat-image-viewer-action"
              onClick={resetZoom}
              title={t("attachments.viewer.resetZoom")}
              aria-label={t("attachments.viewer.resetZoom")}
            >
              <RotateCcw size={14} />
              <span>{t("attachments.viewer.resetZoom")}</span>
            </button>
            <button
              type="button"
              className="chat-image-viewer-action"
              onClick={onClose}
              title={t("attachments.viewer.close")}
              aria-label={t("attachments.viewer.close")}
            >
              <X size={14} />
              <span>{t("attachments.viewer.close")}</span>
            </button>
          </div>
        </div>
        <div
          className={`chat-image-viewer-stage${scale > MIN_SCALE ? " is-zoomed" : ""}${dragging ? " is-dragging" : ""}`}
          onWheel={handleWheel}
          onMouseDown={handleMouseDown}
        >
          {currentSrc ? (
            <img
              src={currentSrc}
              alt={fileName}
              className="chat-image-viewer-image"
              style={{
                transform: `translate3d(${offset.x}px, ${offset.y}px, 0) scale(${scale})`,
              }}
              draggable={false}
              decoding="async"
              onLoad={() => setImageLoaded(true)}
              onError={() => void handleImageError()}
            />
          ) : sourceState === "failed" || !hasAnySource ? (
            <div className="chat-image-viewer-status">{t("attachments.viewer.loadFailed")}</div>
          ) : (
            <div className="chat-image-viewer-status">{t("attachments.viewer.loading")}</div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

function clampScale(value: number): number {
  return Math.max(MIN_SCALE, Math.min(MAX_SCALE, Number(value.toFixed(2))));
}
