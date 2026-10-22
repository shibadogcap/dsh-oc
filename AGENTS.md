*English · [日本語](AGENTS.ja.md) · [中文](AGENTS.zh.md)*

# AGENTS.md — dsh-oc development/agent guide

This file is for the AI agents and developers who take over this repository, and it replaces the development sections of the README. User documentation is in [README.md](README.md); the human contribution process is in [CONTRIBUTING.md](CONTRIBUTING.md).

## What the project is

dsh-oc is the OpenCode TUI front end for DeepSeek Harness (dsh):

- **Front end**: the official opencode CLI (`--server` mode), responsible only for rendering, keyboard, and terminal lifecycle.
- **Back end**: dsh handles agents, sessions, tools, models, permissions, and questions.
- **Bridge**: dsh-oc serves an OpenCode-compatible HTTP/SSE service (`oc-bridge`) inside the dsh process and starts the official TUI child process (`oc-tui`).

```text
dsh (Node) ── dsh-oc bundle ── oc-bridge (HTTP/SSE) <── opencode TUI (--server)
                  │
                  └─ DSH Agent/Session/Tools/LLM/Approval/Questions
```

Repository: `shibadogcap/dsh-oc`; npm package name `@chiro2001/dsh-oc@0.2.0-rc.4` (not published to a registry, so install/update go through the GitHub source `#main` / `#develop`).

The current prerelease targets dsh `>=0.1.5-rc.2` (0.2.0-rc.3 and earlier target `>=0.1.2-rc.1`, whose event model is incompatible and no longer supported). PR #1/#2/#3 were not merged as-is; the RC version re-integrates their valid semantics with the dsh host-services migration. See the CHANGELOG for details.

## Code structure

```text
src/
  bridge/            # OpenCode protocol bridge
    router.ts        # core: SSE, cache/prefetch, command/permission helpers, bridge service wiring
    routes/          # route registration (split by domain, aggregated in routes.ts)
      boot.ts        # boot and directory routes (/api/info /api/location /api/agent /api/model ...)
      session-v2.ts  # session routes (list, messages, prompt, interrupt, command, fork)
      fs.ts          # workspace file read/list/find routes
    routes.ts        # aggregator (registration order is match order, do not reorder)
    events.ts        # SSE event translation (assistant-stream, turn.*, message.*, session.*, tool streams, permissions)
    state.ts         # bridge in-memory state (caches, titles, preset, activity markers)
    file-uploads.ts  # dsh 0.1.5 headless fileUploads provider (see below)
    convert/         # dsh events → opencode message/session/model/permission conversion
    http.ts sse.ts rpc.ts errors.ts stubs.ts git.ts fs.ts
    web-ui.ts        # official opencode Web UI: AppArchive extraction + static file serving
  rewind/            # revert plugin: session fork + file snapshots grouped by turn (copy-on-write)
  tui/               # opencode child process resolve/download/spawn, signal forwarding, exit handling
  help.ts            # --help / /help static capability summary
tui-branding/        # DSH OC brand logo TUI plugin
scripts/             # self-test/load-test/capability matrix/cleanup tools
tests/               # vitest unit tests + e2e (scripts/e2e-*)
docs/                # FEATURES / PROTOCOL / ROADMAP / CHANGELOG / perf
lib/                 # build output (must be pushed with commits; GitHub direct install depends on it)
```

## Common commands

