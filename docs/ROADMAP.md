*English · [日本語](ROADMAP.ja.md) · [中文](ROADMAP.zh.md)*

# dsh-oc next-stage requirements (Roadmap)

> This document is the next-stage work list the user has confirmed. A new agent taking over reads it first, then
> `docs/FEATURES.md`, `docs/PLAN.md`, `docs/PROTOCOL.md`.
> `main` already contains `v0.2.0-rc.4` (dsh 0.1.5 host ABI adaptation); `develop` is the integration delivery
> line for the changes that follow, merged back into `main` once stable.

## RC.4 done (0.2.0-rc.4, 2026-09-11)

Breaking host ABI adaptation for dsh 0.1.5. The target version is pinned to `>=0.1.5-rc.2`, and 0.1.2 is no longer supported:

- profile startup: the headless `fileUploads` provider (`@chiro2001/dsh-oc/file-uploads`)
  fixes the `session-controller` pending; `bindPrompt` returns a disposable binding.
- live stream: an `agent/assistant-stream` subscription replaces the removed `assistant/chunk` session event.
- history: the embedded `assistant/message.stream` restores the packed run plus part durations and the finish reason.
- file tools: diff synthesis for `write`/`edit`; the e2e tools scenario now uses `write`.
- first-turn labels: provisional cards use the session preset/model throughout, and no longer show
  `build`/`deepseek-chat`; when the model is missing, fall back to the deployment default model.
- local gate: 440 unit tests, probe 63/63, full `check-all --e2e` 39/39 PASSED on the first run with
  0 retry; the remote `ci` + `e2e` workflows are all green.

## RC.3 done (0.2.0-rc.3, 2026-09-08)

The reasoning effort fix has converged on the candidate: multi-round selection of max/off on the official TUI top-level `variant`,
the Default fallback, and session/history/live/queued model ref sync all have regressions; the user's manual TUI
max/off selection and the local provider request body oracle both pass. The full local gate covers 435 unit tests,
63/63 probe, perf, artifact audit and 39 e2e; all green on the first run with no retry.

## RC.2 done (0.2.0-rc.2, 2026-09-08)

Issue #4/#5 completed the automated gate and the user's manual TUI verification, and shipped with `v0.2.0-rc.2`:

| Issue | Content | Current status |
|---|---|---|
| #4 | Official TUI `!` shell mode, starting the user's OS shell through Agent idle maintenance | ✅ Done in RC.2 |
| #5 | `/preset` completion results no longer keep showing `QUEUED`, and show the actual model after the switch | ✅ Done in RC.2 |

`!` shell does not trigger a model turn; an explicit `!` from the user is the authorization boundary, the command inherits the OS user's permissions and
the session cwd, it is managed by Agent idle maintenance, and only exact subprocess/process-group cancellation is allowed; the shell
card is a short-lived bridge projection. `/preset` can switch in an empty session and is inherited by later new sessions; a session that already has replies stays
locked by the agent preset. User steps and regression steps are in [MANUAL-TEST.md](MANUAL-TEST.md).

## RC.1 historical baseline (0.2.0-rc.1, 2026-09-07)

This version targets dsh `>=0.1.2-rc.1` and is an ABI breaking minor. PR #1/#2/#3
were not merged as-is; their model/preset, queue, approval/question, subagent/history
semantics were re-integrated with the dsh 0.1.2 host-services migration.

Already landed with targeted regression:

- `sessionController`, `agentPresets`, `goals`, `sessionSkillCatalog`,
  `agents`, `sessions`, `sessionProjections` are connected directly; the old apiProxy survives only in historical documents.
- The status hot path consumes the `api-session/status/activity` in-memory state, with at most one
  `session.list` seed on cold start; the SSE `Last-Event-ID` uses a ring bounded by both event count and bytes, and appends the current status/control snapshot
  after the reconnect replay.
- OpenTUI native temp files are isolated into a dsh-owned per-PID directory and cleaned up; the safe I/O
  monitor is observe-only by default, and explicit cleanup is allowed only for an owned process group.
- The dsh-dcp rc.6 `session.events` getter shim is a temporary compatibility boundary, to be removed once upstream dcp
  completes the dsh 0.1.2 migration.

