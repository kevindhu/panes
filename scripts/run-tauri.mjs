import path from "node:path";
import { repoRoot, run, withToolchainPath } from "./lib/workspace-runtime.mjs";

const tauriCliEntryPoint = path.join(
  repoRoot,
  "node_modules",
  "@tauri-apps",
  "cli",
  "tauri.js",
);

const args = process.argv.slice(2);
const env = withToolchainPath({
  ...process.env,
  PANES_PACKAGE_MANAGER_EXEC_PATH:
    process.env.PANES_PACKAGE_MANAGER_EXEC_PATH ?? process.env.npm_execpath ?? "",
});

await run(process.execPath, [tauriCliEntryPoint, ...args], { env });
