import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("image asset protocol configuration", () => {
  it("keeps the scoped Tauri asset protocol enabled at runtime and compile time", () => {
    const tauriConfig = JSON.parse(
      readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"),
    ) as {
      app?: {
        security?: {
          assetProtocol?: {
            enable?: boolean;
            scope?: unknown[];
          };
        };
      };
    };
    const cargoManifest = readFileSync(
      new URL("../src-tauri/Cargo.toml", import.meta.url),
      "utf8",
    );

    expect(tauriConfig.app?.security?.assetProtocol).toEqual({
      enable: true,
      scope: [],
    });
    expect(cargoManifest).toMatch(
      /tauri\s*=\s*\{[^\n]*features\s*=\s*\[[^\]]*"protocol-asset"/,
    );
  });
});