```bash
pnpm install
pnpm build                 # tsdown → lib/
pnpm typecheck             # tsc --noEmit
pnpm test                  # vitest
pnpm run probe             # opencode 2.1.0 protocol route probe (covers every route of the official client)
pnpm run e2e               # full e2e (real opencode TUI, stable suite takes about 15–20 minutes)
pnpm run e2e:api           # API e2e subset (fast regression)
pnpm run perf              # session performance load test (--sessions N --scale ...)
pnpm run features:update   # refresh docs/FEATURES.md auto-tracking
bash scripts/check-all.sh --e2e          # one-shot full gate
bash scripts/check-all.sh --e2e --scale 5000
bash scripts/verify-release-artifacts.sh # release artifact audit (built into check-all: zero lib diff, no absolute paths in pack, artifact hashes)
bash scripts/e2e-install-rollback.sh     # manual: remote full-SHA cold install + TUI smoke + rollback drill
bash scripts/cleanup-e2e-runs.sh --keep 20 --apply   # clean old .e2e runs (dry-run by default)
bash scripts/replay-session-audit.sh <session.jsonl[.zstd]>
                                          # real session replay audit: bridge translation has no unhandled events/errors
bash scripts/audit-local-sessions.sh [sessions-dir]
                                          # batch audit every session under $DSH_HOME/sessions (includes message id/role conflict checks)
bash scripts/e2e-recovery-crash.sh        # failure domain: --session restart recovery after a mid-run SIGKILL
bash scripts/e2e-recovery-sse-reconnect.sh # failure domain: exactly-once after an observer SSE stream drop and reconnect
node scripts/build-replay-corpus.mjs      # regenerate the synthetic tests/fixtures/replay corpus (structure preserved, no real content)
node scripts/replay-corpus-manifest.mjs   # scan real sessions for feature coverage, output the corpus coverage gap (no content leaked)
bash scripts/e2e-golden-trace.sh          # freeze/verify the golden SSE trace of 1.18.18 event shapes (refresh with DSH_OC_GOLDEN_OVERWRITE=1)
bash scripts/e2e-queued-order-repro.sh    # record the official TUI ordering repro for tool + queue + trailing text
bash scripts/upgrade-lane.sh --bin <candidate>
                                          # candidate opencode upgrade lane: golden trace semantic diff
bash scripts/update-local-install.sh [ref]
                                          # update the local dsh profile install and verify resolved commit/version
bash scripts/e2e-real-queued-order.sh     # manual: real model queue misorder wire/panel evidence
bash scripts/e2e-minimal-server-repro.sh  # official minimal server attribution: scripted events → official TUI render order
scripts/monitor-process-io.sh --pid <pid> --log <tsv> # observe-only by default, silent on normal exit
scripts/e2e-tui-subagent.sh             # dsh subagent → OpenCode task + child navigation
scripts/e2e-tui-shell.sh                # official TUI `!` shell → OS shell tool card
tests/e2e/fake-opencode-idle.sh           # fake TUI idle-without-EOF busy loop regression
tests/e2e/monitor-process-io-attach.sh    # exact TUI PID/log/no-target-kill shell regression
```

Local direct connection to a dsh profile (live verification): `dsh plugin --profile oc add .`; after changing code, `pnpm build` takes effect immediately (link mode). Install from a GitHub branch for verification: `dsh plugin --profile oc add 'github:shibadogcap/dsh-oc#<branch>'`. `#develop` is a mutable ref, and pnpm may reuse an old resolved SHA; re-running add refreshes the lockfile, so check the commit that actually resolved with `rg 'codeload.github.com/shibadogcap/dsh-oc/tar.gz' pnpm-lock.yaml`.

## Install, update, and local development

See the README when the user only cares about the install command; agents and developers verify and update as follows.

Install/update from the GitHub source (same commands as the README; re-running updates to the latest of that branch):

```bash
dsh plugin --profile oc add 'github:shibadogcap/dsh-oc#feat-opencode-2-1'                       # #main
dsh plugin --profile oc add 'github:shibadogcap/dsh-oc#feat-opencode-2-1'      # specific branch
dsh --profile oc --help                                            # verify version
```

