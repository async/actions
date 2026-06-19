import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

const script = new URL("../scripts/hygiene.mjs", import.meta.url);

test("hygiene action writes advisory evidence in report mode", () => {
  const dir = mkdtempSync(join(tmpdir(), "async-actions-hygiene-report-"));
  try {
    const result = runHygiene(dir, {
      INPUT_MODE: "report",
      INPUT_PROFILES: "package,github,docs",
      INPUT_HYGIENE_COMMAND: mockCommand({
        ok: false,
        mode: "package",
        gates: [
          { id: "workflow", ok: false, title: "Workflow hygiene", messages: ["workflow drift"] }
        ],
        failures: ["workflow: workflow drift"]
      }, 1)
    });

    assert.equal(result.status, 0, result.stderr);
    const manifest = JSON.parse(readFileSync(join(dir, ".async/hygiene/manifest.json"), "utf8"));
    assert.equal(manifest.generatedBy, "async/actions/hygiene");
    assert.equal(manifest.status, "passed-with-warnings");
    assert.equal(manifest.findingCount, 1);
    assert.equal(manifest.blockingFindingCount, 0);
    assert.deepEqual(manifest.profiles, ["package", "github", "docs"]);
    const findings = JSON.parse(readFileSync(join(dir, ".async/hygiene/findings.json"), "utf8"));
    assert.equal(findings.findings[0].profile, "github");
    assert.equal(findings.findings[0].blocking, false);
    assert.equal(existsSync(join(dir, ".async/hygiene/summary.md")), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hygiene action fails blocking check mode on findings", () => {
  const dir = mkdtempSync(join(tmpdir(), "async-actions-hygiene-check-"));
  try {
    const result = runHygiene(dir, {
      INPUT_MODE: "check",
      INPUT_PROFILES: "repo",
      INPUT_HYGIENE_COMMAND: mockCommand({
        ok: false,
        mode: "app",
        gates: [
          { id: "unused", ok: false, title: "Unused files", messages: ["unused export"] }
        ],
        failures: ["unused: unused export"]
      }, 1)
    });

    assert.equal(result.status, 1);
    const manifest = JSON.parse(readFileSync(join(dir, ".async/hygiene/manifest.json"), "utf8"));
    assert.equal(manifest.status, "failed");
    assert.equal(manifest.blockingFindingCount, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hygiene action treats release-gated report mode as blocking on release events", () => {
  const dir = mkdtempSync(join(tmpdir(), "async-actions-hygiene-release-"));
  try {
    const result = runHygiene(dir, {
      GITHUB_EVENT_NAME: "release",
      INPUT_MODE: "report",
      INPUT_RELEASE_GATE: "true",
      INPUT_HYGIENE_COMMAND: mockCommand({
        ok: false,
        mode: "package",
        gates: [
          { id: "package", ok: false, title: "Package hygiene", messages: ["bad package metadata"] }
        ],
        failures: ["package: bad package metadata"]
      }, 1)
    });

    assert.equal(result.status, 1);
    const manifest = JSON.parse(readFileSync(join(dir, ".async/hygiene/manifest.json"), "utf8"));
    assert.equal(manifest.effectiveMode, "release");
    assert.equal(manifest.blockingFindingCount, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hygiene action validates generated path inputs", () => {
  const dir = mkdtempSync(join(tmpdir(), "async-actions-hygiene-paths-"));
  try {
    const unsafe = runHygiene(dir, {
      INPUT_EVIDENCE_DIR: "../outside",
      INPUT_HYGIENE_COMMAND: mockCommand({ ok: true, mode: "app", gates: [], failures: [] }, 0)
    });

    assert.notEqual(unsafe.status, 0);
    assert.match(unsafe.stderr, /Unsafe repository path/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("hygiene action resolves repo-local async-hygiene by default", () => {
  const dir = mkdtempSync(join(tmpdir(), "async-actions-hygiene-local-bin-"));
  try {
    const binDir = join(dir, "node_modules/.bin");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(
      join(binDir, "async-hygiene"),
      [
        "#!/bin/sh",
        "printf '%s\\n' '{\"ok\":true,\"mode\":\"package\",\"gates\":[],\"failures\":[]}'"
      ].join("\n"),
      { mode: 0o755 }
    );

    const result = runHygiene(dir, {
      INPUT_MODE: "report",
      INPUT_PROFILES: "package",
      PATH: "/usr/bin:/bin"
    });

    assert.equal(result.status, 0, result.stderr);
    const manifest = JSON.parse(readFileSync(join(dir, ".async/hygiene/manifest.json"), "utf8"));
    assert.equal(manifest.status, "passed");
    assert.equal(manifest.findingCount, 0);
    assert.match(manifest.command, /node_modules\/\.bin\/async-hygiene/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function runHygiene(cwd, env) {
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

function mockCommand(report, exitCode) {
  const script = `console.log(${JSON.stringify(JSON.stringify(report))}); process.exit(${exitCode});`;
  return `${process.execPath} -e ${JSON.stringify(script)}`;
}
