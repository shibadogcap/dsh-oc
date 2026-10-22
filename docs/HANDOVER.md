*English · [日本語](HANDOVER.ja.md)*

# HANDOVER — dsh-oc on dsh 0.2.1 / OpenCode 2.1.0

This file is for handing work over. It gives the next person the state, the decisions, and the
remaining work.

## 0. What the project is

`/data/dsh-ocplus/dsh-oc` is the OpenCode TUI front end for DeepSeek Harness (dsh).

- Front end: the official opencode CLI (`--server` mode). Rendering and keyboard only.
- Back end: dsh handles Agent / Session / tools / models / approvals / questions.
- Bridge: the `oc-bridge` plugin in dsh-oc serves OpenCode-compatible HTTP/SSE inside the dsh
  process, and `oc-tui` starts the official TUI as a child process.

## 1. Current goal and state reached

Goal: bring dsh-oc up to the latest dsh and OpenCode v2, and make it operable from
OpenChamber 2.5.

State reached (every item verified by measurement):

| Item | Status |
| --- | --- |
| Tracking dsh 0.2.1-rc.2 | Done. `package.json` / `cordis.patch.yml` / ABI diff handled |
| Tracking OpenCode 2.1.0 | Done. `@opencode/client@2.1.0`, official TUI binary 2.1.0 |
| Removal of the v1 HTTP layer | Done. Removed together with the `@opencode-ai/sdk` dependency |
| Coverage of all 138 official client routes | Done. `scripts/check-client-routes.mjs` reports `missing: 0` |
| Protocol probe | Done. `node scripts/probe-opencode.mjs` reports `PASSED (138/138 routes, 0 issues)` |
| v2 event vocabulary | Done. `session.text.*` / `session.tool.*` / `session.step.*` / `session.execution.*` / `session.inbox.*` / `permission.*` / `form.*` / `session.compaction.*` are streamed over SSE |
| Opening with `server.connected` | Done. 2.x clients reject the stream unless it opens with this frame |
| Official TUI connection | Done. Started with `opencode --server <url>` and confirmed `event stream connected` |
| Official TUI in operation | Done. `scripts/e2e-tui-boot.sh` PASSED (start → render → exit 0). Also confirmed that a typed prompt reaches dsh and that tool execution and result cards render |
| OpenChamber 2.5 connection | Done. `isOpenCodeReady: true`, `lastOpenCodeError: null` |
| OpenChamber's 22 startup calls | Done. `scripts/e2e-openchamber-bootstrap.mjs` PASS |
| OpenChamber reducer pass-through | Done. `scripts/e2e-openchamber-events.ts` PASS |
| Revert | Done. Three routes (stage / clear / commit) and three `session.revert.*` events implemented. The boundary is exclusive (the boundary message and every message after it disappear at commit), files roll back per turn immediately at stage, commit forks the dsh session and the opencode session id points at the fork, and the next prompt commits automatically. End-to-end verification against the real bridge is `scripts/e2e-revert-flow.mjs` (12 items PASS); regressions are in `tests/rewind/` (12 cases) and `tests/contract/revert.spec.ts` (8 cases) |
| Official Web UI served from the same source | Done. `src/bridge/web-ui.ts` extracts the Web UI from the opencode binary into `$DSH_HOME/opencode/web-ui/2.1.0/` and serves it itself. A `GET`/`HEAD` that matches no API route falls back to the SPA shell, and a missing file under `_assets/` is a 404. The official 2.1.0 client connection is confirmed; **operation in a real browser is not verified** (this environment has no real browser) |
| CORS policy | Done. The same allowlist as the official opencode server (`http://localhost:<port>`, `http://127.0.0.1:<port>`, `oc://renderer`, tauri origins, `*.opencode.ai`, and `DSH_OC_CORS`), with origin echo and `Access-Control-Allow-Credentials: true`. The `*` of the old implementation is removed (browsers rejected credentialed requests) |
| SSE heartbeat | Done. `: heartbeat\n\n` every 15 seconds (the same as the official server). Without it, the official client and the OpenChamber reader fall into reconnect loops |
| Bounded status snapshots | Done. `SESSION_STATUS_SNAPSHOT_LIMIT = 20` (running sessions plus the most recently touched). The old implementation streamed every session the bridge had ever seen |
| Project list | Done. `GET /api/project` returns the bridge's working directory (the official server derives it from the directory it serves) |
| Typecheck / build / tests | All pass (461 passed, 1 skipped / 31 files) |

