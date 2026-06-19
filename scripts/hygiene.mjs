import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { boolInput, cwdFromInput, input, output, parseList, resolveRepoPath, run, summary } from "./lib.mjs";

const cwd = cwdFromInput();
const mode = input("mode", "report").trim();
const profiles = normalizeProfiles(parseList(input("profiles", "package,github,docs")));
const packagePath = input("package-path", ".").trim() || ".";
const evidenceDir = normalizeRepoPath(input("evidence-dir", ".async/hygiene"), "evidence-dir");
const annotations = boolInput("annotations", true);
const failOn = input("fail-on", "generated-policy").trim() || "generated-policy";
const releaseGate = boolInput("release-gate", false);
const eventName = process.env.GITHUB_EVENT_NAME ?? "";
const effectiveMode = releaseGate && eventName === "release" && mode === "report" ? "release" : mode;

if (!["report", "check", "strict", "release"].includes(mode)) {
  throw new Error(`Unsupported hygiene mode ${mode}. Use report, check, strict, or release.`);
}
if (!["generated-policy", "advisory", "blocking"].includes(failOn)) {
  throw new Error(`Unsupported fail-on policy ${failOn}. Use generated-policy, advisory, or blocking.`);
}
resolveRepoPath(cwd, packagePath, "package-path");

const evidenceRoot = resolve(cwd, evidenceDir);
mkdirSync(evidenceRoot, { recursive: true });

const command = input("hygiene-command", "").trim() || defaultHygieneCommand();
const commandResult = runCommand(command);
const report = parseReport(commandResult.stdout);
const findings = normalizeFindings(report, commandResult);
const blocking = findings.filter((finding) => finding.blocking);
const status = blocking.length > 0
  ? "failed"
  : findings.length > 0
    ? "passed-with-warnings"
    : "passed";

const manifestPath = join(evidenceRoot, "manifest.json");
const findingsPath = join(evidenceRoot, "findings.json");
const reportPath = join(evidenceRoot, "hygiene-report.json");
const summaryPath = join(evidenceRoot, "summary.md");
const manifest = {
  version: 1,
  generatedBy: "async/actions/hygiene",
  mode,
  effectiveMode,
  status,
  profiles,
  packagePath,
  annotations,
  failOn,
  releaseGate,
  command,
  reportPath: repoRelativePath(reportPath),
  stdoutSha256: commandResult.stdout ? sha256Text(commandResult.stdout) : "",
  stderrSha256: commandResult.stderr ? sha256Text(commandResult.stderr) : "",
  findingCount: findings.length,
  blockingFindingCount: blocking.length,
  createdAt: new Date().toISOString()
};

writeJson(manifestPath, manifest);
writeJson(findingsPath, { version: 1, findings });
writeJson(reportPath, report ?? { ok: commandResult.status === "passed", failures: [] });
writeFileSync(summaryPath, `${renderSummary(manifest, findings)}\n`, "utf8");

output("status", status);
output("evidence-dir", evidenceDir);
output("manifest-path", repoRelativePath(manifestPath));
output("findings-path", repoRelativePath(findingsPath));
output("summary-path", repoRelativePath(summaryPath));
output("finding-count", String(findings.length));
output("blocking-finding-count", String(blocking.length));

summary([
  "### async/actions/hygiene",
  "",
  `- mode: ${mode}`,
  `- effective mode: ${effectiveMode}`,
  `- status: ${status}`,
  `- profiles: ${profiles.join(", ")}`,
  `- evidence: ${evidenceDir}`,
  `- findings: ${findings.length}`,
  `- blocking findings: ${blocking.length}`
].join("\n"));

if (status === "failed" && blocksJob()) {
  process.exitCode = 1;
}

function defaultHygieneCommand() {
  const args = ["async-hygiene", "check", "--format", "json", "--cwd", packagePath];
  const cliMode = cliModeForProfiles(profiles);
  if (cliMode) args.push("--mode", cliMode);
  return args.map(shellWord).join(" ");
}

function runCommand(command) {
  const result = run("bash", ["-lc", command], { cwd, capture: true, check: false });
  return {
    status: result.status === 0 ? "passed" : "failed",
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? ""
  };
}