- `bin/dsh-oc.mjs` provides the `dsh-oc` shorthand (passes through `dsh --profile oc` arguments and the exit code); after install it sits in the profile's `node_modules/.bin`, and the README gives PATH guidance; on this machine you can make the shorthand permanent on PATH with `ln -sf ~/.dsh/profiles/oc/node_modules/.bin/dsh-oc ~/.local/bin/dsh-oc`.
- The npm package name `@chiro2001/dsh-oc` is not published to a registry; install/update always go through the GitHub source.
- Local development: `dsh plugin --profile oc add .` links the repository as `link:`, so `pnpm build` after changing `src/` takes effect immediately; but `lib/` must be pushed with commits, or a GitHub direct install will not include the latest build output.

## opencode binary and network policy

- Use the official opencode binary directly, with the version pinned in `opencode-version.json` (currently `2.1.0`); startup validates twice with `resolveOpenCodeBinary` + `verifyOpenCodeVersion`, and an explicit `DSH_OC_OPENCODE_BIN` whose version does not match errors out instead of falling back to another version on PATH.
- Native temp-file leaks from OpenTUI 2.1.0/Bun are isolated by dsh-oc into `$DSH_HOME/opencode/tmp/tui-<pid>`; they are cleaned up on normal exit, and the next start reclaims directories left by dsh processes that have exited. dsh-oc does not scan arbitrary user plugin caches and does not disable the official version/integrity checks.
- Resolution priority: `DSH_OC_OPENCODE_BIN` → `$DSH_HOME/opencode/bin/<version>` → a version-matching `opencode` on PATH → the official npm platform package `@opencode/cli-<platform>-<arch>` (lazy install, npm integrity check) → the `opencode-ai` / `@opencode/cli` package inside the profile. From 2.1.0 on, `opencode-assets.json` is no longer maintained and the binary comes only from the npm platform package; installs use the proxy (`HTTPS_PROXY`/`HTTP_PROXY`) and the `DSH_OC_OPENCODE_MIRROR` mirror prefix.
- Network policy: the child process forces `OPENCODE_DISABLE_AUTOUPDATE=1` / `OPENCODE_DISABLE_MODELS_FETCH=1` / `OPENCODE_DISABLE_LSP_DOWNLOAD=1` and writes `autoupdate: false` into the isolated config, which turns off background network activity.
- On a cache error, clear `$DSH_HOME/opencode/bin` or set a matching `DSH_OC_OPENCODE_BIN`; `DSH_OC_TUI_TIMESTAMPS=1` makes the TUI show timestamps by default (`ctrl+shift+t` / `/timestamps` toggles them at runtime).
- **The official Web UI uses the same binary**: `src/bridge/web-ui.ts` extracts the AppArchive inside the opencode binary (the format from `packages/cli/src/app-archive.ts`: little-endian u32 JSON index length, index, `[offset, length]`, and brotli-compressed asset bodies) into `$DSH_HOME/opencode/web-ui/<version>/`, and the bridge serves those files itself. The lookup order of `resolveWebUi()` in `src/bridge/index.ts` is `DSH_OC_WEB_UI` → the extracted directory. **The binary is only looked up and never installed by the bridge** (`resolveOpenCodeBinary` receives `installNpmPackage: async () => false`); the TUI plugin has to install the binary anyway, so the Web UI appears from the next start. With no binary there is no Web UI, and the API is unaffected. For offline extraction use `node scripts/extract-opencode-web-ui.mjs --bin <binary> --out <dir>`.
- **Treat opencode as a vendor ABI**: an upgrade candidate must pass the semantic diff of "golden HTTP/SSE trace + real TUI replay", not only SDK types and route count; create a separate upgrade lane for the candidate version and do not replace the pinned version directly.
- **Real-model regression is a smoke test**: `scripts/e2e-real-llm.sh` covers real text, tools, goal, variant, and TUI interaction, but random model output is not the sole oracle for bridge correctness; the deterministic replay corpus (redacted real sessions) is the higher-priority regression method.
- **Recovery failure domains are verified per path**: `client-sse-reconnect` / `mux-resubscribe` / `process-crash-recovery` are not the same reconnect path. The shared oracle is in `tests/e2e/recovery-lib.sh` (v2 signature, authoritative idle, prefix/full-graph comparison); when you change bridge SSE/history translation, run at least `e2e-recovery-consistency.sh` + `e2e-recovery-crash.sh` + `e2e-recovery-sse-reconnect.sh`.

