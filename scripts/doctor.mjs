import { input, output, run, summary } from "./lib.mjs";

const mode = input("mode", "doctor");
const packagePath = input("package-path", ".");
const packageProfile = input("package-profile", "");
const releaseType = input("release-type", "auto");
const evidenceDir = input("evidence-dir", ".async/release");
const network = input("network", "live");
const repository = input("repository", "");
const workingDirectory = input("working-directory", ".");
const releaseCommand = input("release-command", process.env.ASYNC_RELEASE_COMMAND ?? "async-release");

const command = splitCommand(releaseCommand);
const args = [
  ...modeArgs(mode),
  "--package",
  packagePath,
  "--evidence-dir",
  evidenceDir,
  "--json"
];

if (packageProfile) args.push("--package-profile", packageProfile);
if (releaseType && releaseType !== "auto") args.push("--release-type", releaseType);
if (repository) args.push("--repository", repository);
if (mode === "doctor") args.push("--network", network);

const result = run(command[0], [...command.slice(1), ...args], {
  cwd: workingDirectory,
  capture: true
});

const payload = JSON.parse(result.stdout);
const packageInfo = payload.package ?? {};

output("release-type", payload.releaseType ?? "");
output("package-profile", packageInfo.profile ?? "");
output("package-name", packageInfo.name ?? "");
output("package-version", packageInfo.version ?? "");
output("evidence-dir", evidenceDir);
output("release-notes-path", payload.path ?? `${evidenceDir}/release-notes.md`);

summary([
  "### async/actions/doctor",
  "",
  `- mode: ${mode}`,
  `- package: ${packageInfo.name ?? packagePath}${packageInfo.version ? `@${packageInfo.version}` : ""}`,
  `- evidence: ${evidenceDir}`,
  payload.releaseType ? `- release type: ${payload.releaseType}` : undefined,
  packageInfo.profile ? `- package profile: ${packageInfo.profile}` : undefined,
  payload.status ? `- status: ${payload.status}` : undefined
].filter(Boolean).join("\n"));

function modeArgs(value) {
  if (value === "plan") return ["package", "plan"];
  if (value === "inspect") return ["package", "inspect"];
  if (value === "changelog") return ["changelog", "check"];
  if (value === "notes") return ["notes", "render"];
  if (value === "doctor") return ["doctor"];
  throw new Error(`Unsupported doctor mode ${value}.`);
}

function splitCommand(value) {
  const parts = value.trim().split(/\s+/u).filter(Boolean);
  if (parts.length === 0) throw new Error("release-command cannot be empty.");
  return parts;
}
