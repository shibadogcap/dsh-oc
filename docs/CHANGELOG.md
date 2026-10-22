*English · [日本語](CHANGELOG.ja.md) · [中文](CHANGELOG.zh.md)*

# Changelog

The format follows [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/); version numbers
follow semver. The current npm package name is `@chiro2001/dsh-oc` and it is not published to a
registry yet, so install and update from the GitHub source (`#main` / `#develop`).

## [Unreleased]

- Fix "model configured but the client cannot select it": dsh lists models only when the provider
  has usable credentials. Without credentials `/api/model` is empty, so a client that resolves
  model selection from that catalog (the TUI) stops at "No provider selected" and enters the
  OpenCode provider connection flow that dsh does not use. The bridge now publishes the default
  model from the dsh config when the catalog is empty (`/api/model`, `/api/provider`,
  `/api/model/default`); `/api/config` returns a config document carrying `model` and
  `default_agent`; `POST /api/session` with a model no longer fails as a whole because the model
  cannot be routed; a failed model switch names the missing credential; and the reason the catalog
  is empty is logged once at startup. For configuration, see the model (provider) section in
  [COMPAT.md](COMPAT.md).
- The TUI branding plugin moves to the real plugin API of 2.1.0. The old plugin exported functions
  the 1.x way and failed to load with `Invalid V2 TUI plugin module`; 2.1.0 puts the slot tree at
  `context.ui.slot` and has no home logo slot (the TUI renders the home logo itself), so
  `DSH ⨯ OC` and the subtitle land in `home.footer`. The plugin `package.json` exposes both the
  `"."` and `"./tui"` entries.
- The official OpenCode Web UI is now served by the bridge itself, from the same origin as the API.
  The official opencode binary packs the Web UI into an `AppArchive` (little-endian u32 length of
  the JSON index + index + brotli-compressed assets); the bridge unpacks it once at startup into
  `$DSH_HOME/opencode/web-ui/<version>/` and serves those files itself
  (`src/bridge/web-ui.ts`). The lookup order puts the directory named by `DSH_OC_WEB_UI` first,
  then the unpacked directory. The official Web UI always reaches the API through
  `location.origin`, so same-origin removes both CORS and login, matching the official
  `opencode serve` setup. The binary is only looked up and never installed by the bridge (the TUI
  plugin needs it anyway), so the Web UI appears from the next start; when no binary is found the
  Web UI is not served and the API is unaffected. A `GET`/`HEAD` that matches no route falls back
  to the Web UI shell (single-page app), and missing files under `_assets/` are 404.
  `scripts/extract-opencode-web-ui.mjs` can extract the assets offline into any directory.
- The CORS policy now matches the official opencode server (source
  `packages/server/src/cors.ts`): always allow `http://localhost:<port>`,
  `http://127.0.0.1:<port>`, `oc://renderer`, the tauri origins and `*.opencode.ai`, plus
  `DSH_OC_CORS` (comma separated, equivalent to the official server's `cors` option, for a browser
  UI on the LAN). When allowed, the response echoes the request's own origin and carries
  `Access-Control-Allow-Credentials: true`. The old implementation always returned
  `Access-Control-Allow-Origin: *`, so browsers rejected credentialed requests
  ("credentialed request requires Access-Control-Allow-Origin '<origin>'") and the browser UI
  could not connect at all.
- SSE gains a heartbeat: `SseHub` writes the same comment frame as the official server,
  `: heartbeat\n\n`, to every connection every 15 seconds (official implementation in
  `packages/server/src/handlers/event.ts`). Previously a quiet session's stream looked dead: the
  official client disconnected with "Event stream stalled" and reconnected, and OpenChamber's
  upstream reader gave up after 20 seconds, leaving both in a reconnect loop.
- The SSE status snapshot is now bounded (`SESSION_STATUS_SNAPSHOT_LIMIT = 20`): running sessions
  are reported first and the remaining slots are filled by most recently touched. The old
  implementation reported every session the bridge had ever seen, so the official Web UI read
  hundreds of session records on every connection and initial load never finished.
- The project list reports the bridge's working directory: `GET /api/project` returns a bare
  `Project[]`, and `GET /api/project/:projectID` and `PATCH /api/project/:projectID` return a bare
  `Project` (PATCH currently only echoes and does not persist). The official server derives the
  project list from the directory it serves, so the browser UI has a workspace to select.
- `DSH_OC_HTTP_LOG=1` turns on HTTP request tracing: each request prints one line to stderr on
  arrival, `[bridge/http] <METHOD> <path>`. This is the debugging tool for checking how the
  browser UI calls the API when no browser is available.
- Session revert: implemented with the OpenCode 2.1.0 semantics. Three routes
  `POST /api/session/:id/revert/stage`, `DELETE /api/session/:id/revert`,
  `POST /api/session/:id/revert/commit`, and three SSE events `session.revert.staged` /
  `session.revert.cleared` / `session.revert.committed`. The boundary is **exclusive**: the named
  message and everything after it are dropped on commit, and `before` on
  `POST /api/session/:id/fork` is equally exclusive (dsh's fork copies the event prefix
  **including** `atSeq`, so the cut point is the event before the boundary message). Commit forks
  the dsh session at that cut point, and the opencode session id follows the fork (an alias):
  later dsh calls are rewritten to the fork, the session list publishes the fork under the
  original id and drops the replaced session, `GET /api/session/:id` and `/message` read the
  fork's summary and history, the fork's SSE events are rewritten back to the original id, and
  session-level state (model, agent preset, title, message id mapping) is inherited by the fork.
  Files roll back grouped by dsh turn: stage rolls back in place the files changed by the turns
  after the boundary and reports a diff (clear restores them, commit keeps the rollback), and
  when the boundary is a user prompt that turn's files are rolled back as well. As in OpenCode,
  the next prompt first commits any staged revert, and the prompt then lands in the rewritten
  session.
