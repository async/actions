import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const script = new URL("../scripts/contract.mjs", import.meta.url);

test("contract action writes API, claims, and schema evidence in report mode", () => {
  const dir = mkdtempSync(join(tmpdir(), "async-actions-contract-report-"));
  try {
    mkdirSync(join(dir, "schemas"), { recursive: true });
    writeFileSync(join(dir, "api-contract.json"), JSON.stringify({ package: "fixture" }), "utf8");
    mkdirSync(join(dir, "tests"), { recursive: true });
    writeFileSync(join(dir, "tests/claims.json"), JSON.stringify({ claims: [] }), "utf8");
    writeFileSync(join(dir, "schemas/user.json"), JSON.stringify({ $schema: "https://json-schema.org/draft/2020-12/schema", type: "object" }), "utf8");

    const result = runContract(dir, {
      INPUT_MODE: "report",
      INPUT_CHECKS: "api,claims,schema",
      INPUT_SCHEMA_SOURCES: "schemas/*.json"
    });

    assert.equal(result.status, 0, result.stderr);
    const manifest = JSON.parse(readFileSync(join(dir, ".async/contract/manifest.json"), "utf8"));
    assert.equal(manifest.generatedBy, "async/actions/contract");
    assert.equal(manifest.status, "passed");
    assert.equal(manifest.reports.api.path, ".async/contract/api.json");
    assert.equal(manifest.reports.claims.path, ".async/contract/claims.json");
    assert.equal(manifest.reports.schema.path, ".async/contract/schema.json");
    assert.equal(JSON.parse(readFileSync(join(dir, ".async/contract/schema.json"), "utf8")).schemas[0].kind, "json-schema");
    assert.equal(existsSync(join(dir, ".async/contract/summary.md")), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("contract action fails blocking modes when a configured package CLI command fails", () => {
  const dir = mkdtempSync(join(tmpdir(), "async-actions-contract-fail-"));
  try {
    const result = runContract(dir, {
      INPUT_MODE: "check",
      INPUT_CHECKS: "api",
      INPUT_API_COMMAND: "node -e 'process.exit(7)'"
    });

    assert.equal(result.status, 1);
    const manifest = JSON.parse(readFileSync(join(dir, ".async/contract/manifest.json"), "utf8"));
    assert.equal(manifest.status, "failed");
    assert.equal(manifest.breakingChangeCount, 1);
    assert.match(JSON.stringify(manifest.findings), /api contract command failed/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("contract action keeps report mode advisory when evidence is missing", () => {
  const dir = mkdtempSync(join(tmpdir(), "async-actions-contract-advisory-"));
  try {
    const result = runContract(dir, {
      INPUT_MODE: "report",
      INPUT_CHECKS: "api,claims"
    });

    assert.equal(result.status, 0, result.stderr);
    const manifest = JSON.parse(readFileSync(join(dir, ".async/contract/manifest.json"), "utf8"));
    assert.equal(manifest.status, "passed-with-warnings");
    assert.equal(manifest.findings.length, 2);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("contract action fails strict mode when required reports are missing", () => {
  const dir = mkdtempSync(join(tmpdir(), "async-actions-contract-strict-"));
  try {
    const result = runContract(dir, {
      INPUT_MODE: "strict",
      INPUT_CHECKS: "api,claims"
    });

    assert.equal(result.status, 1);
    const manifest = JSON.parse(readFileSync(join(dir, ".async/contract/manifest.json"), "utf8"));
    assert.equal(manifest.breakingChangeCount, 1);
    assert.equal(manifest.unresolvedClaimCount, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("contract action validates schema sources and rejects unsafe paths", () => {
  const dir = mkdtempSync(join(tmpdir(), "async-actions-contract-schema-"));
  try {
    mkdirSync(join(dir, "schemas"), { recursive: true });
    writeFileSync(join(dir, "schemas/bad.json"), "{ nope", "utf8");
    const invalid = runContract(dir, {
      INPUT_MODE: "check",
      INPUT_CHECKS: "schema",
      INPUT_SCHEMA_SOURCES: "schemas/*.json"
    });
    assert.equal(invalid.status, 1);
    const manifestText = readFileSync(join(dir, ".async/contract/manifest.json"), "utf8");
    assert.match(manifestText, /"status": "failed"/u);
    assert.match(manifestText, /schemas\/bad\.json/u);

    const unsafe = runContract(dir, {
      INPUT_CHECKS: "schema",
      INPUT_SCHEMA_SOURCES: "../outside.json"
    });
    assert.notEqual(unsafe.status, 0);
    assert.match(unsafe.stderr, /Unsafe repository path/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function runContract(cwd, env) {
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
