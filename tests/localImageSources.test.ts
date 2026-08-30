import { describe, expect, it } from "vitest";
import {
  isAbsoluteWindowsLocalImageSource,
  isAbsolutePosixLocalImageSource,
  isLocalImageSource,
  isWorkspaceRelativeLocalImageSource,
  resolveLocalImageFileUrl,
  resolveLocalImagePath,
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

  it("recognizes absolute Windows drive and canonical UNC image sources", () => {
    expect(isAbsoluteWindowsLocalImageSource("C:/repo/translated%20pages/page.PNG")).toBe(true);
    expect(isAbsoluteWindowsLocalImageSource("/C:/Users/dev/Downloads/preview.gif")).toBe(true);
    expect(isAbsoluteWindowsLocalImageSource(String.raw`C:\repo\page.webp?cache=1`)).toBe(true);
    expect(
      isAbsoluteWindowsLocalImageSource(String.raw`\\media-server\translations\page 11.png`),
    ).toBe(true);
    expect(
      isAbsoluteWindowsLocalImageSource("%5C%5Cmedia-server%5Ctranslations%5Cpage%2011.png"),
    ).toBe(true);
    expect(isAbsoluteWindowsLocalImageSource("C:relative/page.png")).toBe(false);
    expect(isAbsoluteWindowsLocalImageSource("C:/repo/notes.md")).toBe(false);
  });

  it("recognizes absolute macOS and Linux image paths", () => {
    expect(isAbsolutePosixLocalImageSource("/Users/dev/project/page.png")).toBe(true);
    expect(isAbsolutePosixLocalImageSource("/home/dev/project/page%2007.webp?cache=1")).toBe(true);
    expect(isAbsolutePosixLocalImageSource("//cdn.example.com/page.png")).toBe(false);
    expect(isAbsolutePosixLocalImageSource("/home/dev/project/readme.md")).toBe(false);
    expect(resolveLocalImagePath("/home/dev/project/page%2007.webp", null)).toBe(
      "/home/dev/project/page 07.webp",
    );
  });

  it("does not mistake remote or protocol-relative images for local paths", () => {
    expect(isLocalImageSource("https://cdn.example.com/page.png")).toBe(false);
    expect(isLocalImageSource("http://cdn.example.com/page.png")).toBe(false);
    expect(isLocalImageSource("//cdn.example.com/page.png")).toBe(false);
    expect(isLocalImageSource("blob:https://example.com/id")).toBe(false);
    expect(isLocalImageSource("data:image/png;base64,YWJj")).toBe(false);
  });

  it("normalizes canonical and mixed-separator image file URLs", () => {
    expect(resolveLocalImageFileUrl("file:///C:/Users/dev/Pictures/page%2001.png")).toBe(
      "C:\\Users\\dev\\Pictures\\page 01.png",
    );
    expect(resolveLocalImageFileUrl(
      "file:///C:/%5CUsers%5Clemondoo%5CPictures%5CKimtoxic%5C%EC%9C%A0%EB%82%98%EB%9D%BC%20(01).png",
    )).toBe("C:\\Users\\lemondoo\\Pictures\\Kimtoxic\\유나라 (01).png");
    expect(isLocalImageSource("file:///C:/Users/dev/Pictures/page.png")).toBe(true);
    expect(resolveLocalImageFileUrl("file:///C:/Users/dev/Pictures/notes.txt")).toBeNull();
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

  it("resolves absolute paths independently of the current workspace", () => {
    expect(
      resolveLocalImagePath(
        "C:/Users/dev/Downloads/translated%20panels/page.png?cache=1",
        "C:\\Users\\dev\\PROJECTS\\current-repo",
      ),
    ).toBe("C:\\Users\\dev\\Downloads\\translated panels\\page.png");
    expect(resolveLocalImagePath("/C:/Users/dev/Downloads/preview.gif", null)).toBe(
      "C:\\Users\\dev\\Downloads\\preview.gif",
    );
    expect(
      resolveLocalImagePath("C:%5CUsers%5Cdev%5CDownloads%5Cpage%2007.png", null),
    ).toBe("C:\\Users\\dev\\Downloads\\page 07.png");
    expect(
      resolveLocalImagePath(
        "%5C%5Cmedia-server%5Ctranslations%5Ctranslated%20page.webp",
        null,
      ),
    ).toBe(String.raw`\\media-server\translations\translated page.webp`);
  });
});