The release gate is complete: artifact audit, full e2e, real TUI, remote full-SHA cold install/rollback and
real model smoke all pass. The release checklist and rollback contract are in [RELEASE.md](RELEASE.md).

## Protocol completion record (2026-08-16)

The following SDK v2 endpoints were upgraded from stub/missing to real implementations, all with unit tests + e2e:

- Permission surface: `GET /api/permission/request`, `GET /api/question/request`,
  `GET /api/session/{id}/permission/{rid}`, `DELETE /api/permission/saved/{id}`,
  with the saved list matching `PermissionSavedInfo`; authorization is isolated in memory per session+tool.
- VCS surface: `GET /vcs`, `GET /vcs/status`, `GET /vcs/diff`, `GET /vcs/diff/raw`
  (real git reads, untracked files do not enter status).
- File system surface: `GET /api/fs/read/{path}` (`*` wildcard, out of range 400, 5 MiB limit),
  `GET /api/fs/list`, `GET /api/fs/find` (skips dependency/build directories).
- Lifecycle surface: `GET /global/health`, `POST /global/dispose`,
  `POST /instance/dispose` (dispose is a no-op acknowledgement, dsh owns the process lifecycle).

Implemented: `/api/session/{id}/history` (`limit` + `after` event seq cursor,
returns `{ data: SessionMessage[], hasMore }`, reuses the v2 message conversion and carries the message anchor
seq; `after` must be a non-negative integer, otherwise 400).

> Late night 2026-08-16: the response adds `next` (the oldest anchor seq of this page) so independent clients can page
> continuously; `after` is an **exclusive upper bound** (dsh native `beforeSeq`, paging backwards), no longer
> a full fold followed by filtering. Full paging of a single 20k-message session takes ~1.2s and single-page latency is bounded; the benchmark is in
> `docs/perf/results-2026-08-15.md`.

SDK routes still LATER: `/api/pty/*` (dsh has no PTY RPC), `/api/integration/*`
(dsh has no integration surface), `/api/credential/*` (dsh already exposes
`credentials.describe/set/unset` RPC, but opencode SDK 1.18.18 has no corresponding
consuming route; implement it once the upstream protocol appears), `/global/upgrade` (auto-update is explicitly off).

## Priority overview

| ID | Requirement | Priority | Suggested branch | Status |
|---|---|---|---|---|
| N1 | Turn off opencode child-process auto-update/hot-update | P0 | `feat-no-autoupdate` | ✅ Done (2026-08-15) |
| N2 | Streaming toolcall / progress | P0 | `feat-stream-tool` | ✅ Done (2026-08-15) |
| N3 | Full Goal support | P0 | `feat-goal` | ✅ Done (2026-08-15) |
| N4 | Session performance test (temporary DB + generated history) | P1 | `feat-perf` | ✅ Done (2026-08-15) |
| N5 | Protocol self-test UT / upgrade probe | P1 | `feat-protocol-ut` | ✅ Done (2026-08-15) |
| N6 | README and `/help` capability matrix | P1 | `feat-capability-help` | ✅ Done (2026-08-15) |

Suggested execution order: do `N1` first on its own (it affects stability and the external network); `N2`/`N3` can run in parallel; `N4`/`N5`/`N6` can run in parallel or immediately after.

## Added after top-tier model review (2026-08-16, round-0001)

The external top-tier model review concluded that the project is suitable for controlled RC/canary delivery; the next stage freezes features and invests 60% in stability/consistency, 30% in install/release and CI, 10% in documentation. Accepted items and their handling are in
`expert-advice/round-0001/decision.md`. Landing order:

- Experiment 1: real event differential replay + recovery consistency + known out-of-order adjudication (live/reconnect/restart/
  `--continue`/`--session` normalized message graph exactly-once; 10k-event single-session
  history cold read/paging benchmark; official TUI minimal repro). Also establish a paging performance baseline for
  `/api/session/{id}/history`.
- Experiment 2: clean install/upgrade/rollback drill for the immutable `v0.1.0-rc.2` candidate (GitHub spec
  cold install, `lib` consistent with the source, old session recovery, `dsh-oc` PATH).
- Experiment 3: flake statistics audit (fixed commit × 50 runs, classified by signature, keep the first-failure evidence;
  afterwards tighten unconditional whole-script retries).
