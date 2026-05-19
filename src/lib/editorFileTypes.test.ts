import { describe, expect, it } from "vitest";

import { getEditorLanguageId, isMarkdownPreviewFile } from "./editorFileTypes";

describe("editorFileTypes", () => {
  it("maps supported source extensions to editor language ids", () => {
    expect(getEditorLanguageId("src/App.tsx")).toBe("tsx");
    expect(getEditorLanguageId("scripts/build.mjs")).toBe("javascript");
    expect(getEditorLanguageId("src-tauri/src/main.rs")).toBe("rust");
    expect(getEditorLanguageId("docs/guide.md")).toBe("markdown");
    expect(getEditorLanguageId("src/Main.java")).toBe("java");
    expect(getEditorLanguageId("src/Program.cs")).toBe("csharp");
    expect(getEditorLanguageId("src\\Program.cs")).toBe("csharp");
    expect(getEditorLanguageId("src/Script.CSX")).toBe("csharp");
  });

  it("returns null for unsupported or extensionless files", () => {
    expect(getEditorLanguageId("Dockerfile")).toBe(null);
    expect(getEditorLanguageId("archive.tar.gz")).toBe(null);
  });

  it("detects markdown preview files case-insensitively", () => {
    expect(isMarkdownPreviewFile("README.md")).toBe(true);
    expect(isMarkdownPreviewFile("docs/Guide.MDX")).toBe(true);
    expect(isMarkdownPreviewFile("src/App.tsx")).toBe(false);
  });
});
