# Changelog

## 0.1.22 - 2026-07-02

### Fixes

- Ensure token-backed npm publishes set scoped packages to public access, including
  retries after an existing-version conflict.

## 0.1.21 - 2026-07-01

### Features

- Add `async/actions/update-train` for explicit release-train repository dispatches.
- Add `async/actions/dependency-bump` for allowlisted dependency bumps with verify and push or pull-request landing.

## 0.1.20 - 2026-06-19

### Changes

- Default preview actions to `@async/release@v0.1.5`.

## 0.1.19 - 2026-06-19

### Changes

- Default preview actions to `@async/release@v0.1.4`.

## 0.1.18 - 2026-06-19

### Fixes

- Stage preview package files inside the repository workspace before publishing.

## 0.1.17 - 2026-06-19

### Features

- Consume the release evidence contract in preview publishing.

## 0.1.16 - 2026-06-19

### Fixes

- Resolve the hygiene action binary from the repo-local install before falling back to `PATH`.

## 0.1.15 - 2026-06-19

### Features

- Add the `async/actions/hygiene` evidence action.

## 0.1.14 - 2026-06-18

### Features

- Add schema output configuration to the contract action.

## 0.1.13 - 2026-06-18

### Features

- Add the `async/actions/contract` action.

## 0.1.12 - 2026-06-18

### Features

- Add workflow evidence capture.

## 0.1.11 - 2026-06-18

### Features

- Add the `async/actions/comment` action.

## 0.1.10 - 2026-06-18

### Features

- Add the `async/actions/doctor` release evidence wrapper.

## 0.1.9 - 2026-06-18

### Features

- Add the `async/actions/attest` evidence action.

## 0.1.8 - 2026-06-18

### Features

- Add the `async/actions/cache` action.

## 0.1.7 - 2026-06-18

### Features

- Add the `async/actions/source-impact` action.

## 0.1.6 - 2026-06-18

### Features

- Add manifest-backed evidence collection through `async/actions/evidence`.

## 0.1.5 - 2026-06-18

### Fixes

- Scope npm auth setup to publish modes.

## 0.1.4 - 2026-06-18

### Fixes

- Support publishing packages without a `dist` layout.

## 0.1.3 - 2026-06-18

### Fixes

- Retry registry verification after publishing.

## 0.1.2 - 2026-06-18

### Fixes

- Prefer the GitHub token when publishing GitHub Packages.

## 0.1.1 - 2026-06-18

### Fixes

- Prepare pnpm before restoring setup cache.

## 0.1.0 - 2026-06-18

### Features

- Add the initial shared Async composite actions for setup, run, publish, preview, Pages, matrix planning, storage, and Dependabot merge.
