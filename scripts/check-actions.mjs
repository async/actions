import { existsSync, readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const actionDirs = ["setup", "run", "pages", "publish", "preview", "dependabot-merge", "matrix", "storage", "evidence", "source-impact", "cache", "attest", "doctor", "comment"];
const failures = [];

for (const dir of actionDirs) {
  const file = join(root, dir, "action.yml");
  if (!existsSync(file)) {
    failures.push(`${dir}/action.yml is missing.`);
    continue;
  }
  const text = readFileSync(file, "utf8");
  for (const required of ["name:", "description:", "inputs:", "runs:", "using: composite", "steps:"]) {
    if (!text.includes(required)) failures.push(`${dir}/action.yml missing ${required}`);
  }
}

for (const entry of await readdir(join(root, "scripts"))) {
  if (!entry.endsWith(".mjs")) continue;
  const result = spawnSync(process.execPath, ["--check", join(root, "scripts", entry)], { encoding: "utf8" });
  if (result.status !== 0) failures.push(`scripts/${entry} failed node --check:\n${result.stderr}`);
}

const actionlint = spawnSync("actionlint", ["-version"], { encoding: "utf8" });
if (actionlint.status === 0) {
  const result = spawnSync("actionlint", actionDirs.map((dir) => join(dir, "action.yml")), { encoding: "utf8" });
  if (result.status !== 0) failures.push(result.stdout + result.stderr);
} else {
  console.warn("actionlint not found; skipped actionlint validation.");
}

if (failures.length > 0) {
  for (const failure of failures) console.error(failure);
  process.exit(1);
}

console.log(`Action checks passed for ${actionDirs.length} action(s).`);
