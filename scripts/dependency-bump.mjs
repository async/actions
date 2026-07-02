import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { cwdFromInput, input, output, parseList, readJson, run, summary } from "./lib.mjs";

const cwd = cwdFromInput();
const eventPayload = readEventPayload();
const packageName = input("package-name", payloadValue("package"));
const version = normalizeVersion(input("version", payloadValue("version")));
const allowedPackages = parseList(input("allowed-packages", ""));
const packageManagerInput = input("package-manager", "");
const verifyCommands = input("verify", "").split(/\n/u).map((entry) => entry.trim()).filter(Boolean);
const successMode = input("success-mode", "pull-request");
const failureMode = input("failure-mode", "pull-request");
const branchPrefix = input("branch-prefix", "async/dependency-bump/");
const baseBranch = input("base-branch", "main");
const repository = input("repository", process.env.GITHUB_REPOSITORY ?? "");
const token = input("github-token", "");

assertPackageName(packageName);
assertVersion(version);
assertMode(successMode, ["pull-request", "push", "none"], "success-mode");
assertMode(failureMode, ["pull-request", "none"], "failure-mode");
if (allowedPackages.length > 0 && !allowedPackages.includes(packageName)) {
  throw new Error(`Package ${packageName} is not in allowed-packages.`);
}
if (!token) throw new Error("github-token is required.");
if (repository) assertRepository(repository);

const manifestPath = join(cwd, "package.json");
const manifest = readJson(manifestPath);
const dependencySection = findDependencySection(manifest, packageName);
if (!dependencySection) {
  throw new Error(`Package ${packageName} is not a direct dependency in package.json.`);
}
const previousSpec = manifest[dependencySection][packageName];
manifest[dependencySection][packageName] = version;
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

const packageManager = normalizePackageManager(packageManagerInput || manifest.packageManager);
runLockfileUpdate(packageManager);

let verifyStatus = "skipped";
let verifyFailed = false;
for (const command of verifyCommands) {
  const result = run("bash", ["-lc", command], { cwd, check: false });
  if (result.status !== 0) {
    verifyStatus = "failed";
    verifyFailed = true;
    break;
  }
  verifyStatus = "passed";
}

const changedFiles = gitChangedFiles();
const changed = changedFiles.length > 0;
const mode = verifyFailed ? failureMode : successMode;
let commitSha = "";
let pullRequestUrl = "";

if (changed && mode !== "none") {
  const branch = branchName(branchPrefix, packageName, version);
  if (mode === "pull-request") run("git", ["checkout", "-B", branch], { cwd });
  run("git", ["config", "user.name", "github-actions[bot]"], { cwd });
  run("git", ["config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"], { cwd });
  run("git", ["add", "--", ...stageableFiles(changedFiles)], { cwd });
  const staged = run("git", ["diff", "--cached", "--quiet"], { cwd, check: false });
  if (staged.status !== 0) {
    run("git", ["commit", "-m", commitMessage()], { cwd });
  }
  commitSha = currentHead();
  if (mode === "push") {
    run("git", ["push", "origin", `HEAD:${baseBranch}`], { cwd, env: gitAuthEnv() });
  } else if (mode === "pull-request") {
    run("git", ["push", "--set-upstream", "origin", `HEAD:${branch}`], { cwd, env: gitAuthEnv() });
    pullRequestUrl = existingPullRequest(branch) || createPullRequest(branch);
  }
}

output("changed", String(changed));
output("package-name", packageName);
output("version", version);
output("commit-sha", commitSha);
output("pull-request-url", pullRequestUrl);
output("verify-status", verifyStatus);
summary(`### async/actions/dependency-bump

- package: ${packageName}
- from: ${previousSpec}
- to: ${version}
- dependency section: ${dependencySection}
- changed: ${changed}
- verify: ${verifyStatus}
- mode: ${mode}`);

function readEventPayload() {
  const path = process.env.GITHUB_EVENT_PATH;
  if (!path || !existsSync(path)) return {};
  return JSON.parse(readFileSync(path, "utf8"));
}