## 2. Main decisions made this round

### 2.1 Removed the whole v1 layer

Deleted `/session`, `/config`, `/provider`, `/global/event`, `/vcs*`, `/permission`, `/question`,
`/path`, `/project/*` and the `@opencode-ai/sdk@1.18.18` dependency. `src/bridge/convert/wire.ts`
keeps the 1.18.18-shaped event projection as local types (the bundled TUI reads them).

### 2.2 Stream both vocabularies at once

1.18.18-shaped events (`message.part.updated` and so on) and the 2.x native vocabulary go out in
the same SSE batch. The OpenChamber reducer only interprets the 2.x vocabulary, but the bundled
TUI reads the 1.18.18 shapes.

### 2.3 The OpenChamber reducer is the specification

The vocabulary that `translateWireEvent` in
`/data/dsh-ocplus/openchamber/packages/ui/src/lib/opencode/events.ts` interprets is exactly the
contract OpenChamber needs. Reading that file settles what is missing.

### 2.4 Start the TUI with `opencode --server <url>`

The 2.x CLI removed the `attach` subcommand (it fails with `Help requested`). `--mini` takes the
form `opencode mini --server <url>`. dsh-oc consumes `--dir` itself to change the bridge cwd and
does not pass it to the CLI.

### 2.5 Route diffs in the official client are detected automatically

`scripts/check-client-routes.mjs` scans the client-side `path:` definitions and matches them
against the bridge. Client chunk file names contain hashes, so the implementation picks the file
with the most matches.

## 3. Verification steps (how to reproduce)

### 3.1 Static gates

```bash
cd /data/dsh-ocplus/dsh-oc
pnpm typecheck
pnpm build
pnpm test                                   # 461 passed, 1 skipped
node scripts/check-client-routes.mjs         # missing: 0
DSH_OC_OPENCODE_BIN=~/.dsh/opencode/packages/linux-x64/node_modules/@opencode/cli-linux-x64/bin/opencode \
  node scripts/probe-opencode.mjs            # PASSED (138/138 routes, 0 issues)
```

### 3.2 E2E against the real thing

```bash
# 1) start the dsh bridge on a fixed port (use an overlay that skips the TUI)
export PATH="/data/dsh-ocplus/.tools/node_modules/.bin:$PATH"
dsh plugin --profile oc add .               # link the local implementation into the profile
DSH_OC_PORT=41800 dsh --profile oc --patch /tmp/overlay.yml &

# 2) start OpenChamber 2.5.0 (official npm build) against the bridge
#    @openchamber/web@2.5.0 is installed in /data/dsh-ocplus/.tools/oc
OPENCODE_HOST=http://127.0.0.1:41800 OPENCODE_SKIP_START=true \
OPENCHAMBER_HOST=127.0.0.1 OPENCHAMBER_UI_PASSWORD=test \
  node /data/dsh-ocplus/.tools/oc/node_modules/@openchamber/web/bin/cli.js \
  serve --foreground --port 39100 --host 127.0.0.1 &

# 3) E2E
node scripts/e2e-openchamber-bootstrap.mjs --bridge http://127.0.0.1:41800
bun   scripts/e2e-openchamber-events.ts   --bridge http://127.0.0.1:41800
node scripts/e2e-revert-flow.mjs         --bridge http://127.0.0.1:41800
```

`scripts/e2e-revert-flow.mjs` checks one full revert cycle against a real bridge. It verifies 12
items from stage → clear → stage+commit → the next prompt (the boundary is exclusive, the earlier
message ids are kept, the session id does not change, and a second revert also works).

Contents of `/tmp/overlay.yml`:

```yaml
- id: webserver
  config:
    host: 127.0.0.1
    port: 0
- id: oc-tui
  disabled: true
```

### 3.3 Checking the official TUI connection

```bash
grep "event stream" ~/.dsh/opencode/data/opencode/log/opencode.log | tail -3
# success if "event stream connected" appears
```

### 3.4 Official TUI in operation (tmux)

```bash
bash scripts/e2e-tui-boot.sh     # start → render → exit 0. PASSED
```

`scripts/e2e-tui-boot.sh` passing (that is, the TUI starts, renders, and does not exit abnormally)
is the criterion for the official TUI working. That a typed prompt reaches dsh and that a tool call
runs and renders its result card can be checked from the pane output of
`scripts/e2e-tui-permission.sh` (`$ echo ...` → output →
`[Command finished with exit code 0]`).

