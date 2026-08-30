import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type SyntheticEvent,
} from "react";
import {
  cacheEmbeddedImageDataUrl,
  getCachedAttachmentImageAssetUrl,
  getCachedAttachmentImageFallbackUrl,
  loadAttachmentImageAssetUrl,
  loadAttachmentImageFallbackUrl,
  type AttachmentImageAssetOptions,
} from "../../lib/attachmentImages";
import {
  chatImageKey,
  type ChatImageDescriptor,
} from "../../lib/chatImageSources";
import { ImageAttachmentViewer } from "./ImageAttachmentViewer";

const DEFAULT_THUMBNAIL_OPTIONS = { maxWidth: 720, maxHeight: 440 };
const INLINE_MAX_WIDTH = 560;
const INLINE_MAX_HEIGHT = 420;
const IMAGE_FRAME_CACHE_LIMIT = 256;

interface ChatImageAssetState {
  thumbnailSrc: string | null;
  originalSrc: string | null;
  resolvedFilePath: string;
  loading: boolean;
  failed: boolean;
  requestViewerSource: () => Promise<string | null>;
  handleThumbnailError: () => void;
}

interface ChatImagePreviewProps {
  image: ChatImageDescriptor;
  variant?: "markdown" | "gallery";
  thumbnailOptions?: AttachmentImageAssetOptions;
}

interface ChatImageGalleryProps {
  images: ChatImageDescriptor[];
  className?: string;
}

interface ImageFrame {
  width: number;
}

const imageFrameCache = new Map<string, ImageFrame>();