- **status hot path**: the bridge maintains an in-memory authoritative map from dsh `api-session/status`/`api-session/activity` and publishes it over the SSE `session.status` event; `POST /api/session/:id/wait` is the 2.x idle-wait entry point.
- **SSE disconnect contract**: `SseHub` keeps a ring bounded by both event count and serialized bytes, consumes `Last-Event-ID` and strictly replays the events after it; when the cursor has been evicted or is unknown, it logs a warning and replays the current status/control snapshot. No history/list scan is triggered per connection. 2.x clients require the event stream to open with `server.connected`, so the bridge sends that frame first after connecting and then replays.
- **e2e TUI I/O observation**: with `DSH_OC_E2E_MONITOR_IO=1` set, `tests/e2e/common.sh` resolves the exact `opencode --server` PID of the current run in `e2e_tui_wait_attach` and records it into that run's directory with an observe-only monitor; the default `0.25s` / `32MiB` read window can be overridden with `DSH_OC_E2E_MONITOR_INTERVAL` / `DSH_OC_E2E_MONITOR_READ_THRESHOLD`. The monitor exits with the target and never ends the target by name; necessary cleanup may only end the monitor's own PID. Add `--report-exit` explicitly to write a normal exit to stderr; threshold warnings still go to stderr either way.
- **Compatibility boundary**: dsh-dcp rc.6 still reads the removed `session.events`, so the bridge temporarily installs a `snapshotEvents()` getter shim; delete it once dcp is upgraded to a version compatible with dsh 0.1.5.
- **dsh 0.1.5 host ABI**:
  - `dsh-api-session-controller` adds a hard dependency on `fileUploads`; the official provider (`dsh-client-file-upload`) is a browser transport plugin that injects `connection`, and oc-bridge does not mount it. `@chiro2001/dsh-oc/file-uploads` (`src/bridge/file-uploads.ts`) provides a headless implementation and must be inserted before `session-controller` in `cordis.patch.yml`; `bindPrompt` must return an object with `Symbol.dispose` (0.1.5 wraps it in explicit resource management, and a plain object raises `TypeError: Object not disposable`).
  - Live streaming: the `assistant/chunk` session event is removed; subscribe to the in-process `agent/assistant-stream` instead (`start` carries turn/step, `chunk` carries attemptId/revision/index plus the same `StreamChunk` payload), `index.ts` maintains the attempt→turn/step mapping and feeds `session/assistant-stream` frames, and late frames with no matching start are dropped.
  - Persisted history: `SessionHistoryRecord` no longer has `chunks`; `assistant/message` / `assistant/attempt` embed `stream: AssistantStreamRecord[]`. `expandRecord` restores packed runs into `text-chunks`/`reasoning-chunks`/`tool-call-chunks` rows, and `assistantStreamTiming` restores part durations and the finish reason from raw `block-start`/`block-end`/`finish`; `assistant/attempt` has no TUI surface in either live or history.
  - `write`/`edit` in `dsh-tool-fs` are the 0.1.5 file tools (`str_replace_editor` exists only on the 0.1.2 base line and is now opt-in); the result meta of a new-file `write` has empty diffs, so the bridge synthesizes the diff from the call arguments to guarantee the opencode edit card has `metadata.diff`.
  - **First-turn labels**: every provisional card (live SSE, streaming history merge, shell synthesized card) must take the session's actual values through `state.sessionModelSelectionFor()` + `sessionAgentFor()` and must never fall back to `build`/`deepseek-chat`; when the prompt carries no model, fall back to the deployment default model. The TUI's default mapping agent `build` is resolved by `applyAgentFromBody` to the deployment default preset, so the first turn shows the real preset.