The e2e harness had drifted from the dsh 0.1.5 baseline to 0.2.1-rc.2. The points fixed on
2026-10-20 are below (all inside `tests/e2e/` and `scripts/`):

| Location | Symptom | Fix |
| --- | --- | --- |
| `tests/e2e/common.sh` | `pnpm` fails with `tunnel error: Connection refused` | use the default proxy `127.0.0.1:14514` only when it actually responds |
| `tests/e2e/common.sh` | the TUI fails the appearance check | dsh starts as `node .../dsh/lib/bin.js --profile oc`, so match on `--profile oc`, not `dsh --profile` |
| `tests/e2e/common.sh` | the TUI input box does not appear in the pane | the TUI draws on the alternate screen, so drop dsh's `--print-logs` (the logs overlap the TUI) |
| `tests/e2e/env.mjs` | the mock LLM server install is rejected | 0.1.0-rc.6 requires `dsh-invariants@^0.1`, so bump to 0.2.1-rc.2 |
| `tests/e2e/env.mjs` | `dump-config: missing id agent-presets` | dsh 0.2 split it into `agent-preset-registry` and `agent-preset` |
| `scripts/e2e-tui-boot.sh` | the prompt is not visible after exit | add the powerline glyph (U+E0B0) and `user@host` to the prompt check |

### 3.5 Checking the official Web UI

The bridge serves the official opencode Web UI from the same source. Verification steps:

```bash
# 1) start on a fixed port (the overlay may skip the TUI)
DSH_OC_PORT=41800 dsh --profile oc --patch /tmp/overlay.yml &

# 2) check the startup log for "web UI served from ... (open http://127.0.0.1:41800/)"
#    if it is missing there is no opencode binary yet (the bridge does not install the binary)

# 3) look at the responses from a shell (and a browser)
curl -sS http://127.0.0.1:41800/ | head -3                      # the SPA shell
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:41800/_assets/nope.js  # 404
curl -sS http://127.0.0.1:41800/api/info | head -c 120          # the API as usual
```

To open it in a real browser, go to `http://127.0.0.1:41800/` (or the address set by
`DSH_OC_HOST` / `DSH_OC_PORT`). The UI calls the API against `location.origin`, so neither CORS nor
login is needed.

To check HTTP call patterns without a browser, set `DSH_OC_HTTP_LOG=1`. One line per request goes
to stderr as soon as it arrives:

```bash
DSH_OC_HTTP_LOG=1 DSH_OC_PORT=41800 dsh --profile oc --patch /tmp/overlay.yml
# [bridge/http] GET /api/info
# [bridge/http] GET /api/event
```

### 3.6 Checking stream connectivity

The official OpenCode 2.1.0 client (Node, not a browser) can subscribe to the bridge's
`/api/event` and receives `server.connected` in about 40 ms. That confirms the bridge-side stream
is correct. Browser-side checks are blocked by the constraint in 4.2.

## 4. Open known failures (not fixable on the dsh-oc side)

### 4.1 OpenChamber's unauthenticated 401 is text/plain

`respondUnauthorized` in `packages/web/server/lib/ui-auth/ui-auth.js` decides JSON with
`req.path?.startsWith('/api')`, but the auth guard is mounted as `app.use('/api', ...)`, so `/api`
is stripped inside the mount and the check never matches. The OpenCode v2 client looks at the
content type first, so it becomes `UnsupportedContentType`.

Workaround: authenticate first with `POST /auth/session` (`scripts/e2e-openchamber.mjs` works
around it by calling with `credentials: 'same-origin'` from inside the page).

### 4.2 The Obscura browser cannot deliver a streaming HTTP response to `fetch()`

**The conclusion changed in the re-investigation on 2026-10-20.** This section used to say that
Obscura's V8 engine does not mount OpenChamber 2.5's React; that conclusion was wrong. The real
cause is that the Obscura browser does not deliver a streaming HTTP response to `fetch()`. The
headers that promise a chunked response never resolve.

What was confirmed:

- Both the OpenChamber 2.5 app and the official OpenCode Web app stall at `/api/event`.
- A plain Node HTTP server that writes the same headers as the official opencode server
  (`text/event-stream`, no content-length) shows the same symptom. Responses that complete
  (`GET /api/info` and so on) arrive.
- The official OpenCode 2.1.0 client (Node, not a browser) subscribes to the bridge's `/api/event`
  and receives `server.connected` in about 40 ms. The bridge-side stream is correct.

