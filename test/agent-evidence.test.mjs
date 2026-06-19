import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const script = new URL("../scripts/agent-evidence.mjs", import.meta.url);

test("agent evidence action collects agent run files and explicit outputs", () => {
  const dir = fixtureDir();
  try {
    const result = runAgentEvidence(dir, {
      INPUT_MODE: "collect",
      INPUT_OUTPUTS: "draft.patch\nreview.md",
      INPUT_EVIDENCE_PATH: ".async/agent-evidence/manifest.json",
      INPUT_BUNDLE_PATH: ".async/agent-evidence/bundle.json",
      INPUT_RECEIPT_PATH: ".async/actions/receipts/agent-evidence.json"
    });

    assert.equal(result.status, 0, result.stderr);
    const manifestText = readFileSync(join(dir, ".async/agent-evidence/manifest.json"), "utf8");
    const manifest = JSON.parse(manifestText);
    assert.equal(manifest.generatedBy, "async/actions/agent-evidence");
    assert.equal(manifest.counts.patches, 1);
    assert.equal(manifest.counts.reports, 1);
    assert.equal(manifest.counts.transcripts, 1);
    assert.equal(manifest.counts.contextPacks, 1);
    assert.equal(manifest.files.find((file) => file.path === "draft.patch")?.kind, "patch");
    assert.equal(manifest.files.find((file) => file.path.endsWith("agents/gen.jsonl"))?.kind, "transcript");
    assert.equal(existsSync(join(dir, ".async/agent-evidence/bundle.json")), true);

    const receiptText = readFileSync(join(dir, ".async/actions/receipts/agent-evidence.json"), "utf8");
    const receipt = JSON.parse(receiptText);
    assert.equal(receipt.kind, "agent-evidence");
    assert.equal(receipt.patchCount, 1);
    assert.equal(receipt.redacted, true);
    assert.doesNotMatch(receiptText, /patch body/u);
    assert.doesNotMatch(manifestText, /Review body/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("agent evidence action writes a bundle manifest", () => {
  const dir = fixtureDir();
  try {
    const result = runAgentEvidence(dir, {
      INPUT_MODE: "bundle",
      INPUT_OUTPUTS: "draft.patch\nreview.md"
    });

    assert.equal(result.status, 0, result.stderr);
    const bundle = JSON.parse(readFileSync(join(dir, ".async/agent-evidence/bundle.json"), "utf8"));
    assert.equal(bundle.generatedBy, "async/actions/agent-evidence");
    assert.equal(bundle.counts.patches, 1);
    assert.equal(bundle.files.some((file) => file.path === "review.md"), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("agent evidence action fails redaction on secret-looking values", () => {
  const dir = fixtureDir();
  try {
    writeFileSync(join(dir, "review.md"), "token = abcdefghijklmnopqrstuvwxyz123456\n", "utf8");
    const result = runAgentEvidence(dir, {
      INPUT_MODE: "redact",
      INPUT_OUTPUTS: "review.md"
    });

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /redaction validation/u);
    assert.match(result.stderr, /review\.md/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("agent evidence action emits bounded comment handoff outputs", () => {
  const dir = fixtureDir();
  try {
    const outputPath = join(dir, "outputs.txt");
    const result = runAgentEvidence(dir, {
      GITHUB_OUTPUT: outputPath,
      INPUT_MODE: "comment",
      INPUT_OUTPUTS: "draft.patch\nreview.md",
      INPUT_COMMENT_MARKER: "async-agent-review"
    });

    assert.equal(result.status, 0, result.stderr);
    const outputs = readFileSync(outputPath, "utf8");
    assert.match(outputs, /comment-marker=async-agent-review/u);
    assert.match(outputs, /comment-body<<async_actions_/u);
    assert.match(outputs, /patches: 1/u);
    assert.match(outputs, /reports: 1/u);
    assert.match(outputs, /Large patches, transcripts, logs, and context packs are attached/u);
    assert.doesNotMatch(outputs, /patch body/u);
    assert.doesNotMatch(outputs, /Review body/u);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

function fixtureDir() {
  const dir = mkdtempSync(join(tmpdir(), "async-actions-agent-evidence-"));
  mkdirSync(join(dir, ".async/runs/run-1/agents"), { recursive: true });
  mkdirSync(join(dir, ".async/runs/run-1/context"), { recursive: true });
  writeFileSync(join(dir, ".async/runs/run-1/agents/gen.prompt.txt"), "write the file\n", "utf8");
  writeFileSync(join(dir, ".async/runs/run-1/agents/gen.jsonl"), [
    JSON.stringify({ type: "request", task: "gen", prompt: "write the file" }),
    JSON.stringify({ type: "response", task: "gen", stdout: "[redacted]" })
  ].join("\n"), "utf8");
  writeFileSync(join(dir, ".async/runs/run-1/context/gen.json"), JSON.stringify({
    schemaVersion: 1,
    task: "gen",
    logTail: "[redacted]"
  }), "utf8");
  writeFileSync(join(dir, "draft.patch"), "patch body\n", "utf8");
  writeFileSync(join(dir, "review.md"), "Review body\n", "utf8");
  return dir;
}

function runAgentEvidence(cwd, env) {
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