function payloadValue(name) {
  const payload = eventPayload?.client_payload;
  if (!payload || typeof payload !== "object") return "";
  const value = payload[name];
  return typeof value === "string" ? value : "";
}

function normalizeVersion(value) {
  return String(value ?? "").trim().replace(/^v/u, "");
}

function assertPackageName(value) {
  if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u.test(String(value))) {
    throw new Error(`Invalid package name ${value}.`);
  }
}

function assertVersion(value) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(String(value))) {
    throw new Error(`Invalid package version ${value}.`);
  }
}

function assertRepository(value) {
  const parts = String(value).split("/");
  if (parts.length !== 2 || !parts.every((part) => /^(?!\.{1,2}$)[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(part))) {
    throw new Error(`Invalid repository ${value}. Expected owner/name.`);
  }
}

function assertMode(value, allowed, label) {
  if (!allowed.includes(value)) {
    throw new Error(`${label} must be one of ${allowed.join(", ")}.`);
  }
}

function findDependencySection(manifest, name) {
  for (const section of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    if (manifest?.[section] && Object.hasOwn(manifest[section], name)) return section;
  }
  return undefined;
}

function normalizePackageManager(value) {
  const match = /^(npm|pnpm|yarn|bun)(?:@.+)?$/u.exec(String(value || "pnpm"));
  return match?.[1] ?? "pnpm";
}

function runLockfileUpdate(manager) {
  if (manager === "npm") {
    run("npm", ["install", "--package-lock-only"], { cwd });
    return;
  }
  if (manager === "yarn") {
    run("yarn", ["install", "--mode", "update-lockfile"], { cwd });
    return;
  }
  if (manager === "bun") {
    run("bun", ["install", "--lockfile-only"], { cwd });
    return;
  }
  run("pnpm", ["install", "--lockfile-only"], { cwd });
}

function gitChangedFiles() {
  const result = run("git", ["diff", "--name-only"], { cwd, capture: true, check: false });
  const files = result.stdout.split(/\n/u).map((entry) => entry.trim()).filter(Boolean);
  if (files.length > 0) return files;
  return ["package.json", ...knownLockfiles().filter((file) => existsSync(join(cwd, file)))];
}

function stageableFiles(files) {
  const allowed = new Set(["package.json", ...knownLockfiles(), ".github/workflows/async-pipeline.yml", ".locks/pipeline/github-workflow.lock.json", ".locks/pipeline/tasks.lock.json"]);
  return files.filter((file) => allowed.has(file) || file.startsWith(".locks/pipeline/"));
}

function knownLockfiles() {
  return ["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb", "bun.lock"];
}

function branchName(prefix, name, targetVersion) {
  const suffix = `${name.replace(/^@/u, "").replace(/[^A-Za-z0-9._-]+/gu, "-")}-${targetVersion.replace(/[^A-Za-z0-9._-]+/gu, "-")}`;
  return `${prefix}${suffix}`;
}

function commitMessage() {
  return input("commit-message", `Bump ${packageName} to ${version}`);
}

function currentHead() {
  return run("git", ["rev-parse", "HEAD"], { cwd, capture: true }).stdout.trim();
}

function gitAuthEnv() {
  return { GH_TOKEN: token, GITHUB_TOKEN: token };
}

function existingPullRequest(branch) {
  if (!repository) return "";
  const result = run("gh", [
    "pr",
    "list",
    "--repo",
    repository,
    "--head",
    branch,
    "--base",
    baseBranch,
    "--state",
    "open",
    "--json",
    "url",
    "--jq",
    ".[0].url"
  ], { cwd, capture: true, check: false, env: gitAuthEnv() });
  return result.status === 0 ? result.stdout.trim() : "";
}

function createPullRequest(branch) {
  if (!repository) throw new Error("repository is required for pull requests.");
  const title = input("pr-title", commitMessage());
  const body = input("pr-body", `Updates ${packageName} to ${version}.`);
  const result = run("gh", [
    "pr",
    "create",
    "--repo",
    repository,
    "--head",
    branch,
    "--base",
    baseBranch,
    "--title",
    title,
    "--body",
    body
  ], { cwd, capture: true, env: gitAuthEnv() });
  return result.stdout.trim();
}
