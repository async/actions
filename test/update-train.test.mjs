import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const script = new URL("../scripts/update-train.mjs", import.meta.url).pathname;

test("update-train dispatches validated package updates to each repository", () => {
  const dir = mkdtempSync(join(tmpdir(), "async-actions-update-train-"));
  try {
    const bin = join(dir, "bin");
    const pkg = join(dir, "pkg");
    const capture = join(dir, "gh.jsonl");
    mkdirSync(bin);
    mkdirSync(pkg);
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@async/pipeline", version: "0.9.31" }), "utf8");
    writeFileSync(join(bin, "gh"), fakeGh(capture), { mode: 0o755 });

    const result = spawnSync(process.execPath, [script], {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        INPUT_PACKAGE_PATH: "pkg",
        INPUT_REPOSITORIES: "async/flow\nasync/framework",
        INPUT_EVENT_TYPE: "async-dep-bump",
        INPUT_GITHUB_TOKEN: "token",
        INPUT_SOURCE_REPOSITORY: "async/pipeline"
      }
    });

    assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
    const calls = readFileSync(capture, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(calls.length, 2);
    assert.deepEqual(calls.map((call) => call.repo), ["repos/async/flow/dispatches", "repos/async/framework/dispatches"]);
    assert.ok(calls.every((call) => call.args.includes("client_payload[package]=@async/pipeline")));
    assert.ok(calls.every((call) => call.args.includes("client_payload[version]=0.9.31")));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("update-train rejects invalid repository names before dispatch", () => {
  const dir = mkdtempSync(join(tmpdir(), "async-actions-update-train-invalid-"));
  try {
    mkdirSync(join(dir, "pkg"));
    writeFileSync(join(dir, "pkg", "package.json"), JSON.stringify({ name: "@async/pipeline", version: "0.9.31" }), "utf8");
    const result = spawnSync(process.execPath, [script], {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        INPUT_PACKAGE_PATH: "pkg",
        INPUT_REPOSITORIES: "../bad",
        INPUT_GITHUB_TOKEN: "token"
      }
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Invalid repository/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("update-train requires an explicit token", () => {
  const dir = mkdtempSync(join(tmpdir(), "async-actions-update-train-token-"));
  try {
    mkdirSync(join(dir, "pkg"));
    writeFileSync(join(dir, "pkg", "package.json"), JSON.stringify({ name: "@async/pipeline", version: "0.9.31" }), "utf8");
    const result = spawnSync(process.execPath, [script], {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        INPUT_PACKAGE_PATH: "pkg",
        INPUT_REPOSITORIES: "async/flow"
      }
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /github-token is required/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function fakeGh(capture) {
  return `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
if (args[0] !== "api") process.exit(2);
appendFileSync(${JSON.stringify(capture)}, JSON.stringify({ repo: args[1], args }) + "\\n");
process.exit(0);
`;
}
