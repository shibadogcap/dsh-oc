*English · [日本語](CONTRIBUTING.ja.md) · [中文](CONTRIBUTING.zh.md)*

# Contributing to dsh-oc

> AI agents taking over the repository should read [AGENTS.md](AGENTS.md) first (structure, commands, self-test gates, and traps). This document is for human contributors.

dsh-oc is a DeepSeek Harness × OpenCode TUI frontend: dsh owns all the backend logic, the
official opencode TUI only renders and handles the keyboard, and dsh-oc provides an
OpenCode-compatible HTTP/SSE bridge inside the dsh process. Repository: `shibadogcap/dsh-oc`,
npm package name `@chiro2001/dsh-oc` (not published to the registry; install and update go
through the GitHub source).

## Development environment

Requirements: Node.js 22+, pnpm 11.x.

```bash
pnpm install
pnpm build          # produces lib/ (must be pushed with the commit; a direct GitHub install picks up new logic only when lib/ is committed)
pnpm typecheck      # tsc --noEmit
pnpm test           # vitest unit tests
pnpm run probe      # opencode 1.18.18 protocol route probe
pnpm run perf       # session performance load test (temporary DSH_HOME + mock)
pnpm run features:update   # refresh the auto-tracked parts of docs/FEATURES.md
```

One-shot self-test entry point:

```bash
bash scripts/check-all.sh              # typecheck + unit tests + probe + perf smoke
bash scripts/check-all.sh --e2e        # also runs the full e2e suite (including the real opencode TUI)
bash scripts/check-all.sh --scale 5000 # also runs the 5000-session load test
```

Local direct connection to the dsh profile (live verification, effective right after `pnpm build`):

```bash
dsh plugin --profile oc add .
```

Install from a GitHub branch (verifies the remote build artifacts):

```bash
dsh plugin --profile oc add 'github:shibadogcap/dsh-oc#<branch>'
```

## Branch strategy

- `main`: stable release line; the README install and update commands point at `#main` by default.
- `develop`: integration delivery line; day-to-day development and live user verification both happen
  on this line. Merge back into `main` once features are stable.
- Feature branches: cut from `develop`, short-lived, PR back to `develop`. Names follow
  `feat-*` / `fix-*` / `docs-*` / `perf-*` / `test-*` / `chore-*` (lowercase
  kebab-case).
- The legacy `feat-*` branches are all merged into `main` and can be cleaned up; use
  `scripts/cleanup-merged-branches.sh` to list and delete them (dry-run by default).

e2e scripts may only run on `main` / `develop` and on `chore-*` / `fix-*` / `docs-*` /
`perf-*` / `test-*` / `feat-*` (matching the CI trigger branches), so a temporary branch
cannot produce meaningless results by accident.

## Commit conventions

- Use Conventional Commits: `feat` / `fix` / `docs` / `perf` / `test` /
  `chore` / `refactor`.
- `lib/` is a build artifact but must be committed with the source; forgetting it makes a
  direct GitHub install run the old logic.
- Before committing, check for machine-specific absolute paths:
  `rg -n --hidden -g '!node_modules' -g '!.git' 'chiro' . | rg -v 'chiro2001|/home/chiro/'`
- When the capability list is involved, run `pnpm run features:update` and commit the result.

## Self-test gates (required before a PR)

1. `pnpm typecheck && pnpm test` all green.
2. `pnpm run probe` passes 63/63.
3. Protocol or bridge changes: run at least the matching `scripts/e2e-api*.sh`.
4. TUI changes: run the relevant `scripts/e2e-tui-*.sh` (boot/turn/mini/brand/continue and so on);
   for a full regression use `bash scripts/check-all.sh --e2e`.
5. Build artifact or release changes: run `bash scripts/verify-release-artifacts.sh`
   (zero diff in lib, no absolute paths and no src leakage in pack); for a release candidate
   rehearsal see `docs/RELEASE.md`.
6. Attach the test commands and a result summary to the PR description.

## Submission flow

1. Cut a short-lived branch from `develop`.
2. Implement the change and add unit/e2e coverage, then self-test against the gates above.
3. Run `pnpm run features:update` (when capabilities are involved) and commit.
4. Open a PR to `develop` describing the change, the blast radius, and the test evidence.
5. Merge once CI is green and review passes; changes that need live user verification take effect
   with develop.
6. Once stable, a maintainer merges `develop` back into `main` and pushes.

## Issue and PR templates

The repository provides `.github/ISSUE_TEMPLATE/` (bug / feature) and
`.github/pull_request_template.md`; fill them in as the templates ask.
