import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const script = new URL("../scripts/cache.mjs", import.meta.url);

test("cache restore plan emits generated keys and path lists", () => {
  const dir = createFixture();
  try {
    const outputPath = join(dir, "outputs.txt");
    const result = runCache(dir, {
      GITHUB_OUTPUT: outputPath,
      INPUT_MODE: "restore"
    });

    assert.equal(result.status, 0, result.stderr);
    const outputs = readFileSync(outputPath, "utf8");
    assert.match(outputs, /primary-key=async-pipeline-linux-verify/u);
    assert.match(outputs, /entry-count=2/u);
    assert.match(outputs, /paths<<async_actions_/u);
    assert.match(outputs, /.async\/cache\/tasks\/aaa111/u);
    assert.match(outputs, /.async\/cache\/tasks\/bbb222/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cache restore receipt records cache hits for evidence collection", () => {
  const dir = createFixture();
  try {
    const outputPath = join(dir, "outputs.txt");
    const summaryPath = join(dir, "summary.md");
    const result = runCache(dir, {
      ASYNC_ACTIONS_CACHE_PHASE: "receipt",
      ASYNC_ACTIONS_CACHE_HIT: "true",
      GITHUB_OUTPUT: outputPath,
      GITHUB_STEP_SUMMARY: summaryPath,
      INPUT_MODE: "restore"
    });

    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(readFileSync(join(dir, ".async/actions/receipts/cache-verify-restore.json"), "utf8"));
    assert.equal(receipt.kind, "cache");
    assert.equal(receipt.action, "restore");
    assert.equal(receipt.status, "hit");
    assert.equal(receipt.cacheHit, true);
    assert.equal(receipt.restoredCount, 2);
    assert.equal(receipt.files.every((file) => file.path.startsWith(".async/cache/tasks/")), true);
    assert.match(readFileSync(summaryPath, "utf8"), /Async task cache restore/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cache save respects read-only trust and read-write manifest entries", () => {
  const dir = createFixture();
  try {
    const readOnly = runCache(dir, {
      ASYNC_ACTIONS_CACHE_PHASE: "receipt",
      GITHUB_OUTPUT: join(dir, "readonly-outputs.txt"),
      INPUT_MODE: "save",
      INPUT_TRUST: "read-only"
    });
    assert.equal(readOnly.status, 0, readOnly.stderr);
    const skipped = JSON.parse(readFileSync(join(dir, ".async/actions/receipts/cache-verify-save.json"), "utf8"));
    assert.equal(skipped.status, "skipped");
    assert.equal(skipped.savedCount, 0);
    assert.equal(skipped.reason, "read-only trust cannot save caches");

    const readWrite = runCache(dir, {
      ASYNC_ACTIONS_CACHE_PHASE: "receipt",
      ASYNC_ACTIONS_CACHE_SAVE_OUTCOME: "success",
      GITHUB_OUTPUT: join(dir, "readwrite-outputs.txt"),
      INPUT_MODE: "save",
      INPUT_TRUST: "read-write",
      INPUT_RECEIPT_PATH: ".async/actions/receipts/cache-save-readwrite.json"
    });
    assert.equal(readWrite.status, 0, readWrite.stderr);
    const saved = JSON.parse(readFileSync(join(dir, ".async/actions/receipts/cache-save-readwrite.json"), "utf8"));
    assert.equal(saved.status, "saved");
    assert.equal(saved.savedCount, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("cache rejects unsafe manifests, keys, and paths", () => {
  const dir = createFixture();
  try {
    const unsafePath = runCache(dir, {
      INPUT_MANIFEST: "../cache-manifest.json"
    });
    assert.notEqual(unsafePath.status, 0);
    assert.match(unsafePath.stderr, /Unsafe repository path/u);

    const manifest = JSON.parse(readFileSync(join(dir, ".async/actions/cache/cache-manifest.json"), "utf8"));
    manifest.entries[0].paths = ["../outside"];
    writeFileSync(join(dir, ".async/actions/cache/cache-manifest.json"), JSON.stringify(manifest), "utf8");
    const unsafeEntryPath = runCache(dir);
    assert.notEqual(unsafeEntryPath.status, 0);
    assert.match(unsafeEntryPath.stderr, /Unsafe repository path/u);

    manifest.entries[0].paths = [".async/cache/tasks/aaa111"];
    manifest.entries[0].key = "../bad";
    writeFileSync(join(dir, ".async/actions/cache/cache-manifest.json"), JSON.stringify(manifest), "utf8");
    const unsafeKey = runCache(dir);
    assert.notEqual(unsafeKey.status, 0);
    assert.match(unsafeKey.stderr, /key is not safe/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createFixture() {
  const dir = mkdtempSync(join(tmpdir(), "async-actions-cache-"));
  mkdirSync(join(dir, ".async/actions/cache"), { recursive: true });
  mkdirSync(join(dir, ".async/cache/tasks/aaa111"), { recursive: true });
  mkdirSync(join(dir, ".async/cache/tasks/bbb222"), { recursive: true });
  writeFileSync(join(dir, ".async/cache/tasks/aaa111/result.json"), "{}\n", "utf8");
  writeFileSync(join(dir, ".async/cache/tasks/bbb222/result.json"), "{}\n", "utf8");
  const manifest = {
    version: 1,
    generatedBy: "@async/pipeline",
    job: "verify",
    trust: "read-only",
    primaryKey: "async-pipeline-linux-verify",
    restoreKeys: [],
    entries: [
      {
        id: "task:test",
        task: "test",
        key: "async-pipeline-linux-test-aaa111",
        restoreKeys: [],
        paths: [".async/cache/tasks/aaa111"],
        writeAllowed: true
      },
      {
        id: "task:lint",
        task: "lint",
        key: "async-pipeline-linux-lint-bbb222",
        restoreKeys: [],
        paths: [".async/cache/tasks/bbb222"],
        writeAllowed: false
      }
    ]
  };
  writeFileSync(join(dir, ".async/actions/cache/cache-manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  return dir;
}

function runCache(cwd, env = {}) {
  return spawnSync(process.execPath, [script.pathname], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      RUNNER_OS: "linux",
      INPUT_WORKING_DIRECTORY: ".",
      INPUT_MANIFEST: ".async/actions/cache/cache-manifest.json",
      ...env
    }
  });
}
