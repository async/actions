import { createHash } from "node:crypto";
import { existsSync, statSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import {
  boolInput,
  cwdFromInput,
  ensureParent,
  input,
  normalizeRepoPath,
  output,
  readJson,
  resolveRepoPath,
  summary
} from "./lib.mjs";

const cwd = cwdFromInput();
const mode = input("mode", "restore").trim();
const trust = input("trust", "read-only").trim();
const phase = process.env.ASYNC_ACTIONS_CACHE_PHASE ?? "plan";
const manifestPath = normalizeRepoPath(input("manifest", ".async/actions/cache/cache-manifest.json"), "manifest");
const manifest = readCacheManifest(manifestPath);

if (!["restore", "save", "summary"].includes(mode)) {
  throw new Error(`Unsupported cache mode ${mode}. Use restore, save, or summary.`);
}
if (trust !== "read-only" && trust !== "read-write") {
  throw new Error(`Unsupported cache trust ${trust}. Use read-only or read-write.`);
}
if (mode === "save" && trust !== "read-write" && phase === "plan") {
  console.log("Async task cache save skipped because trust is read-only.");
}

if (phase === "plan") {
  runPlanPhase();
} else if (phase === "receipt") {
  runReceiptPhase();
} else {
  throw new Error(`Unsupported cache phase ${phase}.`);
}

function runPlanPhase() {
  const plan = actionCachePlan();
  output("primary-key", plan.primaryKey);
  output("restore-keys", plan.restoreKeys.join("\n"));
  output("paths", plan.paths.join("\n"));
  output("cache-hit", "false");
  output("entry-count", String(manifest.entries.length));

  if (mode === "summary") {
    const receiptPath = writeReceipt({
      action: "summary",
      status: "summarized",
      cacheHit: false,
      restoredCount: 0,
      savedCount: 0
    });
    output("receipt-path", receiptPath);
    writeCacheSummary("summary", { receiptPath, paths: plan.paths.length });
  }
}

function runReceiptPhase() {
  const plan = actionCachePlan();
  const cacheHit = process.env.ASYNC_ACTIONS_CACHE_HIT === "true";
  const saveOutcome = process.env.ASYNC_ACTIONS_CACHE_SAVE_OUTCOME ?? "";
  const writeAllowedEntries = manifest.entries.filter((entry) => entry.writeAllowed);
  const savedCount = mode === "save" && trust === "read-write" && saveOutcome !== "skipped"
    ? writeAllowedEntries.length
    : 0;
  const restoredCount = mode === "restore" && cacheHit ? manifest.entries.length : 0;
  const skipped = mode === "save" && trust !== "read-write";
  const status = mode === "restore"
    ? (cacheHit ? "hit" : "miss")
    : mode === "save"
      ? (skipped ? "skipped" : "saved")
      : "summarized";

  if (mode === "restore" && !cacheHit && boolInput("fail-on-miss", false)) {
    const receiptPath = writeReceipt({
      action: "restore",
      status: "miss",
      cacheHit: false,
      restoredCount,
      savedCount: 0,
      reason: "cache miss and fail-on-miss=true"
    });
    output("receipt-path", receiptPath);
    throw new Error("Async task cache restore missed and fail-on-miss=true.");
  }

  const receiptPath = writeReceipt({
    action: mode,
    status,
    cacheHit,
    restoredCount,
    savedCount,
    skipped,
    reason: skipped ? "read-only trust cannot save caches" : undefined
  });
  output("cache-hit", cacheHit ? "true" : "false");
  output("restored-count", String(restoredCount));
  output("saved-count", String(savedCount));
  output("receipt-path", receiptPath);
  writeCacheSummary(mode, { receiptPath, restoredCount, savedCount, paths: plan.paths.length, cacheHit, skipped });
}

function readCacheManifest(path) {
  const value = readJson(resolveRepoPath(cwd, path, "manifest"));
  validateManifest(value);
  return value;
}

function validateManifest(value) {
  if (!value || typeof value !== "object" || value.version !== 1) {
    throw new Error("cache manifest must be an object with version: 1.");
  }
  if (value.generatedBy !== "@async/pipeline") {
    throw new Error("cache manifest generatedBy must be @async/pipeline.");
  }
  if (typeof value.job !== "string" || !value.job.trim()) {
    throw new Error("cache manifest job must be a non-empty string.");
  }
  if (value.trust !== undefined && value.trust !== "read-only" && value.trust !== "read-write") {
    throw new Error("cache manifest trust must be read-only or read-write.");
  }
  if (!Array.isArray(value.entries)) {
    throw new Error("cache manifest entries must be an array.");
  }
  if (value.primaryKey !== undefined && !safeCacheKey(value.primaryKey)) {
    throw new Error("cache manifest primaryKey is not safe.");
  }
  if (value.restoreKeys !== undefined && !Array.isArray(value.restoreKeys)) {
    throw new Error("cache manifest restoreKeys must be an array.");
  }
  for (const restoreKey of value.restoreKeys ?? []) {
    if (!safeCacheKey(restoreKey)) throw new Error("cache manifest restoreKeys contain an unsafe key.");
  }

  const ids = new Set();
  for (const [index, entry] of value.entries.entries()) {
    validateEntry(entry, index, ids);
  }
}

function validateEntry(entry, index, ids) {
  if (!entry || typeof entry !== "object") throw new Error(`cache manifest entry ${index} must be an object.`);
  for (const field of ["id", "task", "key"]) {
    if (typeof entry[field] !== "string" || !entry[field].trim()) {
      throw new Error(`cache manifest entry ${index} ${field} must be a non-empty string.`);
    }
  }
  if (ids.has(entry.id)) throw new Error(`cache manifest entry id ${entry.id} is duplicated.`);
  ids.add(entry.id);
  if (!safeCacheKey(entry.key)) throw new Error(`cache manifest entry ${entry.id} key is not safe.`);
  if (!Array.isArray(entry.paths) || entry.paths.length === 0) {
    throw new Error(`cache manifest entry ${entry.id} paths must be a non-empty array.`);
  }
  for (const path of entry.paths) {
    normalizeRepoPath(path, `cache manifest entry ${entry.id} path`);
  }
  if (!Array.isArray(entry.restoreKeys)) throw new Error(`cache manifest entry ${entry.id} restoreKeys must be an array.`);
  for (const restoreKey of entry.restoreKeys) {
    if (!safeCacheKey(restoreKey)) throw new Error(`cache manifest entry ${entry.id} restore key is not safe.`);
  }
  if (typeof entry.writeAllowed !== "boolean") {
    throw new Error(`cache manifest entry ${entry.id} writeAllowed must be boolean.`);
  }
}

function actionCachePlan() {
  const entries = mode === "save"
    ? manifest.entries.filter((entry) => trust === "read-write" && entry.writeAllowed)
    : manifest.entries;
  const paths = [...new Set(entries.flatMap((entry) => entry.paths))]
    .map((path) => normalizeRepoPath(path, "cache path"))
    .sort();
  const entryKeys = entries.map((entry) => entry.key).sort();
  const primaryKey = manifest.primaryKey ?? `async-pipeline-${runnerScope()}-${sha256(JSON.stringify(entryKeys)).slice(0, 32)}`;
  const restoreKeys = (manifest.restoreKeys ?? [...new Set(entries.flatMap((entry) => entry.restoreKeys))])
    .filter((key) => key !== primaryKey)
    .sort();
  return { primaryKey, restoreKeys, paths };
}

function writeReceipt(details) {
  const receiptPath = receiptPathFor(details.action);
  const files = manifest.entries.flatMap((entry) => entry.paths.map((path) => fileEntry(path, details.action)));
  const receipt = {
    schemaVersion: 1,
    kind: "cache",
    action: details.action,
    status: details.status,
    job: manifest.job,
    trust,
    manifest: manifestPath,
    primaryKey: manifest.primaryKey ?? actionCachePlan().primaryKey,
    entries: manifest.entries.map((entry) => ({
      id: entry.id,
      task: entry.task,
      key: entry.key,
      paths: entry.paths,
      writeAllowed: entry.writeAllowed
    })),
    cacheHit: details.cacheHit,
    restoredCount: details.restoredCount,
    savedCount: details.savedCount,
    skipped: details.skipped ?? false,
    ...(details.reason ? { reason: details.reason } : {}),
    files,
    recordedAt: new Date().toISOString()
  };
  const absolute = resolveRepoPath(cwd, receiptPath, "receipt-path");
  ensureParent(absolute);
  writeFileSync(absolute, `${JSON.stringify(receipt, null, 2)}\n`);
  return receiptPath;
}

function receiptPathFor(action) {
  const requested = input("receipt-path", "").trim();
  if (requested) return normalizeRepoPath(requested, "receipt-path");
  return `.async/actions/receipts/cache-${safeFileName(manifest.job)}-${action}.json`;
}

function fileEntry(path, action) {
  const absolute = resolve(cwd, path);
  const relativePath = relative(cwd, absolute);
  let size = 0;
  let exists = false;
  try {
    const fileStat = statSync(absolute);
    exists = fileStat.isDirectory() || fileStat.isFile();
    size = fileStat.size;
  } catch {
    exists = false;
  }
  return { path: relativePath || path, action, changed: false, exists, size };
}

function writeCacheSummary(action, details) {
  const summaryPath = `.async/actions/cache/${safeFileName(manifest.job)}-${action}-summary.md`;
  const absolute = resolveRepoPath(cwd, summaryPath, "summary-path");
  ensureParent(absolute);
  const body = [
    `# Async task cache ${action}`,
    "",
    `- job: ${manifest.job}`,
    `- trust: ${trust}`,
    `- entries: ${manifest.entries.length}`,
    `- paths: ${details.paths ?? 0}`,
    ...(details.cacheHit === undefined ? [] : [`- cache hit: ${details.cacheHit ? "true" : "false"}`]),
    ...(details.restoredCount === undefined ? [] : [`- restored: ${details.restoredCount}`]),
    ...(details.savedCount === undefined ? [] : [`- saved: ${details.savedCount}`]),
    ...(details.skipped ? ["- skipped: true"] : []),
    `- receipt: ${details.receiptPath}`
  ].join("\n");
  writeFileSync(absolute, `${body}\n`);
  output("summary-path", summaryPath);
  summary(body);
}

function safeCacheKey(value) {
  return typeof value === "string" && /^[A-Za-z0-9_.:/|+=,@-]+$/u.test(value) && !value.includes("..") && value.length <= 512;
}

function safeFileName(value) {
  return String(value).replaceAll(/[^a-zA-Z0-9._-]/g, "_");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function runnerScope() {
  return (process.env.RUNNER_OS || process.platform || "unknown").toLowerCase().replaceAll(/[^a-z0-9_-]/g, "-");
}
