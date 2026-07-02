import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { configureNpmAuth } from "../scripts/lib.mjs";

test("GitHub Packages auth can prefer GITHUB_TOKEN over NODE_AUTH_TOKEN", () => {
  const previousNodeAuth = process.env.NODE_AUTH_TOKEN;
  const previousGitHubToken = process.env.GITHUB_TOKEN;
  const previousUserConfig = process.env.NPM_CONFIG_USERCONFIG;
  process.env.NODE_AUTH_TOKEN = "npm-token";
  process.env.GITHUB_TOKEN = "github-token";

  const auth = configureNpmAuth("https://npm.pkg.github.com", "GITHUB_TOKEN");
  try {
    assert.ok(auth);
    assert.equal(auth.tokenEnvName, "GITHUB_TOKEN");
    assert.match(readFileSync(auth.userconfig, "utf8"), /github-token/u);
  } finally {
    auth?.cleanup();
    restoreEnv("NODE_AUTH_TOKEN", previousNodeAuth);
    restoreEnv("GITHUB_TOKEN", previousGitHubToken);
    restoreEnv("NPM_CONFIG_USERCONFIG", previousUserConfig);
  }
});

test("publish action exposes bounded registry verification retries", () => {
  const action = readFileSync(new URL("../publish/action.yml", import.meta.url), "utf8");
  const script = readFileSync(new URL("../scripts/publish.mjs", import.meta.url), "utf8");

  assert.match(action, /verify-attempts:/u);
  assert.match(action, /verify-delay-ms:/u);
  assert.match(script, /Waiting for \$\{targetSpec\}/u);
  assert.match(script, /await ensureVersionExists\(spec, "https:\/\/registry\.npmjs\.org"\)/u);
});

