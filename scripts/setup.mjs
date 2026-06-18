import { boolInput, cwdFromInput, input, output, parseList, run, summary } from "./lib.mjs";

const cwd = cwdFromInput();
const runtimes = parseList(input("runtime", input("node-version", "24") ? `node@${input("node-version", "24")}` : "node@24"));
const nodeRuntime = runtimes.find((runtime) => runtime === "node" || runtime.startsWith("node@"));
const nodeVersion = input("node-version", nodeRuntime?.split("@")[1] ?? "24");
const pnpmVersion = input("pnpm-version", "11.1.0");
const npmVersion = input("npm-version", "11.16.0");
const packageManager = input("package-manager", "pnpm");
const prepare = boolInput("prepare", true);
const install = boolInput("install", false);
const frozen = boolInput("frozen-lockfile", true);
const cache = boolInput("cache", true);

if (packageManager !== "pnpm" && packageManager !== "npm" && packageManager !== "deno") {
  throw new Error(`Unsupported package-manager ${packageManager}. Use pnpm, npm, or deno.`);
}

if (prepare && packageManager === "pnpm") {
  run("corepack", ["enable"], { cwd });
  run("corepack", ["prepare", `pnpm@${pnpmVersion}`, "--activate"], { cwd });
}

if (prepare && npmVersion !== "false" && npmVersion !== "none") {
  run("npm", ["install", "-g", `npm@${npmVersion}`], { cwd });
}

if (prepare) {
  for (const runtime of runtimes) {
    const [name, version = "latest"] = runtime.split("@");
    if (name === "node" || name === "deno") continue;
    if (name === "bun") {
      run("pnpm", ["runtime", "set", "bun", version, "-g"], { cwd });
    } else {
      throw new Error(`Unsupported runtime ${runtime}. Use node, deno, or bun.`);
    }
  }
}

let dependencyCacheStore = "";
if (prepare && cache && packageManager === "pnpm") {
  const result = run("pnpm", ["store", "path", "--silent"], { cwd, capture: true });
  dependencyCacheStore = result.stdout.trim();
}

if (install) {
  if (packageManager === "pnpm") {
    run("pnpm", ["install", frozen ? "--frozen-lockfile" : "--no-frozen-lockfile"], { cwd });
  } else if (packageManager === "npm") {
    run("npm", [frozen ? "ci" : "install"], { cwd });
  } else {
    run("deno", ["install", frozen ? "--frozen=true" : "--frozen=false"], { cwd });
  }
}

output("node-version", nodeVersion);
output("pnpm-version", pnpmVersion);
output("npm-version", npmVersion);
output("runtimes", runtimes.join(","));
output("dependency-cache-store", dependencyCacheStore);
summary(`### async/actions/setup\n\n- Node: ${nodeVersion}\n- pnpm: ${pnpmVersion}\n- npm: ${npmVersion}\n- runtimes: ${runtimes.join(", ") || "none"}`);
