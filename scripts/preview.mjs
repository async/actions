import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { cp } from "node:fs/promises";
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
const { packageDir, manifest } = packageContext(packagePath);
const repository = input("repository", process.env.GITHUB_REPOSITORY ?? "");
const githubSha = process.env.GITHUB_SHA ?? "";

if (!namespace) throw new Error("namespace or GITHUB_REPOSITORY_OWNER is required.");
if (!repository) throw new Error("repository or GITHUB_REPOSITORY is required.");
const npmAuth = configureNpmAuth(registry, tokenEnvName);

const leaf = manifest.name.startsWith("@") ? manifest.name.split("/")[1] : manifest.name;
const mirrorName = `@${namespace.toLowerCase()}/${leaf}`;
let version;
let distTag;
let prNumber;
let headSha = githubSha;

if (mode === "main") {
  version = `0.0.0-main.sha.${githubSha}`;
  distTag = "main";
} else if (mode === "pr") {
  const event = JSON.parse(process.env.GITHUB_EVENT_PATH ? await import("node:fs/promises").then((fs) => fs.readFile(process.env.GITHUB_EVENT_PATH, "utf8")) : "{}");
  const pr = event.pull_request ?? {};
  prNumber = Number(pr.number ?? event.number);
  headSha = pr.head?.sha ?? githubSha;
  const headRepo = pr.head?.repo?.full_name;
  if (headRepo && headRepo !== repository) {
    console.log(`Skipping preview publish: PR head ${headRepo} is not ${repository}.`);
    process.exit(0);
  }
  if (!Number.isInteger(prNumber) || prNumber <= 0 || !headSha) {
    throw new Error("PR preview needs pull_request.number and pull_request.head.sha.");
  }
  version = `0.0.0-pr.${prNumber}.sha.${headSha}`;
  distTag = `pr-${prNumber}`;
} else {
  throw new Error(`Unsupported preview mode ${mode}. Use pr or main.`);
}

const stagingDir = mkdtempSync(join(tmpdir(), "async-actions-preview-"));
try {
  const staged = {
    ...manifest,
    name: mirrorName,
    version,
    publishConfig: { registry }
  };
  delete staged.scripts;
  delete staged.devDependencies;
  writeFileSync(join(stagingDir, "package.json"), `${JSON.stringify(staged, null, 2)}\n`, "utf8");
  await cp(join(packageDir, "dist"), join(stagingDir, "dist"), { recursive: true });
  const spec = `${mirrorName}@${version}`;
  const view = npmView(spec, registry, stagingDir);
  if (view.status === 0) {
    console.log(`${spec} already exists; skipping publish.`);
  } else {
    if (!isMissingVersion(view)) throw new Error(`Could not determine whether ${spec} exists.`);
    run("npm", ["publish", "--tag", distTag, "--ignore-scripts", "--registry", registry], { cwd: stagingDir });
  }
  run("npm", ["dist-tag", "add", spec, distTag, "--registry", registry], { cwd: stagingDir });

  if (mode === "pr" && shouldComment && prNumber) {
    const target = mirrorName === manifest.name ? `${mirrorName}@${distTag}` : `${manifest.name}@npm:${mirrorName}@${distTag}`;
    const body = [
      "<!-- async-actions-package-preview -->",
      "### Preview package",
      "",
      `Preview for PR head \`${headSha}\`, published as \`${mirrorName}\`.`,
      "",
      "```sh",
      `pnpm add ${target}`,
      "```"
    ].join("\n");
    const comments = run("gh", ["api", `/repos/${repository}/issues/${prNumber}/comments`, "--paginate"], { cwd, capture: true, check: false });
    const existing = comments.status === 0
      ? JSON.parse(comments.stdout || "[]").find((comment) => comment?.body?.includes("<!-- async-actions-package-preview -->") && comment?.user?.login === "github-actions[bot]")
      : undefined;
    if (existing?.id) {
      run("gh", ["api", `/repos/${repository}/issues/comments/${existing.id}`, "--method", "PATCH", "-f", `body=${body}`], { cwd });
    } else {
      run("gh", ["api", `/repos/${repository}/issues/${prNumber}/comments`, "--method", "POST", "-f", `body=${body}`], { cwd });
    }
  }

  output("package-spec", `${mirrorName}@${version}`);
  output("published-version", version);
  output("dist-tag", distTag);
} finally {
  rmSync(stagingDir, { recursive: true, force: true });
}

summary(`### async/actions/preview\n\n- mode: ${mode}\n- package: ${mirrorName}@${version}\n- dist-tag: ${distTag}`);
npmAuth?.cleanup();
