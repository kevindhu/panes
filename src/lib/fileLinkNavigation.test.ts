import { beforeEach, describe, expect, it, vi } from "vitest";

const mockOpenExternal = vi.hoisted(() => vi.fn());
const mockOpenPathWithDefaultApp = vi.hoisted(() => vi.fn());
const mockToastError = vi.hoisted(() => vi.fn());
const mockWorkspaceState = vi.hoisted(() => ({
  activeWorkspaceId: "ws-1",
  activeRepoId: "repo-1",
  workspaces: [
    {
      id: "ws-1",
      name: "Workspace",
      rootPath: "/workspace",
      scanDepth: 4,
      createdAt: "",
      lastOpenedAt: "",
    },
  ],
  repos: [
    {
      id: "repo-1",
      workspaceId: "ws-1",
      name: "app",
      path: "/workspace/apps/app",
      defaultBranch: "main",
      isActive: true,
      trustLevel: "trusted" as const,
    },
    {
      id: "repo-2",
      workspaceId: "ws-1",
      name: "nested",
      path: "/workspace/apps/app/packages/web",
      defaultBranch: "main",
      isActive: true,
      trustLevel: "trusted" as const,
    },
  ],
}));

vi.mock("@tauri-apps/plugin-shell", () => ({
  open: mockOpenExternal,
}));

vi.mock("./codexIpc", () => ({
  ipc: {
    openPathWithDefaultApp: mockOpenPathWithDefaultApp,
  },
}));

vi.mock("../stores/workspaceStore", () => ({
  useWorkspaceStore: {
    getState: () => mockWorkspaceState,
  },
}));

vi.mock("../stores/toastStore", () => ({
  toast: {
    error: mockToastError,
  },
}));

import {
  classifyLinkTarget,
  extractTextLinkMatches,
  navigateLinkTarget,
  resolveLocalFileLinkPath,
} from "./fileLinkNavigation";