- Known limits of session revert: dsh cannot express an empty fork, so a cut point before the
  first message returns 400 `cannot cut before the first message`; the file diff is one coarse
  hunk between the first and last changed line (the same shape as the bridge's own file-change
  diff), not a full LCS diff.
- Add `scripts/e2e-revert-flow.mjs` (`pnpm run e2e:revert`) and `tests/e2e/revert.spec.ts`: a full
  round of stage → clear → stage+commit → next prompt against the real bridge, asserting exclusive
  boundaries, preserved message ids, an unchanged session id, and that a second rewind in the same
  session also takes effect.
- Fix the e2e driver's drift against dsh 0.2.1-rc.2 so the official TUI e2e runs for real: the
  default proxy is enabled only when `127.0.0.1:14514` actually answers (otherwise pnpm reports a
  tunnel error); the dsh process is matched by `--profile oc` (dsh is now
  `node .../dsh/lib/bin.js --profile oc`); TUI startup no longer passes dsh's `--print-logs` (the
  log covers the TUI's alternate screen, so pane capture never sees the input box); the mock LLM
  server moves from `0.1.0-rc.6` to `0.2.1-rc.2` (the former requires `dsh-invariants@^0.1` and
  the plugin manager rejects it); the config dump check now looks for `agent-preset-registry` +
  `agent-preset` (dsh 0.2 split `agent-presets`); and the post-exit shell prompt detection accepts
  powerline shapes.
- Fix the second and later rewinds: the rewind plugin's fork now resolves the alias first, and the
  bridge also uses the resolved dsh session id to take file snapshots, so the file set is no
  longer empty.
- Upgrade to official OpenCode 2.1.0: the pinned version becomes `2.1.0`, `@opencode/client`
  follows to `2.1.0`, and the protocol probe baseline is re-recorded at 138 routes. Relative to
  2.0.32, 2.1.0 has only one contract addition (`PATCH /api/permission/saved/:id`, which
  narrows a remembered grant), and the bridge implements it; the rest are type renames
  (`SessionMessageProviderState` becomes `SessionMessageNative`) and new event types
  (`session.archived` / `session.unarchived`; dsh has no archive concept, so they are not emitted
  yet).
- Migrate to official OpenCode 2.0.32: TUI startup changes from `opencode attach <url>` to
  `opencode --server <url>` (`--mini` uses `opencode mini --server <url>`); the 2.x CLI removed
  the `attach` subcommand, and the old form fails with "Help requested".
- Remove the v1 HTTP layer: `/session`, `/config`, `/provider`, `/global/event`, `/vcs*`,
  `/permission`, `/question`, `/path`, `/project/*` are all retired, leaving only `/api/*`; the
  bridge answers all 137 routes the OpenCode 2.x client calls
  (`scripts/check-client-routes.mjs` verifies `missing: 0`).
- SSE contract: the event stream must open with `server.connected` (the 2.x client rejects a
  stream that does not start with it), and only then do the `Last-Event-ID` replay and the
  status/control snapshot replay follow; that frame does not enter the replay ring.
- Event vocabulary: while the bridge keeps publishing 1.18.18-shaped events, it adds the 2.x
  native vocabulary (`session.text.*`, `session.tool.*`, `session.step.*`, `session.execution.*`,
  `session.inbox.*`, `permission.*`, `form.*`, `session.compaction.*`), and the built-in TUI and
  the OpenChamber UI read the same stream.
- e2e and docs sync: the TUI startup command in scripts becomes the `--server` form, v1 routes
  switch to their `/api/*` equivalents, version assertions become `2.0.32`; `docs/PROTOCOL.md`,
  `docs/FEATURES.md` and the README are updated to the 2.x description.
- Fix the local install resolver after release: resolve only the dsh-oc codeload SHA and
  distinguish other packages such as dsh-dcp; without `rg` it uses a grep fallback verified in
  isolation, and it fails closed when the scan fails or the SHA is missing or ambiguous.

## [0.2.0-rc.4] - 2026-09-11

This candidate targets dsh `>=0.1.5-rc.2` and is a breaking host ABI adaptation: dsh 0.1.5 changed
the session-controller dependency and the assistant streaming event model, so it is **no longer
compatible with dsh 0.1.2 and earlier**. Release and remote immutable identifiers are as given in
the final GitHub notes.

- Fix profiles failing to start: dsh 0.1.5's `dsh-api-session-controller` adds a hard dependency on
  `fileUploads`, so oc-bridge now inserts the headless provider `@chiro2001/dsh-oc/file-uploads` in
  order; `bindPrompt` returns a binding carrying `Symbol.dispose`, satisfying 0.1.5's explicit
  resource management (otherwise the prompt fails with `session/agent-busy` +
  `TypeError: Object not disposable`).
- Live streaming port: the removed `assistant/chunk` session event becomes a global subscription to
  `agent/assistant-stream` frames (attempt `start` records turn/step, `chunk` reuses the original
  chunk translation, `end` reclaims the attempt), and a late frame without a start is dropped
  safely.
- History reads during streaming: 0.1.5 no longer writes in-flight chunks into the persisted log,
  so the bridge merges the translator's live provisional assistant (id/created/text blocks,
  `time.completed` unset) into the v1/v2 history response, keeping the in-flight contract of the
  TUI and the queue-live oracle (`scripts/e2e-tui-queue-live.sh`).
- Fix the agent/model label on the first turn: the live provisional SSE card, the prompt response
  placeholder and streaming v1/v2 history no longer hardcode `build`/`deepseek-chat`; they use the
  preset and model selection already recorded on the session, and fall back to the deployment
  default model when the prompt carries none (`placeholderSessionOptionsForPrompt`); shell
  synthesized cards likewise prefer the session model. The TUI's mapped default agent `build` is
  resolved by `applyAgentFromBody` to the deployment default preset, so the first turn already
  shows the real preset.
