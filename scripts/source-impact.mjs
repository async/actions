import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  boolInput,
  cwdFromInput,
  ensureParent,
  input,
  normalizeRepoPath,
  output,
  readJson,
  resolveRepoPath,
  run,
  summary
} from "./lib.mjs";

const cwd = cwdFromInput();
const mode = input("mode", "plan").trim();
const planPath = normalizeRepoPath(input("source-plan", ".async/actions/source-impact/source-plan.json"), "source-plan");
const plan = readSourcePlan(planPath);

if (!["plan", "checkout", "prepare", "receipt"].includes(mode)) {
  throw new Error(`Unsupported source-impact mode ${mode}. Use plan, checkout, prepare, or receipt.`);
}

if (mode === "plan") {
  runPlanMode();
} else if (mode === "checkout") {
  runCheckoutMode();
} else if (mode === "prepare") {
  runPrepareMode();
} else {
  runReceiptMode();
}

function runPlanMode() {
  const changedFilesPath = input("changed-files", "").trim();
  const changedFiles = changedFilesPath ? readChangedFiles(changedFilesPath) : undefined;
  const matrix = planMatrix(plan, changedFiles);
  const sourceCount = Object.keys(plan.sources).length;
  const changedSourceCount = changedFiles ? changedSourceIds(plan, changedFiles).size : 0;
  const receiptPath = writeReceipt({
    action: "plan",
    id: `${plan.job}:plan`,
    status: "planned",
    skipped: matrix.include.length === 0,
    path: planPath,
    files: [{ path: planPath, action: "source-plan", changed: false }]
  });

  if (boolInput("output-matrix", true)) output("matrix", JSON.stringify(matrix));
  output("source-count", String(sourceCount));
  output("changed-source-count", String(changedSourceCount));
  output("receipt-path", receiptPath);
  writeSummary("plan", { sourceCount, changedSourceCount, matrixRows: matrix.include.length, receiptPath });
}

function runCheckoutMode() {
  const source = selectedSource();
  const sourcePath = sourcePathForInput(source);
  if (source.type === "git") {
    const requestedRef = input("ref", source.ref ?? "").trim();
    if (requestedRef !== source.ref) {
      throw new Error(`Source "${source.id}" ref mismatch. Expected ${source.ref}, received ${requestedRef || "(empty)"}.`);
    }
    assertSafeGitRef(requestedRef, source.id);
    assertSafeGitUrl(source.url, source.id);
    checkoutGitSource(source, sourcePath, requestedRef);
  } else {
    ensureDirectory(resolve(cwd, sourcePath), `Source "${source.id}" path ${sourcePath}`);
  }

  const receiptPath = writeSourceReceipt(source, {
    action: "checkout",
    status: "checked-out",
    path: sourcePath,
    files: [{ path: sourcePath, action: "checkout", changed: false }]
  });
  output("source-id", source.id);
  output("source-path", sourcePath);
  output("receipt-path", receiptPath);
  writeSummary("checkout", { source: source.id, sourcePath, receiptPath });
}

function runPrepareMode() {
  const source = selectedSource();
  const sourcePath = sourcePathForInput(source);
  ensureDirectory(resolve(cwd, sourcePath), `Source "${source.id}" path ${sourcePath}`);

  if (source.prepareSkippedReason) {
    const receiptPath = writeSourceReceipt(source, {
      action: "prepare",
      status: "skipped",
      skipped: true,
      path: sourcePath,
      files: [{ path: sourcePath, action: "prepare", changed: false }]
    });
    output("source-id", source.id);
    output("source-path", sourcePath);
    output("receipt-path", receiptPath);
    writeSummary("prepare", { source: source.id, sourcePath, skipped: source.prepareSkippedReason, receiptPath });
    return;
  }

  for (const command of source.prepare ?? []) {
    console.log(`source-impact prepare ${source.id}: ${command}`);
    run("bash", ["-lc", command], { cwd: resolve(cwd, sourcePath) });
  }

  const receiptPath = writeSourceReceipt(source, {
    action: "prepare",
    status: "prepared",
    path: sourcePath,
    files: [{ path: sourcePath, action: "prepare", changed: false }]
  });
  output("source-id", source.id);
  output("source-path", sourcePath);
  output("receipt-path", receiptPath);
  writeSummary("prepare", { source: source.id, sourcePath, commands: source.prepare?.length ?? 0, receiptPath });
}

