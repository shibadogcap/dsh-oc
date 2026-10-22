*English · [日本語](RELEASE.ja.md) · [中文](RELEASE.zh.md)*

# dsh-oc release and rollback process

`v0.2.0-rc.1` was released on 2026-09-07 and `v0.2.0-rc.2` on 2026-09-08. rc.1–rc.3 target dsh
`>=0.1.2-rc.1`; rc.4 and later target dsh `>=0.1.5-rc.2` (a breaking change to the host ABI, so
installs across 0.1.2 and 0.1.5 cannot be mixed). Later candidates reuse this checklist and
replace `<candidate-version>` with the actual version.

The current candidate is `v0.2.0-rc.4`; the rc.1–rc.3 release records are kept as historical
evidence.

The release decision is recorded in `expert-advice/round-0002/decision.md`; npm stays NO-GO. The
`@chiro2001/dsh-oc` package is installed only from the GitHub source, the **full commit SHA** is
the source of truth for a release, and the `lib/` build artifacts must be committed and show zero
diff against the source.

## Prerequisites (required for every candidate)

1. `pnpm typecheck && pnpm test` all green; every fixture route, protocol, and version check in
   `pnpm run probe` passes (the current baseline prints 63/63; after adding routes, a full fixture
   pass is the criterion).
2. `bash scripts/verify-release-artifacts.sh` PASSED (after a clean rebuild of HEAD the committed
   `lib/` has zero diff; npm pack contains no machine absolute paths; the tarball and tree hashes
   are recorded).
3. `bash scripts/check-all.sh --e2e` all green (including the recovery failure domains, the golden
   trace, queued-order-repro, permission-mini, and the other stable suites).
4. Stable baseline: `scripts/flake-mini-scan.sh` has run the smallest high-risk scripts within the
   release-lane budget (see docs/perf/results-flake-consolidated-2026-08-17.md).

## Candidate steps

1. **Version bump**: change `package.json` and `DSH_OC_VERSION` in `src/index.ts` to
   `<candidate-version>` together; run `pnpm build` to rebuild `lib/` and commit it.
2. **Local gates**: typecheck + unit tests + probe + artifact audit + full e2e; protocol or TUI
   changes must include the matching tmux / official TUI regression.
3. **Push develop** and wait for CI to go green (ci + both e2e shards).
4. **Remote full-SHA rehearsal**:
   ```bash
   bash scripts/e2e-install-rollback.sh \
     --candidate "github:shibadogcap/dsh-oc#<full-sha>" \
     --previous "github:shibadogcap/dsh-oc#<previous immutable sha on the same dsh-0.1.5 ABI>"
   ```
   rc.4 is the first 0.1.5-ABI version and has no earlier immutable SHA on the same ABI: the
   rollback rehearsal uses rc.4's own full SHA to verify that cold install and reinstall are
   idempotent, and separately verifies that rolling back across the ABI to rc.3 requires
   downgrading the dsh CLI to `0.1.2-rc.1` at the same time (otherwise it fails to start as
   expected, which does not count as a failure).
   Verify: the cold install succeeds, the package version is `<candidate-version>`, the TUI smoke
   passes, old sessions can be recovered, and the rollback works; the script also asserts that
   `pnpm-lock.yaml` actually resolves to the given full SHA, so a matching version number cannot
   stand in for a successful rollback.
   An in-place result for a mutable ref of the same version is not proof of cache safety (a
   version change plus a full SHA is).
5. **Real model smoke (remote candidate)**:
   ```bash
   bash scripts/e2e-real-llm.sh --quick --add-spec "github:shibadogcap/dsh-oc#<full-sha>"
   ```
6. **Merge main** and push; record the four release identifiers:
   `{opencode 1.18.18, asset sha256, package tree hash, dsh-oc commit}`.
7. **Protected tag**: `v<candidate-version>` points at the rehearsed full SHA; the release notes
   state the full SHA, the tarball/tree hashes, and the known limitations (out-of-order immediate
   view for tool + queued messages, `Allow always` cleared on restart, the exit splash, and so on).
8. **Update the local install**: `dsh plugin --profile oc add github:shibadogcap/dsh-oc#v<candidate-version>`,
   then check the dsh-oc and dsh versions with `dsh-oc --version`.

