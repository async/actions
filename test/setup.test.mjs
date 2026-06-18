import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";

test("setup action prepares pnpm before restoring dependency cache", async () => {
  const action = await readFile(new URL("../setup/action.yml", import.meta.url), "utf8");

  assert.doesNotMatch(action, /cache:\s*\$\{\{\s*inputs\.package-manager\s*\}\}/u);
  assert.match(action, /name: Prepare package managers/u);
  assert.match(action, /uses: actions\/cache@v4/u);
  assert.match(action, /name: Install dependencies/u);
});

test("setup script emits pnpm store path during prepare", async () => {
  const root = await mkdtemp(join(tmpdir(), "async-actions-setup-"));
  const bin = join(root, "bin");
  const output = join(root, "github-output");
  const log = join(root, "commands.log");
  await mkdir(bin);

  await writeFile(join(bin, "corepack"), fakeCommand("corepack", log), { mode: 0o755 });
  await writeFile(join(bin, "npm"), fakeCommand("npm", log), { mode: 0o755 });
  await writeFile(join(bin, "pnpm"), fakeCommand("pnpm", log, "store path --silent", "/tmp/pnpm-store\n"), { mode: 0o755 });

  const result = spawnSync(process.execPath, [new URL("../scripts/setup.mjs", import.meta.url).pathname], {
    cwd: root,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      GITHUB_OUTPUT: output,
      INPUT_RUNTIME: "node@24",
      INPUT_PACKAGE_MANAGER: "pnpm",
      INPUT_PNPM_VERSION: "11.1.0",
      INPUT_NPM_VERSION: "false",
      INPUT_INSTALL: "false",
      INPUT_CACHE: "true"
    },
    encoding: "utf8"
  });

  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
  assert.match(await readFile(output, "utf8"), /dependency-cache-store=\/tmp\/pnpm-store/u);
  assert.match(
    await readFile(log, "utf8"),
    /corepack enable\ncorepack prepare pnpm@11\.1\.0 --activate\npnpm store path --silent\n/u
  );
});

function fakeCommand(name, log, matchArgs = "", stdout = "") {
  return `#!/usr/bin/env node
const { appendFileSync } = require("node:fs");
const args = process.argv.slice(2).join(" ");
appendFileSync(${JSON.stringify(log)}, ${JSON.stringify(name)} + (args ? " " + args : "") + "\\n");
if (args === ${JSON.stringify(matchArgs)}) process.stdout.write(${JSON.stringify(stdout)});
`;
}
