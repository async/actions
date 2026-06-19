import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boolInput, configureNpmAuth, cwdFromInput, input, isMissingVersion, npmView, output, packageContext, run, summary } from "./lib.mjs";

const cwd = cwdFromInput();
const mode = input("mode", "pr");
const packagePath = input("package-path", ".");
const registry = input("target-registry", "https://npm.pkg.github.com");
const namespace = input("namespace", process.env.GITHUB_REPOSITORY_OWNER ?? "");
const shouldComment = boolInput("comment", true);
const tokenEnvName = input("token-env-name", "GITHUB_TOKEN");
const releasePackage = input("release-package", "github:async/release#v0.1.3");
const shouldMoveDistTag = boolInput("move-dist-tag", true);
const { packageDir, manifest } = packageContext(packagePath);
const repository = input("repository", process.env.GITHUB_REPOSITORY ?? "");
const githubSha = process.env.GITHUB_SHA ?? "";

if (!namespace) throw new Error("namespace or GITHUB_REPOSITORY_OWNER is required.");
if (!repository) throw new Error("repository or GITHUB_REPOSITORY is required.");
let npmAuth;
let stagingDir;

const releaseArgs = [
  "--package", packagePath,
  "--mode", mode,
  "--namespace", namespace,
  "--source-repository", repository,
  "--source-sha", githubSha,
  "--evidence-dir", ".async/release"
];
let prNumber;
let headSha = githubSha;
let skipReason;
if (mode === "main") {
  if (!githubSha) throw new Error("Main preview needs GITHUB_SHA.");
} else if (mode === "pr") {
  const event = JSON.parse(process.env.GITHUB_EVENT_PATH ? await import("node:fs/promises").then((fs) => fs.readFile(process.env.GITHUB_EVENT_PATH, "utf8")) : "{}");
  const pr = event.pull_request ?? {};
  prNumber = Number(pr.number ?? event.number);
  headSha = pr.head?.sha ?? githubSha;
  const headRepo = pr.head?.repo?.full_name;
  if (headRepo && headRepo !== repository) {
    skipReason = `PR head ${headRepo} is not ${repository}.`;
  }
  if (!skipReason && (!Number.isInteger(prNumber) || prNumber <= 0 || !headSha)) {
    throw new Error("PR preview needs pull_request.number and pull_request.head.sha.");
  }
  if (prNumber) releaseArgs.push("--pr-number", String(prNumber));
  if (headSha) releaseArgs.push("--head-sha", headSha);
} else {
  throw new Error(`Unsupported preview mode ${mode}. Use pr or main.`);
}
if (!shouldComment) releaseArgs.push("--no-comment");
if (skipReason) releaseArgs.push("--skip-reason", skipReason);

const plan = runReleasePreview("plan", releaseArgs);
const { mirrorPackageName, version, distTag, packageSpec } = plan.preview;

try {
  if (plan.skip.shouldSkip) {
    console.log(`Skipping preview publish: ${plan.skip.reason}`);
    summary(`### async/actions/preview\n\n- mode: ${mode}\n- package: ${manifest.name}\n- skipped: ${plan.skip.reason}`);
    process.exit(0);
  }

  stagingDir = mkdtempSync(join(tmpdir(), "async-actions-preview-"));
  const stage = runReleasePreview("stage", [
    ...releaseArgs,
    "--registry", registry,
    "--stage-dir", stagingDir
  ]);

  const spec = packageSpec;
  npmAuth = configureNpmAuth(registry, tokenEnvName);
  const view = npmView(spec, registry, stagingDir);
  if (view.status === 0) {
    console.log(`${spec} already exists; skipping publish.`);
  } else {
    if (!isMissingVersion(view)) throw new Error(`Could not determine whether ${spec} exists.`);
    run("npm", ["publish", "--tag", distTag, "--ignore-scripts", "--registry", registry], { cwd: stagingDir });
  }
  if (shouldMoveDistTag) {
    run("npm", ["dist-tag", "add", spec, distTag, "--registry", registry], { cwd: stagingDir });
  } else {
    console.log(`Skipping dist-tag move for ${spec}; move-dist-tag=false.`);
  }

  if (mode === "pr" && shouldComment && prNumber && plan.install?.commentBody) {
    output("comment-body", plan.install.commentBody);
    output("comment-marker", plan.install.commentMarker);
  }

  output("package-spec", packageSpec);
  output("published-version", version);
  output("dist-tag", distTag);
  summary(`### async/actions/preview\n\n- mode: ${mode}\n- package: ${mirrorPackageName}@${version}\n- dist-tag: ${distTag}${shouldMoveDistTag ? "" : " (not moved)"}\n- staging: ${stage.staging?.path ?? "unknown"}`);
} finally {
  if (stagingDir) rmSync(stagingDir, { recursive: true, force: true });
  npmAuth?.cleanup();
}

function runReleasePreview(command, args) {
  const result = run("npm", [
    "exec",
    "--yes",
    "--package",
    releasePackage,
    "--",
    "async-release",
    "preview",
    command,
    ...args,
    "--json"
  ], { cwd, capture: true });
  return JSON.parse(result.stdout);
}
