import { cwdFromInput, input, output, parseList, readJson, summary } from "./lib.mjs";
import { resolve } from "node:path";
import { existsSync } from "node:fs";

const cwd = cwdFromInput();
const mode = input("mode", "runs-on");
let matrix;

if (mode === "json") {
  const raw = input("json", "{}");
  matrix = JSON.parse(raw);
} else if (mode === "file") {
  const file = resolve(cwd, input("file"));
  if (!existsSync(file)) throw new Error(`Matrix file not found: ${file}`);
  matrix = readJson(file);
} else if (mode === "runs-on") {
  const entries = parseList(input("runs-on", "ubuntu-latest"));
  matrix = { runner: entries.map((entry) => entry.includes("+") ? entry.split("+") : [entry]) };
} else {
  throw new Error(`Unsupported matrix mode ${mode}. Use runs-on, file, or json.`);
}

const json = JSON.stringify(matrix);
output("matrix", json);
summary(`### async/actions/matrix\n\n\`\`\`json\n${JSON.stringify(matrix, null, 2)}\n\`\`\``);