function runReceiptMode() {
  const sourceId = input("source-id", "").trim();
  if (!sourceId) {
    const receiptPath = writeReceipt({
      action: "receipt",
      id: `${plan.job}:receipt`,
      status: "recorded",
      path: planPath,
      files: [{ path: planPath, action: "source-plan", changed: false }]
    });
    output("receipt-path", receiptPath);
    writeSummary("receipt", { receiptPath });
    return;
  }
  const source = sourceById(sourceId);
  const sourcePath = sourcePathForInput(source);
  const receiptPath = writeSourceReceipt(source, {
    action: "receipt",
    status: "recorded",
    path: sourcePath,
    files: [{ path: sourcePath, action: "receipt", changed: false }]
  });
  output("source-id", source.id);
  output("source-path", sourcePath);
  output("receipt-path", receiptPath);
  writeSummary("receipt", { source: source.id, sourcePath, receiptPath });
}

function readSourcePlan(path) {
  const value = readJson(resolveRepoPath(cwd, path, "source-plan"));
  validatePlan(value);
  return value;
}

function validatePlan(value) {
  if (!value || typeof value !== "object" || value.version !== 1) {
    throw new Error("source-plan must be an object with version: 1.");
  }
  if (typeof value.job !== "string" || !value.job.trim()) {
    throw new Error("source-plan.job must be a non-empty string.");
  }
  if (!value.sources || typeof value.sources !== "object" || Array.isArray(value.sources)) {
    throw new Error("source-plan.sources must be an object.");
  }
  if (!value.matrix || typeof value.matrix !== "object" || !Array.isArray(value.matrix.include)) {
    throw new Error("source-plan.matrix.include must be an array.");
  }

  for (const [sourceId, source] of Object.entries(value.sources)) {
    validateSourceId(sourceId);
    if (!source || typeof source !== "object") throw new Error(`source-plan source "${sourceId}" must be an object.`);
    if (source.id !== sourceId) throw new Error(`source-plan source key "${sourceId}" must match its id.`);
    if (source.type !== "git" && source.type !== "path") throw new Error(`source-plan source "${sourceId}" type must be git or path.`);
    if (typeof source.path !== "string" || !source.path.trim()) {
      throw new Error(`source-plan source "${sourceId}" path must be a non-empty repo-relative path.`);
    }
    normalizeRepoPath(source.path, `source ${sourceId} path`);
    if (source.type === "git") {
      if (typeof source.url !== "string" || !source.url.trim()) throw new Error(`source-plan git source "${sourceId}" needs url.`);
      if (typeof source.ref !== "string" || !source.ref.trim()) throw new Error(`source-plan git source "${sourceId}" needs ref.`);
      assertSafeGitUrl(source.url, sourceId);
      assertSafeGitRef(source.ref, sourceId);
    }
    if (!Array.isArray(source.prepare)) throw new Error(`source-plan source "${sourceId}" prepare must be an array.`);
    for (const command of source.prepare) {
      if (typeof command !== "string" || !command.trim()) throw new Error(`source-plan source "${sourceId}" prepare commands must be non-empty strings.`);
    }
    if (source.prepareSkippedReason !== undefined && typeof source.prepareSkippedReason !== "string") {
      throw new Error(`source-plan source "${sourceId}" prepareSkippedReason must be a string.`);
    }
  }

  for (const row of value.matrix.include) {
    if (!row || typeof row !== "object") throw new Error("source-plan matrix rows must be objects.");
    validateSourceId(row.source);
    const source = value.sources[row.source];
    if (!source) throw new Error(`source-plan matrix row references unknown source "${row.source}".`);
    for (const field of ["task", "taskId", "type"]) {
      if (typeof row[field] !== "string" || !row[field].trim()) throw new Error(`source-plan matrix row ${row.source} missing ${field}.`);
    }
    if (row.type !== source.type) throw new Error(`source-plan matrix row ${row.task} type does not match source "${row.source}".`);
    if (row.path !== undefined && row.path !== source.path) throw new Error(`source-plan matrix row ${row.task} path does not match source "${row.source}".`);
    if (row.url !== undefined && row.url !== source.url) throw new Error(`source-plan matrix row ${row.task} url does not match source "${row.source}".`);
    if (row.ref !== undefined && row.ref !== source.ref) throw new Error(`source-plan matrix row ${row.task} ref does not match source "${row.source}".`);
  }
}

function selectedSource() {
  const sourceId = input("source-id", "").trim();
  if (!sourceId) throw new Error(`source-impact mode ${mode} requires source-id.`);
  return sourceById(sourceId);
}

function sourceById(sourceId) {
  validateSourceId(sourceId);
  const source = plan.sources[sourceId];
  if (!source) throw new Error(`Unknown source-id "${sourceId}" for generated source plan job "${plan.job}".`);
  return source;
}

function validateSourceId(sourceId) {
  if (typeof sourceId !== "string" || !/^[A-Za-z0-9_.-]+$/u.test(sourceId)) {
    throw new Error(`Invalid source id "${sourceId}".`);
  }
}