- History port: `SessionHistoryRecord`'s `chunks` record is replaced by embedded
  `assistant/message.stream` / `assistant/attempt.stream`; `expandRecord` restores packed runs into
  `text-chunks`/`reasoning-chunks`/`tool-call-chunks` lines, and restores part timings and the
  finish reason from raw `block-start`/`block-end`/`finish`; `assistant/attempt` produces no TUI
  surface in either live or history.
- File tools adapted to dsh 0.1.5: `write`/`edit` (`dsh-tool-fs`) synthesize a diff from the call
  arguments for new files or when no presentation is replayed, and opencode edit cards keep
  carrying `metadata.diff`; the untracked write scenario in `tests/e2e-tui-tools.sh` switches to
  the `write` tool.
- Dependencies and gates: devDeps move to dsh 0.1.5-rc.2 / cordis 4.0.2, and the peer range
  tightens to `>=0.1.5-rc.2`; CI pins dsh 0.1.5-rc.2; pnpm maintains the prerelease exception in
  `pnpm-workspace.yaml` for `pnpm install`; the replay corpus and the perf session generator move
  to the 0.1.5 event shape (session format v3).
- Recovery semantics: 0.1.5 does not persist unsettled streaming content, so a turn may have no
  assistant message after crash recovery; the `e2e-recovery-crash.sh` oracle becomes "the restart
  graph is a persisted prefix + no fabricated crashed attempt + the new turn is exactly-once", and
  it still asserts idle and no leftover processes.
- All local gates green: `pnpm typecheck`, 438 unit tests (23 files), probe 63/63,
  `perf smoke (200)`, release artifact audit (clean rebuild with zero diff, no absolute paths in
  the pack), `scripts/check-all.sh --e2e` 39/39 e2e PASSED on the first run with 0 retries; the
  5000-session stress test is in
  [docs/perf/results-2026-09-11-rc4.md](perf/results-2026-09-11-rc4.md).

## [0.2.0-rc.3] - 2026-09-08

This candidate targets dsh `>=0.1.2-rc.1`; release and remote immutable identifiers are as given in
the final GitHub notes.

- Fix top-level `variant` resolution for official OpenCode 1.18.18 prompts: `max`/`off` keep
  flowing across multiple turns, and the Default that omits variant correctly returns to the dsh
  backend default; the actual model effort stays in sync across the session, user cards,
  live/queued SSE and v1/v2 history.
- Add bridge optimistic-card regressions for max/max, off/off and max→Default, plus deterministic
  checks of the session/history/live model ref in a real host API e2e.
- Manual multi-turn max/off validation in the TUI passes; the local deterministic host oracle
  further asserts the provider request body: max is `thinking.enabled + reasoning_effort=max`, off
  is `thinking.disabled` with no `reasoning_effort`.
- The full local gate covers 435 unit tests, 63/63 protocol probes, perf smoke, artifact audit and
  39 e2e (including the real TUI, recovery and golden trace), all passing on the first run with no
  retries.
- Two gate issues from remote CI feedback are fixed: permission TUI selection state now syncs
  through a theme-independent ANSI foreground signature, and the artifact path scanner fails
  closed without `rg` and gains regression coverage.

## [0.2.0-rc.2] - 2026-09-08

This version targets dsh `>=0.1.2-rc.1` and includes Issue #4/#5 plus the stability convergence
before release.

- Add the official OpenCode `!` shell mode: `POST /session/:id/shell` takes idle ownership through
  the dsh Agent's `runMaintenance`, then starts the exact shell subprocess/process group as the
  current OS user; it neither bypasses nor pretends to have dsh approval/sandbox.
  running/completed/error, abort, busy/idle, `session.idle` exactly-once and the bridge history
  projection all have regressions; after completion, `Agent.inject()` injects the user's manual
  command marked with `plugin: dsh-oc` plus stdout/stderr into the next model prompt, but does not
  start a model turn on its own; model injection has its own UTF-8 budget, and an injection failure
  writes a visible warning into the shell card; commands and output may contain sensitive
  information and are sent to the currently configured model; a route probe, a real TUI + mock
  model e2e and protocol documentation are added, and the feature is validated by the full e2e and
  a manual TUI run.
- Fix the synthetic command result after a `/preset` switch missing its completion time, which
  made the official TUI show the `preset switched to ...` card as `QUEUED` until the next turn
  cleared it; the switch card now also echoes the actual model/variant after the switch; bridge
  unit tests, v1/v2 history and real TUI regression assertions are added.

## [0.2.0-rc.1] - 2026-09-07

> This candidate targets dsh `>=0.1.2-rc.1`. PR #1/#2/#3 were not merged as-is; their effective
> fixes and the dsh 0.1.2 migration went through a semantic re-integration, and the current branch
> is an independent RC candidate.

### Changed

- The bridge migrates from the old `apiProxy` envelope to the dsh 0.1.2 host services
  `sessionController`, `agentPresets`, `goals`, `sessionSkillCatalog`, `agents`, `sessions`,
  `sessionProjections`.
- Model selection, default model/preset, queue visibility, approval/question, subagent lineage,
  history pagination and the dsh 0.1.2 error ABI are re-integrated; the stable v1/v2 OpenCode
  protocol surface is preserved.
- Add a bounded `Last-Event-ID` SSE ring (limits on both event count and serialized bytes); a live
  cursor replays only the missing events, and an evicted or unknown cursor falls back to the
  status/control snapshot.
- `/session/status` becomes an in-memory hot path driven by dsh `api-session/status`; cold start
  seeds at most once with a bounded `session.list`, avoiding the full persistent I/O triggered by
  the official TUI's 250ms wait polling.
- OpenTUI native temp files are isolated to `$DSH_HOME/opencode/tmp/tui-<pid>`; a normal exit
  cleans up and the next start reclaims exited instances; it does not search arbitrary plugin
  caches and does not disable official binary verification.
- The `session.events` compatibility getter for dsh-dcp rc.6 is kept for now and removed once dcp
  completes its dsh 0.1.2 peer/API migration.
