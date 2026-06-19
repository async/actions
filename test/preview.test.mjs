import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("preview action publishes same-repo PR using @async/release plan and stage evidence", () => {
  const context = createPreviewContext("pr");
  try {
    const result = runPreview(context);

    assert.equal(result.status, 0, result.stderr);
    const output = readFileSync(context.outputPath, "utf8");
    assert.match(output, /comment-marker=async-actions-package-preview/u);
    assert.match(output, /comment-body<<async_actions_/u);
    assert.match(output, /Preview for PR head `abc123`/u);
    assert.match(output, /pnpm add @async\/example@pr-12/u);
    assert.match(output, /package-spec=@async\/example@0\.0\.0-pr\.12\.sha\.abc123/u);

    const npmCalls = readCalls(context.callsPath);
    assert.deepEqual(npmCalls.map((call) => call.kind), ["release-plan", "release-stage", "view", "publish", "dist-tag"]);
    assert.equal(npmCalls[1].stageManifest.name, "@async/example");
    assert.equal(npmCalls[1].stageManifest.version, "0.0.0-pr.12.sha.abc123");
    assert.equal(npmCalls[1].stageManifest.publishConfig.registry, "https://npm.pkg.github.com");
  } finally {
    rmSync(context.dir, { recursive: true, force: true });
  }
});

test("preview action skips fork PRs before npm auth, publish, or dist-tag writes", () => {
  const context = createPreviewContext("pr", { headRepo: "fork/example" });
  try {
    const result = runPreview(context);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Skipping preview publish: PR head fork\/example is not async\/example/u);
    const npmCalls = readCalls(context.callsPath);
    assert.deepEqual(npmCalls.map((call) => call.kind), ["release-plan"]);
    assert.equal(readFileSync(context.outputPath, "utf8"), "");
  } finally {
    rmSync(context.dir, { recursive: true, force: true });
  }
});

test("preview action publishes main snapshots and moves the main dist-tag", () => {
  const context = createPreviewContext("main");
  try {
    const result = runPreview(context, { INPUT_MODE: "main", INPUT_COMMENT: "false" });

    assert.equal(result.status, 0, result.stderr);
    const output = readFileSync(context.outputPath, "utf8");
    assert.match(output, /package-spec=@async\/example@0\.0\.0-main\.sha\.mainsha/u);
    assert.match(output, /published-version=0\.0\.0-main\.sha\.mainsha/u);
    assert.match(output, /dist-tag=main/u);
    const npmCalls = readCalls(context.callsPath);
    assert.deepEqual(npmCalls.map((call) => call.kind), ["release-plan", "release-stage", "view", "publish", "dist-tag"]);
  } finally {
    rmSync(context.dir, { recursive: true, force: true });
  }
});

test("preview action can publish immutable versions without moving stale mutable tags", () => {
  const context = createPreviewContext("pr");
  try {
    const result = runPreview(context, { INPUT_MOVE_DIST_TAG: "false" });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /move-dist-tag=false/u);
    const npmCalls = readCalls(context.callsPath);
    assert.deepEqual(npmCalls.map((call) => call.kind), ["release-plan", "release-stage", "view", "publish"]);
  } finally {
    rmSync(context.dir, { recursive: true, force: true });
  }
});

test("preview action skips publish for existing immutable versions and still moves allowed dist-tags", () => {
  const context = createPreviewContext("pr", { versionExists: true });
  try {
    const result = runPreview(context);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /already exists; skipping publish/u);
    const npmCalls = readCalls(context.callsPath);
    assert.deepEqual(npmCalls.map((call) => call.kind), ["release-plan", "release-stage", "view", "dist-tag"]);
  } finally {
    rmSync(context.dir, { recursive: true, force: true });
  }
});

