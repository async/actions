import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  boolInput,
  cwdFromInput,
  ensureParent,
  input,
  normalizeRepoPath,
  output,
  parseList,
  readJson,
  resolveRepoPath,
  summary
} from "./lib.mjs";

const cwd = cwdFromInput();
const mode = input("mode", "digest").trim();
const packagePath = normalizeRepoPath(input("package-path", "."), "package-path");
const artifactInputs = parseList(input("artifacts", ""));
const subjectManifestPath = normalizeRepoPath(input("subject-manifest", ".async/attest/subjects.json"), "subject-manifest");
const sbomPath = normalizeRepoPath(input("sbom-path", ".async/attest/sbom.json"), "sbom-path");
const evidencePath = normalizeRepoPath(input("evidence-path", ".async/actions/receipts/attest.json"), "evidence-path");
const verificationResultsPath = input("verification-results", "").trim();
const requireNpmProvenance = boolInput("require-npm-provenance", false);
const tarballScan = boolInput("tarball-scan", false);
const githubAttestation = boolInput("github-attestation", false);

if (!["digest", "sbom", "attest", "verify"].includes(mode)) {
  throw new Error(`Unsupported attest mode ${mode}. Use digest, sbom, attest, or verify.`);
}

const result = runMode();
emitOutputs(result);

function runMode() {
  if (mode === "digest") {
    const subjects = collectSubjects();
    const checks = {};
    if (tarballScan) checks.tarballScan = scanTarballSubjects(subjects);
    const manifest = subjectManifest(subjects, checks);
    writeJson(subjectManifestPath, manifest);
    const receipt = receiptFor("digest", "passed", { subjectManifest: subjectManifestPath, subjects, checks });
    writeJson(evidencePath, receipt);
    return { subjects, checks, verified: true, attestationUrl: "" };
  }

  if (mode === "sbom") {
    const subjects = collectSubjects();
    const sbom = sbomFor(subjects);
    writeJson(sbomPath, sbom);
    const receipt = receiptFor("sbom", "passed", { sbomPath, subjects });
    writeJson(evidencePath, receipt);
    return { subjects, checks: {}, verified: true, attestationUrl: "" };
  }

  if (mode === "attest") {
    const manifest = readSubjectManifest();
    const status = githubAttestation ? "ready" : "skipped";
    const reason = githubAttestation ? "GitHub attestation requested by generated workflow." : "github-attestation=false";
    const receipt = receiptFor("attest", status, {
      subjectManifest: subjectManifestPath,
      subjects: manifest.subjects,
      githubAttestation,
      reason
    });
    writeJson(evidencePath, receipt);
    return { subjects: manifest.subjects, checks: manifest.checks ?? {}, verified: true, attestationUrl: "" };
  }

  const manifest = readSubjectManifest();
  const checks = { ...(manifest.checks ?? {}) };
  checks.digest = verifySubjectDigests(manifest.subjects);
  if (tarballScan) checks.tarballScan = scanTarballSubjects(manifest.subjects);
  const parsedResults = readVerificationResults();
  if (parsedResults) checks.external = parsedResults;
  if (requireNpmProvenance) {
    checks.npmProvenance = parseNpmProvenance(parsedResults);
  }
  const failed = Object.values(checks).some((check) => check && typeof check === "object" && check.status === "failed");
  const receipt = receiptFor("verify", failed ? "failed" : "passed", {
    subjectManifest: subjectManifestPath,
    subjects: manifest.subjects,
    checks
  });
  writeJson(evidencePath, receipt);
  if (failed) {
    throw new Error("Attestation verification failed.");
  }
  return { subjects: manifest.subjects, checks, verified: true, attestationUrl: "" };
}

