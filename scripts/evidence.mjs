import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import {
  assertSafeRepoPath,
  boolInput,
  cwdFromInput,
  ensureParent,
  input,
  output,
  parseList,
  summary
} from "./lib.mjs";

const cwd = cwdFromInput();
const workspace = process.cwd();
const mode = input("mode", "collect");
const manifestPath = normalizeRepoPath(input("manifest-path", ".async/evidence/manifest.json"), "manifest-path");
const summaryPath = normalizeRepoPath(input("summary-path", ".async/evidence/summary.md"), "summary-path");
const artifactName = input("artifact-name", "async-evidence").trim();
const ifNoFilesFound = input("if-no-files-found", "warn").trim();
const includeSummary = boolInput("include-summary", true);

if (!["collect", "upload", "merge"].includes(mode)) {
  throw new Error(`Unsupported evidence mode ${mode}. Use collect, upload, or merge.`);
}
if (!artifactName) throw new Error("artifact-name must be non-empty.");
if (!["ignore", "warn", "error"].includes(ifNoFilesFound)) {
  throw new Error("if-no-files-found must be ignore, warn, or error.");
}

let manifest;
if (mode === "collect") {
  manifest = collectManifest();
  writeManifest(manifest);
} else if (mode === "upload") {
  manifest = readManifest(manifestPath);
  if (includeSummary) writeSummary(manifest);
} else {
  manifest = mergeManifests();
  writeManifest(manifest);
}

const fileCount = Array.isArray(manifest.files) ? manifest.files.length : 0;
const byteCount = Array.isArray(manifest.files) ? manifest.files.reduce((total, file) => total + Number(file.bytes ?? 0), 0) : 0;
const uploadPaths = uploadPathList(manifest);

output("manifest-path", manifestPath);
output("artifact-name", artifactName);
output("file-count", String(fileCount));
output("byte-count", String(byteCount));
output("summary-path", includeSummary ? summaryPath : "");
output("artifact-paths", uploadPaths.join("\n"));

summary([
  "### async/actions/evidence",
  "",
  `- mode: ${mode}`,
  `- manifest: ${manifestPath}`,
  `- artifact: ${artifactName}`,
  `- files: ${fileCount}`,
  `- bytes: ${byteCount}`
].join("\n"));

function collectManifest() {
  const paths = parseList(input("paths", ".async/runs")).map((value, index) => normalizeRepoPath(value, `paths[${index}]`));
  const receiptPaths = parseList(input("receipt-paths", "")).map((value, index) => normalizeRepoPath(value, `receipt-paths[${index}]`));
  const files = collectFiles(paths);
  handleEmptyFiles(files, paths);
  const receipts = collectReceipts(receiptPaths);
  return {
    version: 1,
    id: manifestId(),
    repository: process.env.GITHUB_REPOSITORY ?? "",
    runId: process.env.GITHUB_RUN_ID ?? "",
    runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? "",
    job: process.env.GITHUB_JOB ?? "",
    sha: process.env.GITHUB_SHA ?? "",
    ref: process.env.GITHUB_REF ?? "",
    generatedBy: "async/actions/evidence",
    artifactName,
    createdAt: new Date().toISOString(),
    mode: "collect",
    files,
    receipts
  };
}

function mergeManifests() {
  const mergeDirectory = normalizeRepoPath(input("merge-directory", ".async/evidence/downloaded"), "merge-directory");
  const manifests = findManifestFiles(resolve(cwd, mergeDirectory))
    .map((path) => readJsonFile(path, "downloaded evidence manifest"));
  if (manifests.length === 0 && ifNoFilesFound === "error") {
    throw new Error(`No evidence manifests found under ${mergeDirectory}.`);
  }
  if (manifests.length === 0 && ifNoFilesFound === "warn") {
    console.warn(`No evidence manifests found under ${mergeDirectory}.`);
  }

  const seenIds = new Set();
  const files = [];
  const receipts = [];
  const manifestSummaries = [];
  for (const manifest of manifests) {
    validateManifestShape(manifest, "downloaded evidence manifest");
    if (seenIds.has(manifest.id)) {
      throw new Error(`Duplicate evidence manifest id ${manifest.id}.`);
    }
    seenIds.add(manifest.id);
    manifestSummaries.push({
      id: manifest.id,
      artifactName: manifest.artifactName,
      fileCount: manifest.files.length,
      byteCount: manifest.files.reduce((total, file) => total + Number(file.bytes ?? 0), 0)
    });
    for (const file of manifest.files) {
      files.push({ ...file, manifestId: manifest.id });
    }
    for (const receipt of manifest.receipts ?? []) {
      receipts.push({ ...receipt, manifestId: manifest.id });
    }
  }

  return {
    version: 1,
    id: manifestId(),
    repository: process.env.GITHUB_REPOSITORY ?? "",
    runId: process.env.GITHUB_RUN_ID ?? "",
    runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? "",
    job: process.env.GITHUB_JOB ?? "",
    sha: process.env.GITHUB_SHA ?? "",
    ref: process.env.GITHUB_REF ?? "",
    generatedBy: "async/actions/evidence",
    artifactName,
    createdAt: new Date().toISOString(),
    mode: "merge",
    manifests: manifestSummaries,
    files,
    receipts
  };
}