Browser-level E2E (a Web UI that uses streaming) therefore cannot run with the Obscura available
in this environment. This is a constraint of the local tooling, not of dsh-oc or of OpenChamber.
dsh-oc's API path (`scripts/e2e-openchamber-bootstrap.mjs`) and event path
(`scripts/e2e-openchamber-events.ts`) pass in measurement.

Reference: the earlier control experiment (connecting directly to a real OpenCode 2.1.0 server gave
the same result) was as follows.

```bash
# without OPENCODE_HOST: OpenChamber starts its own OpenCode 2.1.0
nohup /tmp/start-oc-250-own2.sh > /tmp/oc-250-own3.log 2>&1 &   # port 39300
node scripts/e2e-openchamber.mjs --chamber http://127.0.0.1:39300 \
     --out /tmp/dsh-oc-e2e-control.txt
```

The result is exactly the same as with the dsh-oc connection:

```
login: 200 {"authenticated":true}
navigated
settled
ui state: {"evaluate":"timeout"}
api calls: 0
console errors: 0
error: page.screenshot: Timeout 30000ms exceeded.
```

Control against a real OpenCode 2.1.0 server:

```bash
nohup /tmp/start-oc-250-own.sh > /tmp/oc-250-own.log 2>&1 &   # without OPENCODE_HOST
node scripts/e2e-openchamber.mjs --chamber http://127.0.0.1:39200
# → the same "RENDERER-LIMITED"
```

## 5. Remaining work

In priority order.

### 5.1 New OpenCode 2.1.0 events (low)

`session.archived` / `session.unarchived` were added in 2.1.0. dsh has no concept of archiving, so
the bridge does not emit them. If OpenChamber starts offering an "archive session" action, they
become necessary at that point.

### 5.2 File rollback for revert (done)

`FileSnapshots` in `src/rewind/index.ts` holds per-turn copy-on-write snapshots and groups "which
turn changed which files" from dsh's `session/event` (`turn/start`). `revert/stage` takes the diff
of the files in turns after the turn the boundary message belongs to (`filesAfter`, computed
before rolling back so the diff is not empty) and restores them (`restoreFilesAfter`). When the
boundary message is a user prompt, that turn counts as well (`includeTurn: true`, because the
assistant reply comes after the prompt); when it is an assistant reply, this turn is not rolled
back (`includeTurn: false`). `revert/commit` keeps the restored content (`commitRestore`), and
`revert/clear` puts it back (`undoRestore`). Regressions are pinned in
`tests/rewind/rewind.spec.ts` (12 cases) and `tests/contract/revert.spec.ts` (8 cases). A real
e2e that writes a file while the profile is running and then reverts it is not scripted yet; add
the regression to `scripts/e2e-api.sh` if needed.

### 5.3 Boundary resolution and commit for `session.revert.*` (done)

The boundary is **exclusive**, the same as the OpenCode 2.1.0 server. The message named in
`revert/stage` and every message after it are dropped at commit. dsh's `sessionController.fork`
copies the prefix that **includes** `atSeq`, so `R.atSeqBeforeMessage(ctx, id, messageID)` shifts
the cut point to one event before the boundary message. `before` on
`POST /api/session/:id/fork` uses the same cut computation.

Commit lives in `R.commitStagedRevert`. It forks the dsh session at the boundary and **rebinds the
opencode session id to the fork** with `InteractionState.setSessionAlias`. Because of that alias,

- later dsh calls are rewritten to the fork by `resolveSessionPayload` in `rpc()`
- the session list publishes the fork under the original opencode id, and the replaced session
  disappears
- `GET /api/session/:id` and `GET /api/session/:id/message` read the fork's summary and history
- SSE events for the fork are mapped back to the original opencode id by `mapEventSessionId`
- the model, agent preset, title, and message id mappings are inherited by the fork through
  `inheritSessionState` (the message ids the client sees do not change)

As in OpenCode, when the next prompt arrives the staged revert is committed first
(`POST /api/session/:id/prompt` calls `commitStagedRevert`). Verification is in
`tests/contract/revert.spec.ts` (8 cases).

### 5.4 Known revert limitations (medium)

- dsh cannot express an empty fork (`atSeq` is a non-negative integer). A boundary before the first
  message returns `400 cannot cut before the first message`.
- The bridge's file diff is one coarse hunk covering the first and last changed lines, the same
  shape as the bridge's own file-change diff (not an LCS diff).