function collectSubjects() {
  const patterns = artifactInputs.length > 0 ? artifactInputs : [packagePath === "." ? "package.json" : `${packagePath}/package.json`];
  const subjects = [];
  const seen = new Set();
  for (const pattern of patterns) {
    const normalized = normalizeRepoPath(pattern, "artifacts");
    for (const path of expandPattern(normalized)) {
      const relativePath = repoRelativePath(path);
      if (seen.has(relativePath)) continue;
      seen.add(relativePath);
      const stat = statSync(path);
      subjects.push({
        path: relativePath,
        sha256: sha256(path),
        bytes: stat.size,
        kind: subjectKind(relativePath)
      });
    }
  }
  if (subjects.length === 0) {
    throw new Error(`No attestation subjects matched ${patterns.join(", ")}.`);
  }
  return subjects.sort((left, right) => left.path.localeCompare(right.path));
}

function subjectManifest(subjects, checks) {
  return {
    version: 1,
    generatedBy: "async/actions/attest",
    mode: "digest",
    packagePath,
    createdAt: new Date().toISOString(),
    subjects,
    checks
  };
}

function sbomFor(subjects) {
  const packageJsonPath = resolveRepoPath(cwd, packagePath === "." ? "package.json" : `${packagePath}/package.json`, "package.json");
  const manifest = existsSync(packageJsonPath) ? readJson(packageJsonPath) : {};
  return {
    bomFormat: "CycloneDX",
    specVersion: "1.5",
    metadata: {
      component: {
        type: "library",
        name: typeof manifest.name === "string" ? manifest.name : packagePath,
        version: typeof manifest.version === "string" ? manifest.version : ""
      }
    },
    components: subjects.map((subject) => ({
      type: subject.kind === "npm-tarball" ? "file" : "file",
      name: subject.path,
      hashes: [{ alg: "SHA-256", content: subject.sha256 }]
    }))
  };
}

function readSubjectManifest() {
  const manifest = readJson(resolveRepoPath(cwd, subjectManifestPath, "subject-manifest"));
  if (!manifest || typeof manifest !== "object" || manifest.version !== 1 || manifest.generatedBy !== "async/actions/attest") {
    throw new Error("subject manifest must be generated by async/actions/attest with version 1.");
  }
  if (!Array.isArray(manifest.subjects) || manifest.subjects.length === 0) {
    throw new Error("subject manifest subjects must be a non-empty array.");
  }
  for (const [index, subject] of manifest.subjects.entries()) {
    validateSubject(subject, index);
  }
  return manifest;
}

function validateSubject(subject, index) {
  if (!subject || typeof subject !== "object") throw new Error(`subject ${index} must be an object.`);
  normalizeRepoPath(subject.path, `subject ${index} path`);
  if (!/^[a-f0-9]{64}$/u.test(subject.sha256)) throw new Error(`subject ${index} sha256 must be a 64-character lowercase hex digest.`);
  if (!Number.isInteger(subject.bytes) || subject.bytes < 0) throw new Error(`subject ${index} bytes must be a non-negative integer.`);
  if (typeof subject.kind !== "string" || !subject.kind) throw new Error(`subject ${index} kind must be a non-empty string.`);
}

function verifySubjectDigests(subjects) {
  const failures = [];
  for (const subject of subjects) {
    const absolute = resolveRepoPath(cwd, subject.path, "subject path");
    if (!existsSync(absolute)) {
      failures.push(`${subject.path}: missing`);
      continue;
    }
    const actual = sha256(absolute);
    if (actual !== subject.sha256) {
      failures.push(`${subject.path}: sha256 mismatch`);
    }
  }
  return failures.length === 0
    ? { status: "passed", subjectCount: subjects.length }
    : { status: "failed", failures };
}

function scanTarballSubjects(subjects) {
  const tarballs = subjects.filter((subject) => subject.kind === "npm-tarball");
  if (tarballs.length === 0) return { status: "skipped", reason: "no npm tarball subjects" };
  let entryCount = 0;
  const failures = [];
  for (const subject of tarballs) {
    const absolute = resolveRepoPath(cwd, subject.path, "tarball subject");
    const result = spawnSync("tar", ["-tzf", absolute], { encoding: "utf8" });
    if (result.status !== 0) {
      failures.push(`${subject.path}: tar listing failed`);
      continue;
    }
    const entries = result.stdout.split("\n").map((entry) => entry.trim()).filter(Boolean);
    entryCount += entries.length;
    for (const entry of entries) {
      if (entry.startsWith("/") || entry.split("/").includes("..") || entry.includes("\0")) {
        failures.push(`${subject.path}: unsafe entry ${entry}`);
      }
    }
  }
  return failures.length === 0
    ? { status: "passed", tarballCount: tarballs.length, entryCount }
    : { status: "failed", failures };
}