- Support matrix: at least Linux x64 + macOS arm64 release smoke; shrink Windows/ARM under the "declare means test" principle.

## Added after top-tier model review (2026-08-17, round-0002)

The round-0002 conclusion: rc.2 is currently a conditional NO-GO; the existing recovery consistency test compares warm/cold
history projections, not live SSE, and the parent-chain assertion is always empty. Accepted items and their handling are in
`expert-advice/round-0002/decision.md`. Adjusted execution order:

- Experiment 1a (first round done 2026-08-17): fix the recovery oracle — wait for authoritative idle
  (`/api/session/{id}/wait`) instead of a fixed sleep; v1+v2 dual-surface signature (v1 parent-chain resolution
  non-empty, v2 per-message part + tool name/status/output, user text merged in), no longer
  a global flat comparison. On its first run the oracle found and fixed the dangling parent-chain defect where the v1 warm history `parentID` was not remapped with the surface
  id; recovery consistency e2e 29s PASSED, now in the stable suite.
- Experiment 1b (first round done 2026-08-17): three failure-domain matrix —
  `process-crash-recovery` (SIGKILL mid-run, then `--session` restart: the persisted prefix
  is not lost / no fake completion / the conversation can continue, 20s PASSED), `client-sse-reconnect` (the observer SSE
  stream drops and reconnects, message graph exactly-once, 13s PASSED) are in the stable suite;
  `mux-resubscribe` is covered by unit tests (replayed chunks deduplicated across translator rebuilds). The recovery
  contract (durable exactly-once; the crash prefix is not lost / no fake completion / back to idle / the conversation can continue; pure
  in-memory surfaces are listed as transient) remains the assertion baseline for later experiments.
- Experiment 1c (first round + coverage scan landed 2026-08-17): deterministic synthetic replay corpus
  `scripts/build-replay-corpus.mjs` → `tests/fixtures/replay/` (10
  fixtures, covering reasoning, single/multiple tools, queueing, tool errors, compaction, interruption,
  goal, plugin-context, session-title, unfinished-turn);
  `tests/replay-corpus.spec.ts` asserts no unhandled/error, tool pairing and final state, live
  completion state consistent with durable, durable v1/v2 consistent, and generates a 10k-event long-session
  case at runtime. On its first run the corpus audit found and fixed the **multi-tool turn completion defect** (single-slot pending →
  multiple slots per message, all turn/end complete). The real-session feature coverage scan
  `scripts/replay-corpus-manifest.mjs` shows the 12 features across 64 sessions/58,609 events are
  fully covered by the corpus (results in docs/perf/coverage-real-sessions-2026-08-17.md).
  The official 1.18.18 golden trace baseline has landed (`scripts/e2e-golden-trace.sh` +
  `scripts/normalize-golden-trace.mjs`): the bridge SSE normalized trace of the real TUI tool + trailing text scenario
  (ids/time/paths stripped) is committed as
  `tests/fixtures/golden/recovery-tool-followup-1.18.18.sse.jsonl`, the structure
  is reproducible across runs and is in the stable suite. Out-of-order repro record
  `scripts/e2e-queued-order-repro.sh`: a slow-stream tool + trailing text + a second prompt queued from the keyboard,
  capturing the transient order frame by frame and freezing a second golden baseline
  `tests/fixtures/golden/queued-followup-1.18.18.sse.jsonl` (116 events);
  continuous runs of the mock scenario did not reproduce the transient out-of-order; the real-model version
  `scripts/e2e-real-queued-order.sh` (manual) reproduced the wire precondition twice in a row
  (the trailing text delta keeps arriving after the queued user event), and in 45/50 panel frames reply content
  renders below the queued card. Official minimal server attribution has landed
  (`scripts/minimal-oc-server.mjs` + `scripts/e2e-minimal-server-repro.sh`):
  feeding the official TUI with bridge components + a scripted event sequence (queued-mid-followup fixture),
  the TUI render order is correct (the full trailing text is above the queued card); the bridge adds
  a `src/bridge/router-entry.ts` export (lib/bridge/router-entry.js) for external
  harnesses. Real-session raw JSONL and full bridge SSE trace replay are connected (raw
  direct-play mode), and a new `SseHub.enqueue` pre-connect buffer; currently, under raw direct play, the official
  TUI's `/global/event` connection is a short-lived probe (events within the connection can be delivered, but the external broadcast
  window is too short), and capturing the key segment + 80ms slow replay still does not render, so the raw direct-play route is closed
  (the tool is kept for experiments); fixture replay and real-model live evidence are complete, and the out-of-order
  attribution keeps the conclusion "the official TUI's immediate rendering is affected by event interleaving, the bridge's persisted data is correct".
