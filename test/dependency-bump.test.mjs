import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const script = new URL("../scripts/dependency-bump.mjs", import.meta.url).pathname;

test("dependency-bump preserves dependency section and pushes on green verification", () => {
  const dir = makeRepo();
  try {
    const result = runDependencyBump(dir, {
      INPUT_SUCCESS_MODE: "push",
      INPUT_VERIFY: "node -e \"process.exit(0)\""
    });

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
    assert.equal(manifest.devDependencies["@async/pipeline"], "0.9.31");
    assert.equal(manifest.dependencies.leftpad, "1.0.0");
    const commands = commandLog(dir);
    assert.ok(commands.some((entry) => entry.tool === "pnpm" && entry.args.join(" ") === "install --lockfile-only"));
    assert.ok(commands.some((entry) => entry.tool === "git" && entry.args.join(" ") === "push origin HEAD:main"));
    assert.match(result.stdout, /verify-status=passed/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dependency-bump opens a pull request when verification fails", () => {
  const dir = makeRepo();
  try {
    const result = runDependencyBump(dir, {
      INPUT_SUCCESS_MODE: "push",
      INPUT_FAILURE_MODE: "pull-request",
      INPUT_VERIFY: "node -e \"process.exit(1)\""
    });

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const commands = commandLog(dir);
    assert.ok(commands.some((entry) => entry.tool === "git" && entry.args.join(" ") === "checkout -B async/dependency-bump/async-pipeline-0.9.31"));
    assert.ok(commands.some((entry) => entry.tool === "gh" && entry.args.includes("create")));
    assert.match(result.stdout, /verify-status=failed/u);
    assert.match(result.stdout, /pull-request-url=https:\/\/example.test\/pr\/1/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dependency-bump rejects packages outside the allowlist", () => {
  const dir = makeRepo();
  try {
    const result = runDependencyBump(dir, {
      INPUT_ALLOWED_PACKAGES: "@async/framework"
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not in allowed-packages/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("dependency-bump rejects packages that are not direct dependencies", () => {
  const dir = makeRepo();
  try {
    const result = runDependencyBump(dir, {
      INPUT_PACKAGE_NAME: "@async/missing",
      INPUT_ALLOWED_PACKAGES: "@async/missing"
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /not a direct dependency/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "async-actions-dependency-bump-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(join(dir, "package.json"), JSON.stringify({
    name: "consumer",
    private: true,
    packageManager: "pnpm@11.1.0",
    dependencies: {
      leftpad: "1.0.0"
    },
    devDependencies: {
      "@async/pipeline": "0.9.30"
    }
  }, null, 2), "utf8");
  writeFileSync(join(dir, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n", "utf8");
  writeFileSync(join(bin, "pnpm"), fakeTool("pnpm"), { mode: 0o755 });
  writeFileSync(join(bin, "git"), fakeGit(), { mode: 0o755 });
  writeFileSync(join(bin, "gh"), fakeGh(), { mode: 0o755 });
  return dir;
}

function runDependencyBump(dir, env = {}) {
  return spawnSync(process.execPath, [script], {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${join(dir, "bin")}:${process.env.PATH}`,
      INPUT_PACKAGE_NAME: "@async/pipeline",
      INPUT_VERSION: "0.9.31",
      INPUT_ALLOWED_PACKAGES: "@async/pipeline",
      INPUT_REPOSITORY: "async/flow",
      INPUT_GITHUB_TOKEN: "token",
      ...env
    }
  });
}

function commandLog(dir) {
  return readFileSync(join(dir, "commands.jsonl"), "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function fakeTool(tool) {
  return `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
appendFileSync("commands.jsonl", JSON.stringify({ tool: ${JSON.stringify(tool)}, args: process.argv.slice(2) }) + "\\n");
process.exit(0);
`;
}

function fakeGit() {
  return `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync("commands.jsonl", JSON.stringify({ tool: "git", args }) + "\\n");
if (args[0] === "diff" && args[1] === "--name-only") {
  process.stdout.write("package.json\\npnpm-lock.yaml\\n");
  process.exit(0);
}
if (args[0] === "diff" && args[1] === "--cached" && args[2] === "--quiet") process.exit(1);
if (args[0] === "rev-parse") {
  process.stdout.write("abc123\\n");
  process.exit(0);
}
if (args[0] === "branch") {
  process.stdout.write("main\\n");
  process.exit(0);
}
process.exit(0);
`;
}

function fakeGh() {
  return `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync("commands.jsonl", JSON.stringify({ tool: "gh", args }) + "\\n");
if (args[0] === "pr" && args[1] === "list") process.exit(0);
if (args[0] === "pr" && args[1] === "create") {
  process.stdout.write("https://example.test/pr/1\\n");
  process.exit(0);
}
process.exit(0);
`;
}
