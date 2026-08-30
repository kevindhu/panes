import { access, copyFile, mkdir } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import path from "node:path";
import process from "node:process";
import {
  repoRoot,
  run,
  withToolchainPath,
} from "./lib/workspace-runtime.mjs";

const srcTauriDir = path.join(repoRoot, "src-tauri");
const cargoCacheDir = path.join(srcTauriDir, "target-dev-cache");
const devConfigPath = path.join(srcTauriDir, "tauri.dev-build.conf.json");
const cachedExePath = path.join(cargoCacheDir, "debug", "Panes.exe");
const appDataDir = process.env.APPDATA;

function printUsage() {
  console.log("Usage: pnpm build:dev-exe -- [build-suffix]");
  console.log("Example: pnpm build:dev-exe -- 8-28-2");
  console.log("If omitted, today's month-day suffix is used with a numeric collision suffix.");
}

function normalizeSuffix(value) {
  const normalized = value
    .replace(/^target-build-/i, "")
    .replace(/^panes-/i, "");

  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(normalized)) {
    throw new Error(
      "Build suffix must contain only letters, numbers, dots, underscores, and hyphens.",
    );
  }

  return normalized;
}

async function pathExists(filePath) {
  try {
    await access(filePath, fsConstants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function defaultSuffix() {
  const now = new Date();
  return `${now.getMonth() + 1}-${now.getDate()}`;
}

function buildPaths(suffix, shortcutDir) {
  const buildDir = path.join(srcTauriDir, `target-build-${suffix}`);
  const exeDir = path.join(buildDir, "debug");

  return {
    buildDir,
    exeDir,
    exePath: path.join(exeDir, "Panes.exe"),
    shortcutPath: path.join(shortcutDir, `Panes-${suffix}.lnk`),
  };
}

async function chooseBuildSuffix(requestedSuffix, shortcutDir) {
  if (requestedSuffix) {
    const suffix = normalizeSuffix(requestedSuffix);
    const paths = buildPaths(suffix, shortcutDir);
    if ((await pathExists(paths.buildDir)) || (await pathExists(paths.shortcutPath))) {
      throw new Error(
        `Build ${suffix} already exists. Choose another suffix so older builds are preserved.`,
      );
    }
    return suffix;
  }

  const baseSuffix = defaultSuffix();
  let suffix = baseSuffix;
  let collisionNumber = 2;

  while (true) {
    const paths = buildPaths(suffix, shortcutDir);
    if (!(await pathExists(paths.buildDir)) && !(await pathExists(paths.shortcutPath))) {
      return suffix;
    }
    suffix = `${baseSuffix}-${collisionNumber}`;
    collisionNumber += 1;
  }
}

async function createShortcut({ exePath, exeDir, shortcutPath, suffix, env }) {
  const powershellPath = process.env.SystemRoot
    ? path.join(
        process.env.SystemRoot,
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      )
    : "powershell.exe";
  const shortcutEnv = {
    ...env,
    PANES_DEV_EXE_PATH: exePath,
    PANES_DEV_EXE_DIR: exeDir,
    PANES_DEV_SHORTCUT_PATH: shortcutPath,
    PANES_DEV_BUILD_SUFFIX: suffix,
  };
  const shortcutScript = [
    "$wsh = New-Object -ComObject WScript.Shell",
    "$shortcut = $wsh.CreateShortcut($env:PANES_DEV_SHORTCUT_PATH)",
    "$shortcut.TargetPath = $env:PANES_DEV_EXE_PATH",
    "$shortcut.WorkingDirectory = $env:PANES_DEV_EXE_DIR",
    "$shortcut.IconLocation = \"$($env:PANES_DEV_EXE_PATH),0\"",
    "$shortcut.Description = \"Panes development build $($env:PANES_DEV_BUILD_SUFFIX)\"",
    "$shortcut.Save()",
  ].join("; ");

  await run(
    powershellPath,
    ["-NoProfile", "-NonInteractive", "-Command", shortcutScript],
    { env: shortcutEnv },
  );
  await access(shortcutPath, fsConstants.F_OK);
}

const args = process.argv.slice(2).filter((arg) => arg !== "--");
if (args.includes("--help") || args.includes("-h")) {
  printUsage();
  process.exit(0);
}
if (args.length > 1) {
  printUsage();
  throw new Error("Expected at most one build suffix.");
}
if (process.platform !== "win32") {
  throw new Error("The development executable helper currently supports Windows only.");
}
if (!appDataDir) {
  throw new Error("APPDATA is required to create the Start Menu shortcut.");
}

const shortcutDir = path.join(
  appDataDir,
  "Microsoft",
  "Windows",
  "Start Menu",
  "Programs",
  "Panes Builds",
);
const suffix = await chooseBuildSuffix(args[0], shortcutDir);
const output = buildPaths(suffix, shortcutDir);
const buildEnv = withToolchainPath({
  ...process.env,
  CARGO_TARGET_DIR: cargoCacheDir,
});
const startedAt = Date.now();

console.log(`Building cached development executable Panes-${suffix}...`);
console.log(`Cargo cache: ${cargoCacheDir}`);

await run(
  process.execPath,
  [
    path.join(repoRoot, "scripts", "run-tauri.mjs"),
    "build",
    "--debug",
    "--no-bundle",
    "--features",
    "windowed-dev-exe",
    "--config",
    devConfigPath,
  ],
  { env: buildEnv },
);
await access(cachedExePath, fsConstants.F_OK);

await mkdir(output.exeDir, { recursive: true });
await copyFile(cachedExePath, output.exePath);
await mkdir(shortcutDir, { recursive: true });
await createShortcut({
  exePath: output.exePath,
  exeDir: output.exeDir,
  shortcutPath: output.shortcutPath,
  suffix,
  env: buildEnv,
});

const elapsedSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
console.log(`Development executable: ${output.exePath}`);
console.log(`Start Menu shortcut: ${output.shortcutPath}`);
console.log(`Completed in ${elapsedSeconds}s. No installer was generated.`);