- Experiment 2 (tools and first drill landed 2026-08-17): `v0.1.0-rc.2` takes the full SHA
  as the source of truth — `scripts/verify-release-artifacts.sh` is now in the check-all gate:
  after a clean rebuild from HEAD source the committed `lib/` has zero diff, npm pack has no machine absolute
  path, and the package version/tarball sha256/package-tree hash are recorded;
  `scripts/e2e-install-rollback.sh` (manual) cold-installs the candidate from the remote full SHA and runs
  a real TUI smoke (28s), then rolls back to the previous spec and re-runs (23s), and probes re-add behaviour within the same profile. In-place results before the version bump cannot serve as cache-safety proof; RC.2
  has completed the version bump, the release drill and the protected tag.
  The release execution checklist is in `docs/RELEASE.md`.
- vendor ABI upgrade lane (landed 2026-08-17): `scripts/upgrade-lane.sh`
  runs the golden scenario against the candidate opencode binary (the version check is bypassed with
  `DSH_OC_BYPASS_VERSION_CHECK=1`, used only by the manual lane), and semantically diffs the normalized trace against
  the 1.18.18 baseline; same-version verification shows zero diff. Candidate upgrade flow:
  `bash scripts/upgrade-lane.sh --bin <candidate>`, and only after all green consider updating
  `opencode-version.json`/the asset manifest.
- Experiment 3: tiered flake statistics (10 runs each for the minimal high-risk cases, expanding to 30–60
  after zero failures; release-lane budget 30–45 minutes; no retry on a semantic first failure).
- Experiment 3 first round (2026-08-17): `scripts/flake-mini-scan.sh` has landed; the three recovery
  failure domains were all green over 10 runs each (consistency 29–30s, crash 21–24s, sse 15–16s, see
  `docs/perf/results-flake-recovery-2026-08-17.md`). The first scan run found the crash
  oracle too strict (it failed legitimate recovery of chunks not yet written to disk inside the crash boundary), so it was changed to
  the "persistent prefix or tail text prefix" semantics.
- Experiment 3 second round (2026-08-17): queue-live and agent-tab all green over 10 runs each
  (19–20s / 11–12s, see
  `docs/perf/results-flake-tui-2026-08-17.md`); the permission minimal case
  was split and re-run afterwards.
- Experiment 3 third round (2026-08-17): the permission minimal case
  `scripts/e2e-tui-permission-mini.sh` (single Allow-once, 10–11s) was 10/10 green on its first run
  and joined the stable suite; the full permission matrix is still covered by every regression.
- Experiment 3 consolidated baseline (2026-08-17): 6 minimal high-risk scripts × 10 runs = 60 runs, all green on the first run
  (the three recovery scripts, permission-mini, queue-live, agent-tab), see
  `docs/perf/results-flake-consolidated-2026-08-17.md`.
- The full message-graph variant of `--continue` is no longer a priority: the `e2e-tui-continue.sh` selection
  contract is kept, and a low-cost `-c` selection contract can be added later.

### Recovery contract (draft, the assertion baseline for experiment 1b)

- A completed durable turn: role, order, text/reasoning, tool
  input/output/error, part ownership and references exactly-once.
- An in-flight turn when the process crashes: recover the persisted prefix; do not fake success; after restart get an
  explicit aborted/idle final state; the next prompt is accepted.
- Persistent projections such as title/goal/todo: restored after cold start.
- queued message / pending permission/question: if dsh has an authoritative snapshot,
  resend it, otherwise cancel explicitly, leaving no inoperable TUI card.
- `Allow always`, bridge-synthesized command/error text and other pure in-memory/temporary surfaces: allowed
  not to recover, but the documentation must list them explicitly as transient.

---

## N1. Turn off opencode child-process auto-update and hot-update