function collectFiles(patterns) {
  const byPath = new Map();
  for (const pattern of patterns) {
    for (const path of expandPattern(pattern)) {
      const relativePath = repoRelativePath(path);
      if (!byPath.has(relativePath)) {
        const stat = statSync(path);
        byPath.set(relativePath, {
          path: relativePath,
          kind: inferKind(relativePath),
          bytes: stat.size,
          sha256: sha256(path)
        });
      }
    }
  }
  return [...byPath.values()].sort((left, right) => left.path.localeCompare(right.path));
}

function expandPattern(pattern) {
  const absolute = resolve(cwd, pattern);
  if (!hasGlob(pattern)) {
    if (!existsSync(absolute)) return [];
    const stat = statSync(absolute);
    if (stat.isFile()) return [absolute];
    if (stat.isDirectory()) return walkFiles(absolute);
    return [];
  }

  const base = resolve(cwd, globBase(pattern));
  if (!existsSync(base)) return [];
  const matcher = globMatcher(pattern);
  return walkFiles(base).filter((path) => matcher(repoRelativePath(path)));
}

function collectReceipts(patterns) {
  const receipts = [];
  const seen = new Set();
  for (const path of collectFiles(patterns).map((file) => file.path)) {
    if (seen.has(path)) continue;
    seen.add(path);
    const value = readJsonFile(resolve(cwd, path), `receipt ${path}`);
    for (const receipt of sanitizeReceiptValue(value)) {
      receipts.push({ sourcePath: path, ...receipt });
    }
  }
  return receipts;
}

function sanitizeReceiptValue(value) {
  if (Array.isArray(value)) return value.flatMap(sanitizeReceiptValue);
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value.receipts)) return value.receipts.flatMap(sanitizeReceiptValue);

  const allowed = [
    "kind",
    "action",
    "id",
    "changeSetId",
    "leaseId",
    "leaseExpiresAt",
    "worker",
    "status",
    "repository",
    "commitSha",
    "pullRequestUrl",
    "branch",
    "baseBranch",
    "evidencePath",
    "bundlePath",
    "patchCount",
    "reportCount",
    "transcriptCount",
    "contextPackCount",
    "redacted",
    "changed",
    "path",
    "receiptPath",
    "skipped"
  ];
  const sanitized = {};
  for (const key of allowed) {
    const primitive = value[key];
    if (typeof primitive === "string" || typeof primitive === "number" || typeof primitive === "boolean") {
      sanitized[key] = primitive;
    }
  }
  if (!sanitized.kind) {
    sanitized.kind = sanitized.changeSetId || sanitized.leaseId ? "bridge" : "receipt";
  }
  if (Array.isArray(value.files)) {
    sanitized.files = value.files
      .filter((file) => file && typeof file === "object" && typeof file.path === "string")
      .map((file) => ({
        path: file.path,
        ...(typeof file.action === "string" ? { action: file.action } : {}),
        ...(typeof file.changed === "boolean" ? { changed: file.changed } : {})
      }));
  }
  return [sanitized];
}

function handleEmptyFiles(files, paths) {
  if (files.length > 0) return;
  const message = `No evidence files matched ${paths.join(", ")}.`;
  if (ifNoFilesFound === "error") throw new Error(message);
  if (ifNoFilesFound === "warn") console.warn(message);
}

function writeManifest(value) {
  const target = resolve(cwd, manifestPath);
  ensureParent(target);
  writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  if (includeSummary) writeSummary(value);
}

