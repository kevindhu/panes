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

export function run(
  command,
  args,
  { cwd = repoRoot, env = process.env, shell = isWindows } = {},
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
      if (code === 0) {
        resolve();
        return;
      }

      reject(
        new Error(
          signal
            ? `${command} ${args.join(" ")} exited with signal ${signal}`
            : `${command} ${args.join(" ")} exited with code ${code}`,
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
    return { command: "npm", args: ["run"] };
  }

  if (userAgent.startsWith("pnpm/")) {
    return { command: "pnpm", args: ["run"] };
  }

  if (userAgent.startsWith("yarn/")) {
    return { command: "yarn", args: ["run"] };
  }

  return { command: "pnpm", args: ["run"] };
}

export async function runWorkspaceScript(
  scriptName,
  { args = [], env = withToolchainPath() } = {},
) {
  const invocation = packageManagerInvocation(env);
  const passthroughArgs = args.length > 0 ? ["--", ...args] : [];

  await run(
    invocation.command,
    [...invocation.args, scriptName, ...passthroughArgs],
    { env },
  );
}