### Background
oc-tui runs the official `opencode --server` as a child process. opencode itself may check for new versions and download automatically or hot-update, which causes:
- connecting to the external network at startup, possibly timing out;
- the binary version drifting from the `opencode-version.json` pin, mismatching the dsh-oc bridge protocol.

### Requirements
1. Explicitly turn off opencode auto-update in `buildChildEnv` in `src/tui/index.ts`:
   - first check which env/flags opencode 2.1.0 supports: `OPENCODE_DISABLE_AUTOUPDATE`, `OPENCODE_AUTOUPDATE=false`, `OPENCODE_DISABLE_AUTOUPDATE_CHECK` etc., with the source as the authority.
   - also set `OPENCODE_DISABLE_UPDATE=true` (if that switch exists).
   - do not use switches you are unsure about; when unsure, verify against the opencode source.
2. Prevent opencode from hot-replacing itself:
   - if the official mechanism only "suggests an update", confirm it does not download; if it may download, block it.
   - use a read-only/isolated directory for the opencode data directory (currently under `$DSH_HOME/opencode`), and make sure auto-update state is also written there.
3. Version pin audit:
   - the opencode binary resolved at runtime must always have `--version` matching `OPENCODE_VERSION`.
   - validate again after `resolveOpenCodeBinary`; on mismatch, error out and suggest clearing the cache or specifying `DSH_OC_OPENCODE_BIN`.
4. Network policy:
   - the child process must not proactively access `api.opencode.ai` / GitHub releases (except when the resolver explicitly downloads).
   - preferably provide `OPENCODE_DISABLE_NETWORK` or an equivalent parameter, so the bridge layer fully controls external access later.

### Acceptance
- Unit test: `buildChildEnv` contains every available env that disables updates.
- Offline e2e: with `HTTPS_PROXY/HTTP_PROXY` pointing at an unreachable port and the opencode cache cleared, the TUI still starts within the timeout.
- When `opencode --version` does not match `OPENCODE_VERSION`, dsh-oc errors out explicitly.

---

## N2. Streaming toolcall / progress

### Background
Text/reasoning already stream, but tool calls only emit pending/final, so the intermediate process is invisible. Users need to see the actual execution and progress of tools such as bash.

### Requirements
1. Translate dsh tool stream events:
   - cover at least dsh's `tool/call`, `tool/call-chunks` (or `tool-call-chunks`), `tool/result`.
   - check the corresponding opencode 1.18.18 events:
     - `session.next.tool.input.started`
     - `session.next.tool.input.delta`
     - `session.next.tool.input.ended`
     - `session.next.tool.called`
     - `session.next.tool.progress`
     - `session.next.tool.success`
     - `session.next.tool.failed`
   - also support v1 `message.part.updated` incremental ToolPart updates (the path the opencode 1.18.18 TUI actually consumes).
2. Streaming tool arguments:
   - when dsh tool arguments arrive as deltas, the TUI input area/tool card should display them progressively.
   - avoid stutter from refreshing large arguments in one go.
3. Tool execution process:
   - bash/pwsh output needs real-time progress, not only the final output.
   - read/write/edit file tools show phase headings.
4. Failure and cancellation:
   - tool failure, abort and timeout show an error state and reason in the TUI.
5. Performance protection:
   - throttle/batch high-frequency chunk events to avoid flooding SSE.

### Acceptance
- Unit test: `tool-call-chunks` → ToolPart input/state increments.
- API e2e: mock LLM triggers bash, input.delta/progress/success appear in SSE.
- TUI e2e: `tmux capture-pane` can see partial command output while the tool is executing.

---

## N3. Full Goal support

### Background
Goal is a high-frequency dsh feature, and the opencode TUI has no native goal UI; dsh-oc needs to map dsh goals into states opencode understands (todo/projection/session events/commands).

### Requirements
1. dsh goal lifecycle:
   - translate events such as `goal/start`, `goal/update`, `goal/end` into opencode todos or session messages.
   - at minimum let the user see the goal title, status and steps.
2. `/goal` command:
   - `GET /command` exposes `/goal`.
   - support creating/viewing/switching goals (if dsh has a command registry).
3. Goals in session history:
   - `GET /session/:id/todo` returns goal steps first.
   - goal events in `GET /session/:id/message` are mapped to system messages/compaction summaries.
