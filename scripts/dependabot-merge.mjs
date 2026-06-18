import { input, run, summary } from "./lib.mjs";

const repository = input("repository", process.env.GITHUB_REPOSITORY ?? "");
const prNumber = input("pull-request-number", "");
const actor = input("actor", process.env.GITHUB_ACTOR ?? "");
const allowedEcosystems = input("allowed-ecosystems", "npm,pnpm,github-actions")
  .split(/[\n,]+/)
  .map((entry) => entry.trim())
  .filter(Boolean);
const ecosystem = input("dependency-ecosystem", "");
const waitSeconds = Number(input("wait-seconds", "90"));

if (!repository) throw new Error("repository or GITHUB_REPOSITORY is required.");
if (!prNumber) throw new Error("pull-request-number is required.");
if (!["dependabot[bot]", "app/dependabot"].includes(actor)) {
  throw new Error(`Refusing to merge PR from ${actor}; actor must be Dependabot.`);
}
if (!ecosystem) throw new Error("dependency-ecosystem is required from dependabot/fetch-metadata.");
if (!allowedEcosystems.includes(ecosystem)) {
  throw new Error(`Ecosystem ${ecosystem} is not allowed. Allowed: ${allowedEcosystems.join(", ")}`);
}

run("gh", ["pr", "view", prNumber, "--repo", repository, "--json", "headRefOid,mergeStateStatus,reviewDecision,statusCheckRollup"], { capture: true });
run("gh", ["pr", "review", prNumber, "--repo", repository, "--approve", "--body", "Approved by async/actions/dependabot-merge after metadata validation."], { check: false });

if (waitSeconds > 0) {
  run("gh", ["pr", "checks", prNumber, "--repo", repository, "--watch", "--required", "--interval", "10"], { check: false });
}

run("gh", ["pr", "merge", prNumber, "--repo", repository, "--squash", "--auto", "--delete-branch"]);
summary(`### async/actions/dependabot-merge\n\n- PR: ${repository}#${prNumber}\n- ecosystem: ${ecosystem}\n- allowed: ${allowedEcosystems.join(", ")}`);
