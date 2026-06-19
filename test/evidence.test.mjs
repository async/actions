import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const script = new URL("../scripts/evidence.mjs", import.meta.url);

test("evidence action collects files, hashes, summaries, and sanitized receipts", () => {
  const dir = mkdtempSync(join(tmpdir(), "async-actions-evidence-"));
  try {
    writeFileSync(join(dir, "summary.md"), "ok\n", "utf8");
    mkdirSync(join(dir, "receipts"), { recursive: true });
    writeFileSync(join(dir, "receipts/receipt.json"), JSON.stringify({
      changeSetId: "cs_1",
      leaseId: "lease_1",
      leaseExpiresAt: "2026-06-18T18:10:00Z",
      worker: "actions",
      status: "applied",
      evidencePath: ".async/agent-evidence/manifest.json",
      bundlePath: ".async/agent-evidence/bundle.json",
      patchCount: 1,
      reportCount: 1,
      transcriptCount: 1,
      contextPackCount: 1,
      redacted: true,
      token: "should-not-appear",
      files: [{ path: "docs/example.md", action: "upsert", changed: true }]
    }), "utf8");

    const result = runEvidence(dir, {
      INPUT_PATHS: "summary.md",
      INPUT_RECEIPT_PATHS: "receipts/**/*.json",
      INPUT_MANIFEST_PATH: ".async/evidence/manifest.json",
      INPUT_SUMMARY_PATH: ".async/evidence/summary.md",
      INPUT_ARTIFACT_NAME: "async-evidence-test"
    });

    assert.equal(result.status, 0, result.stderr);
    const manifestText = readFileSync(join(dir, ".async/evidence/manifest.json"), "utf8");
    const manifest = JSON.parse(manifestText);
    assert.equal(manifest.generatedBy, "async/actions/evidence");
    assert.equal(manifest.artifactName, "async-evidence-test");
    assert.equal(manifest.files[0].path, "summary.md");
    assert.equal(manifest.files[0].sha256.length, 64);
    assert.equal(manifest.receipts[0].kind, "bridge");
    assert.equal(manifest.receipts[0].leaseId, "lease_1");
    assert.equal(manifest.receipts[0].bundlePath, ".async/agent-evidence/bundle.json");
    assert.equal(manifest.receipts[0].patchCount, 1);
    assert.equal(manifest.receipts[0].redacted, true);
    assert.equal(manifest.receipts[0].files[0].path, "docs/example.md");
    assert.doesNotMatch(manifestText, /should-not-appear/u);
    assert.equal(existsSync(join(dir, ".async/evidence/summary.md")), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("evidence action rejects paths outside the working directory", () => {
  const dir = mkdtempSync(join(tmpdir(), "async-actions-evidence-path-"));
  try {
    const result = runEvidence(dir, {
      INPUT_PATHS: "../outside.txt"
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Unsafe repository path/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("evidence action can fail when required files are missing", () => {
  const dir = mkdtempSync(join(tmpdir(), "async-actions-evidence-missing-"));
  try {
    const result = runEvidence(dir, {
      INPUT_PATHS: "missing",
      INPUT_IF_NO_FILES_FOUND: "error"
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /No evidence files matched/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("evidence action validates upload mode manifests", () => {
  const dir = mkdtempSync(join(tmpdir(), "async-actions-evidence-upload-"));
  try {
    writeFileSync(join(dir, "manifest.json"), JSON.stringify({
      version: 1,
      id: "manifest-1",
      generatedBy: "async/actions/evidence",
      artifactName: "async-evidence-upload",
      files: []
    }), "utf8");
    const outputPath = join(dir, "outputs.txt");
    const result = runEvidence(dir, {
      GITHUB_OUTPUT: outputPath,
      INPUT_MODE: "upload",
      INPUT_MANIFEST_PATH: "manifest.json",
      INPUT_ARTIFACT_NAME: "async-evidence-upload"
    });
    assert.equal(result.status, 0, result.stderr);
    assert.match(readFileSync(outputPath, "utf8"), /file-count=0/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("evidence action merges manifests and rejects duplicate ids", () => {
  const dir = mkdtempSync(join(tmpdir(), "async-actions-evidence-merge-"));
  try {
    writeFileSync(join(dir, "one.json"), JSON.stringify({
      version: 1,
      id: "duplicate",
      generatedBy: "async/actions/evidence",
      artifactName: "one",
      files: [{ path: "a.txt", kind: "file", bytes: 1, sha256: "a".repeat(64) }]
    }), "utf8");
    writeFileSync(join(dir, "two.json"), JSON.stringify({
      version: 1,
      id: "duplicate",
      generatedBy: "async/actions/evidence",
      artifactName: "two",
      files: []
    }), "utf8");

    const result = runEvidence(dir, {
      INPUT_MODE: "merge",
      INPUT_MERGE_DIRECTORY: ".",
      INPUT_MANIFEST_PATH: ".async/evidence/index.json"
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Duplicate evidence manifest id duplicate/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function runEvidence(cwd, env) {
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