- Add `scripts/monitor-process-io.sh` with safe defaults (observe-only; it may only clean up
  process groups the script itself started with `setsid` and verified) plus a fake attach idle
  regression.

### Verification

- typecheck, 418 unit tests, the full protocol probe fixture, the 5000-session performance test,
  the release artifact audit and the full real TUI e2e pass; the probe baseline was 62/62 at rc.1
  release and 63/63 at rc.2 release after the shell route was added; the high-risk flake scan was
  30/30 on the first run with no retries.
- GitHub CI, full-SHA cold install, real TUI smoke, same-ABI rollback drill and a real DeepSeek
  quick smoke pass. The release quadruple and hashes are in the GitHub prerelease notes.

### Pre-release convergence

- dsh `subagent` / `subagent_fork` are converted to native OpenCode `task` cards, preserving
  delegation and child session lineage; a real TUI Task navigation regression is added.
- Message time identity is fixed for the optimistic user / provisional assistant, fixing duplicate
  rendering of the first reply or of reasoning/tool cards; the real TUI asserts exactly-once on
  tool cards.
- Crash recovery tightens the exact tmux parent/child PIDs, the run-scoped leftover check and the
  observe-only flake scan, so it never operates on external orphan processes by name.
- The GitHub e2e workflow pins dsh `0.1.2-rc.1` and reports perf startup failures immediately;
  full-SHA install/rollback verifies the actual commit in the lockfile and records the joint
  rollback requirement of the old dsh ABI.
- v2 session summary/history binds by child label or parent-local FIFO and keeps
  `metadata.origin`, so multiple children with the same parent and description are not reused by
  mistake.

### Fixed

- User prompts are now submitted with dsh `mode: 'steer'`: a running turn sees the inserted
  message at the next step boundary, matching official opencode's "append to the session stream,
  the loop handles it on the next step" semantics. Previously everything used `mode: 'queue'`
  (next-turn), so an inserted message was only seen by the model after the whole turn ended (or
  was aborted) — in real session e0336d8b, the model kept searching for about 4 minutes after the
  user gave the exact paper title. New regression unit tests lock that a prompt is delivered as
  steer while busy, and the queue-related e2e (QUEUED badge, FIFO, golden trace) all pass.
- Model selection no longer falls back to the default model after the first turn: on session
  switch the TUI restores the prompt model from the "last user message", and the bridge previously
  labelled user messages (history and queued echo cards) with the first catalog entry
  (deepseek-v4-flash), so the second question silently switched back to flash. History and echoes
  now use the session's current model (`session.models`) or the model carried in the prompt body;
  two regression unit tests fix "Pro does not fall back to flash after the first turn".

## [0.1.0] - 2026-08-18

### Added

- `CONTRIBUTING.md` self-test gates gain release/build artifact audit items.
- `.github` templates updated: bug reports use `dsh-oc --version`; the PR self-test checklist gains
  the artifact audit and the full e2e option.
- `bridge-router.spec.ts` adds a cursor contract test for "appending messages between pages": after
  the first page, new turns are appended, the old page cursor does not change, there are no
  duplicates, and a full read contains the appended content exactly once.
- `bridge-router.spec.ts` adds a pagination boundary invariant test: when `limit` cuts through a
  tool turn, `after`/`next` anchor on the oldest seq of the converted messages, tool events
  (tool/call, tool/result are not separate messages) land entirely on one side of the page, and
  after merging across pages the tool part appears exactly once and is completed.
- `AGENTS.md` updates the e2e duration wording (the stable suite has grown to about 15–20 minutes).
- `docs/ROADMAP.md` corrects the LATER note: `/api/credential/*` does exist as the dsh
  `credentials.describe/set/unset` RPC, but opencode SDK 1.18.18 has no consuming route, so it
  stays LATER until an upstream protocol appears.
- `docs/RELEASE.md` adds a "current candidate readiness (12ca493)" summary: local/CI gates,
  flake/performance/real model/install chain/attribution experiment evidence at a glance.
- `dsh-oc --version` now behaves like the other paths when dsh is missing: exits 127 with an
  install hint (previously exited 1 with no hint); bin unit tests are added.
- `docs/PROTOCOL.md` completes the v2 route table: `/api/session/{id}/history` (`after` exclusive
  upper bound + `next` cursor semantics), the `prompt`/`model`/`agent` endpoints, and notes the
  cross-page pagination invariant.
- `e2e-tui-turn.sh` adds an exactly-once assertion for tool parts: the bash tool card may appear
  only once in history (the "dynamic tool call displayed twice" regression item).
- `e2e-tui-preset-inherit.sh`: after `/preset minimal` (including Enter on the selector) before the
  conversation, create a new session and assert the new dsh session inherits the minimal preset
  (the "cannot change the preset with /preset before the conversation" regression item); it is in
  the stable suite and passes 3/3 locally.
- `scripts/update-local-install.sh`: update the local dsh profile to a given GitHub ref in one
  command and verify both the resolved commit and the `dsh-oc --version` output.
- The artifact audit adds pack content verification: the tarball must not contain `src/`, and
  `bin/dsh-oc.mjs`, `lib/index.js`, `lib/bridge/router-entry.js`, `opencode-version.json`,
  `cordis.patch.yml` must be in the package.
- `e2e-queued-order-repro.sh` stability fix: the second prompt is sent as soon as the tool part
  appears (not after it completes), guaranteeing it is still inside the busy window and the QUEUED
  badge must appear; the following text grows to 15 segments. The local 10/10 flake scan passes
  (48s each), fixing the CI slow-runner failure "queued prompt not shown"; the queued-followup
  golden baseline is refreshed to the new scenario (180 events).
- 5000-session performance baseline recorded (commit `609ccd6`): list/message/history/pagination/
  title backfill/RSS data in docs/perf/results-5000-2026-08-17.md, the same order of magnitude as
  the 8-15 baseline.
