import {
  appendFileSync,
  existsSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import {
  assertSafeRepoPath,
  boolInput,
  cwdFromInput,
  ensureParent,
  input,
  output,
  parseList,
  readJson,
  run,
  summary,
  validateChangeFiles
} from "./lib.mjs";

const cwd = cwdFromInput();
const mode = input("mode", "read");
const storagePath = input("path", ".async/actions/storage.json");
const receiptPath = input("receipt-path", ".async/actions/receipts/storage-receipt.json");
const format = input("format", "json");
const allowedPathGlobs = parseList(input("allowed-paths", ""));
const allowWorkflowPaths = boolInput("allow-workflow-paths", false);
const shouldCommit = boolInput("commit", false);
const shouldPush = boolInput("push", false);
const shouldPr = boolInput("pull-request", false);
const repository = input("repository", process.env.GITHUB_REPOSITORY ?? "");

const safety = { allowWorkflowPaths, allowedPathGlobs };
assertSafeRepoPath(receiptPath, { allowWorkflowPaths: false });

let changed = false;
let receipt = {
  version: 1,
  action: mode,
  repository,
  path: storagePath,
  receiptPath,
  changed: false,
  files: [],
  run: {
    runId: process.env.GITHUB_RUN_ID,
    sha: process.env.GITHUB_SHA,
    ref: process.env.GITHUB_REF
  }
};

if (mode === "read") {
  assertSafeRepoPath(storagePath, { allowWorkflowPaths: false, allowedPathGlobs });
  const target = resolve(cwd, storagePath);
  const exists = existsSync(target);
  const value = exists ? readFileSync(target, "utf8") : "";
  if (exists && format === "json") JSON.parse(value);
  output("exists", String(exists));
  output("value", value);
  receipt = { ...receipt, exists, bytes: value.length };
} else if (mode === "write") {
  assertSafeRepoPath(storagePath, { allowWorkflowPaths: false, allowedPathGlobs });
  const target = resolve(cwd, storagePath);
  const value = renderValueForWrite();
  const previous = existsSync(target) ? readFileSync(target, "utf8") : undefined;
  changed = previous !== value;
  if (changed) {
    ensureParent(target);
    writeFileSync(target, value, "utf8");
  }
  receipt = {
    ...receipt,
    changed,
    files: [{ path: storagePath, action: "upsert", changed }]
  };
} else if (mode === "append") {
  assertSafeRepoPath(storagePath, { allowWorkflowPaths: false, allowedPathGlobs });
  const target = resolve(cwd, storagePath);
  const line = renderValueForAppend();
  ensureParent(target);
  appendFileSync(target, `${line}\n`, "utf8");
  changed = true;
  receipt = {
    ...receipt,
    changed,
    files: [{ path: storagePath, action: "append", changed }]
  };
} else if (mode === "apply-change-set") {
  const changeSetPath = input("change-set", "");
  if (!changeSetPath) throw new Error("apply-change-set mode requires change-set.");
  assertSafeRepoPath(changeSetPath, { allowWorkflowPaths: false });
  const changeSet = readJson(resolve(cwd, changeSetPath));
  validateChangeFiles(changeSet.files, safety);
  const files = applyChangeSet(changeSet.files);
  changed = files.some((file) => file.changed);
  receipt = {
    ...receipt,
    action: "apply-change-set",
    id: changeSet.id,
    path: changeSetPath,
    branch: input("branch", changeSet.targetBranch ?? ""),
    baseBranch: input("base-branch", changeSet.baseBranch ?? ""),
    message: input("commit-message", changeSet.message ?? "Apply Async storage change"),
    changed,
    files,
    metadata: changeSet.metadata
  };
} else {
  throw new Error(`Unsupported storage mode ${mode}. Use read, write, append, or apply-change-set.`);
}

if (shouldCommit && changed) {
  receipt = { ...receipt, ...commitAndMaybePublish(receipt.files.map((file) => file.path)) };
}

writeReceipt(receipt);

output("path", storagePath);
output("changed", String(changed));
output("receipt-path", receiptPath);
output("commit-sha", receipt.commitSha ?? "");
output("pull-request-url", receipt.pullRequestUrl ?? "");

summary(`### async/actions/storage

- mode: ${mode}
- changed: ${changed}
- receipt: ${receiptPath}`);

function renderValueForWrite() {
  const raw = readInputValue();
  if (format === "json") return `${JSON.stringify(JSON.parse(raw), null, 2)}\n`;
  if (format === "jsonl") return `${JSON.stringify(JSON.parse(raw))}\n`;
  if (format === "string") return raw;
  throw new Error(`Unsupported storage format ${format}. Use json, jsonl, or string.`);
}

function renderValueForAppend() {
  const raw = readInputValue();
  if (format === "json" || format === "jsonl") return JSON.stringify(JSON.parse(raw));
  if (format === "string") return raw.replace(/\n+$/u, "");
  throw new Error(`Unsupported storage format ${format}. Use json, jsonl, or string.`);
}

function readInputValue() {
  const valueFile = input("value-file", "");
  if (valueFile) {
    assertSafeRepoPath(valueFile, { allowWorkflowPaths: false });
    return readFileSync(resolve(cwd, valueFile), "utf8");
  }
  return input("value", "");
}

function applyChangeSet(files) {
  const receipts = [];
  for (const file of files) {
    const target = resolve(cwd, file.path);
    if (file.action === "delete") {
      const existed = existsSync(target);
      if (existed && statSync(target).isDirectory()) {
        throw new Error(`Refusing to delete directory ${file.path}; change-set deletes must target files.`);
      }
      if (existed) rmSync(target, { force: true });
      receipts.push({ path: file.path, action: "delete", changed: existed });
      continue;
    }

    const content = file.encoding === "base64"
      ? Buffer.from(file.content, "base64").toString("utf8")
      : file.content;
    const previous = existsSync(target) ? readFileSync(target, "utf8") : undefined;
    const fileChanged = previous !== content;
    if (fileChanged) {
      ensureParent(target);
      writeFileSync(target, content, "utf8");
    }
    receipts.push({ path: file.path, action: "upsert", changed: fileChanged });
  }
  return receipts;
}

function commitAndMaybePublish(paths) {
  const branch = input("branch", receipt.branch ?? "");
  const baseBranch = input("base-branch", receipt.baseBranch ?? "");
  const message = input("commit-message", receipt.message ?? "Apply Async storage change");

  if (branch) run("git", ["checkout", "-B", branch], { cwd });
  run("git", ["config", "user.name", "github-actions[bot]"], { cwd });
  run("git", ["config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"], { cwd });
  run("git", ["add", "--all", "--", ...paths], { cwd });
  const staged = run("git", ["diff", "--cached", "--quiet"], { cwd, check: false });
  if (staged.status === 0) return { commitSha: currentHead() };
  run("git", ["commit", "-m", message], { cwd });
  const commitSha = currentHead();
  const effectiveBranch = branch || currentBranch();

  if (shouldPush || shouldPr) {
    run("git", ["push", "--set-upstream", "origin", `HEAD:${effectiveBranch}`], { cwd });
  }

  if (shouldPr) {
    if (!repository) throw new Error("repository or GITHUB_REPOSITORY is required when pull-request is true.");
    const existing = run("gh", [
      "pr",
      "list",
      "--repo",
      repository,
      "--head",
      effectiveBranch,
      ...(baseBranch ? ["--base", baseBranch] : []),
      "--state",
      "open",
      "--json",
      "url",
      "--jq",
      ".[0].url"
    ], { cwd, capture: true, check: false });
    const pullRequestUrl = existing.status === 0 && existing.stdout.trim()
      ? existing.stdout.trim()
      : createPullRequest(effectiveBranch, baseBranch);
    return { commitSha, pullRequestUrl };
  }

  return { commitSha };
}

function createPullRequest(branch, baseBranch) {
  const args = [
    "pr",
    "create",
    "--repo",
    repository,
    "--head",
    branch,
    "--title",
    input("pr-title", "Apply Async storage change"),
    "--body",
    input("pr-body", "Created by async/actions/storage.")
  ];
  if (baseBranch) args.push("--base", baseBranch);
  const created = run("gh", args, { cwd, capture: true });
  return created.stdout.trim();
}

function currentHead() {
  return run("git", ["rev-parse", "HEAD"], { cwd, capture: true }).stdout.trim();
}

function currentBranch() {
  const local = run("git", ["branch", "--show-current"], { cwd, capture: true, check: false }).stdout.trim();
  if (local) return local;
  const ref = process.env.GITHUB_REF ?? "";
  if (ref.startsWith("refs/heads/")) return ref.slice("refs/heads/".length);
  return basename(dirname(ref || "HEAD"));
}

function writeReceipt(value) {
  const target = resolve(cwd, receiptPath);
  ensureParent(target);
  writeFileSync(target, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