## Self-test gate (must be green before commit/merge)

1. `pnpm typecheck && pnpm test`
2. `pnpm run probe` (63/63)
3. Changes touching protocol/bridge/TUI: run at least the relevant `scripts/e2e-*.sh`; for full regression use `bash scripts/check-all.sh --e2e`
4. Release artifact audit: `check-all` includes `verify-release-artifacts.sh` (after a clean rebuild from HEAD, committed `lib/` has zero diff, npm pack contains no machine absolute paths, artifact hashes are recorded); run it standalone with `bash scripts/verify-release-artifacts.sh`
5. `pnpm run features:update` (when the capability list is involved) and commit the result
6. `pnpm run docs:check` (every document has its English, Japanese and Chinese variant, with consistent switcher headers and resolving links)
7. `lib/` build output goes with commits; check for machine-specific absolute paths: `rg -n --hidden -g '!node_modules' -g '!.git' 'chiro' . | rg -v 'chiro2001|/home/chiro/'`

e2e scripts may run only on `main` / `develop` and on `chore-*` / `fix-*` / `docs-*` / `perf-*` / `test-*` / `feat-*` branches (the allowlist is in `tests/e2e/common.sh` and `tests/e2e/env.mjs`, kept in sync with the CI trigger branches).

## Branches and releases

- `main`: stable release line; the README install command defaults to `#main`.
- `develop`: integration delivery line for daily development and live user verification; merges to main once stable.
- Release candidates (rc.N) follow `docs/RELEASE.md`: version bump, full gate, full-SHA remote install/rollback drill, real-model smoke, protected tag; npm stays NO-GO.
- Feature branches: `feat-*` / `fix-*` / `docs-*` / `perf-*` / `test-*` / `chore-*`, branched from develop and short-lived.
- Commit convention: Conventional Commits (feat/fix/docs/perf/test/chore/refactor).
- Leftover feat-* branches are all merged into main; the cleanup tool is `scripts/cleanup-merged-branches.sh` (dry-run by default, `--apply` deletes locally, `--remote` syncs the remote).

## Key implementation conventions and pitfalls

