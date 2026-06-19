import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("doctor action invokes async-release with explicit package and evidence inputs", () => {
  const dir = mkdtempSync(join(tmpdir(), "async-actions-doctor-"));
  try {
    const bin = join(dir, "bin");
    const pkg = join(dir, "pkg");
    mkdirSync(bin);
    mkdirSync(pkg);
    writeFileSync(join(pkg, "package.json"), JSON.stringify({ name: "@async/release", version: "0.1.0" }), "utf8");
    writeFileSync(join(bin, "async-release"), fakeAsyncRelease(join(dir, "args.json")), { mode: 0o755 });
    const outputPath = join(dir, "github-output.txt");

    const result = spawnSync(process.execPath, [new URL("../scripts/doctor.mjs", import.meta.url).pathname], {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        GITHUB_OUTPUT: outputPath,
        INPUT_MODE: "doctor",
        INPUT_PACKAGE_PATH: "pkg",
        INPUT_EVIDENCE_DIR: ".async/release",
        INPUT_NETWORK: "mock",
        INPUT_RELEASE_COMMAND: "async-release"
      }
    });

    assert.equal(result.status, 0, result.stderr);
    const args = JSON.parse(readFileSync(join(dir, "args.json"), "utf8"));
    assert.deepEqual(args.slice(0, 5), ["doctor", "--package", "pkg", "--evidence-dir", ".async/release"]);
    assert.ok(args.includes("--json"));
    assert.ok(args.includes("--network"));
    assert.match(readFileSync(outputPath, "utf8"), /package-name=@async\/release/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("doctor action supports package inspection mode and package profile input", () => {
  const dir = mkdtempSync(join(tmpdir(), "async-actions-doctor-inspect-"));
  try {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "async-release"), fakeAsyncRelease(join(dir, "args.json"), {
      package: { name: "@async/framework", version: "0.11.3", profile: "framework-browser" },
      bundleSizes: []
    }), "utf8");
    chmodSync(join(bin, "async-release"), 0o755);

    const result = spawnSync(process.execPath, [new URL("../scripts/doctor.mjs", import.meta.url).pathname], {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        INPUT_MODE: "inspect",
        INPUT_PACKAGE_PATH: ".",
        INPUT_PACKAGE_PROFILE: "framework-browser",
        INPUT_RELEASE_COMMAND: "async-release"
      }
    });

    assert.equal(result.status, 0, result.stderr);
    const args = JSON.parse(readFileSync(join(dir, "args.json"), "utf8"));
    assert.deepEqual(args.slice(0, 2), ["package", "inspect"]);
    assert.ok(args.includes("--package-profile"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function fakeAsyncRelease(outputPath, payload = {
  package: { name: "@async/release", version: "0.1.0" },
  network: "mock",
  status: "pass",
  checks: []
}) {
  return `#!/usr/bin/env node
const { writeFileSync } = require("node:fs");
const args = process.argv.slice(2);
writeFileSync(${JSON.stringify(outputPath)}, JSON.stringify(args));
process.stdout.write(JSON.stringify(${JSON.stringify(payload)}));
`;
}
