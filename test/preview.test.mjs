import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("preview action emits package comment body for the generated comment action", () => {
  const dir = mkdtempSync(join(tmpdir(), "async-actions-preview-"));
  try {
    const bin = join(dir, "bin");
    const pkg = join(dir, "pkg");
    mkdirSync(bin);
    mkdirSync(join(pkg, "dist"), { recursive: true });
    writeFileSync(join(pkg, "package.json"), `${JSON.stringify({ name: "@async/example", version: "1.2.3" }, null, 2)}\n`, "utf8");
    writeFileSync(join(pkg, "dist", "index.js"), "export const ok = true;\n", "utf8");

    const eventPath = join(dir, "event.json");
    writeFileSync(eventPath, JSON.stringify({
      pull_request: {
        number: 12,
        head: {
          sha: "abc123",
          repo: { full_name: "async/example" }
        }
      }
    }), "utf8");

    const callsPath = join(dir, "npm-calls.jsonl");
    writeFileSync(join(bin, "npm"), fakeNpm(callsPath), { mode: 0o755 });
    const outputPath = join(dir, "output.txt");

    const result = spawnSync(process.execPath, [new URL("../scripts/preview.mjs", import.meta.url).pathname], {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        GITHUB_EVENT_PATH: eventPath,
        GITHUB_OUTPUT: outputPath,
        GITHUB_REPOSITORY: "async/example",
        GITHUB_REPOSITORY_OWNER: "async",
        GITHUB_SHA: "fallback-sha",
        GITHUB_TOKEN: "fake-token",
        INPUT_PACKAGE_PATH: "pkg",
        INPUT_MODE: "pr",
        INPUT_COMMENT: "true",
        INPUT_TARGET_REGISTRY: "https://npm.pkg.github.com"
      }
    });

    assert.equal(result.status, 0, result.stderr);
    const output = readFileSync(outputPath, "utf8");
    assert.match(output, /comment-marker=async-actions-package-preview/u);
    assert.match(output, /comment-body<<async_actions_/u);
    assert.match(output, /Preview for PR head `abc123`/u);
    assert.match(output, /pnpm add @async\/example@pr-12/u);

    const npmCalls = readFileSync(callsPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(npmCalls.map((call) => call.args[0]), ["view", "publish", "dist-tag"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function fakeNpm(callsPath) {
  return `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ args }) + "\\n");
if (args[0] === "view") {
  process.stderr.write("npm ERR! code E404\\nnot found\\n");
  process.exit(1);
}
process.exit(0);
`;
}
