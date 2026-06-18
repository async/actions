import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const script = new URL("../scripts/storage.mjs", import.meta.url);

test("storage action writes JSON state and receipts", () => {
  const dir = mkdtempSync(join(tmpdir(), "async-actions-storage-"));
  try {
    const result = runStorage(dir, {
      INPUT_MODE: "write",
      INPUT_PATH: ".async/state.json",
      INPUT_VALUE: "{\"ready\":true}",
      INPUT_RECEIPT_PATH: ".async/receipts/state.json"
    });

    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(join(dir, ".async/state.json"), "utf8")), { ready: true });
    const receipt = JSON.parse(readFileSync(join(dir, ".async/receipts/state.json"), "utf8"));
    assert.equal(receipt.action, "write");
    assert.equal(receipt.changed, true);
    assert.equal(receipt.files[0].path, ".async/state.json");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("storage action reads existing state through GITHUB_OUTPUT", () => {
  const dir = mkdtempSync(join(tmpdir(), "async-actions-storage-read-"));
  try {
    writeFileSync(join(dir, "state.json"), "{\"status\":\"ok\"}\n", "utf8");
    const outputPath = join(dir, "outputs.txt");
    const result = runStorage(dir, {
      GITHUB_OUTPUT: outputPath,
      INPUT_MODE: "read",
      INPUT_PATH: "state.json"
    });

    assert.equal(result.status, 0, result.stderr);
    const output = readFileSync(outputPath, "utf8");
    assert.match(output, /exists=true/u);
    assert.match(output, /value<<async_actions_/u);
    assert.match(output, /"status":"ok"/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("storage action applies safe change sets and rejects workflow writes by default", () => {
  const dir = mkdtempSync(join(tmpdir(), "async-actions-storage-change-set-"));
  try {
    writeFileSync(join(dir, "change-set.json"), JSON.stringify({
      id: "cs_1",
      files: [
        { path: "docs/example.md", action: "upsert", content: "# Example\n" }
      ]
    }), "utf8");

    const applied = runStorage(dir, {
      INPUT_MODE: "apply-change-set",
      INPUT_CHANGE_SET: "change-set.json",
      INPUT_RECEIPT_PATH: ".async/receipts/change-set.json"
    });
    assert.equal(applied.status, 0, applied.stderr);
    assert.equal(readFileSync(join(dir, "docs/example.md"), "utf8"), "# Example\n");

    writeFileSync(join(dir, "bad-change-set.json"), JSON.stringify({
      files: [
        { path: ".github/workflows/bad.yml", action: "upsert", content: "name: bad\n" }
      ]
    }), "utf8");
    const rejected = runStorage(dir, {
      INPUT_MODE: "apply-change-set",
      INPUT_CHANGE_SET: "bad-change-set.json"
    });
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /allow-workflow-paths/u);
    assert.equal(existsSync(join(dir, ".github/workflows/bad.yml")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("storage action can commit changed storage files", () => {
  const dir = mkdtempSync(join(tmpdir(), "async-actions-storage-commit-"));
  try {
    git(dir, "init", "-b", "main");
    writeFileSync(join(dir, "README.md"), "# Test\n", "utf8");
    git(dir, "add", "README.md");
    git(dir, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "Initial");

    const result = runStorage(dir, {
      INPUT_MODE: "write",
      INPUT_PATH: ".async/state.json",
      INPUT_VALUE: "{\"committed\":true}",
      INPUT_COMMIT: "true",
      INPUT_COMMIT_MESSAGE: "Store async state"
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(git(dir, "log", "-1", "--pretty=%s").stdout.trim(), "Store async state");
    assert.equal(git(dir, "status", "--short", ".async/state.json").stdout.trim(), "");
    assert.equal(git(dir, "status", "--short", ".async/actions/receipts/storage-receipt.json").stdout.trim(), "?? .async/actions/receipts/storage-receipt.json");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function runStorage(cwd, env) {
  return spawnSync(process.execPath, [script.pathname], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      INPUT_WORKING_DIRECTORY: ".",
      ...env
    }
  });
}

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result;
}
