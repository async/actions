import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { cp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { assertSafeRepoPath, boolInput, configureNpmAuth, cwdFromInput, input, isMissingVersion, npmView, output, packageContext, run, summary } from "./lib.mjs";

const cwd = cwdFromInput();
const mode = input("mode", "npm");
const packagePath = input("package-path", ".");
const registry = input("registry", mode === "github-packages" ? "https://npm.pkg.github.com" : "https://registry.npmjs.org");
const distTag = input("dist-tag", "latest");
const access = input("access", "public");
const provenance = boolInput("provenance", true);
const verifyPublic = boolInput("verify-public", true);
const verifyAttempts = positiveIntegerInput("verify-attempts", 6);
const verifyDelayMs = positiveIntegerInput("verify-delay-ms", 5000);
const ownerScope = input("owner-scope", process.env.GITHUB_REPOSITORY_OWNER ?? "");
const tokenEnvName = input("token-env-name", registry.includes("npm.pkg.github.com") ? "GITHUB_TOKEN" : "NODE_AUTH_TOKEN");
const { packageDir, manifest } = packageContext(packagePath);
const version = input("version", manifest.version);
const spec = `${manifest.name}@${version}`;
const npmAuth = mode === "npm" || mode === "github-packages"
  ? configureNpmAuth(registry, tokenEnvName)
  : undefined;

async function ensureVersionExists(targetSpec, targetRegistry) {
  let lastView;
  for (let attempt = 1; attempt <= verifyAttempts; attempt += 1) {
    const view = npmView(targetSpec, targetRegistry, cwd);
    if (view.status === 0) {
      if (attempt > 1) console.log(`Verified ${targetSpec} on ${targetRegistry} after ${attempt} attempts.`);
      return;
    }
    lastView = view;
    if (attempt < verifyAttempts) {
      console.log(`Waiting for ${targetSpec} on ${targetRegistry} (${attempt}/${verifyAttempts}).`);
      await delay(verifyDelayMs);
    }
  }
  throw new Error(`Could not verify ${targetSpec} on ${targetRegistry}: ${((lastView?.stderr ?? lastView?.stdout) ?? "").slice(0, 500)}`);
}

function npmOutput(result) {
  return `${result.stdout ?? ""}${result.stderr ?? ""}`;
}

function isPreviouslyPublished(result) {
  return /previously published versions/i.test(npmOutput(result));
}

function ensureNpmPublicAccess() {
  if (access !== "public") return;
  if (!npmAuth) {
    console.log(`Skipping npm access public check for ${manifest.name}; no npm token is configured.`);
    return;
  }
  run("npm", ["access", "set", "status=public", manifest.name, "--registry", registry], { cwd });
}

function publishToNpm(args) {
  const result = run("npm", args, { cwd, capture: true, check: false });
  process.stdout.write(result.stdout ?? "");
  process.stderr.write(result.stderr ?? "");
  return result;
}

if (mode === "npm") {
  const view = npmView(spec, registry, cwd);
  if (view.status === 0 && view.stdout.trim() === version) {
    ensureNpmPublicAccess();
    console.log(`${spec} already exists on npm; skipping publish.`);
  } else {
    if (!isMissingVersion(view)) throw new Error(`Could not determine whether ${spec} exists on npm.`);
    const args = ["publish", packageDir, "--access", access, "--registry", registry];
    if (provenance) args.push("--provenance");
    const publish = publishToNpm(args);
    if (publish.status === 0) {
      ensureNpmPublicAccess();
    } else if (isPreviouslyPublished(publish)) {
      ensureNpmPublicAccess();
      console.log(`${spec} already exists on npm; repaired public access.`);
    } else {
      throw new Error(`npm publish ${packageDir} failed with exit code ${publish.status ?? "unknown"}.`);
    }
  }
  if (verifyPublic) await ensureVersionExists(spec, "https://registry.npmjs.org");
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
    await stagePackedFiles(packageDir, stagingDir);
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
  await ensureVersionExists(spec, "https://registry.npmjs.org");
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

async function stagePackedFiles(packageDir, stagingDir) {
  for (const file of readPackFiles(packageDir)) {
    if (file === "package.json") continue;
    assertSafeRepoPath(file, { allowWorkflowPaths: true });
    const source = join(packageDir, file);
    const target = join(stagingDir, file);
    await mkdir(dirname(target), { recursive: true });
    await cp(source, target, { recursive: true });
  }
}

function readPackFiles(packageDir) {
  const result = run("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { cwd: packageDir, capture: true });
  const packs = JSON.parse(result.stdout);
  const files = packs?.[0]?.files;
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error("npm pack --dry-run returned no files for GitHub Packages staging.");
  }
  return files.map((entry) => {
    if (!entry || typeof entry.path !== "string") {
      throw new Error("npm pack --dry-run returned an invalid file entry.");
    }
    return entry.path;
  });
}

function positiveIntegerInput(name, fallback) {
  const value = Number(input(name, String(fallback)));
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
