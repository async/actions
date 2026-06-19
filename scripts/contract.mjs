import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { boolInput, cwdFromInput, input, output, parseList, resolveRepoPath, run, summary } from "./lib.mjs";

const cwd = cwdFromInput();
const mode = input("mode", "report").trim();
const checks = normalizeChecks(parseList(input("checks", "api,claims")));
const packagePath = input("package-path", ".").trim() || ".";
const evidenceDir = normalizeRepoPath(input("evidence-dir", ".async/contract"), "evidence-dir");
const schemaOutputInput = input("schema-output", "").trim();
const schemaOutput = schemaOutputInput
  ? normalizeRepoPath(schemaOutputInput, "schema-output")
  : normalizeRepoPath(join(evidenceDir, "schema.json"), "schema-output");
const annotations = boolInput("annotations", true);
const failOn = input("fail-on", "generated-policy").trim() || "generated-policy";

if (!["report", "check", "strict", "release"].includes(mode)) {
  throw new Error(`Unsupported contract mode ${mode}. Use report, check, strict, or release.`);
}
if (checks.length === 0) throw new Error("checks must include at least one of api, claims, or schema.");
resolveRepoPath(cwd, packagePath, "package-path");

const evidenceRoot = resolve(cwd, evidenceDir);
mkdirSync(evidenceRoot, { recursive: true });

const reports = {};
const findings = [];
let breakingChangeCount = 0;
let unresolvedClaimCount = 0;

if (checks.includes("api")) {
  reports.api = runReportCommand("api", input("api-command", ""), ".async/contract/api-contract.json");
}
if (checks.includes("claims")) {
  reports.claims = runReportCommand("claims", input("claims-command", ""), ".async/contract/claims.json");
}
if (checks.includes("schema")) {
  reports.schema = runSchemaCheck();
}

const status = findings.some((finding) => finding.severity === "error")
  ? "failed"
  : findings.length > 0
    ? "passed-with-warnings"
    : "passed";
const manifestPath = join(evidenceRoot, "manifest.json");
const summaryPath = join(evidenceRoot, "summary.md");
const manifest = {
  version: 1,
  generatedBy: "async/actions/contract",
  mode,
  status,
  checks,
  packagePath,
  annotations,
  failOn,
  reports,
  breakingChangeCount,
  unresolvedClaimCount,
  findings,
  createdAt: new Date().toISOString()
};

writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
writeFileSync(summaryPath, `${renderSummary(manifest)}\n`, "utf8");

output("status", status);
output("evidence-dir", evidenceDir);
output("manifest-path", repoRelativePath(manifestPath));
output("api-report", reports.api?.path ?? "");
output("claims-report", reports.claims?.path ?? "");
output("schema-report", reports.schema?.path ?? "");
output("breaking-change-count", String(breakingChangeCount));
output("unresolved-claim-count", String(unresolvedClaimCount));

summary([
  "### async/actions/contract",
  "",
  `- mode: ${mode}`,
  `- status: ${status}`,
  `- checks: ${checks.join(", ")}`,
  `- evidence: ${evidenceDir}`,
  `- findings: ${findings.length}`
].join("\n"));

if (status === "failed" && mode !== "report") {
  process.exitCode = 1;
}

function runReportCommand(kind, command, fallbackPath) {
  const reportPath = reportPathFor(kind, fallbackPath);
  const result = command.trim()
    ? runCommand(kind, command)
    : { status: "observed", stdout: "", stderr: "", command: "" };
  const existing = findExistingReport(kind);
  const report = {
    kind,
    status: result.status,
    command: result.command,
    reportSource: existing ? repoRelativePath(existing) : "",
    stdoutSha256: result.stdout ? sha256Text(result.stdout) : "",
    stderrSha256: result.stderr ? sha256Text(result.stderr) : ""
  };
  if (result.status === "failed") {
    const severity = kind === "claims" ? "error" : "error";
    findings.push({ kind, severity, message: `${kind} contract command failed` });
    if (kind === "claims") unresolvedClaimCount += 1;
    else breakingChangeCount += 1;
  } else if (!existing && mode === "strict") {
    findings.push({ kind, severity: "error", message: `${kind} contract report is missing` });
    if (kind === "claims") unresolvedClaimCount += 1;
    else breakingChangeCount += 1;
  } else if (!existing) {
    findings.push({ kind, severity: "warning", message: `${kind} contract report is missing` });
  }
  writeJson(reportPath, report);
  return { path: repoRelativePath(reportPath), status: report.status };
}