export function useChatImageAsset(
  image: ChatImageDescriptor,
  thumbnailOptions: AttachmentImageAssetOptions = DEFAULT_THUMBNAIL_OPTIONS,
  preloadFull = true,
): ChatImageAssetState {
  const directSource = image.sourceUrl?.trim() || null;
  const initialFilePath = image.filePath?.trim() || "";
  const initialThumbnail = initialFilePath
    ? getCachedAttachmentImageAssetUrl(initialFilePath, image.mimeType, thumbnailOptions)
      ?? getCachedAttachmentImageFallbackUrl(initialFilePath, image.mimeType)
      ?? directSource
    : directSource;
  const initialOriginal = initialFilePath
    ? getCachedAttachmentImageAssetUrl(initialFilePath, image.mimeType) ?? directSource
    : directSource;
  const [resolvedFilePath, setResolvedFilePath] = useState(initialFilePath);
  const [thumbnailSrc, setThumbnailSrc] = useState<string | null>(initialThumbnail);
  const [originalSrc, setOriginalSrc] = useState<string | null>(initialOriginal);
  const [loading, setLoading] = useState(!initialThumbnail);
  const [failed, setFailed] = useState(false);
  const resolvedFilePathRef = useRef(initialFilePath);
  const requestTokenRef = useRef(0);
  const embeddedRequestRef = useRef<Promise<string | null> | null>(null);
  const thumbnailRequestRef = useRef<Promise<string | null> | null>(null);
  const fullRequestRef = useRef<Promise<string | null> | null>(null);
  const fallbackRequestRef = useRef<Promise<string | null> | null>(null);

  const materializeFilePath = useCallback(async (): Promise<string> => {
    if (resolvedFilePathRef.current) {
      return resolvedFilePathRef.current;
    }
    if (!directSource?.startsWith("data:image/")) {
      return "";
    }
    if (!embeddedRequestRef.current) {
      const requestToken = requestTokenRef.current;
      let request: Promise<string | null>;
      request = cacheEmbeddedImageDataUrl(directSource, image.mimeType)
        .then((asset) => {
          const nextPath = asset?.filePath?.trim() ?? "";
          if (nextPath && requestTokenRef.current === requestToken) {
            resolvedFilePathRef.current = nextPath;
            setResolvedFilePath(nextPath);
          }
          return nextPath || null;
        })
        .catch(() => null)
        .finally(() => {
          if (embeddedRequestRef.current === request) {
            embeddedRequestRef.current = null;
          }
        });
      embeddedRequestRef.current = request;
    }
    return (await embeddedRequestRef.current) ?? "";
  }, [directSource, image.mimeType]);

  const requestThumbnail = useCallback(async (): Promise<string | null> => {
    const requestToken = requestTokenRef.current;
    const filePath = resolvedFilePathRef.current || await materializeFilePath();
    if (requestTokenRef.current !== requestToken) {
      return null;
    }
    if (!filePath) {
      return directSource;
    }
    const cached = getCachedAttachmentImageAssetUrl(filePath, image.mimeType, thumbnailOptions);
    if (cached !== undefined) {
      return cached ?? directSource;
    }
    if (!thumbnailRequestRef.current) {
      let request: Promise<string | null>;
      request = loadAttachmentImageAssetUrl(
        filePath,
        image.mimeType,
        thumbnailOptions,
      ).finally(() => {
        if (thumbnailRequestRef.current === request) {
          thumbnailRequestRef.current = null;
        }
      });
      thumbnailRequestRef.current = request;
    }
    return (await thumbnailRequestRef.current) ?? directSource;
  }, [directSource, image.mimeType, materializeFilePath, thumbnailOptions]);

  const requestFull = useCallback(async (): Promise<string | null> => {
    const requestToken = requestTokenRef.current;
    const filePath = resolvedFilePathRef.current || await materializeFilePath();
    if (requestTokenRef.current !== requestToken) {
      return null;
    }
    if (!filePath) {
      return directSource;
    }
    const cached = getCachedAttachmentImageAssetUrl(filePath, image.mimeType);
    if (cached !== undefined) {
      return cached ?? directSource;
    }
    if (!fullRequestRef.current) {
      let request: Promise<string | null>;
      request = loadAttachmentImageAssetUrl(filePath, image.mimeType)
        .finally(() => {
          if (fullRequestRef.current === request) {
            fullRequestRef.current = null;
          }
        });
      fullRequestRef.current = request;
    }
    return (await fullRequestRef.current) ?? directSource;
  }, [directSource, image.mimeType, materializeFilePath]);

  const requestFallback = useCallback(async (): Promise<string | null> => {
    const requestToken = requestTokenRef.current;
    const filePath = resolvedFilePathRef.current || await materializeFilePath();
    if (requestTokenRef.current !== requestToken) {
      return null;
    }
    if (!filePath) {
      return directSource;
    }
    const cached = getCachedAttachmentImageFallbackUrl(filePath, image.mimeType);
    if (cached !== undefined) {
      return cached ?? directSource;
    }
    if (!fallbackRequestRef.current) {
      let request: Promise<string | null>;
      request = loadAttachmentImageFallbackUrl(filePath, image.mimeType)
        .finally(() => {
          if (fallbackRequestRef.current === request) {
            fallbackRequestRef.current = null;
          }
        });
      fallbackRequestRef.current = request;
    }
    return (await fallbackRequestRef.current) ?? directSource;
  }, [directSource, image.mimeType, materializeFilePath]);

  const requestViewerSource = useCallback(async (): Promise<string | null> => {
    const requestToken = requestTokenRef.current;
    try {
      const full = await requestFull();
      if (full && requestTokenRef.current === requestToken) {
        setOriginalSrc(full);
        return full;
      }
    } catch {
      // The raw-byte and descriptor sources below are independent fallbacks.
    }
    if (requestTokenRef.current !== requestToken) {
      return null;
    }
    if (directSource) {
      return directSource;
    }
    try {
      const fallback = await requestFallback();
      if (fallback && requestTokenRef.current === requestToken) {
        setThumbnailSrc(fallback);
        return fallback;
      }
    } catch {
      // The caller will show the terminal image failure state.
    }
    return null;
  }, [directSource, requestFallback, requestFull]);

  useEffect(() => {
    const requestToken = requestTokenRef.current + 1;
    requestTokenRef.current = requestToken;
    embeddedRequestRef.current = null;
    thumbnailRequestRef.current = null;
    fullRequestRef.current = null;
    fallbackRequestRef.current = null;
    const filePath = image.filePath?.trim() || "";
    const cachedThumbnail = filePath
      ? getCachedAttachmentImageAssetUrl(filePath, image.mimeType, thumbnailOptions)
        ?? getCachedAttachmentImageFallbackUrl(filePath, image.mimeType)
        ?? directSource
      : directSource;
    const cachedOriginal = filePath
      ? getCachedAttachmentImageAssetUrl(filePath, image.mimeType) ?? directSource
      : directSource;
    resolvedFilePathRef.current = filePath;
    setResolvedFilePath(filePath);
    setThumbnailSrc(cachedThumbnail);
    setOriginalSrc(cachedOriginal);
    setLoading(!cachedThumbnail);
    setFailed(false);

    let disposed = false;
    const commit = (callback: () => void) => {
      if (!disposed && requestTokenRef.current === requestToken) {
        callback();
      }
    };

    void requestThumbnail()
      .then((source) => {
        commit(() => {
          setThumbnailSrc(source);
          setLoading(false);
          setFailed(!source);
        });
      })
      .catch(async () => {
        try {
          const fallback = directSource ?? await requestFallback();
          commit(() => {
            setThumbnailSrc(fallback);
            setLoading(false);
            setFailed(!fallback);
          });
        } catch {
          commit(() => {
            setLoading(false);
            setFailed(true);
          });
        }
      });

    if (preloadFull) {
      void requestFull()
        .then((source) => commit(() => setOriginalSrc(source)))
        .catch(() => commit(() => setOriginalSrc(directSource)));
    }

    return () => {
      disposed = true;
    };
  }, [directSource, image.filePath, image.id, image.mimeType, preloadFull, requestFallback, requestFull, requestThumbnail, thumbnailOptions]);

  const handleThumbnailError = useCallback(() => {
    const requestToken = requestTokenRef.current;
    setOriginalSrc((current) => current === thumbnailSrc ? null : current);
    if (directSource && thumbnailSrc !== directSource) {
      setThumbnailSrc(directSource);
      setOriginalSrc(directSource);
      setFailed(false);
      return;
    }
    void requestFallback()
      .then((source) => {
        if (requestTokenRef.current !== requestToken) {
          return;
        }
        setThumbnailSrc(source);
        setOriginalSrc(source);
        setLoading(false);
        setFailed(!source);
      })
      .catch(() => {
        if (requestTokenRef.current !== requestToken) {
          return;
        }
        setThumbnailSrc(null);
        setLoading(false);
        setFailed(true);
      });
  }, [directSource, requestFallback, thumbnailSrc]);

  return {
    thumbnailSrc,
    originalSrc,
    resolvedFilePath,
    loading,
    failed,
    requestViewerSource,
    handleThumbnailError,
  };
}

