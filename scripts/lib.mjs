import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { spawnSync } from "node:child_process";

export function input(name, fallback = "") {
  const key = `INPUT_${name.toUpperCase().replace(/-/g, "_")}`;
  const value = process.env[key];
  return value === undefined || value === "" ? fallback : value;
}

export function boolInput(name, fallback = false) {
  const value = input(name, fallback ? "true" : "false").trim().toLowerCase();
  return ["1", "true", "yes", "on"].includes(value);
}

export function cwdFromInput() {
  return resolve(process.cwd(), input("working-directory", "."));
}

export function parseList(value) {
  return value
    .split(/[\n,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? process.cwd(),
    env: { ...process.env, ...(options.env ?? {}) },
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit"
  });
  if (result.status !== 0 && options.check !== false) {
    const rendered = [command, ...args].join(" ");
    if (options.capture) {
      process.stderr.write(result.stdout ?? "");
      process.stderr.write(result.stderr ?? "");
    }
    throw new Error(`${rendered} failed with exit code ${result.status ?? "unknown"}.`);
  }
  return result;
}

export function output(name, value) {
  const path = process.env.GITHUB_OUTPUT;
  if (!path) {
    console.log(`${name}=${value}`);
    return;
  }
  const rendered = String(value);
  if (rendered.includes("\n")) {
    const marker = `async_actions_${randomUUID().replace(/-/g, "")}`;
    writeFileSync(path, `${name}<<${marker}\n${rendered}\n${marker}\n`, { flag: "a" });
    return;
  }
  writeFileSync(path, `${name}=${rendered}\n`, { flag: "a" });
}

export function env(name, value) {
  const path = process.env.GITHUB_ENV;
  if (!path) return;
  writeFileSync(path, `${name}=${value}\n`, { flag: "a" });
}

export function summary(markdown) {
  const path = process.env.GITHUB_STEP_SUMMARY;
  if (!path) return;
  writeFileSync(path, `${markdown.trim()}\n`, { flag: "a" });
}

export function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function packageContext(packagePath) {
  const packageDir = resolve(cwdFromInput(), packagePath);
  const manifestPath = join(packageDir, "package.json");
  if (!existsSync(manifestPath)) {
    throw new Error(`Package path ${packagePath} does not contain package.json.`);
  }
  const manifest = readJson(manifestPath);
  if (typeof manifest.name !== "string" || typeof manifest.version !== "string") {
    throw new Error(`${manifestPath} must include name and version.`);
  }
  return { packageDir, manifest };
}

export function ensureDirectory(path, label = path) {
  if (!existsSync(path) || !statSync(path).isDirectory()) {
    throw new Error(`${label} does not exist or is not a directory.`);
  }
}

export function ensureFile(path, label = path) {
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw new Error(`${label} does not exist or is not a file.`);
  }
}

export function ensureParent(path) {
  mkdirSync(dirname(path), { recursive: true });
}

export function normalizeRepoPath(path, label = "path", options = {}) {
  const value = String(path ?? "").trim();
  assertSafeRepoPath(value, options);
  return value;
}

export function resolveRepoPath(cwd, path, label = "path", options = {}) {
  const normalized = normalizeRepoPath(path, label, options);
  const target = resolve(cwd, normalized);
  const relativePath = relative(cwd, target);
  if (relativePath === ".." || relativePath.startsWith(`..${sep}`) || relativePath === "") {
    if (relativePath !== "") {
      throw new UnsafeRepoPathError(normalized, `${label} resolves outside the working directory`);
    }
  }
  return target;
}

export class UnsafeRepoPathError extends Error {
  constructor(path, reason) {
    super(`Unsafe repository path "${path}": ${reason}`);
    this.name = "UnsafeRepoPathError";
  }
}