- `e2e-real-llm.sh` strengthens assertions (round-0002 noted the real regression was weak): the
  queue probe now verifies FIFO content order (the second prompt is the last user message and the
  final reply contains the requested two-character answer) instead of counting user messages; TUI
  keyboard input waits for delivery and reply idle, and asserts exactly one new user message plus a
  panel record. It also fixes a latent bug where the bridge URL was not refreshed in the TUI phase,
  and makes `wait_idle`/count helpers tolerant of transient API failures.
- flake consolidated baseline: 6 minimal high-risk scripts, 10 first runs each for 60 runs total,
  all green (current HEAD), results in docs/perf/results-flake-consolidated-2026-08-17.md.
- `e2e-cli-bin.sh` adds a `dsh-oc --version` assertion: the output must be the two-version format
  `dsh-oc <semver> (dsh <version>)`.
- `SseHub.enqueue`: buffer events when no client is connected and flush them immediately when the
  first SSE client attaches (a late connection in raw replay/recovery scenarios no longer loses
  events); unit tests lock the buffering and immediate broadcast behavior.
- The minimal server supports a raw SSE direct-replay mode
  (`minimal-oc-server.mjs --sse <trace.raw>`): it broadcasts recorded bridge SSE events to the
  official TUI in their original order; the repro driver supports custom markers, event delay, a
  CJK heuristic and capture duration (`DSH_OC_MINIMAL_*`). Replay of real-session raw JSONL and of
  complete bridge SSE traces are both wired in: fixture replay renders in the correct order; raw
  direct replay located the official TUI's `/global/event` connection as a short-lived probe
  (fixture mode relies on in-connection streaming events arriving inside the window, and the
  external broadcast window is too short), so it does not render the conversation for now and is
  listed as a follow-up experiment; capturing the key section plus 80ms slow replay still does not
  render, so the raw direct-replay route is closed (the tool stays); in raw mode mux stays
  suspended so the bridge does not disconnect on its own. `e2e-real-queued-order.sh` now records
  the full `/global/event` trace starting before the first prompt, and the real model reproduced
  the wire precondition three times in a row.
- Official minimal-server attribution harness: `scripts/minimal-oc-server.mjs` uses bridge
  components plus a scripted event sequence (no dsh, no real model) to provide the full
  OpenCode-compatible surface, and `scripts/e2e-minimal-server-repro.sh` drives the official
  1.18.18 TUI attach and analyzes the queued/follow-up text order frame by frame; on the first run
  the official TUI rendered in the correct order (follow-up text above the queued card). The
  bridge gains a `src/bridge/router-entry.ts` build entry exporting
  `createBridgeRouter`/`startBridgeServer` for the harness.
- Real-model queued misordering repro `scripts/e2e-real-queued-order.sh` (manual, real DeepSeek
  API): queue a second prompt from the keyboard right after the tool completes, record bridge SSE
  timing evidence (whether the follow-up text delta arrives after the queued user event) and the
  streaming panel frames; two consecutive runs gave `wire_follow_after_queued=1`, with the reply
  content rendered below the queued card in 45/50 panel frames. It also fixes the
  `DSH_OC_REAL_KEEP_RUN=1` cleanup logic in e2e-real-llm/e2e-real-queued-order (previously
  inverted, deleting on keep).
- Candidate opencode upgrade lane `scripts/upgrade-lane.sh`: run the golden scenario against a
  candidate binary and semantically diff the normalized SSE trace against the 1.18.18 baseline
  (`--bin`/`--out`), with zero diff on the same version; the version-check bypass
  `DSH_OC_BYPASS_VERSION_CHECK=1` applies only to lane scenarios, and the production path still
  enforces a matching version.
- Misordering repro record `scripts/e2e-queued-order-repro.sh`: queue a second prompt from the
  keyboard during tool + slow-stream follow-up text, capture the official TUI panel order frame by
  frame (transient misordering detection), and freeze a second 1.18.18 golden SSE baseline
  `tests/fixtures/golden/queued-followup-1.18.18.sse.jsonl`; consecutive mock-driven runs observed
  no transient misordering, recorded as renderer/bridge attribution evidence.
- 1.18.18 golden SSE trace baseline: `scripts/e2e-golden-trace.sh` runs the "tool + follow-up
  text" scenario on the real TUI and records the trace with an observer SSE,
  `scripts/normalize-golden-trace.mjs` normalizes it (random ids, absolute times and machine paths
  removed), and the baseline is committed to `tests/fixtures/golden/`; repeated runs are
  structurally identical, it is in the stable suite, and it serves semantic diffing for future
  vendor upgrades.
- Minimal permission e2e `scripts/e2e-tui-permission-mini.sh`: a single Allow-once cycle on the
  real TUI (dialog → approve → tool completes → exactly one reply → no leftover permission),
  10–11s; it is in the stable suite, and the flake scan is 10/10 green.
- Second flake scan round: `e2e-tui-queue-live.sh` and `e2e-tui-agent-tab.sh` 10 first runs each,
  all green (the two scripts that flaked occasionally in CI), results in
  docs/perf/results-flake-tui-2026-08-17.md.
- Real-session feature coverage scan `scripts/replay-corpus-manifest.mjs`: it outputs only event
  type/feature counts and never touches real content; all 12 features across 64 real sessions are
  covered by the synthetic corpus (long-session is covered by runtime generation in the spec),
  report in docs/perf/coverage-real-sessions-2026-08-17.md.
- Deterministic replay corpus (experiment 1c): `scripts/build-replay-corpus.mjs` generates 10
  structure-preserving synthetic fixtures (reasoning, single/multiple tools, queued, tool error,
  compaction, interrupt, goal, plugin-context, session-title, unfinished-turn) into
  `tests/fixtures/replay/`; `tests/replay-corpus.spec.ts` audits the replay: no unhandled or
  translation errors, tool calls paired and terminal, live completion state consistent with
  durable, durable v1/v2 message surfaces consistent, and a 10k-event long session at runtime.
