import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { boolInput, cwdFromInput, input, run, summary } from "./lib.mjs";

const cwd = cwdFromInput();
const phase = input("phase", "execute");
const evidenceDir = join(cwd, ".async", "runs");

async function evidenceMarkdown() {
  if (!existsSync(evidenceDir)) {
    return "### async/actions/run\n\nNo `.async/runs` evidence directory was produced.";
  }
  const entries = (await readdir(evidenceDir, { withFileTypes: true }))
    .filter((entry) => entry.isDirectory() || entry.isFile())
    .map((entry) => entry.name)
    .sort()
    .slice(-10);
  return [
    "### async/actions/run",
    "",
    `Evidence directory: \`${evidenceDir}\``,
    entries.length > 0 ? "" : "No evidence entries were found.",
    ...entries.map((entry) => `- \`${entry}\``)
  ].filter(Boolean).join("\n");
}

if (phase === "explain") {
  summary(await evidenceMarkdown());
  process.exit(0);
}

if (phase !== "execute") {
  throw new Error(`Unsupported phase ${phase}. Use execute or explain.`);
}

if (boolInput("check-generated", true)) {
  run("async-pipeline", ["github", "check"], { cwd });
}

const command = input("command", "");
const job = input("job", "");
const task = input("task", "");
const execution = input("execution", "");

if (command) {
  run("bash", ["-lc", command], { cwd });
} else if (job) {
  const args = ["run", job];
  if (execution) args.push("--execution", execution);
  run("async-pipeline", args, { cwd });
} else if (task) {
  const args = ["run-task", task];
  if (execution) args.push("--execution", execution);
  run("async-pipeline", args, { cwd });
} else {
  throw new Error("Provide command, job, or task.");
}