test("preview action preserves custom namespace and registry from release evidence", () => {
  const context = createPreviewContext("pr", { sourceName: "plain-package" });
  try {
    const result = runPreview(context, {
      INPUT_NAMESPACE: "Async-Preview",
      INPUT_TARGET_REGISTRY: "https://npm.pkg.github.com/custom/"
    });

    assert.equal(result.status, 0, result.stderr);
    const output = readFileSync(context.outputPath, "utf8");
    assert.match(output, /package-spec=@async-preview\/plain-package@0\.0\.0-pr\.12\.sha\.abc123/u);
    assert.match(output, /plain-package@npm:@async-preview\/plain-package@pr-12/u);
    const npmCalls = readCalls(context.callsPath);
    assert.equal(npmCalls[1].stageManifest.publishConfig.registry, "https://npm.pkg.github.com/custom/");
  } finally {
    rmSync(context.dir, { recursive: true, force: true });
  }
});

function createPreviewContext(mode, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), "async-actions-preview-"));
  const bin = join(dir, "bin");
  const pkg = join(dir, "pkg");
  mkdirSync(bin);
  mkdirSync(join(pkg, "dist"), { recursive: true });
  writeFileSync(join(pkg, "package.json"), `${JSON.stringify({ name: options.sourceName ?? "@async/example", version: "1.2.3" }, null, 2)}\n`, "utf8");
  writeFileSync(join(pkg, "dist", "index.js"), "export const ok = true;\n", "utf8");

  const eventPath = join(dir, "event.json");
  writeFileSync(eventPath, JSON.stringify({
    pull_request: {
      number: 12,
      head: {
        sha: "abc123",
        repo: { full_name: options.headRepo ?? "async/example" }
      }
    }
  }), "utf8");

  const callsPath = join(dir, "npm-calls.jsonl");
  writeFileSync(join(bin, "npm"), fakeNpm(callsPath, { mode, versionExists: options.versionExists === true }), { mode: 0o755 });
  return {
    dir,
    bin,
    pkg,
    eventPath,
    callsPath,
    outputPath: join(dir, "output.txt"),
    summaryPath: join(dir, "summary.md")
  };
}

