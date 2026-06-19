import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const script = new URL("../scripts/attest.mjs", import.meta.url);

test("attest digest mode writes subject manifest, tarball scan, and receipt evidence", () => {
  const dir = createTarballFixture();
  try {
    const result = runAttest(dir, {
      INPUT_MODE: "digest",
      INPUT_PACKAGE_PATH: "package",
      INPUT_ARTIFACTS: "package.tgz",
      INPUT_TARBALL_SCAN: "true"
    });

    assert.equal(result.status, 0, result.stderr);
    const manifest = JSON.parse(readFileSync(join(dir, ".async/attest/subjects.json"), "utf8"));
    assert.equal(manifest.generatedBy, "async/actions/attest");
    assert.equal(manifest.subjects[0].path, "package.tgz");
    assert.equal(manifest.subjects[0].kind, "npm-tarball");
    assert.equal(manifest.subjects[0].sha256.length, 64);
    assert.equal(manifest.checks.tarballScan.status, "passed");
    assert.equal(manifest.checks.tarballScan.tarballCount, 1);

    const receipt = JSON.parse(readFileSync(join(dir, ".async/actions/receipts/attest.json"), "utf8"));
    assert.equal(receipt.kind, "attest");
    assert.equal(receipt.action, "digest");
    assert.equal(receipt.status, "passed");
    assert.equal(receipt.subjects[0].path, "package.tgz");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("attest sbom mode writes deterministic package component evidence", () => {
  const dir = createTarballFixture();
  try {
    const result = runAttest(dir, {
      INPUT_MODE: "sbom",
      INPUT_PACKAGE_PATH: "package",
      INPUT_ARTIFACTS: "package/package.json"
    });

    assert.equal(result.status, 0, result.stderr);
    const sbom = JSON.parse(readFileSync(join(dir, ".async/attest/sbom.json"), "utf8"));
    assert.equal(sbom.bomFormat, "CycloneDX");
    assert.equal(sbom.metadata.component.name, "@async/example");
    assert.equal(sbom.metadata.component.version, "1.2.3");
    assert.equal(sbom.components[0].name, "package/package.json");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("attest verify mode parses npm provenance verification results", () => {
  const dir = createTarballFixture();
  try {
    const digest = runAttest(dir, {
      INPUT_MODE: "digest",
      INPUT_PACKAGE_PATH: "package",
      INPUT_ARTIFACTS: "package.tgz"
    });
    assert.equal(digest.status, 0, digest.stderr);

    writeFileSync(join(dir, "verification.json"), JSON.stringify({ npmProvenance: "failed" }), "utf8");
    const failed = runAttest(dir, {
      INPUT_MODE: "verify",
      INPUT_REQUIRE_NPM_PROVENANCE: "true",
      INPUT_VERIFICATION_RESULTS: "verification.json"
    });
    assert.notEqual(failed.status, 0);
    assert.match(failed.stderr, /Attestation verification failed/u);

    writeFileSync(join(dir, "verification.json"), JSON.stringify({ npmProvenance: "passed" }), "utf8");
    const passed = runAttest(dir, {
      INPUT_MODE: "verify",
      INPUT_REQUIRE_NPM_PROVENANCE: "true",
      INPUT_VERIFICATION_RESULTS: "verification.json",
      INPUT_TARBALL_SCAN: "true"
    });
    assert.equal(passed.status, 0, passed.stderr);
    const receipt = JSON.parse(readFileSync(join(dir, ".async/actions/receipts/attest.json"), "utf8"));
    assert.equal(receipt.action, "verify");
    assert.equal(receipt.checks.npmProvenance.status, "passed");
    assert.equal(receipt.checks.digest.status, "passed");
    assert.equal(receipt.checks.tarballScan.status, "passed");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("attest rejects unsafe subject paths", () => {
  const dir = createTarballFixture();
  try {
    const result = runAttest(dir, {
      INPUT_ARTIFACTS: "../package.tgz"
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Unsafe repository path/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function createTarballFixture() {
  const dir = mkdtempSync(join(tmpdir(), "async-actions-attest-"));
  mkdirSync(join(dir, "package"), { recursive: true });
  writeFileSync(join(dir, "package/package.json"), JSON.stringify({ name: "@async/example", version: "1.2.3" }), "utf8");
  const tar = spawnSync("tar", ["-czf", "package.tgz", "-C", "package", "package.json"], { cwd: dir, encoding: "utf8" });
  assert.equal(tar.status, 0, tar.stderr);
  return dir;
}

function runAttest(cwd, env = {}) {
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
