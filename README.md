# async/actions

Reusable GitHub composite actions for Async generated workflows.

`@async/pipeline` remains the source of truth for workflow triggers, job graph,
matrices, permissions, environments, and secret mapping. This repo only contains
step-level actions that generated workflows call.

## Actions

| Action | Purpose |
| --- | --- |
| `async/actions/setup` | Set up Node, pnpm, npm, optional Deno/Bun, registry auth, cache, and optional install. |
| `async/actions/run` | Check generated workflow drift, run an `async-pipeline` job/task, and upload run evidence. |
| `async/actions/pages` | Validate static/prerender output, build Jekyll when requested, upload Pages artifacts, and optionally deploy. |
| `async/actions/publish` | Publish npm/GitHub Packages, create or sync GitHub Releases, and verify release state via `npm` and `gh`. |
| `async/actions/doctor` | Run `async-release` package planning, inspection, release-note rendering, and doctor evidence commands. |
| `async/actions/preview` | Publish same-repo PR/main preview packages to GitHub Packages and emit preview comment bodies. |
| `async/actions/comment` | Create or update idempotent comments, append job summaries, and emit structured workflow annotations. |
| `async/actions/contract` | Run API, claims, and schema contract checks and write bounded evidence reports. |
| `async/actions/dependabot-merge` | Validate Dependabot metadata, approve, wait for checks, and squash-merge. |
| `async/actions/matrix` | Produce matrix JSON for downstream `fromJSON(...)` jobs. |
| `async/actions/storage` | Read/write repo-local state, apply safe change sets, and emit receipts for Actions-only users who cannot install the GitHub App. |
| `async/actions/evidence` | Collect, upload, and merge manifest-backed run evidence artifacts without copying raw file contents into the manifest. |
| `async/actions/agent-evidence` | Collect redacted agent transcripts, context packs, explicit outputs, bundle metadata, and comment handoff bodies. |
| `async/actions/source-impact` | Read generated source plans, emit impact matrices, validate source checkout metadata, run generated prepare commands, and write source receipts. |
| `async/actions/cache` | Restore, save, and summarize Async task caches from generated cache manifests. |
| `async/actions/attest` | Compute subject digests, write package SBOM evidence, validate tarball subjects, and record provenance or attestation verification receipts. |

## Boundary

These actions do not own workflow-level behavior. Callers must grant permissions
and pass tokens explicitly. Network behavior is intentionally visible in
generated GitHub Actions instead of being bundled inside normal package installs.

Generated Async workflows should pin these actions to reviewed full commit SHAs.
Compatibility tags such as `v0` may remain human-facing labels, but moving a tag
must not change already-generated privileged workflow behavior.

## Governance

Executable changes are owner-only. External bug reports and security reports are
welcome through issues or advisories, but maintainers write action metadata,
helper scripts, and package metadata. A maintainer review is required before
`@async/pipeline` updates its generated action manifest to a new commit SHA.

## Actions-Only Storage Bridge

`async/actions/storage` is the fallback path for teams that cannot install the
Async GitHub App yet. It works inside a normal checked-out repository with the
caller-provided `GITHUB_TOKEN` permissions:

```yaml
- uses: async/actions/storage@<reviewed-full-sha> # v0.1.x
  with:
    mode: apply-change-set
    change-set: .async/inbox/change-set.json
    receipt-path: .async/receipts/change-set.json
    commit: "true"
    pull-request: "true"
    branch: async/storage/${{ github.run_id }}
    base-branch: main
    github-token: ${{ secrets.GITHUB_TOKEN }}
```

Change sets use the same safe file shape as `@async/github-app`: `files` entries
with `path`, `action: "upsert" | "delete"`, and optional `content`. Absolute
paths, `..`, duplicate paths, empty path segments, and `.github/workflows/**`
writes are rejected unless the caller explicitly enables workflow paths.

## Evidence Artifacts

`async/actions/evidence` writes a JSON manifest for explicit repo-local files,
directories, and globs, then can upload that manifest-backed artifact or merge
downloaded manifests into one index. Manifest file entries include path, kind,
size, and SHA-256 digest; they do not include raw file contents, logs, or
environment dumps.

Bridge and storage receipt JSON can be passed through `receipt-paths`. The action
keeps only bounded metadata such as change-set id, lease id, worker, status,
commit SHA, pull request URL, and changed paths. It rejects absolute paths and
`..` segments before reading evidence inputs.

## Agent Evidence

`async/actions/agent-evidence` packages agent run artifacts already written by
`@async/pipeline`: prompt files, redacted transcripts, failure context packs, and
explicit task outputs such as patches or reports. The action records paths,
kinds, sizes, and hashes, writes a receipt for `async/actions/evidence`, and can
emit a bounded comment body for `async/actions/comment`. It does not run agents,
choose models, apply patches, or paste large artifacts into comments.

## Contract Evidence

`async/actions/contract` writes manifest-backed evidence for API, claims, and
schema checks. Generated workflows choose `mode: report`, `check`, `strict`, or
`release`; the action records status and findings, while the caller workflow
owns whether those findings block the job. Optional command inputs let generated
workflows run package-specific CLIs from the checked-out repo. Schema sources are
validated from repo-local JSON files or globs, and generated workflows can set
the schema report path while evidence stays under `.async/contract`.

## Source Impact

`async/actions/source-impact` is a step-level helper for workflows generated by
`@async/pipeline`. The generated workflow writes the trusted source plan, then
calls the action in `plan`, `checkout`, `prepare`, or `receipt` mode. Source ids,
paths, refs, and matrix rows are validated against that generated plan before
the action writes receipts under `.async/actions/receipts`.

Git refs must be full SHAs or generated-safe refs such as `refs/heads/*`,
`refs/tags/*`, or `refs/pull/<number>/merge`. Prepare commands come from the
generated plan and are printed before execution.

## Task Cache

`async/actions/cache` restores and saves task-cache paths from a generated
`@async/pipeline` manifest. The manifest owns cache keys, path lists, write
eligibility, and trust level; the action validates that metadata, delegates to
pinned `actions/cache` restore/save steps, and writes cache receipts under
`.async/actions/receipts`.

Use `trust: read-only` for untrusted pull requests. Save mode requires
`trust: read-write`; read-only saves are skipped and recorded rather than
silently writing cache state.

## Attestation Evidence

`async/actions/attest` works from explicit generated subjects. Digest and SBOM
modes hash repo-local files and write manifests under `.async/attest`; verify
mode re-reads those manifests, checks current digests, can scan npm tarballs for
unsafe entries, and can require a parsed npm provenance result. The action does
not publish packages. Real GitHub artifact attestation requires the generated
workflow to grant OIDC permissions and pass that mode explicitly.

## Release Doctor

`async/actions/doctor` is a thin wrapper around `async-release`. Generated
workflows choose the command mode and package path explicitly, then the action
records bounded evidence such as the release plan, package report, rendered
release notes, and doctor checks. The action does not infer workflow
permissions, release package selection, or registry credentials.

## Comments And Annotations

`async/actions/comment` owns idempotent marker management, markdown body loading,
summary appends, and structured annotation rendering. Callers pass tokens
explicitly and choose the target repository, issue or pull request number, body
source, and marker. Markdown bodies are bounded before comment writes.

## Local Checks

```sh
npm run check
npm test
```
