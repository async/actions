import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { boolInput, cwdFromInput, input, output, parseList, resolveRepoPath, summary } from "./lib.mjs";

const cwd = cwdFromInput();
const mode = input("mode", "collect");
const runDirectory = input("run-directory", ".async/runs");
const explicitOutputs = parseList(input("outputs", ""));
const evidencePath = input("evidence-path", ".async/agent-evidence/manifest.json");
const bundlePath = input("bundle-path", ".async/agent-evidence/bundle.json");
const receiptPath = input("receipt-path", ".async/actions/receipts/agent-evidence.json");
const shouldComment = boolInput("comment", false) || mode === "comment";
const commentMarker = input("comment-marker", "async-agent-evidence");
const maxBytes = positiveInt(input("max-bytes", "20000"), 20000);

const SECRET_PATTERNS = [
  { name: "private key", regex: /-----BEGIN [A-Z ]*PRIVATE KEY-----/u },
  { name: "GitHub token", regex: /\b(?:ghp|github_pat)_[A-Za-z0-9_]{20,}\b/u },
  { name: "OpenAI-style key", regex: /\bsk-[A-Za-z0-9_-]{20,}\b/u },
  { name: "named secret", regex: /\b(?:secret|token|password|api[_-]?key)\b\s*[:=]\s*["']?[A-Za-z0-9_./+=-]{16,}/iu }
];

if (!["collect", "redact", "comment", "bundle"].includes(mode)) {
  throw new Error(`Unsupported agent evidence mode ${mode}. Use collect, redact, comment, or bundle.`);
}

const manifest = buildManifest();
validateRedaction(manifest.files);
writeJson(evidencePath, manifest);
writeJson(bundlePath, bundleFromManifest(manifest));
writeJson(receiptPath, receiptFromManifest(manifest));

output("evidence-path", evidencePath);
output("bundle-path", bundlePath);
output("patch-count", String(manifest.counts.patches));
output("report-count", String(manifest.counts.reports));
output("redacted", "true");
if (shouldComment) {
  output("comment-body", renderComment(manifest));
  output("comment-marker", commentMarker);
}

summary([
  "### async/actions/agent-evidence",
  "",
  `- mode: ${mode}`,
  `- files: ${manifest.files.length}`,
  `- patches: ${manifest.counts.patches}`,
  `- reports: ${manifest.counts.reports}`,
  `- transcripts: ${manifest.counts.transcripts}`,
  `- context packs: ${manifest.counts.contextPacks}`,
  `- bundle: ${bundlePath}`
].join("\n"));

function buildManifest() {
  const files = [...collectRunFiles(), ...collectExplicitOutputs()];
  const unique = new Map();
  for (const file of files) {
    if (!unique.has(file.path)) unique.set(file.path, file);
  }
  const sorted = [...unique.values()].sort((left, right) => left.path.localeCompare(right.path));
  return {
    version: 1,
    id: manifestId(),
    generatedBy: "async/actions/agent-evidence",
    mode,
    repository: process.env.GITHUB_REPOSITORY ?? "",
    runId: process.env.GITHUB_RUN_ID ?? "",
    runAttempt: process.env.GITHUB_RUN_ATTEMPT ?? "",
    job: process.env.GITHUB_JOB ?? "",
    sha: process.env.GITHUB_SHA ?? "",
    ref: process.env.GITHUB_REF ?? "",
    createdAt: new Date().toISOString(),
    runDirectory,
    evidencePath,
    bundlePath,
    receiptPath,
    counts: countFiles(sorted),
    redacted: true,
    files: sorted
  };
}

function collectRunFiles() {
  const root = resolveRepoPath(cwd, runDirectory, "run-directory");
  if (!existsSync(root)) return [];
  return walkFiles(root)
    .filter((path) => isAgentRunArtifact(repoRelativePath(path)))
    .map((path) => fileEntry(path, "run"));
}

function collectExplicitOutputs() {
  return explicitOutputs.map((path, index) => {
    const target = resolveRepoPath(cwd, path, `outputs[${index}]`);
    if (!existsSync(target) || !statSync(target).isFile()) {
      throw new Error(`Expected agent output does not exist: ${path}`);
    }
    return fileEntry(target, "output");
  });
}

function isAgentRunArtifact(path) {
  return /(^|\/)agents\/[^/]+\.(jsonl|prompt\.txt)$/u.test(path)
    || /(^|\/)context\/[^/]+\.json$/u.test(path);
}

function fileEntry(path, source) {
  const stat = statSync(path);
  const relativePath = repoRelativePath(path);
  return {
    path: relativePath,
    source,
    kind: inferKind(relativePath),
    bytes: stat.size,
    sha256: sha256(path)
  };
}

function inferKind(path) {
  if (/\/agents\/[^/]+\.jsonl$/u.test(path)) return "transcript";
  if (/\/agents\/[^/]+\.prompt\.txt$/u.test(path)) return "prompt";
  if (/\/context\/[^/]+\.json$/u.test(path)) return "context-pack";
  if (/\.(patch|diff)$/iu.test(path)) return "patch";
  if (/\.(md|markdown|txt)$/iu.test(path)) return "report";
  return "output";
}

function countFiles(files) {
  return {
    total: files.length,
    patches: files.filter((file) => file.kind === "patch").length,
    reports: files.filter((file) => file.kind === "report").length,
    transcripts: files.filter((file) => file.kind === "transcript").length,
    prompts: files.filter((file) => file.kind === "prompt").length,
    contextPacks: files.filter((file) => file.kind === "context-pack").length,
    outputs: files.filter((file) => file.source === "output").length
  };
}

function validateRedaction(files) {
  const offenders = [];
  for (const file of files) {
    const absolute = resolve(cwd, file.path);
    if (!isTextLike(file.path)) continue;
    const sample = readFileSync(absolute).subarray(0, maxBytes).toString("utf8");
    for (const pattern of SECRET_PATTERNS) {
      if (pattern.regex.test(sample)) {
        offenders.push(`${file.path}: ${pattern.name}`);
        break;
      }
    }
  }
  if (offenders.length > 0) {
    throw new Error(`Agent evidence failed redaction validation: ${offenders.join("; ")}`);
  }
}

function bundleFromManifest(manifest) {
  return {
    version: 1,
    generatedBy: manifest.generatedBy,
    createdAt: manifest.createdAt,
    evidencePath: manifest.evidencePath,
    counts: manifest.counts,
    files: manifest.files
  };
}

function receiptFromManifest(manifest) {
  return {
    kind: "agent-evidence",
    action: "bundle",
    id: manifest.id,
    status: "collected",
    repository: manifest.repository,
    commitSha: manifest.sha,
    branch: manifest.ref,
    evidencePath: manifest.evidencePath,
    bundlePath: manifest.bundlePath,
    patchCount: manifest.counts.patches,
    reportCount: manifest.counts.reports,
    transcriptCount: manifest.counts.transcripts,
    contextPackCount: manifest.counts.contextPacks,
    redacted: true,
    files: manifest.files.map((file) => ({ path: file.path, action: file.kind }))
  };
}

function renderComment(manifest) {
  return [
    "### Agent evidence",
    "",
    `Bundle: \`${manifest.bundlePath}\``,
    "",
    `- patches: ${manifest.counts.patches}`,
    `- reports: ${manifest.counts.reports}`,
    `- transcripts: ${manifest.counts.transcripts}`,
    `- context packs: ${manifest.counts.contextPacks}`,
    `- files: ${manifest.counts.total}`,
    "",
    "Large patches, transcripts, logs, and context packs are attached as evidence artifacts rather than pasted into this comment."
  ].join("\n");
}

function walkFiles(root) {
  const found = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      found.push(...walkFiles(path));
    } else if (entry.isFile()) {
      found.push(path);
    }
  }
  return found;
}

function writeJson(path, value) {
  const target = resolveRepoPath(cwd, path, "output path");
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function repoRelativePath(path) {
  const value = relative(cwd, path);
  if (value === ".." || value.startsWith(`..${sep}`)) {
    throw new Error(`Path escaped working directory: ${path}`);
  }
  return value.split(sep).join("/");
}

function isTextLike(path) {
  return /\.(json|jsonl|md|markdown|txt|patch|diff|log)$/iu.test(path);
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function manifestId() {
  const seed = [
    process.env.GITHUB_RUN_ID ?? "",
    process.env.GITHUB_RUN_ATTEMPT ?? "",
    process.env.GITHUB_JOB ?? "",
    Date.now().toString()
  ].join(":");
  return `agent-evidence-${createHash("sha256").update(seed).digest("hex").slice(0, 16)}`;
}

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
