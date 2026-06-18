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
| `async/actions/preview` | Publish same-repo PR/main preview packages to GitHub Packages and maintain preview comments. |
| `async/actions/dependabot-merge` | Validate Dependabot metadata, approve, wait for checks, and squash-merge. |
| `async/actions/matrix` | Produce matrix JSON for downstream `fromJSON(...)` jobs. |
| `async/actions/storage` | Read/write repo-local state, apply safe change sets, and emit receipts for Actions-only users who cannot install the GitHub App. |

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

## Local Checks

```sh
npm run check
npm test
```