- Budgeted flake scan `scripts/flake-mini-scan.sh`: repeat the minimal high-risk e2e scripts N
  times (default 10), record the first failure and the duration, stop immediately on a semantic
  failure without retrying; the three recovery fault domains are green in their first 10 runs each
  (results in docs/perf).
- The recovery oracle gains crash semantics: `recovery_assert_crash_prefix` accepts a restart graph
  that is a complete message prefix of the observed graph, or, at equal length, a last text part
  that is a prefix of the observed text (a SIGKILL landing inside the last chunk's write boundary
  is normal crash consistency, not data loss).
- Release artifact audit `scripts/verify-release-artifacts.sh` (part of the `check-all` gate):
  clean-rebuild from HEAD sources and assert zero diff against the committed `lib/`; scan the npm
  pack for machine absolute paths; print the package version, tarball sha256 and package-tree
  hash.
- Install/upgrade/rollback drill `scripts/e2e-install-rollback.sh` (manual): cold-install the
  candidate from a remote GitHub full SHA and run a real TUI smoke, roll back to the previous spec
  and re-run, and probe re-add behavior within the same profile; before a version bump, in-place
  results only validate the command path.
- Recovery fault-domain e2e matrix:
  - `scripts/e2e-recovery-crash.sh`: SIGKILL dsh in the middle of a slow stream, restart with
    `--session` and assert the persisted prefix is exactly-once (nothing lost, no fabricated
    completion), the session returns to idle (explicitly cancelling the in-flight turn when
    needed), and a new prompt can continue (20s).
  - `scripts/e2e-recovery-sse-reconnect.sh`: an observer SSE stream breaks and reconnects; assert
    events keep arriving after the reconnect and the final v1/v2 message graph is exactly-once
    (13s).
  - mux resubscribe unit test: replayed text-chunks across a translator rebuild are deduplicated by
    the connection-level replay guard, so deltas are not sent twice.
- Recovery assertion helpers converge into `tests/e2e/recovery-lib.sh` (v1/v2 signatures,
  authoritative idle, prefix/full equality comparison), and `e2e-recovery-consistency.sh` reuses
  the same oracle.
- `GET /api/session/{id}/history`: SDK v2 history endpoint (`limit` + `after` event seq cursor),
  returning `{ data: SessionMessage[], hasMore, next }`; `after` is an exclusive upper bound (dsh
  native `beforeSeq`, paging backwards) and single-page latency is bounded; the v2 message
  conversion gains a message anchor seq, and a negative `after` returns 400.
- Background subagent capability enabled: `GET /experimental/capabilities` returns
  `{ backgroundSubagents: true }`, and `POST /experimental/session/{id}/background` is added as a
  no-op success route (dsh sessions live in the server, and the `subagent` tool runs in the
  background by default).
- `GET /session/{id}/children`: returns the subagent child sessions by `parentSessionId`, paired
  with the background subagent capability for TUI subagent tree queries.
- `GET /experimental/session`: GlobalSession list (search/directory filter/limit subset
  supported), completing the experimental session list surface.
- `POST /session/{id}/init`: no-op success `true` (a dsh session is initialized when created).
- `GET /session/{id}/message/{messageID}`: single message query (reuses the v1 conversion, 404 when
  not found).
- `POST /session/{id}/permissions/{permissionID}`: SDK v2 permission reply alias (body uses the
  `response` field), mapped to the same `permissionReply`.
- `GET /api/health`: returns `{ healthy: true }` for client liveness checks.
- `GET /api/session/active`: returns the current active session
  (`{ data: { [sessionId]: { type: "running" } } }`).
- `POST /api/session/{id}/wait`: bounded polling wait for the session to go idle (≤30s, 204 when
  idle).
- `GET /api/session/{id}/context`: returns `{ data: SessionMessage[] }` (reuses the v2 message
  conversion).
- `GET /api/session/{id}/event`: SSE event stream filtered by session (a subset of
  `/global/event`).
- `GET /api/session/{id}/message/{messageID}`: v2 single message query
  (`{ data: SessionMessage }`).
- `GET /api/provider/{id}`: single provider query (`{ location, data: ProviderV2Info }`).
- SDK v2 permission surface completed: `GET /api/permission/request`, `GET /api/question/request`
  (global pending lists, `{ location, data }`), `GET /api/session/{id}/permission/{rid}` (single
  query, 404 when the session does not match), `DELETE /api/permission/saved/{id}` (delete an
  in-memory `sessionID:toolName` grant); `GET /api/permission/saved` output aligns with the SDK
  `PermissionSavedInfo` (`projectID/action/resource`, keeping `sessionID/grantedAt`).
- Real VCS surface: `GET /vcs`, `GET /vcs/status`, `GET /vcs/diff`, `GET /vcs/diff/raw` upgrade
  from stubs to real git reads (current branch, origin default branch, staged+unstaged file status
  and line counts, per-file and raw unified diff; untracked files do not enter status).
- Workspace filesystem surface: `GET /api/fs/read/{path}` (raw bytes, 400 for out-of-range paths,
  5 MiB per-file limit), `GET /api/fs/list`, `GET /api/fs/find` (recursive search, skipping
  dependency/build directories and limiting the result count); route matching gains trailing `*`
  wildcard support.
- Lifecycle surface: `GET /global/health` (`{ healthy: true, version }`), `POST /global/dispose`
  and `POST /instance/dispose` (no-op acknowledgements; the process is managed by dsh).
- Real title backfill for the session list: dsh `session.list` does not return a title projection,
  so the bridge backfills from the history tail projection per session and caches it (full sync
  for ≤40; larger lists do not block, a background low-concurrency job backfills the most recent
  24 with concurrency 2), and restored old sessions are also recognized correctly in the exit
  note.
- Esc interrupt/cancel: `turn.wait` / `turn.idle` events drive the TUI running state; two
  consecutive Esc presses in the full TUI and one Esc in `--mini` call `session.cancel` to stop
  the in-flight stream.