function parseReport(stdout) {
  const text = stdout.trim();
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function normalizeFindings(report, commandResult) {
  const findings = [];
  if (commandResult.status === "failed" && !report) {
    findings.push({
      ruleId: "async-hygiene.command",
      severity: "error",
      profile: "repo",
      message: `async-hygiene command failed with exit code ${commandResult.exitCode}`,
      suggestedFix: "Run the command locally and inspect its stderr.",
      blocking: blocksJob()
    });
    return findings;
  }

  const failedGates = Array.isArray(report?.gates)
    ? report.gates.filter((gate) => gate && typeof gate === "object" && gate.ok === false)
    : [];
  for (const failure of failedGates.length === 0 && Array.isArray(report?.failures) ? report.failures : []) {
    findings.push({
      ruleId: "async-hygiene.failure",
      severity: "error",
      profile: profileForFailure(String(failure)),
      message: String(failure),
      suggestedFix: "",
      blocking: blocksJob()
    });
  }

  for (const gate of failedGates) {
    const gateId = typeof gate.id === "string" ? gate.id : "gate";
    const messages = Array.isArray(gate.messages) && gate.messages.length > 0 ? gate.messages : [`${gateId} failed`];
    for (const message of messages) {
      findings.push({
        ruleId: `async-hygiene.${gateId}`,
        severity: "error",
        profile: profileForGate(gateId),
        message: String(message),
        suggestedFix: "",
        blocking: blocksJob()
      });
    }
  }

  if (commandResult.status === "failed" && findings.length === 0) {
    findings.push({
      ruleId: "async-hygiene.command",
      severity: "error",
      profile: "repo",
      message: `async-hygiene command failed with exit code ${commandResult.exitCode}`,
      suggestedFix: "",
      blocking: blocksJob()
    });
  }
  return dedupeFindings(findings);
}

function blocksJob() {
  if (failOn === "blocking") return true;
  if (failOn === "advisory") return false;
  return effectiveMode !== "report";
}

function normalizeProfiles(values) {
  const allowed = new Set(["package", "github", "docs", "repo", "release", "mixed"]);
  const normalized = values.map((value) => value.trim()).filter(Boolean);
  for (const profile of normalized) {
    if (!allowed.has(profile)) {
      throw new Error(`Unsupported hygiene profile ${profile}. Use package, github, docs, repo, release, or mixed.`);
    }
  }
  return [...new Set(normalized)];
}

function cliModeForProfiles(values) {
  if (values.includes("mixed")) return "mixed";
  if (values.includes("package") || values.includes("release")) return "package";
  if (values.length > 0) return "app";
  return "";
}

function profileForGate(gateId) {
  if (gateId === "workflow") return "github";
  if (gateId === "package") return "package";
  if (gateId === "unused") return "repo";
  return "repo";
}

function profileForFailure(failure) {
  const [gateId] = failure.split(":");
  return profileForGate(gateId.trim());
}

function dedupeFindings(findings) {
  const seen = new Set();
  const deduped = [];
  for (const finding of findings) {
    const key = `${finding.ruleId}\0${finding.message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(finding);
  }
  return deduped;
}

function renderSummary(manifest, findings) {
  const lines = [
    "# Async Hygiene Evidence",
    "",
    `- Status: ${manifest.status}`,
    `- Mode: ${manifest.mode}`,
    `- Effective mode: ${manifest.effectiveMode}`,
    `- Profiles: ${manifest.profiles.join(", ")}`,
    `- Findings: ${manifest.findingCount}`,
    `- Blocking findings: ${manifest.blockingFindingCount}`
  ];
  if (findings.length > 0) {
    lines.push("", "## Findings");
    for (const finding of findings) {
      lines.push(`- [${finding.severity}] ${finding.ruleId}: ${finding.message}`);
    }
  }
  return lines.join("\n");
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function normalizeRepoPath(path, label) {
  return resolveRepoPath(cwd, path, label) && String(path).trim();
}

function repoRelativePath(path) {
  return path.startsWith(`${cwd}/`) ? path.slice(cwd.length + 1) : path;
}

function sha256Text(text) {
  return createHash("sha256").update(text).digest("hex");
}

function shellWord(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`;
}
