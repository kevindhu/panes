#!/usr/bin/env node
import { execFileSync, execSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const contractPath = join(scriptDir, "codex-app-server-contract.json");

function parseArgs(argv) {
  const args = { schemaDir: null, keepSchema: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (arg === "--schema-dir") {
      args.schemaDir = argv[index + 1] ?? null;
      index += 1;
    } else if (arg === "--keep-schema") {
      args.keepSchema = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

function loadJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function requireFile(schemaRoot, relativePath) {
  const path = join(schemaRoot, relativePath);
  assert(existsSync(path), `Missing Codex app-server schema file: ${relativePath}`);
  return path;
}

function sorted(values) {
  return [...values].sort((left, right) => left.localeCompare(right));
}

function assertSameSet(actualValues, expectedValues, label) {
  const actual = new Set(actualValues);
  const expected = new Set(expectedValues);
  const missing = sorted([...expected].filter((value) => !actual.has(value)));
  const unexpected = sorted([...actual].filter((value) => !expected.has(value)));
  assert(
    missing.length === 0 && unexpected.length === 0,
    `${label} drifted. Missing: ${missing.join(", ") || "none"}. ` +
      `Unreviewed: ${unexpected.join(", ") || "none"}. ` +
      "Review the generated schema and update scripts/codex-app-server-contract.json.",
  );
}

function extractMethods(schema) {
  return (schema.oneOf ?? [])
    .flatMap((variant) => variant.properties?.method?.enum ?? [])
    .filter((method) => typeof method === "string");
}

function extractThreadItemTypes(threadReadSchema) {
  const variants = threadReadSchema.definitions?.ThreadItem?.oneOf;
  assert(Array.isArray(variants), "v2/ThreadReadResponse.json has no ThreadItem union");
  const types = variants.flatMap((variant) => variant.properties?.type?.enum ?? []);
  assert(types.every((value) => typeof value === "string"), "ThreadItem contains a non-string type");
  return types;
}

function assertContainsAll(actualValues, expectedValues, label) {
  const actual = new Set(actualValues);
  const missing = expectedValues.filter((value) => !actual.has(value));
  assert(missing.length === 0, `${label} is missing: ${missing.join(", ")}`);
}

function assertSourceContains(relativePath, tokens) {
  const source = readFileSync(join(repoRoot, relativePath), "utf8");
  for (const token of tokens) {
    assert(source.includes(token), `${relativePath} is missing required implementation token: ${token}`);
  }
}

function assertSourceExcludes(relativePath, tokens) {
  const source = readFileSync(join(repoRoot, relativePath), "utf8");
  for (const token of tokens) {
    assert(!source.includes(token), `${relativePath} still contains forbidden lossy path: ${token}`);
  }
}

function quoteCmdArgument(value) {
  return `"${String(value).replaceAll('"', '""')}"`;
}

function generateSchema(outputDirectory) {
  const args = ["app-server", "generate-json-schema", "--out", outputDirectory];
  if (process.platform === "win32") {
    // npm installs Codex as a .cmd shim on Windows. execFileSync cannot launch .cmd files
    // directly, while execSync intentionally resolves the shim through cmd.exe.
    execSync(["codex", ...args.map(quoteCmdArgument)].join(" "), { stdio: "pipe" });
    return;
  }
  execFileSync("codex", args, { stdio: "pipe" });
}

const args = parseArgs(process.argv.slice(2));
const contract = loadJson(contractPath);
let generatedDir = null;
let schemaRoot = args.schemaDir ? resolve(args.schemaDir) : null;

if (!schemaRoot) {
  generatedDir = mkdtempSync(join(tmpdir(), "panes-codex-schema-"));
  generateSchema(generatedDir);
  schemaRoot = generatedDir;
}

try {
  const threadRead = loadJson(requireFile(schemaRoot, join("v2", "ThreadReadResponse.json")));
  const serverNotifications = loadJson(requireFile(schemaRoot, "ServerNotification.json"));
  const serverRequests = loadJson(requireFile(schemaRoot, "ServerRequest.json"));

  const reviewedItemTypes = Object.keys(contract.threadItemTypes ?? {});
  for (const [itemType, projection] of Object.entries(contract.threadItemTypes ?? {})) {
    assert(
      projection === "specialized" || projection === "raw",
      `Invalid projection classification for ${itemType}: ${projection}`,
    );
  }

  assertSameSet(
    extractThreadItemTypes(threadRead),
    reviewedItemTypes,
    "Codex ThreadItem union",
  );
  assertContainsAll(
    extractMethods(serverNotifications),
    contract.requiredNotifications ?? [],
    "ServerNotification.json",
  );
  assertContainsAll(
    extractMethods(serverRequests),
    contract.requiredServerRequests ?? [],
    "ServerRequest.json",
  );

  for (const requiredPath of [
    join("v2", "ThreadStartParams.json"),
    join("v2", "ThreadResumeParams.json"),
    join("v2", "ThreadForkParams.json"),
    join("v2", "TurnStartParams.json"),
    join("v2", "TurnSteerParams.json"),
    join("v2", "TurnStartedNotification.json"),
    join("v2", "TurnCompletedNotification.json"),
    join("v2", "ThreadTokenUsageUpdatedNotification.json"),
    join("v2", "ItemStartedNotification.json"),
    join("v2", "ItemCompletedNotification.json"),
  ]) {
    requireFile(schemaRoot, requiredPath);
  }

  assertSourceContains("src-tauri/src/db/codex_transcript.rs", [
    "record_native_event_batch",
    "load_turn_snapshot",
    "params_json",
    "completed_json",
    "Codex item completion is authoritative",
  ]);
  assertSourceContains("src-tauri/src/engines/codex_transport.rs", [
    "is_lossless_conversation_signature",
    "CodexNativeEvent",
    "source_sequence",
    "capture_native_message",
  ]);
  assertSourceContains("src-tauri/src/engines/codex.rs", [
    "capture_response",
  ]);
  assertSourceExcludes("src-tauri/src/engines/codex_protocol.rs", [
    "parse_large_output_params",
    "parse_item_completed_params",
    "parse_trimmed_json_string",
  ]);
  assertSourceExcludes("src-tauri/src/engines/codex_transport.rs", [
    "trim_buffered_incoming_message",
    "trim_large_output_params",
  ]);

  console.log(
    `Codex app-server transcript contract passed (${reviewedItemTypes.length} item types): ${schemaRoot}`,
  );
} finally {
  if (generatedDir && !args.keepSchema) {
    rmSync(generatedDir, { recursive: true, force: true });
  } else if (generatedDir) {
    console.log(`Kept generated Codex schema at ${generatedDir}`);
  }
}