4. Cooperation with plan mode / todo:
   - the current todo projection keeps working; a goal does not overwrite todos.

### Implementation status (2026-08-15)

- `goal/change` and the `goal` projection → merged into `todo.updated` (the goal is the first sidebar todo,
  `active → in_progress`, `paused/blocked → pending`, `complete → completed`).
- `GET /session/:id/todo` returns goals first (projection or folded history events), with dsh todos after them.
- `GET /command` / `GET /api/command` register `/goal`; `POST /session/:id/command` and the
  prompt route capture `/goal [objective|clear|edit ...|pause|resume]`, execute through the dsh command
  registry and broadcast the busy/idle result.
- v1/v2 history messages fold `goal/change` into an assistant text note.
- Acceptance: `tests/convert/goal.spec.ts`, `tests/bridge-events.spec.ts`,
  `tests/bridge-router.spec.ts`, `scripts/e2e-api-goal.sh`,
  `scripts/e2e-tui-goal.sh` (the goal is visible in the real TUI sidebar) all pass.

### Acceptance
- Unit test: goal events → todo/session messages.
- API e2e: create a goal, goal step changes are visible.
- TUI e2e: the user can see the goal status and continue the task.

---

## N4. Session performance test

> Status: done (2026-08-15). Implementation in `scripts/perf.mjs`, `scripts/perf-session-gen.mjs`,
> unit tests in `tests/perf.spec.ts`, example report in `docs/perf/report-example.json`.
> Run: `pnpm run perf -- --sessions 1000 --messages-per-session 6 --tools --todos --children 10`.

### Background
You need to simulate a large amount of dsh session history to verify the experiential performance of list/search/SSE/history.

### Requirements
1. Generator:
   - generate dsh session history directly with a temporary DSH_HOME + SQLite/JSONL; data may come from:
     - `~/.codex/history.jsonl`
     - opencode history JSONL
     - synthetic fixtures
   - support `--sessions N`, `--messages-per-session M`, `--turns K`, `--tools`.
2. Metrics:
   - `GET /session` cold/warm start latency
   - `GET /session/:id/message` paging latency
   - SSE first-event latency
   - memory usage at 1000/5000/10000 sessions
3. Scenarios:
   - cold start: no profile cache
   - warm start: profile already loaded
   - many subagent children
   - many todos/produced-files
4. Output: JSON/text report with p50/p95/max.

### Acceptance
- `pnpm run perf` can be run repeatedly.
- CI optionally runs the smoke scale (e.g. 1000 sessions).
- If there is an obvious regression >500ms, record the issue and fix it.

### Measured baseline (this machine, 30 sessions × 4 messages, 2026-08-15)
- boot (bridge URL ready): about 0.8s
- `GET /session` p50 ≈ 14ms / p95 ≈ 28ms (including the cold-start first request)
- `GET /session/:id/message?limit=50` p50 ≈ 15ms / p95 ≈ 40ms
- SSE first event (after triggering): < 1ms
- dsh process RSS: about 250 MB
- More numbers in `docs/perf/report-example.json`; for large scales (1000/5000/10000) run the full test on this machine.

---

## N5. Protocol self-test UT / opencode upgrade probe

### Background
After an opencode version upgrade, API routes/types may change, so the user needs to be able to run the protocol self-test themselves.

### Requirements
1. The existing `tests/bridge-router.spec.ts` remains the core UT.
2. Add a protocol probe script:
   - `scripts/probe-opencode.sh` or `scripts/probe-opencode.mjs`
   - can specify `OPENCODE_VERSION` and the opencode binary path.
   - start a real/local opencode server or a mock bridge, and capture the startup requests.
3. Output a compatibility report:
   - missing routes
   - route method/query changes
   - SDK schema changes
4. Upgrade flow:
   - update `opencode-version.json`
   - run `node scripts/update-opencode-assets.mjs`
   - run the probe
   - update the `docs/PROTOCOL.md` compatibility matrix
5. Optional: cache multi-version SDK types and diff them to generate the report.

### Acceptance
- The probe runs all green on the current 1.18.18.
- When a route is simulated as missing, the probe errors and gives a fix suggestion.

---

## N6. README and `/help` capability matrix

### Background
Users need to know clearly which original opencode features are available and which are stub/unsupported.