- On the second and later reverts the file snapshots stay bound to the fork's dsh session id while
  the bridge looks them up by the opencode id, so the set of files to roll back can be empty.
  **Fixed on 2026-10-20**: `RewindServiceImpl.fork` resolves the alias before forking, and the
  bridge also looks up the file list with the id from `resolveSessionId`.
  `scripts/e2e-revert-flow.mjs` confirms against a real bridge that a second revert works.

### 5.5 Browser E2E (not possible with the local tooling)

Browser-level E2E (a Web UI that uses streaming) cannot run with the Obscura available in this
environment. The Obscura browser cannot deliver a streaming HTTP response to `fetch()`
(section 4.2), so it stalls at `/api/event`. Assume either an environment with a real browser or
that no other automation method is available, and verify with the following.

- API path: `scripts/e2e-openchamber-bootstrap.mjs`
- Event path: `scripts/e2e-openchamber-events.ts`
- Stream connectivity: the official OpenCode 2.1.0 client (Node) subscribes to `/api/event` and
  receives `server.connected` (section 3.6)
- Call patterns: `DSH_OC_HTTP_LOG=1` (section 3.5)

### 5.6 Calling the bash tool from the TUI in a restored session never returns (unresolved, medium)

**The TUI itself is usable** (section 3.4). Only this combination leaves a tool call without a
result:

- connect the official TUI to a session restored across dsh processes, and
- call the **bash** tool in that session: `tool/call` stays in the durable log but `tool/result`
  never arrives (the TUI stays spinning).

Triaged (2026-10-20):

| Condition | Result |
| --- | --- |
| restored session + TUI + bash | no result |
| restored session + API only + bash | works |
| restored session + TUI + non-bash tools such as write | works |
| new session + TUI + bash | works |

It is not waiting for approval (`GET /api/permission/request` is empty and no dialog appears). The
restore path of the persistent shell in dsh's bash tool is the strong suspect, and whether the
problem is on the dsh side or the bridge side is not yet separated. dsh's `dsh-bash-sandbox` and
the session state at restore time (restoring the shell reference) are where to start.

### 5.7 Cleaning up v1 remnants (low)

The auto-tracking column in `docs/FEATURES.md` and the golden traces in
`tests/fixtures/golden/*.1.18.18.sse.jsonl` are still in v1 shapes. The golden traces are kept on
purpose as the 1.18.18-shape regression baseline, so do not delete them. Regenerate
`docs/FEATURES.md` with `pnpm run features:update` and commit it.

### 5.8 `/openapi.json` (low)

OpenCode 2.x's `opencode api <op>` subcommand reads the server's `/openapi.json`. The bridge does
not implement it (501). Neither OpenChamber nor the TUI needs this subcommand, so the priority is
low. Implementing it would require matching the official server's operationId scheme
(`session.list` style), but the official server sits behind authentication, so it cannot be
recorded by measurement.

## 6. Main files added or changed this round

### New

| File | Role |
| --- | --- |
| `src/bridge/routes/v2-stubs.ts` | schema-valid empty responses for every route the official client calls |
| `src/bridge/routes/v2-client-compat.ts` | 2.x-specific extra routes (pty, integration, rpc, and so on) |
| `src/bridge/routes/v2-shapes.ts` | shared placeholder builders |
| `src/bridge/routes/session-v2-extra.ts` | auxiliary session routes (command/synthetic/shell/move/inbox/form/revert and so on) |
| `src/bridge/web-ui.ts` | AppArchive extraction for the official opencode Web UI and static file serving |
| `src/bridge/convert/wire.ts` | local projection types for the 1.18.18 shapes |
| `src/rewind/index.ts` | revert plugin (fork + file copy-on-write) |
| `scripts/check-client-routes.mjs` | matches the client route table against the bridge |
| `scripts/extract-opencode-web-ui.mjs` | offline extraction of the Web UI assets from the opencode binary |
| `scripts/e2e-openchamber-bootstrap.mjs` | E2E for OpenChamber's 22 startup calls |
| `scripts/e2e-openchamber-events.ts` | E2E that pushes events through OpenChamber's own reducer |
| `scripts/e2e-revert-flow.mjs` | end-to-end revert E2E (stage / clear / commit / next prompt) |
| `scripts/e2e-openchamber.mjs` | browser E2E (through Obscura) |
| `tests/contract/` | contract tests (client / events / routes) |
| `tests/e2e/` | E2E tests (openchamber / events) |
| `tests/rewind/` | revert tests |
| `tests/contract/revert.spec.ts` | revert contract test (exclusive boundary, 3 events, session id preserved) |
| `docs/COMPAT.md` | compatibility matrix and upgrade procedure (**the upgrade steps are here**) |
| `docs/OPENCHAMBER.md` | OpenChamber 2.5 connection and verification steps |
| `docs/ACCEPTANCE.md` | acceptance criteria |

