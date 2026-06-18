import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { configureNpmAuth } from "../scripts/lib.mjs";

test("GitHub Packages auth can prefer GITHUB_TOKEN over NODE_AUTH_TOKEN", () => {
  const previousNodeAuth = process.env.NODE_AUTH_TOKEN;
  const previousGitHubToken = process.env.GITHUB_TOKEN;
  const previousUserConfig = process.env.NPM_CONFIG_USERCONFIG;
  process.env.NODE_AUTH_TOKEN = "npm-token";
  process.env.GITHUB_TOKEN = "github-token";

  const auth = configureNpmAuth("https://npm.pkg.github.com", "GITHUB_TOKEN");
  try {
    assert.ok(auth);
    assert.equal(auth.tokenEnvName, "GITHUB_TOKEN");
    assert.match(readFileSync(auth.userconfig, "utf8"), /github-token/u);
  } finally {
    auth?.cleanup();
    restoreEnv("NODE_AUTH_TOKEN", previousNodeAuth);
    restoreEnv("GITHUB_TOKEN", previousGitHubToken);
    restoreEnv("NPM_CONFIG_USERCONFIG", previousUserConfig);
  }
});

test("publish action exposes bounded registry verification retries", () => {
  const action = readFileSync(new URL("../publish/action.yml", import.meta.url), "utf8");
  const script = readFileSync(new URL("../scripts/publish.mjs", import.meta.url), "utf8");

  assert.match(action, /verify-attempts:/u);
  assert.match(action, /verify-delay-ms:/u);
  assert.match(script, /Waiting for \$\{targetSpec\}/u);
  assert.match(script, /await ensureVersionExists\(spec, "https:\/\/registry\.npmjs\.org"\)/u);
});

function restoreEnv(name, value) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}
