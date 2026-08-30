import { describe, expect, it } from "vitest";
import commonEn from "./resources/en/common.json";
import chatEn from "./resources/en/codex-chat.json";

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
      ...flattenKeys(chatEn, "chat"),
    ].sort();

    expect(enKeys.length).toBeGreaterThan(0);
  });

  it("defines the Codex approval copy used by the chat panel", () => {
    expect(readNestedString(chatEn, "panel.approvalActions.deny")).toBeTruthy();
    expect(readNestedString(chatEn, "messageBlocks.approval.showDetails")).toBeTruthy();
  });
});
