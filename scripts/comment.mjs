import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { cwdFromInput, input, output, resolveRepoPath, run, summary } from "./lib.mjs";

const cwd = cwdFromInput();
const mode = input("mode", "pr-comment");
const repository = input("repository", process.env.GITHUB_REPOSITORY ?? "");
const number = input("number", "");
const marker = input("marker", "");
const bodyInput = input("body", "");
const bodyFile = input("body-file", "");
const annotationsFile = input("annotations-file", "");
const token = input("token", "");
const maxBodyBytes = positiveInt(input("max-body-bytes", "60000"), 60000);

if (mode === "summary") {
  const body = boundedBody(readBody(), maxBodyBytes);
  if (process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${body.trimEnd()}\n`);
  } else {
    process.stdout.write(`${body.trimEnd()}\n`);
  }
  output("updated", "false");
} else if (mode === "annotation") {
  emitAnnotations(readAnnotations());
  output("updated", "false");
  summary("### async/actions/comment\n\n- mode: annotation");
} else if (mode === "pr-comment" || mode === "issue-comment") {
  if (!repository) throw new Error("repository is required for comment modes.");
  if (!/^\d+$/u.test(number) || Number(number) <= 0) throw new Error("number must be a positive integer for comment modes.");
  if (!marker) throw new Error("marker is required for idempotent comments.");
  if (!token) throw new Error("token input is required for comment modes.");
  const body = withMarker(marker, boundedBody(readBody(), maxBodyBytes));
  const comments = listComments(repository, number, token);
  const existing = comments.find((comment) => typeof comment?.body === "string"
    && comment.body.includes(markerHtml(marker))
    && comment?.user?.login === "github-actions[bot]");
  if (existing?.id) {
    const patched = ghJson(["api", `/repos/${repository}/issues/comments/${existing.id}`, "--method", "PATCH", "-f", `body=${body}`], token);
    output("comment-id", String(patched.id ?? existing.id));
    output("comment-url", String(patched.html_url ?? existing.html_url ?? ""));
    output("updated", "true");
  } else {
    const created = ghJson(["api", `/repos/${repository}/issues/${number}/comments`, "--method", "POST", "-f", `body=${body}`], token);
    output("comment-id", String(created.id ?? ""));
    output("comment-url", String(created.html_url ?? ""));
    output("updated", "false");
  }
  summary(`### async/actions/comment\n\n- mode: ${mode}\n- repository: ${repository}\n- number: ${number}\n- marker: ${marker}`);
} else {
  throw new Error(`Unsupported comment mode ${mode}.`);
}

function readBody() {
  if (bodyFile) {
    return readFileSync(resolveRepoPath(cwd, bodyFile, "body-file"), "utf8");
  }
  if (bodyInput) return bodyInput;
  return "";
}

function readAnnotations() {
  if (!annotationsFile) throw new Error("annotations-file is required for annotation mode.");
  const path = resolveRepoPath(cwd, annotationsFile, "annotations-file");
  if (!existsSync(path)) throw new Error(`annotations-file does not exist: ${annotationsFile}`);
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(parsed)) throw new Error("annotations-file must contain a JSON array.");
  return parsed;
}

function listComments(repo, issueNumber, ghToken) {
  const result = run("gh", ["api", `/repos/${repo}/issues/${issueNumber}/comments`, "--paginate"], {
    cwd,
    capture: true,
    check: false,
    env: { GITHUB_TOKEN: ghToken }
  });
  if (result.status !== 0) {
    const text = `${result.stdout ?? ""}${result.stderr ?? ""}`.slice(0, 500);
    throw new Error(`Failed to list comments for ${repo}#${issueNumber}: ${text}`);
  }
  const parsed = JSON.parse(result.stdout || "[]");
  if (!Array.isArray(parsed)) throw new Error("GitHub comments response was not an array.");
  return parsed;
}

function ghJson(args, ghToken) {
  const result = run("gh", args, {
    cwd,
    capture: true,
    env: { GITHUB_TOKEN: ghToken }
  });
  return result.stdout.trim() ? JSON.parse(result.stdout) : {};
}

function withMarker(id, body) {
  const markerText = markerHtml(id);
  return body.includes(markerText) ? body : `${markerText}\n${body}`;
}

function markerHtml(id) {
  if (!/^[A-Za-z0-9._:-]+$/u.test(id)) {
    throw new Error("marker may contain only letters, numbers, dot, underscore, colon, or hyphen.");
  }
  return `<!-- ${id} -->`;
}

function boundedBody(body, maxBytes) {
  const buffer = Buffer.from(body, "utf8");
  if (buffer.byteLength <= maxBytes) return body;
  const marker = `\n\n<!-- async-actions-comment-truncated: ${buffer.byteLength} bytes > ${maxBytes} bytes -->\n`;
  return `${buffer.subarray(0, Math.max(0, maxBytes - Buffer.byteLength(marker))).toString("utf8").replace(/\uFFFD$/u, "")}${marker}`;
}

function emitAnnotations(entries) {
  for (const entry of entries) {
    if (!entry || typeof entry !== "object") throw new Error("annotation entries must be objects.");
    const level = entry.level ?? "notice";
    if (!["notice", "warning", "error"].includes(level)) throw new Error(`Unsupported annotation level ${level}.`);
    const message = String(entry.message ?? "");
    if (!message) throw new Error("annotation message is required.");
    const properties = [];
    if (entry.file) properties.push(`file=${escapeProperty(entry.file)}`);
    if (entry.line) properties.push(`line=${escapeProperty(entry.line)}`);
    if (entry.endLine) properties.push(`endLine=${escapeProperty(entry.endLine)}`);
    if (entry.title) properties.push(`title=${escapeProperty(entry.title)}`);
    process.stdout.write(`::${level}${properties.length ? ` ${properties.join(",")}` : ""}::${escapeMessage(message)}\n`);
  }
}

function escapeProperty(value) {
  return String(value).replace(/%/gu, "%25").replace(/\r/gu, "%0D").replace(/\n/gu, "%0A").replace(/:/gu, "%3A").replace(/,/gu, "%2C");
}

function escapeMessage(value) {
  return String(value).replace(/%/gu, "%25").replace(/\r/gu, "%0D").replace(/\n/gu, "%0A");
}

function positiveInt(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
