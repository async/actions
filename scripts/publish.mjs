import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boolInput, configureNpmAuth, cwdFromInput, input, isMissingVersion, npmView, output, packageContext, run, summary } from "./lib.mjs";

const cwd = cwdFromInput();
const mode = input("mode", "npm");
const packagePath = input("package-path", ".");
const registry = input("registry", mode === "github-packages" ? "https://npm.pkg.github.com" : "https://registry.npmjs.org");
const distTag = input("dist-tag", "latest");
const access = input("access", "public");
const provenance = boolInput("provenance", true);
const verifyPublic = boolInput("verify-public", true);
const ownerScope = input("owner-scope", process.env.GITHUB_REPOSITORY_OWNER ?? "");
const { packageDir, manifest } = packageContext(packagePath);
const version = input("version", manifest.version);
const spec = `${manifest.name}@${version}`;
const npmAuth = configureNpmAuth(registry);

function ensureVersionExists(targetSpec, targetRegistry) {
  const view = npmView(targetSpec, targetRegistry, cwd);
  if (view.status !== 0) {
    throw new Error(`Could not verify ${targetSpec} on ${targetRegistry}: ${(view.stderr ?? view.stdout ?? "").slice(0, 500)}`);
  }
}

if (mode === "npm") {
  const view = npmView(spec, registry, cwd);
  if (view.status === 0 && view.stdout.trim() === version) {
    console.log(`${spec} already exists on npm; skipping publish.`);
  } else {
    if (!isMissingVersion(view)) throw new Error(`Could not determine whether ${spec} exists on npm.`);
    const args = ["publish", packageDir, "--access", access, "--registry", registry];
    if (provenance) args.push("--provenance");
    run("npm", args, { cwd });
  }
  if (verifyPublic) ensureVersionExists(spec, "https://registry.npmjs.org");
} else if (mode === "github-packages") {
  if (!ownerScope) throw new Error("owner-scope is required for GitHub Packages publishing.");
  const leaf = manifest.name.startsWith("@") ? manifest.name.split("/")[1] : manifest.name;
  const mirrorName = `@${ownerScope.toLowerCase()}/${leaf}`;
  const mirrorSpec = `${mirrorName}@${version}`;
  const stagingDir = mkdtempSync(join(tmpdir(), "async-actions-github-packages-"));
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
    const view = npmView(mirrorSpec, registry, stagingDir);
    if (view.status === 0 && view.stdout.trim() === version) {
      console.log(`${mirrorSpec} already exists on GitHub Packages; skipping publish.`);
    } else {
      if (!isMissingVersion(view)) throw new Error(`Could not determine whether ${mirrorSpec} exists on GitHub Packages.`);
      run("npm", ["publish", "--tag", distTag, "--ignore-scripts", "--registry", registry], { cwd: stagingDir });
    }
    run("npm", ["dist-tag", "add", mirrorSpec, distTag, "--registry", registry], { cwd: stagingDir });
    output("package-spec", mirrorSpec);
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
  }
} else if (mode === "github-release") {
  const tag = `v${version}`;
  const notesFile = input("notes-file", "");
  const title = input("title", `${manifest.name} ${tag}`);
  const repo = input("repository", process.env.GITHUB_REPOSITORY ?? "");
  if (!repo) throw new Error("repository or GITHUB_REPOSITORY is required.");
  const view = run("gh", ["release", "view", tag, "--repo", repo], { cwd, capture: true, check: false });
  if (view.status === 0) {
    const args = ["release", "edit", tag, "--repo", repo, "--title", title];
    if (notesFile) args.push("--notes-file", notesFile);
    run("gh", args, { cwd });
  } else {
    const args = ["release", "create", tag, "--repo", repo, "--target", process.env.GITHUB_SHA ?? "HEAD", "--title", title];
    if (notesFile) args.push("--notes-file", notesFile);
    run("gh", args, { cwd });
  }
} else if (mode === "doctor") {
  ensureVersionExists(spec, "https://registry.npmjs.org");
  const repo = input("repository", process.env.GITHUB_REPOSITORY ?? "");
  if (repo) run("gh", ["release", "view", `v${version}`, "--repo", repo], { cwd });
} else {
  throw new Error(`Unsupported publish mode ${mode}.`);
}

output("published-version", version);
output("package-spec", spec);
output("dist-tag", distTag);
summary(`### async/actions/publish\n\n- mode: ${mode}\n- package: ${spec}\n- registry: ${registry}\n- dist-tag: ${distTag}`);
npmAuth?.cleanup();