test("GitHub Packages publishing stages npm pack files without requiring dist", () => {
  const dir = mkdtempSync(join(tmpdir(), "async-actions-publish-root-files-"));
  try {
    const bin = join(dir, "bin");
    const pkg = join(dir, "pkg");
    mkdirSync(bin);
    mkdirSync(pkg);

    writeFileSync(join(pkg, "package.json"), JSON.stringify({
      name: "@async/framework",
      version: "0.11.2",
      files: [
        "README.md",
        "LICENSE",
        "browser.js",
        "server.js"
      ]
    }, null, 2), "utf8");
    writeFileSync(join(pkg, "README.md"), "# Framework\n", "utf8");
    writeFileSync(join(pkg, "LICENSE"), "MIT\n", "utf8");
    writeFileSync(join(pkg, "browser.js"), "export const target = 'browser';\n", "utf8");
    writeFileSync(join(pkg, "server.js"), "export const target = 'server';\n", "utf8");

    const publishCapture = join(dir, "publish.json");
    writeFileSync(join(bin, "npm"), fakeNpm(publishCapture), { mode: 0o755 });

    const result = spawnSync(process.execPath, [new URL("../scripts/publish.mjs", import.meta.url).pathname], {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        GITHUB_TOKEN: "github-token",
        GITHUB_REPOSITORY_OWNER: "async",
        INPUT_MODE: "github-packages",
        INPUT_PACKAGE_PATH: "pkg",
        INPUT_REGISTRY: "https://npm.pkg.github.com",
        INPUT_WORKING_DIRECTORY: "."
      }
    });

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const published = JSON.parse(readFileSync(publishCapture, "utf8"));
    assert.equal(published.manifest.name, "@async/framework");
    assert.deepEqual(published.files.sort(), [
      "LICENSE",
      "README.md",
      "browser.js",
      "package.json",
      "server.js"
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("npm publishing sets public access when token-backed publish succeeds", () => {
  const dir = mkdtempSync(join(tmpdir(), "async-actions-npm-access-"));
  try {
    const bin = join(dir, "bin");
    const pkg = join(dir, "pkg");
    mkdirSync(bin);
    mkdirSync(pkg);
    writeFileSync(join(pkg, "package.json"), JSON.stringify({
      name: "@async/cli",
      version: "0.1.0"
    }, null, 2), "utf8");

    const commandLog = join(dir, "commands.jsonl");
    writeFileSync(join(bin, "npm"), fakeNpmAccess(commandLog, { publishConflict: false }), { mode: 0o755 });

    const result = spawnSync(process.execPath, [new URL("../scripts/publish.mjs", import.meta.url).pathname], {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        NODE_AUTH_TOKEN: "npm-token",
        INPUT_MODE: "npm",
        INPUT_PACKAGE_PATH: "pkg",
        INPUT_REGISTRY: "https://registry.npmjs.org",
        INPUT_VERIFY_PUBLIC: "false",
        INPUT_WORKING_DIRECTORY: "."
      }
    });

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const commands = readJsonLines(commandLog);
    assert.equal(commands.some((args) => args[0] === "publish"), true);
    assert.deepEqual(commands.find((args) => args[0] === "access"), [
      "access",
      "set",
      "status=public",
      "@async/cli",
      "--registry",
      "https://registry.npmjs.org"
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("npm publishing repairs public access after an existing-version conflict", () => {
  const dir = mkdtempSync(join(tmpdir(), "async-actions-npm-access-conflict-"));
  try {
    const bin = join(dir, "bin");
    const pkg = join(dir, "pkg");
    mkdirSync(bin);
    mkdirSync(pkg);
    writeFileSync(join(pkg, "package.json"), JSON.stringify({
      name: "@async/cli",
      version: "0.1.0"
    }, null, 2), "utf8");

    const commandLog = join(dir, "commands.jsonl");
    writeFileSync(join(bin, "npm"), fakeNpmAccess(commandLog, { publishConflict: true }), { mode: 0o755 });

    const result = spawnSync(process.execPath, [new URL("../scripts/publish.mjs", import.meta.url).pathname], {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        NODE_AUTH_TOKEN: "npm-token",
        INPUT_MODE: "npm",
        INPUT_PACKAGE_PATH: "pkg",
        INPUT_REGISTRY: "https://registry.npmjs.org",
        INPUT_VERIFY_PUBLIC: "false",
        INPUT_WORKING_DIRECTORY: "."
      }
    });

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const commands = readJsonLines(commandLog);
    assert.equal(commands.some((args) => args[0] === "publish"), true);
    assert.equal(commands.some((args) => args[0] === "access"), true);
    assert.match(result.stdout, /repaired public access/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function restoreEnv(name, value) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

function readJsonLines(path) {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function fakeNpm(publishCapture) {
  return `#!/usr/bin/env node
const { readdirSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const args = process.argv.slice(2);

if (args[0] === "pack") {
  const manifest = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
  const files = ["package.json", ...manifest.files].map((path) => ({ path }));
  process.stdout.write(JSON.stringify([{ files }]));
  process.exit(0);
}

if (args[0] === "view") {
  process.stderr.write("npm ERR! 404 Not Found\\n");
  process.exit(1);
}

if (args[0] === "publish") {
  const files = readdirSync(process.cwd()).sort();
  const manifest = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
  writeFileSync(${JSON.stringify(publishCapture)}, JSON.stringify({ files, manifest }, null, 2));
  process.exit(0);
}

if (args[0] === "dist-tag") {
  process.exit(0);
}

process.stderr.write("unexpected npm command " + args.join(" ") + "\\n");
process.exit(1);
`;
}

function fakeNpmAccess(commandLog, { publishConflict }) {
  return `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(commandLog)}, JSON.stringify(args) + "\\n");

if (args[0] === "view") {
  process.stderr.write("npm ERR! 404 Not Found\\n");
  process.exit(1);
}

if (args[0] === "publish") {
  if (${publishConflict ? "true" : "false"}) {
    process.stderr.write("npm error 403 Forbidden - You cannot publish over the previously published versions: 0.1.0.\\n");
    process.exit(1);
  }
  process.exit(0);
}

if (args[0] === "access") {
  process.exit(0);
}

process.stderr.write("unexpected npm command " + args.join(" ") + "\\n");
process.exit(1);
`;
}
