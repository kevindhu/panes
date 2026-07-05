import { describe, expect, it } from "vitest";
import {
  isWorkspaceRelativeLocalImageSource,
  resolveWorkspaceRelativeLocalImagePath,
} from "../src/lib/localImageSources";

describe("local image sources", () => {
  it("recognizes image-only workspace-relative sources", () => {
    expect(isWorkspaceRelativeLocalImageSource("screenshots/page.png")).toBe(true);
    expect(isWorkspaceRelativeLocalImageSource("./screenshots/page.WEBP?cache=1")).toBe(true);
    expect(isWorkspaceRelativeLocalImageSource("docs/readme.md")).toBe(false);
    expect(isWorkspaceRelativeLocalImageSource("https://example.com/page.png")).toBe(false);
    expect(isWorkspaceRelativeLocalImageSource("file:///repo/page.png")).toBe(false);
    expect(isWorkspaceRelativeLocalImageSource("C:/repo/page.png")).toBe(false);
  });

  it("resolves relative image sources inside the workspace root", () => {
    expect(
      resolveWorkspaceRelativeLocalImagePath(
        "screenshots/page.png",
        "C:\\Users\\dev\\repo",
      ),
    ).toBe("C:\\Users\\dev\\repo\\screenshots\\page.png");
    expect(
      resolveWorkspaceRelativeLocalImagePath(
        "./screenshots/../page.webp",
        "/home/dev/repo",
      ),
    ).toBe("/home/dev/repo/page.webp");
  });

  it("rejects relative image sources that escape the workspace root", () => {
    expect(resolveWorkspaceRelativeLocalImagePath("../secret.png", "/home/dev/repo")).toBeNull();
    expect(resolveWorkspaceRelativeLocalImagePath("../../secret.png", "C:\\repo")).toBeNull();
  });
});
