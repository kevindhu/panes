const MARKDOWN_PREVIEW_EXTENSIONS = new Set(["md", "mdx", "markdown"]);

export type EditorLanguageId =
  | "typescript"
  | "tsx"
  | "javascript"
  | "jsx"
  | "rust"
  | "python"
  | "html"
  | "css"
  | "json"
  | "markdown"
  | "sql"
  | "yaml"
  | "java"
  | "csharp";

const EDITOR_LANGUAGE_BY_EXTENSION: Record<string, EditorLanguageId> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  rs: "rust",
  py: "python",
  html: "html",
  htm: "html",
  css: "css",
  json: "json",
  md: "markdown",
  mdx: "markdown",
  markdown: "markdown",
  sql: "sql",
  yaml: "yaml",
  yml: "yaml",
  java: "java",
  cs: "csharp",
  csx: "csharp",
};

function getFileExtension(filePath: string): string | null {
  const lastDotIndex = filePath.lastIndexOf(".");
  const lastSeparatorIndex = Math.max(filePath.lastIndexOf("/"), filePath.lastIndexOf("\\"));

  if (lastDotIndex <= lastSeparatorIndex) {
    return null;
  }

  const extension = filePath.slice(lastDotIndex + 1).toLowerCase();
  return extension.length > 0 ? extension : null;
}

export function getEditorLanguageId(filePath: string): EditorLanguageId | null {
  const extension = getFileExtension(filePath);
  return extension ? EDITOR_LANGUAGE_BY_EXTENSION[extension] ?? null : null;
}

export function isMarkdownPreviewFile(filePath: string): boolean {
  const extension = getFileExtension(filePath);
  return extension ? MARKDOWN_PREVIEW_EXTENSIONS.has(extension) : false;
}
