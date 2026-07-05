const SUPPORTED_LOCAL_IMAGE_EXTENSIONS = new Set([
  "bmp",
  "gif",
  "jpeg",
  "jpg",
  "png",
  "svg",
  "tif",
  "tiff",
  "webp",
]);

export function splitLocalImageSource(source: string): { path: string; suffix: string } {
  const queryIndex = source.indexOf("?");
  const hashIndex = source.indexOf("#");
  const suffixIndex = [queryIndex, hashIndex]
    .filter((index) => index >= 0)
    .sort((left, right) => left - right)[0];

  if (suffixIndex === undefined) {
    return { path: source, suffix: "" };
  }

  return {
    path: source.slice(0, suffixIndex),
    suffix: source.slice(suffixIndex),
  };
}

function safeDecodePath(path: string): string {
  try {
    return decodeURI(path);
  } catch {
    return path;
  }
}

export function hasSupportedLocalImageExtension(sourcePath: string): boolean {
  const path = safeDecodePath(sourcePath).replace(/\\/g, "/");
  const filename = path.split("/").filter(Boolean).pop() ?? "";
  const dotIndex = filename.lastIndexOf(".");

  if (dotIndex <= 0 || dotIndex === filename.length - 1) {
    return false;
  }

  return SUPPORTED_LOCAL_IMAGE_EXTENSIONS.has(filename.slice(dotIndex + 1).toLowerCase());
}

export function isWorkspaceRelativeLocalImageSource(source: string): boolean {
  const trimmed = source.trim();

  if (!trimmed) {
    return false;
  }

  const lower = trimmed.toLowerCase();

  if (
    trimmed.startsWith("#") ||
    trimmed.startsWith("/") ||
    trimmed.startsWith("\\") ||
    lower.startsWith("http://") ||
    lower.startsWith("https://") ||
    lower.startsWith("data:") ||
    lower.startsWith("blob:") ||
    lower.startsWith("asset:") ||
    lower.startsWith("file:") ||
    lower.startsWith("mailto:") ||
    lower.startsWith("tel:") ||
    /^[a-z][a-z0-9+.-]*:/i.test(trimmed)
  ) {
    return false;
  }

  return hasSupportedLocalImageExtension(splitLocalImageSource(trimmed).path);
}

function normalizeRelativePathParts(sourcePath: string): string[] | null {
  const decodedPath = safeDecodePath(sourcePath).replace(/\\/g, "/");
  const parts: string[] = [];

  for (const part of decodedPath.split("/")) {
    if (!part || part === ".") {
      continue;
    }

    if (part === "..") {
      if (parts.length === 0) {
        return null;
      }
      parts.pop();
      continue;
    }

    parts.push(part);
  }

  return parts.length > 0 ? parts : null;
}

function preferredPathSeparator(rootPath: string): "\\" | "/" {
  return rootPath.includes("\\") ? "\\" : "/";
}

export function resolveWorkspaceRelativeLocalImagePath(
  source: string,
  workspaceRootPath?: string | null,
): string | null {
  const root = workspaceRootPath?.trim();
  const trimmed = source.trim();

  if (!root || !isWorkspaceRelativeLocalImageSource(trimmed)) {
    return null;
  }

  const { path } = splitLocalImageSource(trimmed);
  const parts = normalizeRelativePathParts(path);

  if (!parts) {
    return null;
  }

  const separator = preferredPathSeparator(root);
  const normalizedRoot = root.replace(/[\\/]+$/g, "");

  if (!normalizedRoot) {
    return null;
  }

  return `${normalizedRoot}${separator}${parts.join(separator)}`;
}
