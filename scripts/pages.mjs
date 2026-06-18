import { existsSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { boolInput, cwdFromInput, ensureDirectory, ensureFile, input, output, summary } from "./lib.mjs";

const cwd = cwdFromInput();
const mode = input("mode", "static");
const artifactName = input("artifact-name", "github-pages");
const validateIndex = boolInput("validate-index", true);
const spaFallback = boolInput("spa-fallback", false);
const upload = boolInput("upload", true);

let artifactPath;
if (!upload) {
  artifactPath = "";
} else if (mode === "static" || mode === "prerender") {
  artifactPath = resolve(cwd, input("path", ".async/pages"));
  ensureDirectory(artifactPath, `${mode} Pages output`);
  if (validateIndex) ensureFile(join(artifactPath, "index.html"), `${mode} Pages index`);
  if (spaFallback && !existsSync(join(artifactPath, "404.html"))) {
    const index = join(artifactPath, "index.html");
    ensureFile(index, "SPA fallback source index.html");
    writeFileSync(join(artifactPath, "404.html"), "<!doctype html><meta http-equiv=\"refresh\" content=\"0; url=./index.html\">\n", "utf8");
  }
} else if (mode === "jekyll") {
  artifactPath = resolve(cwd, input("destination", "./_site"));
} else {
  throw new Error(`Unsupported pages mode ${mode}. Use static, jekyll, or prerender.`);
}

output("artifact-name", artifactName);
output("path", artifactPath);
summary(`### async/actions/pages\n\n- mode: ${mode}\n- upload: ${upload}\n- path: ${artifactPath || "deploy-only"}\n- artifact: ${artifactName}`);
