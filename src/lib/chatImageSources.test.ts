import { describe, expect, it } from "vitest";
import {
  createChatImageDescriptor,
  extractChatImagesFromPayload,
  isLikelyInlineImagePayload,
  redactChatImagePayload,
} from "./chatImageSources";

const PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

describe("chatImageSources", () => {
  it("normalizes local, remote, protocol-relative, and embedded sources", () => {
    expect(createChatImageDescriptor({
      origin: "markdown",
      source: "screenshots/page.png",
      workspaceRootPath: "C:\\repo",
    })?.filePath).toBe("C:\\repo\\screenshots\\page.png");

    expect(createChatImageDescriptor({
      origin: "generated",
      filePath: "generated/poster.png",
      workspaceRootPath: "C:\\repo",
    })?.filePath).toBe("C:\\repo\\generated\\poster.png");

    expect(createChatImageDescriptor({
      origin: "markdown",
      source: "/Users/dev/project/page.webp",
    })?.filePath).toBe("/Users/dev/project/page.webp");

    expect(createChatImageDescriptor({
      origin: "markdown",
      source: "file:///C:/%5CUsers%5Cdev%5CPictures%5Cpage%2001.png",
    })?.filePath).toBe("C:\\Users\\dev\\Pictures\\page 01.png");

    expect(createChatImageDescriptor({
      origin: "markdown",
      source: "//cdn.example.com/page.png",
    })?.sourceUrl).toBe("https://cdn.example.com/page.png");

    expect(createChatImageDescriptor({
      origin: "mcp",
      source: PNG_BASE64,
      mimeType: "image/png",
    })?.sourceUrl).toBe(`data:image/png;base64,${PNG_BASE64}`);

    const rawJpeg = `/9j/${"A".repeat(28)}`;
    expect(createChatImageDescriptor({
      origin: "generated",
      source: rawJpeg,
    })?.sourceUrl).toBe(`data:image/jpeg;base64,${rawJpeg}`);
  });

  it("prefers an image-generation saved path and retains the result as fallback", () => {
    const images = extractChatImagesFromPayload({
      id: "generated-1",
      type: "imageGeneration",
      status: "completed",
      result: `data:image/png;base64,${PNG_BASE64}`,
      savedPath: "C:\\workspace\\generated\\poster.png",
      revisedPrompt: "A blue poster",
    });

    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({
      origin: "generated",
      filePath: "C:\\workspace\\generated\\poster.png",
      sourceUrl: `data:image/png;base64,${PNG_BASE64}`,
      alt: "A blue poster",
    });
  });

  it("extracts image-view paths", () => {
    expect(extractChatImagesFromPayload({
      id: "view-1",
      type: "imageView",
      path: "C:\\workspace\\screenshots\\page.png",
    })).toEqual([
      expect.objectContaining({
        origin: "image-view",
        fileName: "page.png",
        filePath: "C:\\workspace\\screenshots\\page.png",
      }),
    ]);
  });

  it("extracts and deduplicates dynamic-tool image URLs", () => {
    const imageUrl = `data:image/png;base64,${PNG_BASE64}`;
    const images = extractChatImagesFromPayload({
      id: "dynamic-1",
      type: "dynamicToolCall",
      tool: "render",
      contentItems: [
        { type: "inputText", text: "done" },
        { type: "inputImage", imageUrl },
        { type: "inputImage", imageUrl },
      ],
    });

    expect(images).toHaveLength(1);
    expect(images[0]).toMatchObject({
      origin: "dynamic-tool",
      sourceUrl: imageUrl,
    });
  });

  it("extracts MCP images, embedded resources, and image resource links", () => {
    const images = extractChatImagesFromPayload({
      id: "mcp-1",
      type: "mcpToolCall",
      server: "design",
      tool: "render",
      result: {
        content: [
          { type: "text", text: "rendered" },
          { type: "image", data: PNG_BASE64, mimeType: "image/png" },
          {
            type: "resource",
            resource: {
              uri: "image://second",
              blob: PNG_BASE64.replace(/A/g, "B"),
              mimeType: "image/png",
            },
          },
          {
            type: "resource_link",
            uri: "https://cdn.example.com/third.webp",
            mimeType: "image/webp",
          },
        ],
      },
    });

    expect(images).toHaveLength(3);
    expect(images.map((image) => image.origin)).toEqual(["mcp", "mcp", "mcp"]);
    expect(images[2]?.sourceUrl).toBe("https://cdn.example.com/third.webp");
  });

  it("does not recursively reinterpret arbitrary text as image data", () => {
    expect(extractChatImagesFromPayload({
      type: "mcpToolCall",
      result: {
        content: [{ type: "text", text: PNG_BASE64 }],
        structuredContent: { prompt: PNG_BASE64 },
      },
    })).toEqual([]);
  });

  it("bounds traversal of oversized structured tool output", () => {
    const lateRecord = {} as Record<string, unknown>;
    Object.defineProperty(lateRecord, "type", {
      get: () => {
        throw new Error("late output should not be traversed");
      },
    });
    const content = Array.from({ length: 900 }, () => ({ type: "text", text: "ok" }));
    content.push(lateRecord as { type: string; text: string });

    expect(() => extractChatImagesFromPayload({
      type: "mcpToolCall",
      result: { content },
    })).not.toThrow();
  });

  it("identifies large inline image payloads without flagging ordinary output", () => {
    expect(isLikelyInlineImagePayload(`data:image/png;base64,${PNG_BASE64}`)).toBe(true);
    expect(isLikelyInlineImagePayload("A".repeat(256))).toBe(true);
    expect(isLikelyInlineImagePayload("normal command output")).toBe(false);
  });

  it("redacts embedded image bytes from expandable JSON details", () => {
    expect(redactChatImagePayload({
      result: `data:image/png;base64,${PNG_BASE64}`,
      nested: { imageUrl: "https://cdn.example.com/image.png" },
    })).toEqual({
      result: expect.stringContaining("embedded image data omitted"),
      nested: { imageUrl: "https://cdn.example.com/image.png" },
    });
  });
});
