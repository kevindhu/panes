import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const isWindows = process.platform === "win32";

export const repoRoot = path.resolve(scriptDir, "..", "..");

function detectPathKey(env) {
  if (!isWindows) {
    return "PATH";
  }

  return Object.keys(env).find((key) => key.toUpperCase() === "PATH") ?? "Path";
}

function uniquePathEntries(entries) {
  const seen = new Set();
  const normalizedEntries = [];

  for (const entry of entries) {
    if (!entry) {
      continue;
    }

    const normalizedKey = isWindows ? entry.toLowerCase() : entry;
    if (seen.has(normalizedKey)) {
      continue;
    }

    seen.add(normalizedKey);
    normalizedEntries.push(entry);
  }

  return normalizedEntries;
}

export function withToolchainPath(baseEnv = process.env) {
  const env = { ...baseEnv };
  const pathKey = detectPathKey(env);
  const existingPath = env[pathKey] ?? env.PATH ?? env.Path ?? "";
  const nextPath = uniquePathEntries([
    path.dirname(process.execPath),
    path.join(os.homedir(), ".cargo", "bin"),
    ...existingPath.split(path.delimiter),
  ]).join(path.delimiter);

  env[pathKey] = nextPath;
  env.PATH = nextPath;

  if (isWindows) {
    env.Path = nextPath;
  }

  return env;
}

function normalizeExitCode(code) {
  if (typeof code !== "number") {
    return null;
  }

  if (!isWindows) {
    return code;
  }

  return code | 0;
}

export function run(
  command,
  args,
  { cwd = repoRoot, env = process.env, shell = false, allowedExitCodes = [] } = {},
) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env,
      stdio: "inherit",
      shell,
      windowsHide: true,
    });

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      const normalizedCode = normalizeExitCode(code);
      const isAllowedExit =
        normalizedCode === 0 ||
        allowedExitCodes.includes(normalizedCode) ||
        (typeof code === "number" && allowedExitCodes.includes(code));

      if (isAllowedExit) {
        resolve();
        return;
      }

      const displayCode =
        typeof code === "number" && normalizedCode !== null && normalizedCode !== code
          ? `${normalizedCode} (${code})`
          : `${normalizedCode ?? code}`;

      reject(
        new Error(
          signal
            ? `${command} ${args.join(" ")} exited with signal ${signal}`
            : `${command} ${args.join(" ")} exited with code ${displayCode}`,
        ),
      );
    });
  });
}

function packageManagerInvocation(env = process.env) {
  const packageManagerExecPath =
    env.PANES_PACKAGE_MANAGER_EXEC_PATH ?? env.npm_execpath;

  if (packageManagerExecPath) {
    return {
      command: process.execPath,
      args: [packageManagerExecPath, "run"],
    };
  }

  const userAgent = env.npm_config_user_agent ?? "";

  if (userAgent.startsWith("npm/")) {
    return { command: isWindows ? "npm.cmd" : "npm", args: ["run"] };
  }

  if (userAgent.startsWith("pnpm/")) {
    return { command: isWindows ? "pnpm.cmd" : "pnpm", args: ["run"] };
  }

  if (userAgent.startsWith("yarn/")) {
    return { command: isWindows ? "yarn.cmd" : "yarn", args: ["run"] };
  }

  return { command: isWindows ? "pnpm.cmd" : "pnpm", args: ["run"] };
}

export async function runWorkspaceScript(
  scriptName,
  { args = [], env = withToolchainPath(), allowedExitCodes = [] } = {},
) {
  const invocation = packageManagerInvocation(env);
  const passthroughArgs = args.length > 0 ? ["--", ...args] : [];

  await run(
    invocation.command,
    [...invocation.args, scriptName, ...passthroughArgs],
    { env, allowedExitCodes },
  );
}