### Deleted

| File | Reason |
| --- | --- |
| `src/bridge/routes/session-v1.ts` | all v1 session routes removed |
| `src/bridge/routes/permission.ts` | only registered in v1 |
| `src/bridge/routes/vcs.ts` | only registered in v1 |
| `opencode-assets.json` | 2.x gets it from the npm platform package |

### Changed

- `package.json`: `@opencode/client` 2.1.0, `@opencode-ai/sdk` removed, `engines.dsh` added, and the
  `e2e:openchamber` / `e2e:openchamber-events` / `check:client-routes` scripts added
- `cordis.patch.yml`: moved to `agent-preset-registry` + `agent-preset`, added the controller group
  and `workspace-changes`, `mcp-client` temporarily disabled because the 0.2.1 API does not match,
  added `oc-rewind`
- `src/tui/index.ts`: starts `opencode --server <url>`, `--mini` maps to the `mini` subcommand,
  `--dir` is consumed and not forwarded
- `src/bridge/router.ts`: emits `server.connected` at stream open, adds the
  `PATCH /api/permission/saved/:id` route, the `webUiDir` option and `serveWebUi`, the status
  snapshot cap (`SESSION_STATUS_SNAPSHOT_LIMIT`), and `projectInfo`
- `src/bridge/http.ts`: the same CORS policy as the official server (origin echo + credentials),
  fallback to the Web UI for unmatched routes, request tracing with `DSH_OC_HTTP_LOG=1`
- `src/bridge/sse.ts`: a `: heartbeat\n\n` comment frame every 15 seconds
- `src/bridge/index.ts`: `resolveWebUi()` (`DSH_OC_WEB_UI` → extracted directory), reading
  `DSH_OC_CORS`
- `src/bridge/routes/v2-stubs.ts`: `GET /api/project`, `GET`/`PATCH /api/project/:projectID`
- `src/bridge/events.ts` / `events-util.ts`: added the 2.x vocabulary events, added the durable
  envelope
- `src/bridge/state.ts`: revert boundary, updating saved permissions
- `.github/workflows/{ci,e2e}.yml`: fake binary 2.1.0, the official binary comes from the npm
  platform package

## 7. Environment notes

- dsh itself is in `/data/dsh-ocplus/.tools` as `@deepseek-ai/dsh@0.2.1-rc.2`. Put it on `PATH` to
  use it.
- The official opencode binary is at
  `~/.dsh/opencode/packages/linux-x64/node_modules/@opencode/cli-linux-x64/bin/opencode` (2.1.0).
  The `~/.opencode/bin/opencode` on `PATH` is still 2.0.32, so the resolver skips it for a version
  mismatch and picks the npm package.
- The official npm build of OpenChamber 2.5.0 is in `/data/dsh-ocplus/.tools/oc`.
- The working directory is `/data/dsh-ocplus` (the NVMe side, not `/`).
- The dsh profile is `~/.dsh/profiles/oc`. `dsh plugin --profile oc add .` links the local
  implementation.

## 8. Notes for handover

1. Include `lib/` in commits (a GitHub direct install uses `lib/`). After a change, run
   `pnpm build` and commit `lib/` along with it.
2. The self-test gate in `AGENTS.md` includes `pnpm run probe`. The probe baseline
   `tests/fixtures/opencode/routes.json` is re-recorded from the client.
3. Treat the official TUI as a vendor ABI. Update versions with the procedure in
   `docs/COMPAT.md`, and lock only after checking the semantic diff of "golden HTTP/SSE trace +
   real TUI replay".
4. `docs/FEATURES.md` is auto-tracked. Commit after `pnpm run features:update`.
5. When following OpenChamber API changes, two files matter:
   `packages/ui/src/lib/opencode/client.ts` (the call surface) and
   `packages/ui/src/lib/opencode/events.ts` (the vocabulary the reducer reads).
6. The official Web UI is an asset bundled in the opencode binary, and the bridge does not install
   the binary (`resolveWebUi()` resolves with `installNpmPackage: false`). The extraction target is
   `$DSH_HOME/opencode/web-ui/<version>/`, so upgrading opencode changes that directory too.
   Verify the Web UI in an environment with a real browser (section 4.2).