function sourcePathForInput(source) {
  const requested = input("path", source.path).trim();
  const normalized = normalizeRepoPath(requested, "path");
  if (normalized !== source.path) {
    throw new Error(`Source "${source.id}" path mismatch. Expected ${source.path}, received ${normalized}.`);
  }
  return normalized;
}

function planMatrix(sourcePlan, changedFiles) {
  const changed = changedFiles ? changedSourceIds(sourcePlan, changedFiles) : new Set();
  const include = changedFiles && changed.size > 0
    ? sourcePlan.matrix.include.filter((row) => changed.has(row.source))
    : [...sourcePlan.matrix.include];
  return { include };
}

function changedSourceIds(sourcePlan, changedFiles) {
  const changed = new Set();
  for (const source of Object.values(sourcePlan.sources)) {
    const prefix = `${source.path.replace(/\/+$/u, "")}/`;
    if (changedFiles.some((file) => file === source.path || file.startsWith(prefix))) {
      changed.add(source.id);
    }
  }
  return changed;
}

function readChangedFiles(path) {
  const target = resolveRepoPath(cwd, path, "changed-files");
  if (!existsSync(target)) return [];
  return readFileSync(target, "utf8")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line, index) => normalizeRepoPath(line, `changed-files[${index}]`));
}

function checkoutGitSource(source, sourcePath, ref) {
  const target = resolve(cwd, sourcePath);
  ensureParent(target);
  if (!existsSync(resolve(target, ".git"))) {
    run("git", ["clone", "--no-checkout", source.url, target]);
  } else {
    run("git", ["remote", "set-url", "origin", source.url], { cwd: target });
  }
  run("git", ["fetch", "--tags", "origin"], { cwd: target });
  run("git", ["checkout", "--force", ref], { cwd: target });
}

function ensureDirectory(path, label) {
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    throw new Error(`${label} does not exist or is not a directory.`);
  }
}

function assertSafeGitUrl(url, sourceId) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Source "${sourceId}" url must be an absolute https or ssh URL from generated metadata.`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "ssh:") {
    throw new Error(`Source "${sourceId}" url protocol ${parsed.protocol} is not allowed.`);
  }
  if (!parsed.hostname) throw new Error(`Source "${sourceId}" url must include a hostname.`);
}

function assertSafeGitRef(ref, sourceId) {
  if (/^[a-f0-9]{40}$/iu.test(ref)) return;
  if (/^refs\/(?:heads|tags)\/[A-Za-z0-9._/-]+$/u.test(ref) && !ref.includes("..") && !ref.endsWith("/")) return;
  if (/^refs\/pull\/[1-9][0-9]*\/(?:head|merge)$/u.test(ref)) return;
  throw new Error(`Source "${sourceId}" ref "${ref}" must be a full SHA or generated-safe ref.`);
}

function writeSourceReceipt(source, fields) {
  return writeReceipt({
    kind: "source-impact",
    id: source.id,
    repository: source.type === "git" ? source.url : source.id,
    commitSha: source.type === "git" && /^[a-f0-9]{40}$/iu.test(source.ref) ? source.ref : undefined,
    ...fields
  });
}

function writeReceipt(fields) {
  const fallbackName = sanitizeReceiptPart(fields.id ?? mode);
  const path = normalizeRepoPath(input("receipt-path", `.async/actions/receipts/source-impact-${fallbackName}.json`), "receipt-path");
  const target = resolveRepoPath(cwd, path, "receipt-path");
  ensureParent(target);
  const receipt = {
    version: 1,
    kind: "source-impact",
    generatedBy: "async/actions/source-impact",
    job: plan.job,
    action: fields.action ?? mode,
    id: fields.id,
    status: fields.status ?? "recorded",
    ...(fields.repository ? { repository: fields.repository } : {}),
    ...(fields.commitSha ? { commitSha: fields.commitSha } : {}),
    ...(fields.path ? { path: fields.path } : {}),
    receiptPath: path,
    skipped: Boolean(fields.skipped),
    files: fields.files ?? [],
    createdAt: new Date().toISOString()
  };
  writeFileSync(target, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
  return path;
}

function sanitizeReceiptPart(value) {
  return String(value).replace(/[^A-Za-z0-9_.-]+/gu, "-").replace(/^-|-$/gu, "") || hash(String(value));
}

function hash(value) {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function writeSummary(action, facts) {
  output("source-count", String(Object.keys(plan.sources).length));
  summary([
    "### async/actions/source-impact",
    "",
    `- mode: ${action}`,
    `- job: ${plan.job}`,
    ...Object.entries(facts).map(([key, value]) => `- ${key}: ${String(value)}`)
  ].join("\n"));
}