function runPreview(context, env = {}) {
  writeFileSync(context.outputPath, "", "utf8");
  writeFileSync(context.summaryPath, "", "utf8");
  return spawnSync(process.execPath, [new URL("../scripts/preview.mjs", import.meta.url).pathname], {
    cwd: context.dir,
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${context.bin}:${process.env.PATH}`,
      GITHUB_EVENT_PATH: context.eventPath,
      GITHUB_OUTPUT: context.outputPath,
      GITHUB_STEP_SUMMARY: context.summaryPath,
      GITHUB_REPOSITORY: "async/example",
      GITHUB_REPOSITORY_OWNER: "async",
      GITHUB_SHA: "mainsha",
      GITHUB_TOKEN: "fake-token",
      INPUT_PACKAGE_PATH: "pkg",
      INPUT_MODE: "pr",
      INPUT_COMMENT: "true",
      INPUT_TARGET_REGISTRY: "https://npm.pkg.github.com",
      INPUT_RELEASE_PACKAGE: "github:async/release#v0.1.3",
      ...env
    }
  });
}

function readCalls(callsPath) {
  const text = readFileSync(callsPath, "utf8").trim();
  return text ? text.split("\n").map((line) => JSON.parse(line)) : [];
}

function fakeNpm(callsPath, options) {
  return `#!/usr/bin/env node
const { appendFileSync, cpSync, mkdirSync, readFileSync, writeFileSync } = require("node:fs");
const { dirname, join, resolve } = require("node:path");
const args = process.argv.slice(2);
const callsPath = ${JSON.stringify(callsPath)};
const options = ${JSON.stringify(options)};

function record(call) {
  appendFileSync(callsPath, JSON.stringify(call) + "\\n");
}

function flag(name, fallback = "") {
  const index = args.lastIndexOf(name);
  return index === -1 ? fallback : args[index + 1];
}

function previewData() {
  const packagePath = flag("--package", ".");
  const manifest = JSON.parse(readFileSync(join(resolve(process.cwd(), packagePath), "package.json"), "utf8"));
  const mode = flag("--mode", "pr");
  const namespace = flag("--namespace", "async").replace(/^@/, "").toLowerCase();
  const leaf = manifest.name.startsWith("@") ? manifest.name.split("/")[1] : manifest.name;
  const mirrorName = "@" + namespace + "/" + leaf;
  const prNumber = flag("--pr-number", "12");
  const headSha = flag("--head-sha", "abc123");
  const sourceSha = flag("--source-sha", "mainsha");
  const distTag = mode === "main" ? "main" : "pr-" + prNumber;
  const version = mode === "main" ? "0.0.0-main.sha." + sourceSha : "0.0.0-pr." + prNumber + ".sha." + headSha;
  const target = mirrorName === manifest.name ? mirrorName + "@" + distTag : manifest.name + "@npm:" + mirrorName + "@" + distTag;
  const skipReason = flag("--skip-reason", "");
  return {
    manifest,
    mode,
    registry: flag("--registry", "https://npm.pkg.github.com"),
    stageDir: flag("--stage-dir", ""),
    skipReason,
    plan: {
      schemaVersion: 1,
      package: { name: manifest.name, version: manifest.version, packagePath },
      preview: {
        mode,
        sourceRepository: flag("--source-repository", null),
        sourceSha,
        pullRequestNumber: mode === "pr" ? Number(prNumber) : null,
        pullRequestHeadSha: mode === "pr" ? headSha : null,
        mirrorNamespace: namespace,
        mirrorPackageName: mirrorName,
        version: skipReason ? null : version,
        distTag: skipReason ? null : distTag,
        packageSpec: skipReason ? null : mirrorName + "@" + version
      },
      skip: { shouldSkip: Boolean(skipReason), reason: skipReason || null },
      install: skipReason ? null : {
        target,
        command: "pnpm add " + target,
        commentMarker: "async-actions-package-preview",
        commentBody: mode === "pr" ? "### Preview package\\n\\nPreview for PR head \`" + headSha + "\`, published as \`" + mirrorName + "\`.\\n\\n\`\`\`sh\\npnpm add " + target + "\\n\`\`\`" : ""
      }
    }
  };
}

if (args[0] === "exec") {
  const commandIndex = args.indexOf("async-release");
  const command = args[commandIndex + 2];
  const data = previewData();
  if (command === "plan") {
    record({ kind: "release-plan", skip: data.skipReason || null });
    process.stdout.write(JSON.stringify(data.plan));
    process.exit(0);
  }
  if (command === "stage") {
    mkdirSync(data.stageDir, { recursive: true });
    const stageManifest = {
      ...data.manifest,
      name: data.plan.preview.mirrorPackageName,
      version: data.plan.preview.version,
      publishConfig: { registry: data.registry }
    };
    delete stageManifest.scripts;
    delete stageManifest.devDependencies;
    writeFileSync(join(data.stageDir, "package.json"), JSON.stringify(stageManifest, null, 2) + "\\n");
    mkdirSync(join(data.stageDir, "dist"), { recursive: true });
    cpSync(join(resolve(process.cwd(), flag("--package", ".")), "dist", "index.js"), join(data.stageDir, "dist", "index.js"));
    record({ kind: "release-stage", stageManifest });
    process.stdout.write(JSON.stringify({ schemaVersion: 1, package: data.plan.package, preview: data.plan.preview, staging: { path: data.stageDir } }));
    process.exit(0);
  }
}

if (args[0] === "view") {
  record({ kind: "view", args });
  if (options.versionExists) {
    const manifest = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf8"));
    process.stdout.write(manifest.version + "\\n");
    process.exit(0);
  }
  process.stderr.write("npm ERR! code E404\\nnot found\\n");
  process.exit(1);
}

if (args[0] === "publish") {
  record({ kind: "publish", args });
  process.exit(0);
}

if (args[0] === "dist-tag") {
  record({ kind: "dist-tag", args });
  process.exit(0);
}

process.stderr.write("unexpected npm command " + args.join(" ") + "\\n");
process.exit(1);
`;
}