export function ChatImagePreview({
  image,
  variant = "gallery",
  thumbnailOptions = DEFAULT_THUMBNAIL_OPTIONS,
}: ChatImagePreviewProps) {
  const asset = useChatImageAsset(image, thumbnailOptions, false);
  const [viewerOpen, setViewerOpen] = useState(false);
  const frameKey = chatImageKey(image);
  const [frame, setFrame] = useState<ImageFrame | null>(() => imageFrameCache.get(frameKey) ?? null);

  useEffect(() => {
    setFrame(imageFrameCache.get(frameKey) ?? null);
  }, [frameKey]);

  const frameStyle = frame && variant === "markdown"
    ? ({
        "--markdown-local-image-frame-width": `${frame.width}px`,
      } as CSSProperties)
    : undefined;

  function handleImageLoad(event: SyntheticEvent<HTMLImageElement>) {
    if (variant !== "markdown") {
      return;
    }
    const nextFrame = fitInlineFrame(
      event.currentTarget.naturalWidth,
      event.currentTarget.naturalHeight,
    );
    if (!nextFrame) {
      return;
    }
    imageFrameCache.delete(frameKey);
    imageFrameCache.set(frameKey, nextFrame);
    while (imageFrameCache.size > IMAGE_FRAME_CACHE_LIMIT) {
      const oldestKey = imageFrameCache.keys().next().value as string | undefined;
      if (!oldestKey) break;
      imageFrameCache.delete(oldestKey);
    }
    setFrame(nextFrame);
  }

  const buttonClass = variant === "markdown"
    ? "chat-image-preview markdown-local-image-button"
    : "chat-image-preview chat-image-gallery-card";
  const imageClass = variant === "markdown"
    ? "chat-image-preview-thumbnail markdown-local-image-thumbnail"
    : "chat-image-preview-thumbnail chat-image-gallery-thumbnail";

  const previewButton = (
    <button
      type="button"
      className={buttonClass}
      style={frameStyle}
      data-panes-chat-image-id={image.id}
      data-panes-markdown-local-image-path={image.filePath}
      data-panes-markdown-local-image-mime={image.mimeType}
      aria-label="Open image"
      onClick={() => setViewerOpen(true)}
    >
      {asset.thumbnailSrc ? (
        <img
          src={asset.thumbnailSrc}
          alt={image.alt}
          className={imageClass}
          draggable={false}
          loading="lazy"
          decoding="async"
          onLoad={handleImageLoad}
          onError={asset.handleThumbnailError}
        />
      ) : (
        <span className="markdown-local-image-placeholder chat-image-placeholder">
          {asset.failed ? "Image unavailable" : asset.loading ? "Loading image" : "Image unavailable"}
        </span>
      )}
    </button>
  );
  const viewer = viewerOpen ? (
    <ImageAttachmentViewer
      open
      filePath={asset.resolvedFilePath}
      fileName={image.fileName}
      mimeType={image.mimeType}
      originalSrc={asset.originalSrc}
      previewSrc={asset.thumbnailSrc}
      requestPreview={asset.requestViewerSource}
      onClose={() => setViewerOpen(false)}
    />
  ) : null;

  if (variant === "markdown") {
    return (
      <span className="chat-image-figure chat-image-figure-markdown">
        {previewButton}
        {viewer}
      </span>
    );
  }

  return (
    <figure className="chat-image-figure chat-image-figure-gallery">
      {previewButton}
      {image.caption && <figcaption title={image.caption}>{image.caption}</figcaption>}
      {viewer}
    </figure>
  );
}

export function ChatImageGallery({ images, className }: ChatImageGalleryProps) {
  const uniqueImages = useMemo(() => {
    const seen = new Set<string>();
    return images.filter((image) => {
      const key = chatImageKey(image);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }, [images]);

  if (uniqueImages.length === 0) {
    return null;
  }

  return (
    <div
      className={`chat-image-gallery${uniqueImages.length === 1 ? " single" : ""}${className ? ` ${className}` : ""}`}
      data-chat-image-count={uniqueImages.length}
    >
      {uniqueImages.map((image) => (
        <ChatImagePreview key={chatImageKey(image)} image={image} />
      ))}
    </div>
  );
}

function fitInlineFrame(naturalWidth: number, naturalHeight: number): ImageFrame | null {
  if (naturalWidth <= 0 || naturalHeight <= 0) {
    return null;
  }
  const aspect = naturalWidth / naturalHeight;
  let width = Math.min(naturalWidth, INLINE_MAX_WIDTH);
  let height = width / aspect;
  if (height > INLINE_MAX_HEIGHT) {
    height = INLINE_MAX_HEIGHT;
    width = height * aspect;
  }
  return {
    width: Math.max(1, Math.round(width)),
  };
}
