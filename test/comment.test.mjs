import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

test("comment action updates an existing marked PR comment", () => {
  const run = runComment({
    comments: [{ id: 42, body: "<!-- async-preview -->\nold", html_url: "https://github.test/old", user: { login: "github-actions[bot]" } }],
    env: {
      INPUT_MODE: "pr-comment",
      INPUT_REPOSITORY: "async/pipeline",
      INPUT_NUMBER: "5",
      INPUT_MARKER: "async-preview",
      INPUT_BODY: "new body",
      INPUT_TOKEN: "fake-token"
    }
  });

  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(run.calls.map((call) => call.args.slice(0, 3)), [
    ["api", "/repos/async/pipeline/issues/5/comments", "--paginate"],
    ["api", "/repos/async/pipeline/issues/comments/42", "--method"]
  ]);
  assert.match(run.calls[1].args.at(-1), /body=<!-- async-preview -->\nnew body/u);
  assert.match(run.output, /comment-id=42/u);
  assert.match(run.output, /updated=true/u);
});

test("comment action creates a marked issue comment when none exists", () => {
  const run = runComment({
    comments: [],
    env: {
      INPUT_MODE: "issue-comment",
      INPUT_REPOSITORY: "async/pipeline",
      INPUT_NUMBER: "9",
      INPUT_MARKER: "async-release",
      INPUT_BODY: "release result",
      INPUT_TOKEN: "fake-token"
    }
  });

  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.calls[1].args[1], "/repos/async/pipeline/issues/9/comments");
  assert.match(run.output, /comment-id=100/u);
  assert.match(run.output, /updated=false/u);
});

test("comment action posts a bounded bridge storage receipt body from a file", () => {
  const run = runComment({
    comments: [],
    files: {
      "receipt.md": [
        "### Storage receipt",
        "",
        "- lease: `lease-123`",
        "- worker: `async-actions/storage`",
        "- status: `applied`",
        "- changed paths:",
        "  - `docs/api.md` (`update`)",
        "  - `docs/github-actions.md` (`create`)"
      ].join("\n")
    },
    env: {
      INPUT_MODE: "issue-comment",
      INPUT_REPOSITORY: "async/pipeline",
      INPUT_NUMBER: "11",
      INPUT_MARKER: "async-storage-receipt",
      INPUT_BODY_FILE: "receipt.md",
      INPUT_TOKEN: "fake-token"
    }
  });

  assert.equal(run.status, 0, run.stderr);
  const bodyArg = run.calls[1].args.find((arg) => arg.startsWith("body="));
  assert.match(bodyArg, /lease-123/u);
  assert.match(bodyArg, /docs\/api.md/u);
  assert.doesNotMatch(bodyArg, /raw file contents|project token|backend url/iu);
});

test("comment action appends summary markdown from a file", () => {
  const dir = mkdtempSync(join(tmpdir(), "async-actions-comment-summary-"));
  try {
    writeFileSync(join(dir, "body.md"), "# Summary\n", "utf8");
    const summaryPath = join(dir, "summary.md");
    const result = spawnSync(process.execPath, [new URL("../scripts/comment.mjs", import.meta.url).pathname], {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        GITHUB_STEP_SUMMARY: summaryPath,
        INPUT_MODE: "summary",
        INPUT_BODY_FILE: "body.md"
      }
    });

    assert.equal(result.status, 0, result.stderr);
    assert.equal(readFileSync(summaryPath, "utf8"), "# Summary\n");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("comment action emits structured annotations", () => {
  const dir = mkdtempSync(join(tmpdir(), "async-actions-comment-annotation-"));
  try {
    writeFileSync(join(dir, "annotations.json"), JSON.stringify([
      { level: "warning", file: "docs/api.md", line: 12, title: "Docs", message: "claim drift" }
    ]), "utf8");
    const result = spawnSync(process.execPath, [new URL("../scripts/comment.mjs", import.meta.url).pathname], {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        INPUT_MODE: "annotation",
        INPUT_ANNOTATIONS_FILE: "annotations.json"
      }
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /::warning file=docs\/api.md,line=12,title=Docs::claim drift/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function runComment({ comments, env, files = {} }) {
  const dir = mkdtempSync(join(tmpdir(), "async-actions-comment-"));
  try {
    const bin = join(dir, "bin");
    mkdirSync(bin);
    for (const [path, content] of Object.entries(files)) {
      writeFileSync(join(dir, path), content, "utf8");
    }
    const callsPath = join(dir, "calls.jsonl");
    const outputPath = join(dir, "output.txt");
    writeFileSync(callsPath, "", "utf8");
    writeFileSync(join(bin, "gh"), fakeGh(callsPath, comments), { mode: 0o755 });
    const result = spawnSync(process.execPath, [new URL("../scripts/comment.mjs", import.meta.url).pathname], {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        GITHUB_OUTPUT: outputPath,
        ...env
      }
    });
    const calls = readFileSync(callsPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const output = readFileSync(outputPath, "utf8");
    return { ...result, calls, output };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function fakeGh(callsPath, comments) {
  return `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify({ args, token: process.env.GITHUB_TOKEN ? "set" : "missing" }) + "\\n");
if (args.includes("--paginate")) {
  process.stdout.write(JSON.stringify(${JSON.stringify(comments)}));
  process.exit(0);
}
if (args.includes("PATCH")) {
  process.stdout.write(JSON.stringify({ id: 42, html_url: "https://github.test/updated" }));
  process.exit(0);
}
if (args.includes("POST")) {
  process.stdout.write(JSON.stringify({ id: 100, html_url: "https://github.test/created" }));
  process.exit(0);
}
process.stderr.write("unexpected gh args " + args.join(" "));
process.exit(1);
`;
}
