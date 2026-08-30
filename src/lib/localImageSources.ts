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

function isWindowsDriveAbsolutePath(path: string): boolean {
  return /^[a-z]:[\\/]/i.test(path);
}

function isWindowsUncPath(path: string): boolean {
  // Forward-slash `//host/path` sources stay browser URLs; canonical UNC paths
  // use backslashes so they cannot collide with protocol-relative remote images.
  return /^\\\\[^\\/]+[\\/]+[^\\/]+(?:[\\/]|$)/.test(path);
}

function isPosixAbsolutePath(path: string): boolean {
  return path.startsWith("/") && !path.startsWith("//");
}

function normalizeAbsoluteWindowsImagePath(sourcePath: string): string | null {
  const decodedPath = safeDecodePath(sourcePath);
  const drivePath = /^\/[a-z]:[\\/]/i.test(decodedPath)
    ? decodedPath.slice(1)
    : decodedPath;

  if (isWindowsDriveAbsolutePath(drivePath)) {
    return drivePath.replace(/\//g, "\\");
  }

  if (isWindowsUncPath(decodedPath)) {
    return decodedPath
      .replace(/\//g, "\\")
      .replace(/^\\+/, "\\\\");
  }

  return null;
}

function normalizeWindowsFileUrlPath(path: string): string {
  return path.replace(/[\\/]+/g, "\\");
}

export function resolveLocalImageFileUrl(source: string): string | null {
  const trimmed = source.trim();
  if (!trimmed.toLowerCase().startsWith("file://")) {
    return null;
  }

  try {
    const url = new URL(trimmed);
    if (url.protocol.toLowerCase() !== "file:") {
      return null;
    }
    const decodedPath = decodeURIComponent(url.pathname);
    let filePath: string;

    if (url.hostname && url.hostname.toLowerCase() !== "localhost") {
      const networkPath = normalizeWindowsFileUrlPath(decodedPath).replace(/^\\+/, "");
      filePath = networkPath
        ? `\\\\${decodeURIComponent(url.hostname)}\\${networkPath}`
        : `\\\\${decodeURIComponent(url.hostname)}`;
    } else if (/^\/[a-z]:[\\/]/i.test(decodedPath)) {
      filePath = normalizeWindowsFileUrlPath(decodedPath.slice(1));
    } else {
      filePath = decodedPath;
    }

    return hasSupportedLocalImageExtension(filePath) ? filePath : null;
  } catch {
    return null;
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

export function isAbsoluteWindowsLocalImageSource(source: string): boolean {
  const trimmed = source.trim();

  if (!trimmed) {
    return false;
  }

  const { path } = splitLocalImageSource(trimmed);
  return (
    normalizeAbsoluteWindowsImagePath(path) !== null &&
    hasSupportedLocalImageExtension(path)
  );
}

export function isAbsolutePosixLocalImageSource(source: string): boolean {
  const trimmed = source.trim();

  if (!trimmed) {
    return false;
  }

  const { path } = splitLocalImageSource(trimmed);
  return isPosixAbsolutePath(safeDecodePath(path)) && hasSupportedLocalImageExtension(path);
}

export function isLocalImageSource(source: string): boolean {
  return (
    resolveLocalImageFileUrl(source) !== null ||
    isAbsoluteWindowsLocalImageSource(source) ||
    isAbsolutePosixLocalImageSource(source) ||
    isWorkspaceRelativeLocalImageSource(source)
  );
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

export function resolveLocalImagePath(
  source: string,
  workspaceRootPath?: string | null,
): string | null {
  const trimmed = source.trim();

  if (!trimmed) {
    return null;
  }

  const fileUrlPath = resolveLocalImageFileUrl(trimmed);
  if (fileUrlPath) {
    return fileUrlPath;
  }

  const { path } = splitLocalImageSource(trimmed);
  const absolutePath = normalizeAbsoluteWindowsImagePath(path);
  if (absolutePath && hasSupportedLocalImageExtension(path)) {
    return absolutePath;
  }

  const decodedPath = safeDecodePath(path);
  if (isPosixAbsolutePath(decodedPath) && hasSupportedLocalImageExtension(decodedPath)) {
    return decodedPath;
  }

  return resolveWorkspaceRelativeLocalImagePath(trimmed, workspaceRootPath);
}