## v0.2.0-rc.1 release record (2026-09-07)

This candidate completed the release gates and the remote rehearsal:

- dsh ABI: host services connected directly, the legacy dcp rc.6 compat shim, history follow/page
  iterator close, and existing targeted tests for errors/approval/question.
- bridge: the in-memory status hot path, api-session/status/activity, the bounded SSE ring,
  reconnect status replay, and queue/history/model/preset/subagent regressions are covered.
- Build and audit: `pnpm typecheck`, 418 unit tests, `pnpm build`, all protocol probe fixtures, the
  5000-session performance test, and the release artifact audit passed (the rc.1 release baseline
  was 62/62; the rc.2 release baseline was 63/63).
- TUI and remote: the full real TUI e2e, the high-risk flake scan 30/30, GitHub CI, the full-SHA
  cold install, the real TUI smoke, the same-ABI rollback, and the real DeepSeek quick smoke
  passed.
- Four release identifiers: opencode `1.18.18`, the dsh-oc commit, the tarball SHA256, and the package
  tree hash; see the GitHub prerelease notes.

## v0.2.0-rc.3 candidate record (2026-09-08)

- Fixed reasoning effort sync for the top-level `variant` of official OpenCode prompts: an explicit
  max/off keeps applying to later turns, Default returns to the dsh backend default, and the
  session, history, live, and queued user model refs stay in sync.
- The user's multi-turn manual TUI verification of max/off passed; the local host oracle validates
  the enabled/max and disabled/no-reasoning_effort semantics of the provider request body.
- Local typecheck, 435 unit tests, 63/63 probe, perf smoke, artifact audit, and 39 e2e runs
  (including the real TUI, recovery, and golden trace) were all green on the first run with no
  retries.
- The permission TUI theme-dependent choice sync and the artifact scanner behaviour when `rg` is
  missing, both reported by remote CI feedback, are fixed and each has deterministic regression
  coverage.
- The full SHA, tarball SHA256, package tree hash, and final release status are authoritative in
  the GitHub notes.

## v0.2.0-rc.2 release record (2026-09-08)

- Added the official OpenCode `!` shell mode; the user command and its output are injected into
  the next model prompt through a non-waking context, and exact PID/process-group cancellation and
  the output budget are preserved.
- Fixed the model/variant echo on the final assistant card for `/preset` and the `QUEUED`
  completion state, with added v1/v2 history and real TUI regressions.
- Improved profile isolation and the dsh-tui/dsh-dcp ABI troubleshooting docs; fixed build
  artifact hash drift across paths and tightened the state-driven waits in the TUI e2e.
- The protocol probe release baseline is 63/63; the full commit SHA, tarball SHA256, package tree
  hash, and opencode asset SHA256 are authoritative in the
  [GitHub prerelease notes](https://github.com/shibadogcap/dsh-oc/releases);
  this document does not copy release identifiers that can drift.

## Rollback

If any step hits a blocker (stale or missing `lib`, a version that does not match
`<candidate-version>`, a failed remote SHA install, incompatible old sessions, inconsistent
recovery, a CI semantic failure washed green by retries), stop the release; after fixing it, rerun
the matching rehearsal from a **fresh profile** instead of continuing in a polluted environment.
The current RC is a dsh ABI breaking minor: a rollback inside the same dsh `0.1.5-rc.2` can
reinstall the previous immutable SHA on the same ABI (the previous immutable SHA before rc.4 is
rc.3, but it targets dsh 0.1.2 and cannot share the dsh CLI with this version); rolling back to
`dsh-oc v0.1.0` requires rolling the dsh CLI back to `0.1.0-rc.6` at the same time. A cross-ABI
rollback must roll back the dsh CLI as well, otherwise the old host-services/event contract
differs from the new dsh and the install cannot start.

## opencode binary upgrade (separate lane, not mixed into the current candidate)

opencode version upgrades are not mixed into `<candidate-version>`: first run
`bash scripts/upgrade-lane.sh --bin <candidate>` for a semantic diff against the golden trace, and
only when it is fully green consider updating `opencode-version.json`/the asset manifest and going
through a separate candidate flow.