- **Route registration order is match order**: `src/bridge/routes.ts` calls boot → session-v2 → session-v2-extra → fs → stubs → client-compat → SSE in that order; add new routes to the matching domain file.
- **Session list titles**: dsh `session.list` does not return a title projection; the bridge backfills it by projecting the `session.history` tail (synchronous full read for ≤40 non-empty sessions, background backfill of 24 at low concurrency for large lists, never blocking the list request). Title priority: projected title → directory basename → session id.
- **In-flight merging and caching**: in-flight RPCs for `session.list` / `session.history` are shared (a loading promise inside `InteractionState`), and invalidation uses a generation counter to prevent races.
- **Revert boundaries are exclusive**: the message named in `POST /api/session/:id/revert/stage` and every message after it are discarded together at commit; `before` on `POST /api/session/:id/fork` is exclusive in the same way. dsh's `sessionController.fork` copies the prefix that **includes** `atSeq`, so the cut point must be computed with `R.atSeqBeforeMessage` (the event before the boundary message); when the cut point is before the first message, dsh cannot express an empty fork and returns 400 `cannot cut before the first message`. The three routes (stage / `DELETE .../revert` / commit) and the three `session.revert.*` events are in `src/bridge/routes/session-v2.ts`; file rollback is in `src/rewind/` (copy-on-write snapshots grouped by turn: stage rolls back immediately, commit keeps, clear undoes; when the boundary is a user prompt, that turn's files count as well).
- **After a revert the opencode session id follows the fork**: commit forks the dsh session at the cut point and uses `InteractionState.setSessionAlias` to point the opencode id at the fork. Therefore `resolveSessionPayload` in `rpc()` rewrites every dsh call to the fork; the session list publishes the fork under the original id and drops the replaced session; `GET /api/session/:id` and `/message` read the fork; SSE events for the fork are rewritten back to the original id by `mapEventSessionId`; the model/preset/title/message id mappings are inherited through `inheritSessionState`. As in OpenCode, when the next prompt arrives, `POST /api/session/:id/prompt` first commits the staged revert. Known limitation: the file diff is one coarse hunk between the first and last changed lines (the same shape as the bridge's own file-change diff), not a full LCS diff.
- **SSE turn events**: `turn/start` broadcasts `session.status busy` + `turn.wait`; `turn/end` broadcasts `session.status idle` + `session.idle` + `turn.idle`. Esc interrupt in the TUI depends on `phase === "running"`; without `turn.wait` it does not interrupt.
- **The SSE heartbeat cannot be removed**: `src/bridge/sse.ts` writes one `: heartbeat\n\n` frame to every connection every 15 seconds (the same style as the official server's `packages/server/src/handlers/event.ts`). Without the heartbeat, clients judge a quiet session's stream as stalled: the official client reports "Event stream stalled" and reconnects, OpenChamber's upstream reader gives up after 20 seconds, and both turn into reconnect loops. Comment frames are transparent to SSE parsers but count as "data received".
- **Status snapshots must stay bounded**: `replaySessionStatusSnapshot()` is capped by `SESSION_STATUS_SNAPSHOT_LIMIT = 20` (running sessions are reported first, the remaining slots go to the most recently touched by `sessionStatusUpdatedAt`). The old implementation reported every session the bridge had ever seen, so the official Web UI read hundreds of session records on each connection and initial load never finished. Raising this limit requires evaluating the connection cost as well.
- **CORS aligned with the official server**: `isAllowedCorsOrigin()` / `corsHeaders()` in `src/bridge/http.ts` must keep the shape of the official `packages/server/src/cors.ts`: allow `http://localhost:<port>`, `http://127.0.0.1:<port>`, `oc://renderer`, tauri origins, `*.opencode.ai`, plus `DSH_OC_CORS` (comma-separated, equivalent to the official `cors` option); when a request is allowed, **echo its own origin** and include `Access-Control-Allow-Credentials: true`. The old `Access-Control-Allow-Origin: *` was removed: browsers reject credentialed requests ("credentialed request requires Access-Control-Allow-Origin '<origin>'"), so the browser UI could not connect at all. Do not go back to `*`.
- **Web UI fallback rule**: in `src/bridge/http.ts`, a `GET`/`HEAD` that matches no route goes to `router.serveWebUi` (`src/bridge/web-ui.ts`): single-page app, so unknown paths also get `index.html`; missing files under `_assets/`, `icons/` are 404, and unmatched routes for other methods are still 501. API routes take priority over the Web UI.
- **`DSH_OC_HTTP_LOG=1`** turns on per-request stderr tracing (`[bridge/http] <METHOD> <path>`); it is the way to confirm UI call patterns when no browser is available.
- **reasoning duration**: the `end` of a reasoning part takes the time of that block's last chunk; when a text block starts, and at turn/end (interrupt with no final message), any reasoning part still open is closed so thinking does not spin forever. In 0.1.5 live timing comes from the `time` of `agent/assistant-stream` frames, and cold reads come from `block-start`/`block-end` of the embedded stream (see `assistantStreamTiming`).
- **agent preset locking**: dsh locks the agent preset after the session produces its first reply (409 `agent-preset-locked`). Tab/`/preset` only affect empty sessions; for a started session, when the prompt body carries an agent the bridge tries to switch, and on failure broadcasts an "Agent switch locked" notice once after the first message (deduplicated by session+agent).
- **Exit splash**: when the session has content, the official opencode binary prints its own logo and the `opencode -s <id>` resume command, which cannot be replaced; dsh-oc appends one line of dsh resume instructions below it (`DSH_OC_DISABLE_EXIT_NOTE=1` turns this off).
- **--mini**: start it with `opencode mini --server <bridge-url>`; prompts go through `POST /api/session/:id/prompt`; interrupting a streaming turn takes two Esc presses (the same as the official opencode 2.1.0 handler), and the full TUI also takes two.
- **mini e2e exit code**: the three C-c presses in `scripts/e2e-tui-mini.sh` may end through SIGINT and return 130; the script accepts 0/130 but must still assert the dsh-oc exit note.
- **Protocol probe**: `scripts/probe-opencode.mjs` automatically scans `router.ts` + `routes.ts` + `src/bridge/routes/` + `stubs.ts`; new route files must be picked up by the scan.
- **e2e mock LLM**: `tests/e2e/mock-llm.mjs` wraps `@deepseek-ai/dsh-llm-mock-server`; use `partial_disconnect` + `repeatLast` for long streams and `chunkDelayMs/chunkSize` for slow chunks (note that the `success` behavior has a fixed 0 delay). The mock started by env.mjs exits with the parent process, so manual tests must build their own inside the same process.
- **Watch for performance regressions**: any change that adds synchronous work to the list/history request path must be compared with `pnpm run perf -- --sessions 5000`; title backfilling once dragged cold reads to 10s+.

## Documentation entry points

- [docs/FEATURES.md](docs/FEATURES.md): capability matrix (auto-tracked).
- [docs/PROTOCOL.md](docs/PROTOCOL.md): protocol routes and SSE mapping.
- [docs/ROADMAP.md](docs/ROADMAP.md): next-stage requirements.
- [docs/CHANGELOG.md](docs/CHANGELOG.md): version changes.
- [docs/perf/results-2026-08-15.md](docs/perf/results-2026-08-15.md): performance data.

## Demo recording and publishing (README demo)

Aimed at users who have not used dsh-oc yet: use a real model with a meaningful task, not a mock or a meaningless task. The GitHub README does not execute `<script>`, so an asciinema player cannot be embedded directly; follow asciinema's official advice and generate a GIF with `agg` for `<img>` embedding, keeping the cast source in the repository.

Dependencies: `asciinema` (`pip install asciinema`) and `agg` (`gh release download -R asciinema/agg -p 'agg-<platform>'` or `cargo install agg`).

1. Install the fork (`dsh plugin --profile oc add 'github:shibadogcap/dsh-oc#feat-opencode-2-1'`), then launch `dsh --profile oc` manually once to warm the opencode binary and caches, so the real recording has no long first download/resolve wait.
2. Record in tmux / a PTY; `-i 2` compresses idle stretches to at most 2 seconds on playback: `asciinema rec --cols 110 --rows 30 -i 2 -t 'dsh-oc demo' -q docs/demo/dsh-oc-demo.cast`, then start `dsh --profile oc` and complete a meaningful short task with a real model (for example "run `pnpm test` and report the result"), then press Ctrl+C to exit and end the recording. Keep the real startup segment (shell prompt → typed command → logo) and do not trim the beginning; idle time is compressed by `-i` / `--idle-time-limit`.
3. Generate the GIF (for the README): `agg --font-family 'Hack,Noto Sans Mono CJK SC' --idle-time-limit 1 --speed 1.2 --fps-cap 15 --font-size 14 docs/demo/dsh-oc-demo.cast docs/demo/dsh-oc-demo.gif`
   - `Hack` is the monospace font and `Noto Sans Mono CJK SC` is the Chinese fallback; do not use the SVG approach, because size/font/error rendering all break easily.
   - Optional upload: `asciinema upload docs/demo/dsh-oc-demo.cast`; anonymous uploads expire after 7 days and must be claimed on asciinema.org; the main README embed is still the GIF.