- `/preset` inheritance for new sessions: the most recently selected agent preset applies to
  sessions created by later `/new`; after a switch, `session.updated` is broadcast carrying the
  new agent.
- Exit note: the official opencode exit splash (full/`--mini`) cannot be replaced, so dsh-oc prints
  one explanatory line below it when the session has content (the session id belongs to dsh;
  resume with `dsh --profile oc --session <id>`); `DSH_OC_DISABLE_EXIT_NOTE=1` turns it off.

### Engineering

- CI e2e runs each script under `timeout -k` (default 300s, `E2E_TIMEOUT` overrides); a hung suite
  fails fast and retries once instead of holding the whole job.
- CI failure artifacts are uploaded as a bundle (excluding `node_modules` and `work/.git`), with a
  5-minute limit on the upload step, so `.e2e` uploads do not hang for hours.
- `scripts/cleanup-merged-branches.sh` now enumerates both local and remote merged branches (a dry
  run lists leftovers such as `origin/feat-*`, `origin/chore-*`), and `--apply --remote` cleans
  them in one go.
- `CONTRIBUTING.md`, PR/Issue templates and the branch strategy (main releases / develop integrates
  / short-lived feature branches).
- CI: pushes to `main`/`develop`/`feat-*`/`fix-*`/`docs-*`/`perf-*`/`test-*`/`chore-*` run the
  stable e2e suite automatically (`CI_E2E_SUBSET=1`); manual runs do the full e2e + stress test.
- M5 refactor: route registration is extracted from `router.ts` and split by domain into
  `src/bridge/routes/{boot,session-v1,session-v2,permission}.ts`; the protocol probe scans the
  route directory automatically.
- `scripts/cleanup-merged-branches.sh`: list/delete leftover branches already merged into main
  (dry run by default, `--apply` deletes locally, `--remote` also deletes on the remote).
- `scripts/cleanup-e2e-runs.sh`: clean old e2e run directories under `.e2e` (dry run by default,
  `--keep N` keeps the most recent N, `--apply` deletes; test artifacts are regenerable).
- `pnpm run e2e` / `pnpm run e2e:api`: run the full or the API-subset e2e in one command.
- `scripts/e2e-tui-permission.sh`: real TUI permission/question e2e (workspace-write + mock LLM
  escalating a tool call), covering Allow once, Allow always + automatic allowance within the
  session, Reject (error returned and nothing persisted), the `ask_user_question` option dialog,
  and once/always+auto-allow/reject/question plus single-reply rendering in `--mini` mode.
- `scripts/e2e-api-permission.sh`: API permission e2e completion (v1 once does not persist a
  grant, v2 always/alias reject, a saved grant does not leak across sessions, re-ask after
  deletion, question second-option reply and v2 reject, 400/404 error branches).
- `scripts/e2e-tui-permission-ext.sh`: TUI keyboard surface extensions (question option highlight
  moves on Down, question cancels on Esc, permission Esc=reject: direct reject in standard, a
  confirmation layer first in `--mini`).
- `scripts/e2e-tui-mini.sh`: after a graceful `--mini` exit (three Ctrl+C), assert the dsh-oc exit
  note is visible.