function writeSummary(value) {
  const target = resolve(cwd, summaryPath);
  ensureParent(target);
  const fileCount = Array.isArray(value.files) ? value.files.length : 0;
  const receiptCount = Array.isArray(value.receipts) ? value.receipts.length : 0;
  const sample = Array.isArray(value.files) ? value.files.slice(0, 20) : [];
  writeFileSync(target, [
    "# Async Evidence",
    "",
    `- manifest: ${manifestPath}`,
    `- artifact: ${value.artifactName ?? artifactName}`,
    `- files: ${fileCount}`,
    `- receipts: ${receiptCount}`,
    "",
    ...sample.map((file) => `- ${file.path} (${file.kind}, ${file.bytes} bytes)`)
  ].join("\n").trimEnd() + "\n", "utf8");
}

function uploadPathList(manifestValue) {
  const paths = new Set([manifestPath]);
  if (includeSummary) paths.add(summaryPath);
  if (mode === "collect") {
    for (const file of manifestValue.files ?? []) paths.add(file.path);
  }
  return [...paths].map((path) => workspaceRelativePath(resolve(cwd, path)));
}

function readManifest(path) {
  const manifest = readJsonFile(resolve(cwd, path), "evidence manifest");
  validateManifestShape(manifest, "evidence manifest");
  return manifest;
}

function validateManifestShape(value, label) {
  if (!value || typeof value !== "object" || value.version !== 1 || typeof value.id !== "string" || !Array.isArray(value.files)) {
    throw new Error(`${label} must be a version 1 manifest with id and files.`);
  }
}

function findManifestFiles(root) {
  if (!existsSync(root)) return [];
  return walkFiles(root)
    .filter((path) => path.endsWith(".json"))
    .filter((path) => {
      try {
        const value = readJsonFile(path, "candidate manifest");
        return value?.version === 1 && value?.generatedBy === "async/actions/evidence";
      } catch {
        return false;
      }
    })
    .sort((left, right) => left.localeCompare(right));
}

function readJsonFile(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Invalid ${label}: ${error.message}`);
  }
}

function walkFiles(root) {
  if (!existsSync(root)) return [];
  const stat = statSync(root);
  if (stat.isFile()) return [root];
  if (!stat.isDirectory()) return [];
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))) {
    const path = resolve(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkFiles(path));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}

function normalizeRepoPath(value, label) {
  const normalized = value.replace(/\\/gu, "/").replace(/^\.\//u, "");
  assertSafeRepoPath(normalized, { allowWorkflowPaths: false });
  return normalized;
}

function repoRelativePath(path) {
  const relativePath = relative(cwd, path).split(sep).join("/");
  if (!relativePath || relativePath.startsWith("../") || relativePath === "..") {
    throw new Error(`Evidence path ${path} is outside the working directory.`);
  }
  return relativePath;
}

function workspaceRelativePath(path) {
  const relativePath = relative(workspace, path).split(sep).join("/");
  if (!relativePath || relativePath.startsWith("../") || relativePath === "..") {
    return path;
  }
  return relativePath;
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function inferKind(path) {
  if (path.endsWith("summary.md")) return "run-summary";
  if (path.includes("/cache/") && path.endsWith(".json")) return "cache-receipt";
  if (path.includes("/receipts/") && path.endsWith(".json")) return "receipt";
  if (path.startsWith(".async/runs/")) return "run-evidence";
  if (path.endsWith(".tgz")) return "package";
  if (path.endsWith(".json")) return "json";
  return "file";
}

function manifestId() {
  return [
    process.env.GITHUB_REPOSITORY || "local",
    process.env.GITHUB_RUN_ID || String(process.pid),
    process.env.GITHUB_RUN_ATTEMPT || "0",
    process.env.GITHUB_JOB || "local",
    artifactName
  ].join(":");
}

function hasGlob(pattern) {
  return pattern.includes("*");
}

function globBase(pattern) {
  const index = pattern.indexOf("*");
  const prefix = pattern.slice(0, index);
  const slash = prefix.lastIndexOf("/");
  return slash < 0 ? "." : prefix.slice(0, slash) || ".";
}

function globMatcher(pattern) {
  let source = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*" && pattern[index + 1] === "*" && pattern[index + 2] === "/") {
      source += "(?:.*/)?";
      index += 2;
      continue;
    }
    if (character === "*" && pattern[index + 1] === "*") {
      source += ".*";
      index += 1;
      continue;
    }
    if (character === "*") {
      source += "[^/]*";
      continue;
    }
    source += /[.+?^${}()|[\]\\]/u.test(character) ? `\\${character}` : character;
  }
  source += "$";
  const regex = new RegExp(source, "u");
  return regex.test.bind(regex);
}
