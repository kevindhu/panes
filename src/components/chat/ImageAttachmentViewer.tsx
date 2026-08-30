import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type SyntheticEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import { createPortal } from "react-dom";
import { Copy, Minus, Plus, RotateCcw, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { copyAttachmentImage } from "../../lib/attachmentImages";
import { recordPerfMetric } from "../../lib/perfTelemetry";
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

interface DragState {
  pointerId: number;
  startX: number;
  startY: number;
  originX: number;
  originY: number;
}

interface Point {
  x: number;
  y: number;
}

const DEFAULT_OFFSET: Point = { x: 0, y: 0 };
const FIT_SCALE_FALLBACK = 1;
const MIN_SCALE_RATIO = 0.25;
const ABSOLUTE_MIN_SCALE = 0.001;
const MAX_SCALE = 6;
const SCALE_FACTOR = 1.2;
const VIEWER_IMAGE_INSET = 24;
const SCALE_EPSILON = 0.0001;

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
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const imageRef = useRef<HTMLImageElement>(null);
  const dragStateRef = useRef<DragState | null>(null);
  const failedSourcesRef = useRef(new Set<string>());
  const requestedSourcePromiseRef = useRef<Promise<string | null> | null>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const openStartedAtRef = useRef(0);
  const firstPixelRecordedRef = useRef(false);
  const fitScaleRef = useRef(FIT_SCALE_FALLBACK);
  const userAdjustedScaleRef = useRef(false);
  const [fitScale, setFitScale] = useState(FIT_SCALE_FALLBACK);
  const [scale, setScale] = useState(FIT_SCALE_FALLBACK);
  const [offset, setOffset] = useState(DEFAULT_OFFSET);
  const [copying, setCopying] = useState(false);
  const [displaySrc, setDisplaySrc] = useState<string | null>(previewSrc ?? originalSrc);
  const [dragging, setDragging] = useState(false);
  const [failed, setFailed] = useState(false);
  const [naturalSize, setNaturalSize] = useState<Point | null>(null);
  const currentSrc = [displaySrc, previewSrc, originalSrc].find(
    (source): source is string => Boolean(
      source && !failedSourcesRef.current.has(source),
    ),
  ) ?? null;
  const hasAnySource = Boolean(currentSrc || previewSrc || originalSrc || requestPreview);
  const requestViewerSource = useCallback((): Promise<string | null> => {
    if (!requestPreview) {
      return Promise.resolve(null);
    }
    if (!requestedSourcePromiseRef.current) {
      const request = requestPreview().catch((error) => {
        if (requestedSourcePromiseRef.current === request) {
          requestedSourcePromiseRef.current = null;
        }
        throw error;
      });
      requestedSourcePromiseRef.current = request;
    }
    return requestedSourcePromiseRef.current;
  }, [requestPreview]);

  const fitCurrentImage = useCallback((force = false) => {
    const nextFitScale = calculateFitScale(
      stageRef.current,
      imageRef.current,
      VIEWER_IMAGE_INSET,
    );
    if (nextFitScale === null) {
      return;
    }
    fitScaleRef.current = nextFitScale;
    setFitScale(nextFitScale);
    if (force || !userAdjustedScaleRef.current) {
      setScale(nextFitScale);
      setOffset(DEFAULT_OFFSET);
      return;
    }
    setScale((currentScale) => {
      const nextScale = clampScale(currentScale, nextFitScale);
      setOffset((currentOffset) => constrainOffset(
        currentOffset,
        nextScale,
        stageRef.current,
        imageRef.current,
      ));
      return nextScale;
    });
  }, []);

  useLayoutEffect(() => {
    if (!open) {
      return;
    }
    openStartedAtRef.current = performance.now();
    firstPixelRecordedRef.current = false;
    failedSourcesRef.current.clear();
    requestedSourcePromiseRef.current = null;
    fitScaleRef.current = FIT_SCALE_FALLBACK;
    userAdjustedScaleRef.current = false;
    setFitScale(FIT_SCALE_FALLBACK);
    setScale(FIT_SCALE_FALLBACK);
    setOffset(DEFAULT_OFFSET);
    setCopying(false);
    setDisplaySrc(previewSrc ?? originalSrc);
    setDragging(false);
    setFailed(false);
    setNaturalSize(null);
    dragStateRef.current = null;
  }, [fileName, filePath, mimeType, open, requestPreview]);

  useEffect(() => {
    if (!open || displaySrc) {
      return;
    }
    const immediateSource = previewSrc ?? originalSrc;
    if (immediateSource) {
      setDisplaySrc(immediateSource);
      setFailed(false);
    }
  }, [displaySrc, open, originalSrc, previewSrc]);

  useEffect(() => {
    if (
      !open
      || !originalSrc
      || originalSrc === currentSrc
      || failedSourcesRef.current.has(originalSrc)
    ) {
      return;
    }

    let cancelled = false;
    const startedAt = performance.now();
    void decodeImageSource(originalSrc)
      .then(() => {
        if (cancelled) {
          return;
        }
        setDisplaySrc(originalSrc);
        setFailed(false);
        recordPerfMetric("chat.image.viewer_full_decode.ms", performance.now() - startedAt);
      })
      .catch(() => {
        failedSourcesRef.current.add(originalSrc);
      });

    return () => {
      cancelled = true;
    };
  }, [currentSrc, open, originalSrc]);

  useEffect(() => {
    if (!open || originalSrc || !requestPreview) {
      return;
    }

    let cancelled = false;
    const startingSource = currentSrc;
    void requestViewerSource()
      .then(async (nextPreviewSrc) => {
        if (cancelled) {
          return;
        }
        if (!nextPreviewSrc) {
          if (!startingSource) {
            setFailed(true);
          }
          return;
        }
        if (nextPreviewSrc === startingSource) {
          return;
        }
        if (!startingSource) {
          setDisplaySrc(nextPreviewSrc);
          setFailed(false);
          return;
        }
        try {
          await decodeImageSource(nextPreviewSrc);
          if (!cancelled) {
            setDisplaySrc(nextPreviewSrc);
            setFailed(false);
          }
        } catch {
          failedSourcesRef.current.add(nextPreviewSrc);
        }
      })
      .catch(() => {
        if (!cancelled && !startingSource) {
          setFailed(true);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [currentSrc, open, originalSrc, requestPreview, requestViewerSource]);

  useEffect(() => {
    if (!open || typeof document === "undefined") {
      return;
    }
    restoreFocusRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    const previousBodyOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const timer = window.setTimeout(() => dialogRef.current?.focus(), 0);
    return () => {
      window.clearTimeout(timer);
      document.body.style.overflow = previousBodyOverflow;
      const restoreTarget = restoreFocusRef.current;
      window.setTimeout(() => {
        if (restoreTarget?.isConnected) {
          restoreTarget.focus();
        }
      }, 0);
    };
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
        return;
      }

      if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        changeScale(1);
        return;
      }
      if (event.key === "-" || event.key === "_") {
        event.preventDefault();
        changeScale(-1);
        return;
      }
      if (event.key === "0") {
        event.preventDefault();
        resetZoom();
        return;
      }
      if (event.key === "Tab") {
        trapDialogFocus(event, dialogRef.current);
      }
    }

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [copying, currentSrc, filePath, mimeType, onClose, open, originalSrc, previewSrc, scale, t]);

  useEffect(() => {
    if (!open) {
      return;
    }
    const stage = stageRef.current;
    const handleResize = () => fitCurrentImage();
    window.addEventListener("resize", handleResize);
    const resizeObserver = stage && typeof ResizeObserver !== "undefined"
      ? new ResizeObserver(handleResize)
      : null;
    if (resizeObserver && stage) {
      resizeObserver.observe(stage);
    }
    return () => {
      window.removeEventListener("resize", handleResize);
      resizeObserver?.disconnect();
    };
  }, [fitCurrentImage, open]);

  if (!open || typeof document === "undefined") {
    return null;
  }

  async function handleCopy() {
    if (copying || !currentSrc) {
      return;
    }
    setCopying(true);
    try {
      await copyAttachmentImage(
        filePath,
        [currentSrc, originalSrc, previewSrc],
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
    userAdjustedScaleRef.current = false;
    setScale(fitScaleRef.current);
    setOffset(DEFAULT_OFFSET);
    setDragging(false);
    dragStateRef.current = null;
    fitCurrentImage(true);
  }

  function changeScale(direction: -1 | 1, anchor?: Point) {
    if (!currentSrc) {
      return;
    }
    userAdjustedScaleRef.current = true;
    setScale((currentScale) => {
      const nextScale = clampScale(
        currentScale * (direction > 0 ? SCALE_FACTOR : 1 / SCALE_FACTOR),
        fitScaleRef.current,
      );
      setOffset((currentOffset) => offsetForScale(
        currentOffset,
        currentScale,
        nextScale,
        anchor,
        stageRef.current,
        imageRef.current,
        fitScaleRef.current,
      ));
      return nextScale;
    });
  }

  function handleWheel(event: ReactWheelEvent<HTMLDivElement>) {
    if (!currentSrc) {
      return;
    }
    event.preventDefault();
    const stageRect = stageRef.current?.getBoundingClientRect();
    const anchor = stageRect
      ? {
          x: event.clientX - (stageRect.left + stageRect.width / 2),
          y: event.clientY - (stageRect.top + stageRect.height / 2),
        }
      : undefined;
    changeScale(event.deltaY < 0 ? 1 : -1, anchor);
  }

  function handleDoubleClick(event: ReactMouseEvent<HTMLDivElement>) {
    if (!currentSrc) {
      return;
    }
    event.preventDefault();
    if (scale > fitScale + SCALE_EPSILON) {
      resetZoom();
      return;
    }
    const stageRect = stageRef.current?.getBoundingClientRect();
    const anchor = stageRect
      ? {
          x: event.clientX - (stageRect.left + stageRect.width / 2),
          y: event.clientY - (stageRect.top + stageRect.height / 2),
        }
      : undefined;
    changeScale(1, anchor);
  }

  function handlePointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (scale <= fitScale + SCALE_EPSILON || !currentSrc || event.button !== 0) {
      return;
    }
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    dragStateRef.current = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      originX: offset.x,
      originY: offset.y,
    };
    setDragging(true);
  }

  function handlePointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const dragState = dragStateRef.current;
    if (!dragState || dragState.pointerId !== event.pointerId) {
      return;
    }
    const candidate = {
      x: dragState.originX + (event.clientX - dragState.startX),
      y: dragState.originY + (event.clientY - dragState.startY),
    };
    setOffset(constrainOffset(candidate, scale, stageRef.current, imageRef.current));
  }

  function handlePointerEnd(event: ReactPointerEvent<HTMLDivElement>) {
    if (dragStateRef.current?.pointerId !== event.pointerId) {
      return;
    }
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    }
    setDragging(false);
    dragStateRef.current = null;
  }

  function handleImageLoad(event: SyntheticEvent<HTMLImageElement>) {
    const nextNaturalSize = {
      x: event.currentTarget.naturalWidth,
      y: event.currentTarget.naturalHeight,
    };
    setNaturalSize(nextNaturalSize);
    fitCurrentImage();
    if (!firstPixelRecordedRef.current) {
      firstPixelRecordedRef.current = true;
      recordPerfMetric(
        "chat.image.viewer_first_pixel.ms",
        performance.now() - openStartedAtRef.current,
      );
    }
  }

  async function handleImageError() {
    if (!currentSrc) {
      setFailed(true);
      return;
    }
    failedSourcesRef.current.add(currentSrc);

    const nextKnownSource = [previewSrc, originalSrc].find(
      (source): source is string => Boolean(
        source
        && source !== currentSrc
        && !failedSourcesRef.current.has(source),
      ),
    );
    if (nextKnownSource) {
      setDisplaySrc(nextKnownSource);
      return;
    }

    if (requestPreview) {
      try {
        const nextPreviewSrc = await requestViewerSource();
        if (nextPreviewSrc && !failedSourcesRef.current.has(nextPreviewSrc)) {
          setDisplaySrc(nextPreviewSrc);
          setFailed(false);
          return;
        }
      } catch {
        // Fall through to the terminal failure state.
      }
    }

    setDisplaySrc(null);
    setFailed(true);
  }

  const dimensionLabel = naturalSize?.x && naturalSize.y
    ? `${naturalSize.x} × ${naturalSize.y}`
    : null;

  return createPortal(
    <div
      className="chat-image-viewer-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        ref={dialogRef}
        className="chat-image-viewer-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <div className="chat-image-viewer-toolbar">
          <div className="chat-image-viewer-meta">
            <span id={titleId} className="chat-image-viewer-file-name">{fileName}</span>
            {dimensionLabel && <span className="chat-image-viewer-dimensions">{dimensionLabel}</span>}
            <span className="chat-image-viewer-zoom-label">{formatScaleLabel(scale)}</span>
          </div>
          <div className="chat-image-viewer-actions">
            <button
              type="button"
              className="chat-image-viewer-action chat-image-viewer-icon-action"
              onClick={() => changeScale(-1)}
              disabled={!currentSrc || scale <= minimumScaleForFit(fitScale) + SCALE_EPSILON}
              title={t("attachments.viewer.zoomOut")}
              aria-label={t("attachments.viewer.zoomOut")}
            >
              <Minus size={14} />
            </button>
            <button
              type="button"
              className="chat-image-viewer-action chat-image-viewer-icon-action"
              onClick={() => changeScale(1)}
              disabled={!currentSrc || scale >= MAX_SCALE}
              title={t("attachments.viewer.zoomIn")}
              aria-label={t("attachments.viewer.zoomIn")}
            >
              <Plus size={14} />
            </button>
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
              disabled={scalesApproximatelyEqual(scale, fitScale) && offset.x === 0 && offset.y === 0}
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
          ref={stageRef}
          className={`chat-image-viewer-stage${scale > fitScale + SCALE_EPSILON ? " is-zoomed" : ""}${dragging ? " is-dragging" : ""}`}
          onWheel={handleWheel}
          onDoubleClick={handleDoubleClick}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerEnd}
          onPointerCancel={handlePointerEnd}
        >
          {currentSrc ? (
            <img
              ref={imageRef}
              src={currentSrc}
              alt={fileName}
              className="chat-image-viewer-image"
              style={{
                transform: `translate3d(calc(-50% + ${offset.x}px), calc(-50% + ${offset.y}px), 0) scale(${scale})`,
              }}
              draggable={false}
              decoding="async"
              onLoad={handleImageLoad}
              onError={() => void handleImageError()}
            />
          ) : failed || !hasAnySource ? (
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

function decodeImageSource(source: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.decoding = "async";
    image.onload = () => {
      if (typeof image.decode !== "function") {
        resolve();
        return;
      }
      void image.decode().then(resolve, () => resolve());
    };
    image.onerror = () => reject(new Error("Unable to decode full-resolution image."));
    image.src = source;
  });
}

function minimumScaleForFit(fitScale: number): number {
  return Math.max(ABSOLUTE_MIN_SCALE, fitScale * MIN_SCALE_RATIO);
}

function clampScale(value: number, fitScale: number): number {
  return Math.max(
    minimumScaleForFit(fitScale),
    Math.min(MAX_SCALE, Number(value.toFixed(4))),
  );
}

function scalesApproximatelyEqual(left: number, right: number): boolean {
  return Math.abs(left - right) <= SCALE_EPSILON;
}

function formatScaleLabel(scale: number): string {
  const percentage = scale * 100;
  return `${percentage < 10 ? Number(percentage.toFixed(1)) : Math.round(percentage)}%`;
}

function calculateFitScale(
  stage: HTMLDivElement | null,
  image: HTMLImageElement | null,
  inset: number,
): number | null {
  if (!stage || !image || image.naturalWidth <= 0 || image.naturalHeight <= 0) {
    return null;
  }
  const availableWidth = Math.max(1, stage.clientWidth - inset);
  const availableHeight = Math.max(1, stage.clientHeight - inset);
  return Math.min(
    FIT_SCALE_FALLBACK,
    availableWidth / image.naturalWidth,
    availableHeight / image.naturalHeight,
  );
}

function offsetForScale(
  currentOffset: Point,
  currentScale: number,
  nextScale: number,
  anchor: Point | undefined,
  stage: HTMLDivElement | null,
  image: HTMLImageElement | null,
  fitScale: number,
): Point {
  if (nextScale <= fitScale + SCALE_EPSILON) {
    return DEFAULT_OFFSET;
  }
  if (!anchor || currentScale <= 0) {
    return constrainOffset(currentOffset, nextScale, stage, image);
  }
  const ratio = nextScale / currentScale;
  return constrainOffset({
    x: anchor.x - (anchor.x - currentOffset.x) * ratio,
    y: anchor.y - (anchor.y - currentOffset.y) * ratio,
  }, nextScale, stage, image);
}

function constrainOffset(
  offset: Point,
  scale: number,
  stage: HTMLDivElement | null,
  image: HTMLImageElement | null,
): Point {
  if (!stage || !image) {
    return DEFAULT_OFFSET;
  }
  const imageWidth = image.naturalWidth || image.offsetWidth;
  const imageHeight = image.naturalHeight || image.offsetHeight;
  const maxX = Math.max(0, (imageWidth * scale - stage.clientWidth) / 2);
  const maxY = Math.max(0, (imageHeight * scale - stage.clientHeight) / 2);
  return {
    x: Math.max(-maxX, Math.min(maxX, offset.x)),
    y: Math.max(-maxY, Math.min(maxY, offset.y)),
  };
}

function trapDialogFocus(event: KeyboardEvent, dialog: HTMLDivElement | null): void {
  if (!dialog) {
    return;
  }
  const focusable = Array.from(dialog.querySelectorAll<HTMLElement>(
    "button:not([disabled]), [href], input:not([disabled]), [tabindex]:not([tabindex='-1'])",
  )).filter((element) => element.offsetParent !== null || element === document.activeElement);
  if (focusable.length === 0) {
    event.preventDefault();
    dialog.focus();
    return;
  }
  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}