### Requirements
1. README:
   - add a "capability status" table referencing `docs/FEATURES.md`.
   - mark with ✅ / 🟡 / ❌: available, partially available, unavailable.
   - state the network, auto-update and binary pinning policy clearly.
2. `/help`:
   - `dsh --profile oc --help` output should show:
     - version
     - supported attach parameters
     - core capability summary
     - known limitations
     - documentation entry points
   - can be generated automatically from `docs/FEATURES.md`.
3. Dynamic update:
   - `scripts/update-feature-matrix.mjs` updates README and FEATURES.md together.
   - landing a new feature must update the matrix, otherwise the UT fails.

### Acceptance
- README and FEATURES.md content are consistent.
- `dsh --profile oc --help` shows the capability matrix.
- After `pnpm run features:update` the git diff is minimal.

---

## M series: maintenance and engineering (from 2026-08-15)

After the feature mainline (N1–N6) completes, the project enters the maintenance stage, with the goal of making the repository sustainably iterable, easy to contribute to and easy to verify. It is currently in the `develop` branch integration delivery mode.

### Priority overview

| ID | Direction | Status |
|---|---|---|
| M1 | Documentation and known-limitation sync | ✅ README (user) separated from AGENTS.md (agent/development), CHANGELOG/FEATURES auto-tracked |
| M2 | Development flow and CI | ✅ CI covers `main`/`develop`/`feat-*`/`fix-*`/`docs-*`/`perf-*`/`test-*`/`chore-*`; push runs the stable e2e suite automatically, manual trigger runs the full e2e + load test |
| M3 | Community contribution flow | ✅ `CONTRIBUTING.md`, PR template, Issue templates (bug/feature) |
| M4 | Branch strategy and cleanup | ✅ `scripts/cleanup-merged-branches.sh` (dry-run by default); historical `feat-*` branches are all merged into main |
| M5 | Refactoring (router split / unified caching) | ✅ Route registration split by domain into `src/bridge/routes/`; cache/in-flight merging and invalidation generation unified |

### M1 Documentation

- README known limitations stay consistent with `docs/FEATURES.md`; new behaviour (such as the exit splash note) must be
  synced in both places.
- For changes involving the capability list, run `pnpm run features:update` and commit the auto-tracked result.

### M2 Development flow

- Unit tests/probe/performance smoke are run with one command via `scripts/check-all.sh`; use `--e2e` for the full e2e.
- GitHub Actions: `ci.yml` automatically runs build/typecheck/test/probe; `e2e.yml` runs the stable e2e
  suite automatically on push, and the full e2e and load test on manual trigger.
- e2e branch allowlist: `main` / `develop` and `chore-*` / `fix-*` / `docs-*` /
  `perf-*` / `test-*` / `feat-*`.

### M3 Community contribution

- See `CONTRIBUTING.md` for the development environment, branch strategy, commit conventions and self-test gate.
- Issue/PR templates are in `.github/`; fill them in following the template.

### M4 Branch strategy and cleanup

- `main` for stable releases, `develop` for integration delivery, short-lived feature branches.
- Historical `feat-*` branches already merged into `main` can be cleaned up safely:
  `bash scripts/cleanup-merged-branches.sh` (dry-run first, `--apply` deletes locally,
  `--remote` deletes the remote too; branches still checked out in a worktree are skipped).

### M5 Refactoring (done)

- Route registration split by domain into `src/bridge/routes/{boot,session-v1,session-v2,permission}.ts`,
  `router.ts` dropped from about 2200 lines to about 1600, and the protocol probe scans the route directory automatically.
- `InteractionState` cache/in-flight merging/invalidation generation managed uniformly.
- Optional follow-ups: converge the tmux/wait helpers in `tests/e2e/common.sh`, sink the helpers further
  (currently the command-domain helpers are coupled to each other, the benefit is limited, so they are not split for now).

---

## Unified acceptance gate

1. `pnpm install && pnpm build && pnpm typecheck && pnpm test` all pass.
2. All relevant e2e scripts pass, and new scripts cover the new features.
3. The automatic part of `docs/FEATURES.md` is refreshed; README/ROADMAP updated.
4. `lib/` build output is committed.
5. Each branch commits independently, then merges into main and pushes after integration.
