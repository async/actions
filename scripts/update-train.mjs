import { input, output, packageContext, parseList, run, summary } from "./lib.mjs";

const packagePath = input("package-path", ".");
const explicitPackageName = input("package-name", "");
const explicitVersion = input("version", "");
const repositories = parseList(input("repositories", ""));
const eventType = input("event-type", "async-dep-bump");
const token = input("github-token", "");
const sourceRepository = input("source-repository", process.env.GITHUB_REPOSITORY ?? "");
const { manifest } = packageContext(packagePath);
const packageName = explicitPackageName || manifest.name;
const version = normalizeVersion(explicitVersion || manifest.version);

assertPackageName(packageName);
assertVersion(version);
assertEventType(eventType);
if (!token) throw new Error("github-token is required.");
if (repositories.length === 0) throw new Error("repositories must include at least one owner/name target.");
for (const repository of repositories) assertRepository(repository);
if (sourceRepository) assertRepository(sourceRepository);

for (const repository of repositories) {
  run("gh", [
    "api",
    `repos/${repository}/dispatches`,
    "-f",
    `event_type=${eventType}`,
    "-f",
    `client_payload[package]=${packageName}`,
    "-f",
    `client_payload[version]=${version}`,
    ...(sourceRepository ? ["-f", `client_payload[source_repository]=${sourceRepository}`] : [])
  ], {
    env: {
      GH_TOKEN: token,
      GITHUB_TOKEN: token
    }
  });
  console.log(`Dispatched ${eventType} to ${repository} for ${packageName}@${version}.`);
}

output("package-name", packageName);
output("version", version);
output("dispatched", String(repositories.length));
summary(`### async/actions/update-train

- package: ${packageName}@${version}
- event: ${eventType}
- dispatched: ${repositories.length}`);

function normalizeVersion(value) {
  return String(value ?? "").trim().replace(/^v/u, "");
}

function assertPackageName(value) {
  if (!/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/u.test(String(value))) {
    throw new Error(`Invalid package name ${value}.`);
  }
}

function assertVersion(value) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u.test(String(value))) {
    throw new Error(`Invalid package version ${value}.`);
  }
}

function assertRepository(value) {
  const parts = String(value).split("/");
  if (parts.length !== 2 || !parts.every((part) => /^(?!\.{1,2}$)[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(part))) {
    throw new Error(`Invalid repository ${value}. Expected owner/name.`);
  }
}

function assertEventType(value) {
  if (!/^[A-Za-z0-9_.:-]+$/u.test(String(value))) {
    throw new Error(`Invalid event type ${value}.`);
  }
}