function runSchemaCheck() {
  const reportPath = resolve(cwd, schemaOutput);
  const command = input("schema-command", "").trim();
  const commandResult = command ? runCommand("schema", command) : { status: "observed", stdout: "", stderr: "", command: "" };
  const sources = parseList(input("schema-sources", ""))
    .map((value, index) => normalizeRepoPath(value, `schema-sources[${index}]`));
  const files = collectSchemaFiles(sources);
  const schemas = [];
  for (const file of files) {
    try {
      const value = JSON.parse(readFileSync(file, "utf8"));
      schemas.push({
        path: repoRelativePath(file),
        kind: inferSchemaKind(value),
        bytes: statSync(file).size,
        sha256: sha256File(file)
      });
    } catch (error) {
      findings.push({
        kind: "schema",
        severity: "error",
        path: repoRelativePath(file),
        message: error instanceof Error ? error.message : String(error)
      });
      breakingChangeCount += 1;
    }
  }
  if (commandResult.status === "failed") {
    findings.push({ kind: "schema", severity: "error", message: "schema contract command failed" });
    breakingChangeCount += 1;
  }
  if (sources.length === 0 && mode === "strict") {
    findings.push({ kind: "schema", severity: "error", message: "schema check requires schema-sources in strict mode" });
    breakingChangeCount += 1;
  } else if (sources.length > 0 && files.length === 0) {
    findings.push({ kind: "schema", severity: mode === "report" ? "warning" : "error", message: "schema sources matched no files" });
    if (mode !== "report") breakingChangeCount += 1;
  }
  const report = {
    kind: "schema",
    status: commandResult.status === "failed" || schemas.length < files.length ? "failed" : "passed",
    command: commandResult.command,
    sources,
    schemas
  };
  writeJson(reportPath, report);
  return { path: repoRelativePath(reportPath), status: report.status };
}

function runCommand(kind, command) {
  const result = run("bash", ["-lc", command], { cwd, capture: true, check: false });
  return {
    status: result.status === 0 ? "passed" : "failed",
    command,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? ""
  };
}

function normalizeChecks(values) {
  const allowed = new Set(["api", "claims", "schema"]);
  const normalized = values.map((value) => value.trim()).filter(Boolean);
  for (const check of normalized) {
    if (!allowed.has(check)) {
      throw new Error(`Unsupported contract check ${check}. Use api, claims, or schema.`);
    }
  }
  return [...new Set(normalized)];
}

function reportPathFor(kind, fallback) {
  return resolve(cwd, normalizeRepoPath(join(evidenceDir, `${kind}.json`), `${kind}-report`, { allowGeneratedEvidencePath: true }) || fallback);
}

function findExistingReport(kind) {
  const candidates = kind === "api"
    ? ["api-contract.json", "API_SURFACE.md", join(packagePath, "api-contract.json"), join(packagePath, "API_SURFACE.md")]
    : kind === "claims"
      ? ["tests/claims.json", "claims.json", join(packagePath, "tests/claims.json")]
      : [];
  for (const candidate of candidates) {
    const target = resolve(cwd, candidate);
    if (existsSync(target)) return target;
  }
  return undefined;
}

function collectSchemaFiles(patterns) {
  const files = new Map();
  for (const pattern of patterns) {
    for (const file of expandPattern(pattern)) files.set(repoRelativePath(file), file);
  }
  return [...files.values()].sort((left, right) => repoRelativePath(left).localeCompare(repoRelativePath(right)));
}

function expandPattern(pattern) {
  const absolute = resolveRepoPath(cwd, pattern, "schema-source");
  if (!hasGlob(pattern)) {
    if (!existsSync(absolute)) return [];
    const stat = statSync(absolute);
    if (stat.isFile()) return [absolute];
    if (stat.isDirectory()) return walkFiles(absolute).filter((file) => file.endsWith(".json"));
    return [];
  }
  const base = resolveRepoPath(cwd, globBase(pattern), "schema-source-base");
  if (!existsSync(base)) return [];
  const matcher = globMatcher(pattern);
  return walkFiles(base).filter((file) => matcher.test(repoRelativePath(file)));
}

function hasGlob(value) {
  return /[*?[\]{}]/u.test(value);
}

function globBase(pattern) {
  const parts = pattern.split("/");
  const base = [];
  for (const part of parts) {
    if (/[*?[\]{}]/u.test(part)) break;
    base.push(part);
  }
  return base.length === 0 ? "." : base.join("/");
}

function globMatcher(pattern) {
  const escaped = pattern
    .split("**")
    .map((part) => part.replace(/[.+^${}()|[\]\\]/gu, "\\$&").replaceAll("*", "[^/]*").replaceAll("?", "[^/]"))
    .join(".*");
  return new RegExp(`^${escaped}$`, "u");
}

function walkFiles(dir) {
  const entries = [];
  for (const entry of statSafeReaddir(dir)) {
    const target = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === ".git" || entry.name === "node_modules" || entry.name === ".async") continue;
      entries.push(...walkFiles(target));
    } else if (entry.isFile()) {
      entries.push(target);
    }
  }
  return entries;
}

function statSafeReaddir(dir) {
  return existsSync(dir) ? readdirSync(dir, { withFileTypes: true }) : [];
}

function inferSchemaKind(value) {
  if (value && typeof value === "object" && "$schema" in value) return "json-schema";
  if (Array.isArray(value)) return "sample-array";
  return "json";
}

function normalizeRepoPath(value, label) {
  resolveRepoPath(cwd, value, label);
  return value;
}

function repoRelativePath(path) {
  return relative(cwd, path).replace(/\\/gu, "/");
}

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function renderSummary(manifest) {
  return [
    "# Async Contract Evidence",
    "",
    `- mode: ${manifest.mode}`,
    `- status: ${manifest.status}`,
    `- checks: ${manifest.checks.join(", ")}`,
    `- breaking changes: ${manifest.breakingChangeCount}`,
    `- unresolved claims: ${manifest.unresolvedClaimCount}`,
    `- findings: ${manifest.findings.length}`
  ].join("\n");
}

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sha256Text(value) {
  return createHash("sha256").update(value).digest("hex");
}