export function assertSafeRepoPath(path, options = {}) {
  if (!path || path.trim() !== path) {
    throw new UnsafeRepoPathError(path, "paths must be non-empty and cannot include leading or trailing whitespace");
  }

  if (path.startsWith("/") || /^[A-Za-z]:[\\/]/u.test(path)) {
    throw new UnsafeRepoPathError(path, "absolute paths are not allowed");
  }

  const parts = path.split("/");
  if (parts.some((part) => part === ".." || part === "")) {
    throw new UnsafeRepoPathError(path, "paths cannot contain empty segments or ..");
  }

  if (!options.allowWorkflowPaths && path.startsWith(".github/workflows/")) {
    throw new UnsafeRepoPathError(path, ".github/workflows writes require allow-workflow-paths");
  }

  if (options.allowedPathGlobs?.length && !options.allowedPathGlobs.some((glob) => matchesSimpleGlob(path, glob))) {
    throw new UnsafeRepoPathError(path, `path is outside allowed paths: ${options.allowedPathGlobs.join(", ")}`);
  }
}

export function validateChangeFiles(files, options = {}) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new UnsafeRepoPathError("(empty)", "change sets must contain at least one file");
  }

  const seen = new Set();
  for (const file of files) {
    if (!file || typeof file !== "object") {
      throw new UnsafeRepoPathError("(invalid)", "change-set files must be objects");
    }
    assertSafeRepoPath(file.path, options);
    if (seen.has(file.path)) {
      throw new UnsafeRepoPathError(file.path, "a change set cannot include the same path more than once");
    }
    seen.add(file.path);

    if (file.action !== "upsert" && file.action !== "delete") {
      throw new UnsafeRepoPathError(file.path, "file action must be upsert or delete");
    }
    if (file.action === "upsert" && typeof file.content !== "string") {
      throw new UnsafeRepoPathError(file.path, "upsert files require string content");
    }
  }
}

function matchesSimpleGlob(path, glob) {
  if (glob.endsWith("/**")) {
    return path.startsWith(glob.slice(0, -2));
  }

  if (glob.endsWith("/*")) {
    const prefix = glob.slice(0, -1);
    const rest = path.slice(prefix.length);
    return path.startsWith(prefix) && rest.length > 0 && !rest.includes("/");
  }

  if (glob.includes("*")) {
    const escaped = glob
      .replace(/[.+?^${}()|[\]\\]/gu, "\\$&")
      .replaceAll("\\*", "[^/]*");
    return new RegExp(`^${escaped}$`, "u").test(path);
  }

  return path === glob || path.startsWith(`${glob}/`);
}

export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

export function npmView(spec, registry, cwd) {
  return run("npm", ["view", spec, "version", "--registry", registry], { cwd, capture: true, check: false });
}

export function isMissingVersion(result) {
  const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
  return result.status !== 0 && /(^|[\s])(E404|404)([\s]|$)|not found/i.test(output);
}

export function configureNpmAuth(registry, tokenEnvName = "") {
  const names = [
    tokenEnvName,
    "NODE_AUTH_TOKEN",
    "NPM_TOKEN",
    "GITHUB_TOKEN"
  ].filter((name, index, all) => name && all.indexOf(name) === index);
  const name = names.find((candidate) => process.env[candidate]);
  if (!name) return undefined;
  const token = process.env[name];
  const parsed = new URL(registry);
  const registryPath = `${parsed.host}${parsed.pathname.replace(/\/?$/, "/")}`;
  const dir = mkdtempSync(join(tmpdir(), "async-actions-npmrc-"));
  const userconfig = join(dir, ".npmrc");
  writeFileSync(userconfig, `//${registryPath}:_authToken=${token}\nalways-auth=true\n`, { mode: 0o600 });
  process.env.NPM_CONFIG_USERCONFIG = userconfig;
  if (!process.env.NODE_AUTH_TOKEN) process.env.NODE_AUTH_TOKEN = token;
  return {
    tokenEnvName: name,
    userconfig,
    cleanup() {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}
