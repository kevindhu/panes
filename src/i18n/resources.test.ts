import { describe, expect, it } from "vitest";
import commonEn from "./resources/en/common.json";
import appEn from "./resources/en/app.json";
import chatEn from "./resources/en/chat.json";
import workspaceEn from "./resources/en/workspace.json";
import setupEn from "./resources/en/setup.json";
import gitEn from "./resources/en/git.json";
import nativeEn from "./resources/en/native.json";

function flattenKeys(value: unknown, prefix = ""): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return prefix ? [prefix] : [];
  }

  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    flattenKeys(child, prefix ? `${prefix}.${key}` : key),
  );
}

function readNestedString(
  value: Record<string, unknown>,
  path: string,
): string | undefined {
  const segments = path.split(".");
  let current: unknown = value;

  for (const segment of segments) {
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[segment];
  }

  return typeof current === "string" ? current : undefined;
}

describe("i18n resources", () => {
  it("keeps English namespace resources valid", () => {
    const enKeys = [
      ...flattenKeys(commonEn, "common"),
      ...flattenKeys(appEn, "app"),
      ...flattenKeys(chatEn, "chat"),
      ...flattenKeys(workspaceEn, "workspace"),
      ...flattenKeys(setupEn, "setup"),
      ...flattenKeys(gitEn, "git"),
      ...flattenKeys(nativeEn, "native"),
    ].sort();

    expect(enKeys.length).toBeGreaterThan(0);
  });

  it("defines fallback thread titles used by the chat panel", () => {
    expect(readNestedString(chatEn, "panel.workspaceChatTitle")).toBeTruthy();
    expect(readNestedString(chatEn, "panel.repoChatTitle")).toBeTruthy();
  });
});
