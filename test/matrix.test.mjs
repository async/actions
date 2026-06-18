import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("matrix action script renders runner matrix JSON", () => {
  const result = spawnSync(process.execPath, ["scripts/matrix.mjs"], {
    encoding: "utf8",
    env: {
      ...process.env,
      INPUT_RUNS_ON: "ubuntu-latest\nself-hosted+macos+tart"
    }
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /matrix=/);
  assert.match(result.stdout, /ubuntu-latest/);
  assert.match(result.stdout, /self-hosted/);
});