describe("fileLinkNavigation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockWorkspaceState.activeWorkspaceId = "ws-1";
    mockWorkspaceState.activeRepoId = "repo-1";
    mockWorkspaceState.workspaces = [
      {
        id: "ws-1",
        name: "Workspace",
        rootPath: "/workspace",
        scanDepth: 4,
        createdAt: "",
        lastOpenedAt: "",
      },
    ];
    mockWorkspaceState.repos = [
      {
        id: "repo-1",
        workspaceId: "ws-1",
        name: "app",
        path: "/workspace/apps/app",
        defaultBranch: "main",
        isActive: true,
        trustLevel: "trusted",
      },
      {
        id: "repo-2",
        workspaceId: "ws-1",
        name: "nested",
        path: "/workspace/apps/app/packages/web",
        defaultBranch: "main",
        isActive: true,
        trustLevel: "trusted",
      },
    ];
    mockOpenExternal.mockResolvedValue(undefined);
    mockOpenPathWithDefaultApp.mockResolvedValue(undefined);
  });

  it("resolves absolute POSIX paths with hash and suffix line references", () => {
    expect(
      resolveLocalFileLinkPath("/workspace/apps/app/src/main.ts#L12", {
        workspaceRoot: "/workspace",
        repos: [{ id: "repo-1", path: "/workspace/apps/app" }],
      }),
    ).toBe("/workspace/apps/app/src/main.ts");

    expect(
      resolveLocalFileLinkPath("/workspace/apps/app/src/main.ts:44:7", {
        workspaceRoot: "/workspace",
        repos: [{ id: "repo-1", path: "/workspace/apps/app" }],
      }),
    ).toBe("/workspace/apps/app/src/main.ts");
  });

  it("resolves file URLs with encoded spaces", () => {
    expect(
      resolveLocalFileLinkPath("file:///workspace/apps/app/docs/My%20File.md#L9", {
        workspaceRoot: "/workspace",
        repos: [{ id: "repo-1", path: "/workspace/apps/app" }],
      }),
    ).toBe("/workspace/apps/app/docs/My File.md");
  });

  it("ignores malformed percent-encoding in file URLs", () => {
    expect(
      resolveLocalFileLinkPath("file:///workspace/apps/app/docs/%ZZ.md#L9", {
        workspaceRoot: "/workspace",
        repos: [{ id: "repo-1", path: "/workspace/apps/app" }],
      }),
    ).toBeNull();

    expect(classifyLinkTarget("file:///workspace/apps/app/docs/%ZZ.md#L9")).toBe("other");
    expect(() =>
      extractTextLinkMatches(
        "bad file:///workspace/apps/app/docs/%ZZ.md should not break parsing",
      ),
    ).not.toThrow();
    expect(
      extractTextLinkMatches(
        "bad file:///workspace/apps/app/docs/%ZZ.md should not break parsing",
      ),
    ).toEqual([]);
  });

  it("resolves Windows absolute paths and file URLs", () => {
    expect(
      resolveLocalFileLinkPath("C:\\Users\\dev\\repo\\src\\app.ts:7:3", {
        workspaceRoot: "C:/Users/dev",
        repos: [{ id: "repo-1", path: "C:/Users/dev/repo" }],
      }),
    ).toBe("C:/Users/dev/repo/src/app.ts");

    expect(
      resolveLocalFileLinkPath("file:///C:/Users/dev/repo/src/app.ts#L11", {
        workspaceRoot: "C:/Users/dev",
        repos: [{ id: "repo-1", path: "C:/Users/dev/repo" }],
      }),
    ).toBe("C:/Users/dev/repo/src/app.ts");

    expect(
      resolveLocalFileLinkPath("C:/Users/dev/repo/My%20File.md#L13", {
        workspaceRoot: "C:/Users/dev",
        repos: [{ id: "repo-1", path: "C:/Users/dev/repo" }],
      }),
    ).toBe("C:/Users/dev/repo/My File.md");
  });

  it("ignores malformed percent-encoding in absolute paths", () => {
    expect(classifyLinkTarget("C:/Users/dev/repo/%ZZ.md")).toBe("other");
  });

  it("resolves absolute paths inside repositories and the workspace root", () => {
    expect(
      resolveLocalFileLinkPath("/workspace/apps/app/packages/web/src/page.tsx#L5", {
        workspaceRoot: "/workspace",
        repos: [
          { id: "repo-1", path: "/workspace/apps/app" },
          { id: "repo-2", path: "/workspace/apps/app/packages/web" },
        ],
        activeRepoId: "repo-1",
      }),
    ).toBe("/workspace/apps/app/packages/web/src/page.tsx");

    expect(
      resolveLocalFileLinkPath("/workspace/README.md#L2", {
        workspaceRoot: "/workspace",
        repos: [{ id: "repo-1", path: "/workspace/apps/app" }],
      }),
    ).toBe("/workspace/README.md");
  });

  it("resolves repo-relative file references against the active repo first", () => {
    expect(
      resolveLocalFileLinkPath("src/main.ts:44:7", {
        workspaceRoot: "/workspace",
        repos: [
          { id: "repo-1", path: "/workspace/apps/app", isActive: true },
          { id: "repo-2", path: "/workspace/apps/app/packages/web", isActive: true },
        ],
        activeRepoId: "repo-1",
      }),
    ).toBe("/workspace/apps/app/src/main.ts");

    expect(
      resolveLocalFileLinkPath("./README.md#L12", {
        workspaceRoot: "/workspace",
        repos: [{ id: "repo-1", path: "/workspace/apps/app", isActive: true }],
        activeRepoId: "repo-1",
      }),
    ).toBe("/workspace/apps/app/README.md");

    expect(
      resolveLocalFileLinkPath(".gitignore", {
        workspaceRoot: "/workspace",
        repos: [{ id: "repo-1", path: "/workspace/apps/app", isActive: true }],
        activeRepoId: "repo-1",
      }),
    ).toBe("/workspace/apps/app/.gitignore");
  });

  it("rejects paths outside the active workspace and classifies external URLs", () => {
    expect(
      resolveLocalFileLinkPath("/other/place/file.ts#L1", {
        workspaceRoot: "/workspace",
        repos: [{ id: "repo-1", path: "/workspace/apps/app" }],
      }),
    ).toBeNull();

    expect(classifyLinkTarget("https://example.com")).toBe("external");
    expect(classifyLinkTarget("/workspace/apps/app/src/main.ts#L1")).toBe("local");
    expect(classifyLinkTarget("src/main.ts#L1")).toBe("local");
    expect(classifyLinkTarget("#heading")).toBe("other");
  });

  it("extracts plain-text links for absolute paths, relative paths, hashes and URLs", () => {
    expect(
      extractTextLinkMatches("- /workspace/apps/app/src/main.ts:44:7"),
    ).toEqual([
      {
        text: "/workspace/apps/app/src/main.ts:44:7",
        startIndex: 2,
        endIndex: 38,
        kind: "local",
      },
    ]);

    expect(
      extractTextLinkMatches("see /workspace/apps/app/src/main.ts#L12 and https://example.com/docs."),
    ).toEqual([
      {
        text: "/workspace/apps/app/src/main.ts#L12",
        startIndex: 4,
        endIndex: 39,
        kind: "local",
      },
      {
        text: "https://example.com/docs",
        startIndex: 44,
        endIndex: 68,
        kind: "external",
      },
    ]);

    expect(
      extractTextLinkMatches("relative src/App.tsx should now link"),
    ).toEqual([
      {
        text: "src/App.tsx",
        startIndex: 9,
        endIndex: 20,
        kind: "local",
      },
    ]);

    expect(extractTextLinkMatches("ignore example.com and version 1.2.3")).toEqual([]);
  });

  it("opens local links with the system default app", async () => {
    await expect(navigateLinkTarget("/workspace/apps/app/src/main.ts#L12C4"))
      .resolves.toBe("system");

    expect(mockOpenPathWithDefaultApp).toHaveBeenCalledWith(
      "/workspace/apps/app/src/main.ts",
    );
  });

  it("opens repo-relative local links against the active repo", async () => {
    await expect(navigateLinkTarget("src/main.ts:12:4"))
      .resolves.toBe("system");

    expect(mockOpenPathWithDefaultApp).toHaveBeenCalledWith(
      "/workspace/apps/app/src/main.ts",
    );
  });

  it("opens external links through the system shell", async () => {
    await expect(navigateLinkTarget("https://example.com/docs"))
      .resolves.toBe("external");

    expect(mockOpenExternal).toHaveBeenCalledWith("https://example.com/docs");
  });

  it("hands absolute local links outside the workspace to the system default app", async () => {
    await expect(navigateLinkTarget("/other/place/demo.mp4"))
      .resolves.toBe("system");

    expect(mockOpenPathWithDefaultApp).toHaveBeenCalledWith("/other/place/demo.mp4");
  });

  it("decodes the exact Markdown-encoded folder link before opening it", async () => {
    await expect(
      navigateLinkTarget(
        "C:/Users/lemondoo/Documents/Panes%20Memory%20Leak%20Investigation%202026-08-29",
      ),
    ).resolves.toBe("system");

    expect(mockOpenPathWithDefaultApp).toHaveBeenCalledWith(
      "C:/Users/lemondoo/Documents/Panes Memory Leak Investigation 2026-08-29",
    );
  });

  it("shows a short error toast when a local link no longer exists", async () => {
    mockOpenPathWithDefaultApp.mockRejectedValue(new Error("path does not exist"));

    await expect(navigateLinkTarget("C:/Users/dev/old-folder")).resolves.toBe("ignored");

    expect(mockToastError).toHaveBeenCalledWith("That file or folder no longer exists.");
  });
});