- `scripts/e2e-tui-continue.sh`: the seeded session carries an explicit title; after `--continue`
  restores it, assert the session list returns the real title (the historical "restored session
  has no title" regression item).
- `scripts/perf.mjs` adds `measurements.titleCoverage`: quantifies the real-title coverage of the
  list.
- `e2e-tui-abort.sh`: the mini branch now waits for a real streaming increment in SSE before
  pressing Esc, asserting the in-flight stream is actually interrupted (the long mock enables
  `repeatLast`, fixing the earlier false pass where the second request was rejected with 500).
- `e2e-tui-queue.sh`: send a second prompt while a permission dialog blocks the first turn, assert
  the TUI shows QUEUED, and that the second prompt is processed in order after approval.
- `e2e-tui-queue-live.sh`: send a second prompt from the TUI keyboard during a slow stream, assert
  QUEUED appears, then interrupt and exit cleanly (the "cannot send a new message while the model
  runs" regression item).
- `e2e-tui-agent-tab.sh`: after switching agent with Tab, it takes effect with the prompt and the
  dsh session preset really switches (build → standard).
- `e2e-tui-abort.sh` adds a spinner-stop assertion: after an interrupt, two captures must not show
  a changing spinner frame (the "thinking keeps spinning after interrupt" regression item).
- `scripts/e2e-real-llm.sh`: local full-flow real-LLM regression (headless text+tool, FIFO queue
  order, `/goal` creation, variant preservation, TUI sidebar and send, clean exit; local manual
  runs only, consumes real tokens).
- README trimmed per review: capability status moved up front, cast recording details removed
  (kept in AGENTS.md), binary notes reduced to "official binary", update commands and the npm
  package name explained.
- The README demo becomes a GIF recorded with a real model: an asciinema cast (`docs/demo/`)
  rendered to GIF with the official `agg` and embedded in the README (GitHub does not execute
  `<script>`, so a player script is not an option), with the cast kept for interactive
  `asciinema play` replay; the recording uses a real DeepSeek model on a real task, not a mock.
- Error display: dsh `host/agent-error` now broadcasts a visible assistant text message with an
  error prefix in addition to `session.error`, so the TUI conversation area shows the error
  directly instead of staying silent or rendering abnormally.
- Queued messages visible: the dsh pending inbox (`session/queue` initialization +
  `agent/inbox/spliced` increments) maps to opencode user messages, so the TUI shows QUEUED; the
  300ms same-text debounce is removed (it masked the root cause of "no queued feedback → user
  resends").
- `tool-call-chunks` history replay: the dsh persisted main-stream encoding (701 vs 39 live deltas
  in a real session) restores streaming tool arguments through the shared feed pipeline.
- Slash command queue notice: when `/goal`, `/preset` or `/help` runs while user messages are
  still queued, the result ends with a note that N messages are still queued for processing.
- Known log-type session events (`step/start`, `request/header|context`,
  `session/title-llm-request`, `permission/preset`, `sandbox/mode`, `approval/policy`,
  `command/run|done`) are explicitly silenced, while genuinely unknown types still log.
- Top-level model round-0002 review (gpt-5.6-sol / max): confirms rc.2 as a conditional NO-GO; the
  primary recovery-consistency evidence must upgrade from the warm/cold history projection to a
  v1+v2 two-sided oracle; the `--continue` message-graph variant is deferred, prioritizing the
  three fault domains (SSE disconnect, mux resubscribe, process crash) and the full-SHA immutable
  install/upgrade/rollback drill; the misordering attribution wording is downgraded to a neutral
  known limitation pending an official 1.18.18 minimal repro.

### Fixed

- When a turn has multiple assistant messages containing tool calls, turn/end now sends completed
  for **every** tool message (the pending completion state was a single slot, so only the last
  tool message got completed and earlier tool cards lacked a completion state in the live view;
  the corpus audit found this on its first run, and a multi-tool completion unit test is added).
- The v1 history message `parentID` is now remapped together with the bridge surface id:
  previously, inside a warm process the parent chain still pointed at the original dsh id while
  message ids had already switched to bridge ids, so clients could not resolve the parent chain
  within the returned list (a cold `--session` with no mapping could resolve it); after the fix the
  warm/cold v1 graphs agree under the normalized index.
- `e2e-recovery-consistency.sh` upgrades to a two-sided recovery-consistency oracle: wait for
  authoritative idle (`POST /api/session/:id/wait`) instead of a fixed sleep; compare both v1
  (parent chain/part ownership) and v2 (per-message parts, user text merged in); tool parts
  include `name/status/output`, and it asserts at least one completed tool output and that the
  whole parent chain resolves (no more empty assertions without a parent chain).
- The first reply is no longer rendered twice: the plugin context message dsh injects
  (`Current runtime context`) no longer overwrites the "parent anchor", and assistant messages
  always use the bridge id registered for that prompt, matching the history endpoint id, so the
  TUI renders once.
- After switching preset with Tab / `/preset` before the conversation, the TUI sidebar agent label
  no longer falls back: the bridge tracks the real agent per session and carries it through user
  messages, assistant messages, `session.updated` and v1/v2 history; the prompt echo is broadcast
  after the agent is applied; assistant messages gain the official runtime's `agent` field.
- Streaming errors show readable text in the sidebar: `session.error` is emitted per the official
  discriminated union (`UnknownError` / `MessageAbortedError` / `ProviderAuthError`) instead of
  rendering as `[object Object]`.
- v1/v2 history merges the tool call and the following text of the same turn into a single message
  by bridge id, consistent with live SSE (previously history returned two messages with the same
  id, and after TUI merging the tool card/text were rendered twice); the immediate "tool + queued"
  view misordering is a display limitation observed in the official TUI 1.18.18 (the bridge's
  persisted data is correct and re-entering with `--session` has the right order; the exact
  attribution awaits the official minimal repro experiment).
- `turn/end` now also deletes the record when skipping pending completion for a finalized message,
  so nothing lingers into the next turn and re-sends a duplicate `message.updated`.
- `/api/session/active` returns the session only when it is actually `running`, and `{ data: {} }`
  when idle or missing (previously it was marked running unconditionally).
- Document the known behavior of paired duplicate SSE text deltas (dsh double encoding + mux
  replay; the TUI renders full text from `message.updated` and is unaffected in practice).
- Thought (reasoning) duration: `end` now uses the timestamp of the last reasoning chunk instead of
  wrongly equalling the completion time of the whole reply (applies to history reads and the live
  stream).
- Interrupt/streaming spinner: the reasoning part is closed immediately when a text block starts
  (with an end time); on interrupt (no final assistant/message) turn/end also closes a still-open
  reasoning part, so the TUI thinking indicator no longer spins forever.
- Tab/agent selection takes effect with the prompt: all v1/v2 prompt routes now apply the `agent`
  in the request body; dsh locks the agent preset for a session that already produced a reply
  (409), in which case an "Agent switch locked" notice is shown once in the TUI after the first
  message instead of failing silently.
- Assistant messages with unfinished tool calls are no longer marked `completed` early; completion
  is sent at `step/end` / `turn/end`, so the official TUI's QUEUED determination (a user message
  after the last unfinished assistant) works correctly.

## [0.1.0-rc.1] - 2026-08-15

### Added

- HTTP/SSE bridge and real TUI attach based on OpenCode 1.18.18.
- DSH OC branding startup logo (replacing the OpenCode ASCII art).
- Automatic updates disabled and the binary version pinned to 1.18.18.
- Streaming toolcall/progress, the full Goal lifecycle, dsh model catalog/preset switching.
- Text/image attachments, in-memory `Always` permission memory for the session, skills directory
  and slash commands.
- v2 session search/pagination/sorting, `--dir` directory filtering.
- SSE mux/host reconnect with replay dedup, todo/goal state preserved across reconnects.
- Session performance stress tests (200/1000/5000/10000) and the protocol upgrade probe.
- One-command self-test `scripts/check-all.sh` and GitHub Actions CI.

### Fixed

- `--mini` no reply (added `POST /session/:id/prompt_async`).
- `--mini` reply rendered twice (streaming/final part id reuse).
- Session history list has no title (persisted title → project directory basename → session id
  fallback).
- The old package name migration caused `duplicate loader entry id: storage` (removing the leftover
  `@deepseek-ai/dsh-oc` dependency and bundle entry from the profile restores it).

### Refactored

- Package name migrated from `@deepseek-ai/dsh-oc` to `@chiro2001/dsh-oc`.
- Route registration extracted from `router.ts` to `src/bridge/routes.ts`.