function readVerificationResults() {
  if (!verificationResultsPath) return undefined;
  return readJson(resolveRepoPath(cwd, normalizeRepoPath(verificationResultsPath, "verification-results"), "verification-results"));
}

function parseNpmProvenance(results) {
  if (!results || typeof results !== "object") {
    return { status: "failed", reason: "require-npm-provenance=true but no verification-results file was provided" };
  }
  const value = results.npmProvenance;
  if (value === "passed" || value === true || value?.status === "passed") {
    return { status: "passed" };
  }
  return { status: "failed", reason: "npm provenance verification did not pass" };
}

function receiptFor(action, status, details) {
  return {
    schemaVersion: 1,
    kind: "attest",
    action,
    status,
    packagePath,
    subjectManifest: details.subjectManifest,
    sbomPath: details.sbomPath,
    evidencePath,
    githubAttestation: details.githubAttestation,
    reason: details.reason,
    subjects: details.subjects.map((subject) => ({
      path: subject.path,
      sha256: subject.sha256,
      bytes: subject.bytes,
      kind: subject.kind
    })),
    checks: details.checks,
    recordedAt: new Date().toISOString()
  };
}

function expandPattern(pattern) {
  const absolute = resolve(cwd, pattern);
  if (!hasGlob(pattern)) {
    if (!existsSync(absolute)) return [];
    const stat = statSync(absolute);
    if (stat.isFile()) return [absolute];
    if (stat.isDirectory()) return walkFiles(absolute);
    return [];
  }
  const base = resolve(cwd, globBase(pattern));
  if (!existsSync(base)) return [];
  const matcher = globMatcher(pattern);
  return walkFiles(base).filter((path) => matcher(repoRelativePath(path)));
}

function walkFiles(dir) {
  const result = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      result.push(...walkFiles(path));
    } else if (entry.isFile()) {
      result.push(path);
    }
  }
  return result;
}

function hasGlob(pattern) {
  return /[*?[\]]/u.test(pattern);
}

function globBase(pattern) {
  const parts = pattern.split("/");
  const base = [];
  for (const part of parts) {
    if (/[*?[\]]/u.test(part)) break;
    base.push(part);
  }
  return base.length > 0 ? base.join("/") : ".";
}

function globMatcher(pattern) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/gu, "\\$&")
    .replaceAll("**", "__ASYNC_GLOBSTAR__")
    .replaceAll("*", "[^/]*")
    .replaceAll("__ASYNC_GLOBSTAR__", ".*");
  return new RegExp(`^${escaped}$`, "u");
}

function repoRelativePath(path) {
  return relative(cwd, path).split("\\").join("/");
}

function subjectKind(path) {
  if (/\.t(ar\.)?gz$/u.test(path)) return "npm-tarball";
  if (path.endsWith("package.json")) return "package-manifest";
  if (path.endsWith(".json")) return "json-evidence";
  return "artifact";
}

function sha256(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function writeJson(path, value) {
  const absolute = resolveRepoPath(cwd, path, path);
  ensureParent(absolute);
  writeFileSync(absolute, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function emitOutputs(result) {
  output("subject-manifest", subjectManifestPath);
  output("sbom-path", sbomPath);
  output("attestation-url", result.attestationUrl ?? "");
  output("verified", result.verified ? "true" : "false");
  output("evidence-path", evidencePath);
  summary([
    "### async/actions/attest",
    "",
    `- mode: ${mode}`,
    `- subjects: ${result.subjects.length}`,
    `- subject manifest: ${subjectManifestPath}`,
    `- evidence: ${evidencePath}`
  ].join("\n"));
}
