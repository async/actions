import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const script = new URL("../scripts/source-impact.mjs", import.meta.url);

test("source-impact plan emits generated matrix JSON and conservative changed-source counts", () => {
  const dir = createFixture();
  try {
    writeFileSync(join(dir, "changed.txt"), "repos/app/src/index.js\nREADME.md\n", "utf8");
    const outputPath = join(dir, "outputs.txt");
    const result = runSourceImpact(dir, {
      GITHUB_OUTPUT: outputPath,
      INPUT_MODE: "plan",
      INPUT_CHANGED_FILES: "changed.txt"
    });

    assert.equal(result.status, 0, result.stderr);
    const outputs = readFileSync(outputPath, "utf8");
    assert.match(outputs, /source-count=2/u);
    assert.match(outputs, /changed-source-count=1/u);
    const matrix = JSON.parse(outputs.match(/matrix=(.*)/u)?.[1] ?? "{}");
    assert.deepEqual(matrix.include.map((row) => row.task), ["app:test"]);
    assert.equal(existsSync(join(dir, ".async/actions/receipts/source-impact-verifyImpact-plan.json")), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("source-impact checkout validates source metadata and writes a sanitized receipt", () => {
  const dir = createFixture();
  try {
    const result = runSourceImpact(dir, {
      INPUT_MODE: "checkout",
      INPUT_SOURCE_ID: "app",
      INPUT_PATH: "repos/app"
    });

    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(readFileSync(join(dir, ".async/actions/receipts/source-impact-app.json"), "utf8"));
    assert.equal(receipt.kind, "source-impact");
    assert.equal(receipt.action, "checkout");
    assert.equal(receipt.id, "app");
    assert.equal(receipt.path, "repos/app");
    assert.equal(receipt.files[0].path, "repos/app");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("source-impact prepare runs representable generated commands", () => {
  const dir = createFixture();
  try {
    const result = runSourceImpact(dir, {
      INPUT_MODE: "prepare",
      INPUT_SOURCE_ID: "app"
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(join(dir, "repos/app/prepared.txt"), "utf8"), "ready\n");
    const receipt = JSON.parse(readFileSync(join(dir, ".async/actions/receipts/source-impact-app.json"), "utf8"));
    assert.equal(receipt.action, "prepare");
    assert.equal(receipt.status, "prepared");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("source-impact receipt mode records declared source receipts", () => {
  const dir = createFixture();
  try {
    const result = runSourceImpact(dir, {
      INPUT_MODE: "receipt",
      INPUT_SOURCE_ID: "lib",
      INPUT_RECEIPT_PATH: ".async/actions/receipts/lib-source.json"
    });

    assert.equal(result.status, 0, result.stderr);
    const receipt = JSON.parse(readFileSync(join(dir, ".async/actions/receipts/lib-source.json"), "utf8"));
    assert.equal(receipt.action, "receipt");
    assert.equal(receipt.repository, "lib");
    assert.equal(receipt.path, "repos/lib");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("source-impact rejects unknown sources, unsafe paths, and unsafe refs", () => {
  const dir = createFixture();
  try {
    const unknown = runSourceImpact(dir, {
      INPUT_MODE: "checkout",
      INPUT_SOURCE_ID: "missing"
    });
    assert.notEqual(unknown.status, 0);
    assert.match(unknown.stderr, /Unknown source-id/u);

    const unsafePath = runSourceImpact(dir, {
      INPUT_SOURCE_PLAN: "../plan.json"
    });
    assert.notEqual(unsafePath.status, 0);
    assert.match(unsafePath.stderr, /Unsafe repository path/u);

    const unsafePlan = JSON.parse(readFileSync(join(dir, ".async/actions/source-impact/source-plan.json"), "utf8"));
    unsafePlan.sources.git = {
      id: "git",
      type: "git",
      url: "https://github.com/async/example.git",
      ref: "main",
      path: ".async/sources/git/hash",
      prepare: []
    };
    unsafePlan.matrix.include.push({ task: "git:test", source: "git", taskId: "test", type: "git", url: unsafePlan.sources.git.url, ref: "main", path: unsafePlan.sources.git.path });
    writeFileSync(join(dir, ".async/actions/source-impact/source-plan.json"), JSON.stringify(unsafePlan), "utf8");

    const unsafeRef = runSourceImpact(dir, {
      INPUT_MODE: "checkout",
      INPUT_SOURCE_ID: "git"
    });
    assert.notEqual(unsafeRef.status, 0);
    assert.match(unsafeRef.stderr, /full SHA or generated-safe ref/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createFixture() {
  const dir = mkdtempSync(join(tmpdir(), "async-actions-source-impact-"));
  mkdirSync(join(dir, ".async/actions/source-impact"), { recursive: true });
  mkdirSync(join(dir, "repos/app"), { recursive: true });
  mkdirSync(join(dir, "repos/lib"), { recursive: true });
  const plan = {
    version: 1,
    generatedBy: "@async/pipeline",
    job: "verifyImpact",
    sources: {
      app: {
        id: "app",
        type: "path",
        path: "repos/app",
        pipeline: "pipeline.js",
        prepare: ["printf 'ready\\n' > prepared.txt"]
      },
      lib: {
        id: "lib",
        type: "path",
        path: "repos/lib",
        pipeline: "pipeline.js",
        prepare: []
      }
    },
    matrix: {
      include: [
        { task: "app:test", source: "app", taskId: "test", type: "path", path: "repos/app" },
        { task: "lib:test", source: "lib", taskId: "test", type: "path", path: "repos/lib" }
      ]
    }
  };
  writeFileSync(join(dir, ".async/actions/source-impact/source-plan.json"), JSON.stringify(plan, null, 2), "utf8");
  return dir;
}

function runSourceImpact(cwd, env) {
  return spawnSync(process.execPath, [script.pathname], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      INPUT_WORKING_DIRECTORY: ".",
      INPUT_SOURCE_PLAN: ".async/actions/source-impact/source-plan.json",
      ...env
    }
  });
}
