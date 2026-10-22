*English · [日本語](FEATURES.ja.md) · [中文](FEATURES.zh.md)*

# dsh-oc feature support matrix

> Status legend: ✅ supported; 🟡 partial support / limited; ❌ not implemented or stub only.
> This file is the entry point for feature status; route and protocol details are in [PROTOCOL.md](PROTOCOL.md).
> Run `pnpm run features:update` to refresh the "auto-tracked" section at the end of the file; the manual status matrix is kept.

## Current state and next phase

> This table is the factual entry point for user-visible capabilities. Supported capabilities are in the matrix below, and unreleased work is recorded under
> `Unreleased` in [CHANGELOG.md](CHANGELOG.md). The upcoming plan is in [ROADMAP.md](ROADMAP.md).

## 1. Models

| Feature | Status | Route / implementation | How it is verified | Last updated |
|---|---|---|---|---|
| Provider / model catalog display | ✅ | `GET /api/provider`, `GET /api/model`, `src/bridge/convert/model.ts` | `tests/convert/model.spec.ts`, `scripts/e2e-api.sh` | `f30b156` |
| Default build agent carries the available models | ✅ | `GET /api/agent`, `src/bridge/router.ts` | `tests/bridge-router.spec.ts` | `f30b156` |
| Model selector writes back to dsh (`/api/session/:id/model`) | ✅ | `POST /api/session/:sessionID/model` (body carries model) | `tests/bridge-router.spec.ts`, `e2e-api.sh` | this commit |
| Reasoning effort / variant display and switching | ✅ | `Model.variants`, `ModelV2Info.variants`, session model `variant` | `tests/convert/model.spec.ts`, `tests/bridge-router.spec.ts`, `scripts/e2e-api.sh`, TUI `ctrl+t` | this commit |
| dsh agent preset display and switching (minimal and others) | ✅ | `GET /api/agent`, `POST /api/session/:sessionID/agent`, `POST /api/session/:id/command` `/preset` | `tests/bridge-router.spec.ts`; an isolated profile without minimal only has build | this commit |
| Tab/`/preset` agent switch takes effect with the prompt | ✅ | the `agent` field in the prompt body is applied to the session; when dsh has locked a session that already produced a reply (409), one lock notice appears after the first submit; the final switch card carries the completion time and the actual model/variant and does not stay QUEUED | `tests/bridge-router.spec.ts`, real TUI and manual user verification | `v0.2.0-rc.2` |
| Model / provider error mapping | ✅ | `src/bridge/errors.ts`, `src/bridge/rpc.ts` | `tests/bridge-router.spec.ts` (404/409/400/501) | `f30b156` |

## 2. Sessions

| Feature | Status | Route / implementation | How it is verified | Last updated |
|---|---|---|---|---|
| Session list / status | ✅ | `GET /api/session`, `POST /api/session/:id/wait` | `tests/bridge-router.spec.ts`, `e2e-api.sh` | `f30b156` |
| Session list title fallback | ✅ | persisted title → project directory basename → session id (matches the dsh client display logic) | `tests/convert/session.spec.ts` | this commit |
| Real title backfill in the session list | ✅ | dsh `session.list` carries no title projection; the bridge backfills the history tail projection per session and caches it, so the list shows real titles (full synchronous read for ≤40, background backfill of 24 for large lists, never blocking the list) | `tests/bridge-router.spec.ts`, `scripts/e2e-tui-turn.sh` | this commit |
| Session search (v2 `?search=`) with limit/directory filtering | ✅ | `src/bridge/router.ts` `/api/session` through `session.search` | `tests/bridge-router.spec.ts` | this commit |
| Session list pagination (v2 `cursor` next/previous + order) | ✅ | `src/bridge/router.ts` `/api/session` offset cursor | `tests/bridge-router.spec.ts` | this commit |
| New / rename / history / messages | ✅ | `POST /api/session`, `PATCH /api/session/:id`, `GET /api/session/:id/message`, etc. | `tests/bridge-router.spec.ts`, `e2e-tui-turn.sh` | `f30b156` |
| Prompt | ✅ | `POST /api/session/:sessionID/prompt` (body `text` or `parts`) | `e2e-api.sh`, `e2e-tui-turn.sh` | `f30b156` |
| `!` Shell mode (user command) | ✅ | official TUI `!` → `POST /api/session/:id/shell`; takes idle exclusively through Agent `runMaintenance`, then starts an OS shell, maps user/assistant/tool cards, and injects the user's manual command and output into the next model prompt through a non-waking `Agent.inject()` | `tests/bridge-router.spec.ts`, `scripts/e2e-tui-shell.sh`, manual TUI use | `v0.2.0-rc.2` |
| `--mini` prompt submission | ✅ | `POST /api/session/:sessionID/prompt` (slash/model/agent handling) | `tests/bridge-router.spec.ts`, `e2e-tui-mini.sh` | this commit |
| Abort / cancel | ✅ | `POST /api/session/:id/interrupt` | `e2e-api.sh` | `f30b156` |
| Fork (`parentID`) | ✅ | `POST /api/session/:id/fork`, messageID→atSeq | `tests/bridge-router.spec.ts`, `e2e-api.sh` | this commit |
| Session revert | ✅ | `POST /api/session/:sessionID/revert/stage`, `DELETE /api/session/:sessionID/revert`, `POST /api/session/:sessionID/revert/commit`; the boundary is exclusive (the boundary message and everything after it are dropped together); stage rolls back the files of the affected turns and reports the diff; commit forks the dsh session at the cut point and the opencode session id follows the fork (alias); the next prompt commits automatically; the session record carries a `revert` field; SSE `session.revert.staged` / `.cleared` / `.committed` | `tests/contract/revert.spec.ts`, `tests/rewind/rewind.spec.ts` | this commit |
| Known limitations of session revert | 🟡 | dsh cannot express an empty fork (it returns 400 `cannot cut before the first message` when the cut point is before the first message); the file diff is one coarse hunk between the first and last changed lines (the same shape as the bridge's own file-change diff), not a full LCS diff | `docs/PROTOCOL.md` section 4.3 | this commit |
| Todo projection | ✅ | SSE `todo.updated` (2.x has no separate todo GET route) | `tests/convert/todo.spec.ts`, `tests/bridge-router.spec.ts` | `f30b156` |
| Diff / produced-files / Modified Files | ✅ | `GET /api/session/:id/diff`, `session.diff` + Snapshot/Patch part | `tests/bridge-router.spec.ts`, `e2e-tui-tools.sh` | this commit |
| SSE session/message events | ✅ | `GET /api/event` (first frame `server.connected`), `src/bridge/events.ts` | `tests/bridge-events.spec.ts`, `e2e-api.sh`, `e2e-tui-stream.sh` | `f30b156` |
| SSE text deltas duplicated in pairs | 🟡 | known behavior: dsh sends `assistant/chunk` and packed `text-chunks` for the same text at the same time, and a new mux subscription replays them; bridge deltas may therefore be duplicated in pairs, while the TUI renders the full text from `message.updated` and shows no duplication in practice | `docs/PROTOCOL.md` | this commit |
| Agent/stream error → `session.error` | ✅ | `stream/error` and `host/agent-error` mapping | `tests/bridge-events.spec.ts` | this commit |
| SSE mux/host transient error auto-reconnect (exponential backoff) | ✅ | `src/bridge/router.ts` `startSse` resubscribe (starts at 250ms by default, at most 3 attempts) | `tests/bridge-events.spec.ts` | this commit |
| Reconnect approval/question replay dedup | ✅ | `MuxEventTranslator` `replayGuard` (per SSE connection) | `tests/bridge-events.spec.ts` | this commit |
| Todo/goal projection state kept after reconnect | ✅ | `sharedState` shared across translator rebuilds | `tests/bridge-events.spec.ts` | this commit |

## 3. Tools

| Feature | Status | Route / implementation | How it is verified | Last updated |
|---|---|---|---|---|
| Tool call / result four-state mapping | ✅ | `src/bridge/convert/tool.ts`, `src/bridge/events.ts` | `tests/convert/tool.spec.ts`, `e2e-tui-turn.sh` | `f30b156` |
| Tool argument streaming (`tool-call-delta` → input.started/delta/ended + v1 ToolPart increments) | ✅ | `src/bridge/events.ts` `startToolInput`/`queueToolDelta`/`flushToolDelta` | `tests/bridge-events.spec.ts`, `scripts/e2e-api.sh` | this commit |
| Queued prompt visibility (`session/queue` initialization + `agent/inbox/spliced` increments → QUEUED message) | ✅ | `src/bridge/events.ts` `queuedMessageEvents`, `src/bridge/state.ts` inbox projection | `tests/bridge-events.spec.ts`, `scripts/e2e-tui-queue.sh` | this commit |
| v2 tool lifecycle (called/progress/success/failed) | ✅ | `src/bridge/events.ts` `endToolInput`/`completeToolInputImmediately` | `tests/bridge-events.spec.ts`, `scripts/e2e-api.sh` | this commit |
| High-frequency chunk throttling/batching | ✅ | `MuxEventTranslator` `toolFlushMs` + merged pending deltas | `tests/bridge-events.spec.ts` (fake timer) | this commit |
| `!` shell live output progress | 🟡 | the shell path publishes retained stdout/stderr only after the child process exits; the cap is 1MiB per stream, and output beyond it keeps draining and is marked truncated | `docs/PROTOCOL.md`, `tests/bridge-router.spec.ts` | `v0.2.0-rc.2` |
| Tool execution is done by the dsh backend | ✅ | model tools go through the dsh tool registry; `!` shell runs an OS child process authorized by the user and managed by Agent maintenance | `e2e-api.sh` (bash tool), `tests/bridge-router.spec.ts` | `v0.2.0-rc.2` |
| read/write/edit file change display | ✅ | tool result → ToolPart metadata/diff + `session.diff` + Modified Files | `tests/convert/tool.spec.ts`, `e2e-tui-tools.sh` | this commit |
| dsh multi edit-mode mapping (view/create/str_replace/insert/undo_edit) | ✅ | `src/bridge/convert/tool.ts` maps them to read/edit cards and keeps the mode | `tests/convert/tool.spec.ts`, `e2e-tui-tools.sh` | this commit |
| Text attachment / file part | ✅ | `src/bridge/router.ts` `filePartToContent`: data URL text and images, local files inside cwd; files outside cwd and binaries get 400 | `tests/bridge-router.spec.ts`, `scripts/e2e-api.sh` | this commit |
| MCP servers (configured as `mcp-client` plugins in the dsh profile) | ✅ | `/api/mcp` lists the servers whose tools are registered as `mcp__<server>__<tool>` | `tests/bridge-mcp.spec.ts` | — |
| LSP / formatter and other peripheral tools | ❌ | `src/bridge/stubs.ts` returns schema-valid empty data | `e2e-api.sh` route matrix | `f30b156` |

## 4. Permissions

| Feature | Status | Route / implementation | How it is verified | Last updated |
|---|---|---|---|---|
| Permission ask / once / reject | ✅ | `GET /api/permission/request`, `POST /api/session/{id}/permission/{rid}/reply`, `POST /api/permission/{rid}/reply` | `tests/convert/permission.spec.ts`, `e2e-api.sh` | `f30b156` |
| "Always" remembered within the session (same session and tool auto-approved) | ✅ | `src/bridge/state.ts` `savedPermissions` + SSE auto approve | `tests/bridge-events.spec.ts`, `e2e-api.sh` | this commit |
| Saved permissions query/delete | ✅ | `GET /api/permission/saved` + `DELETE /api/permission/saved/{id}` (`sessionID:toolName`); a grant does not leak across sessions | `tests/bridge-events.spec.ts`, `scripts/e2e-api-permission.sh` | this commit |
| SDK v2 permission/question request aliases | ✅ | `GET /api/permission/request`, `GET /api/question/request`, `GET /api/session/{id}/permission/{rid}` | `tests/bridge-router.spec.ts`, `scripts/e2e-api-permission.sh` | this commit |
| TUI permission/question keyboard interaction | ✅ | Down moves the option highlight, question Esc cancels, permission Esc=reject (standard rejects directly, mini shows a confirmation layer first) | `scripts/e2e-tui-permission.sh`, `scripts/e2e-tui-permission-ext.sh` | this commit |

## 5. Subagents

| Feature | Status | Route / implementation | How it is verified | Last updated |
|---|---|---|---|---|
| Main agent (build) display | ✅ | `GET /api/agent`, `src/bridge/router.ts` | `tests/bridge-router.spec.ts` | `f30b156` |
| Background subagents | ✅ | `GET /experimental/capabilities` returns `{ backgroundSubagents: true }`; `POST /experimental/session/{id}/background` succeeds as a no-op (dsh sessions stay on the server side and `subagent` is background by default) | `e2e-api.sh`, `tests/bridge-router.spec.ts` | this commit |
| Subagent session tree / parent-child rendering | ✅ | `Session.parentID`, child cwd/parent inheritance, child history reuse | `tests/convert/session.spec.ts`, `e2e-api.sh` fork lineage | this commit |
| Native OpenCode Task subagent card | ✅ | dsh `subagent*` → `tool: task`, child `sessionId` metadata and parent lineage preserved | `tests/bridge-events.spec.ts`, `tests/bridge-router.spec.ts`, `scripts/e2e-tui-subagent.sh` | `v0.2.0-rc.1` |

## 6. Commands

| Feature | Status | Route / implementation | How it is verified | Last updated |
|---|---|---|---|---|
| Command list | ✅ | `GET /api/command` registers `/preset` `/goal` `/help` | `e2e-api.sh`, `tests/bridge-router.spec.ts` | this commit |
| `/goal` create/view/switch | ✅ | `src/bridge/router.ts` `runGoalCommand` + dsh command registry | `tests/bridge-router.spec.ts`, `scripts/e2e-api-goal.sh` | this commit |
| `/goal` lifecycle (complete/pause/resume/clear) | ✅ | `complete` goes through the `goal.complete` RPC, the rest through the registry | `tests/bridge-router.spec.ts`, `scripts/e2e-api-goal.sh` | this commit |
| TUI `/help` capability summary | ✅ | `src/help.ts` `ocHelp` + `runHelpCommand` (does not trigger a model turn) | `tests/bridge-router.spec.ts`, `e2e-api.sh` | this commit |
| TUI `/help` pane e2e | ✅ | `scripts/e2e-tui-command.sh` types `/help` and asserts the summary is visible | `bash scripts/e2e-tui-command.sh` | this commit |
| `/compact` / summarize | ✅ | `POST /api/session/:id/compact` | `e2e-api.sh`, `tests/bridge-router.spec.ts` | this commit |
| Skills catalog | ✅ | `GET /api/skill` through dsh `skill.list` (matches sessions by directory; returns `[]` with no session) | `tests/bridge-router.spec.ts`, `e2e-api.sh` | this commit |
| Skills slash commands | ✅ | `/command` exposes skill names; the command route forwards to the `/name` path of `session.prompt` | `tests/bridge-router.spec.ts` | this commit |
| Skill slash command TUI e2e | ✅ | `scripts/e2e-tui-skill.sh` (`DSH_OC_E2E_FAKE_SKILLS` injection + real keyboard input) | `bash scripts/e2e-tui-skill.sh` | this commit |
| References / integrations | ❌ | `GET /api/reference`, `GET /api/integration`, etc. return schema-valid `[]` | `e2e-api.sh` | `f30b156` |

## 7. TUI

| Feature | Status | Route / implementation | How it is verified | Last updated |
|---|---|---|---|---|
| `opencode --server` start/exit/signal forwarding | ✅ | `src/tui/index.ts` `startOpenCodeTui` (`--mini` → `opencode mini --server`) | `tests/tui/index.spec.ts`, `e2e-tui-boot.sh` | `f30b156` |
| TUI argument filtering (`--session/--dir/--mini/--print-logs/...`) | ✅ | `src/tui/index.ts` `filterSupportedArgs`; `--dir` is also written to the bridge cwd | `tests/tui/index.spec.ts`, `scripts/e2e-tui-dir.sh` | this commit |
| `--dir` path validation | ✅ | `resolveTuiDir`: an explicit error when the path does not exist or is not a directory | `tests/tui/index.spec.ts` | this commit |
| Data isolation (config/data/state/cache under `$DSH_HOME/opencode`) | ✅ | `src/tui/index.ts` `buildChildEnv` | `tests/tui/index.spec.ts` | `f30b156` |
| Message timestamps on by default | ✅ | `DSH_OC_TUI_TIMESTAMPS=1` → `kv.json` `timestamps: show` + `tui.json` keybind | `tests/tui/index.spec.ts`, `scripts/e2e-tui-timestamps.sh` | this commit |
| Timestamp toggle at runtime | ✅ | `tui.json` binds `session_toggle_timestamps` / `messages_toggle_timestamps` to `ctrl+shift+t`, and `/timestamps` also works | manual TUI verification | this commit |
| Binary version check (`--version` exact match + error on an explicit override) | ✅ | `src/tui/binary.ts` `parseOpenCodeVersion`/`verifyOpenCodeVersion` | `tests/tui/binary.spec.ts`, `scripts/e2e-tui-version-lock.sh` | this commit |
| Auto-update / hot update disabled | ✅ | `OPENCODE_DISABLE_AUTOUPDATE=1` + isolated config `autoupdate: false` | `tests/tui/index.spec.ts`, `scripts/e2e-tui-offline.sh` | this commit |
| Background network activity disabled (models fetch / LSP download) | ✅ | `OPENCODE_DISABLE_MODELS_FETCH=1`, `OPENCODE_DISABLE_LSP_DOWNLOAD=1` | `tests/tui/index.spec.ts` | this commit |
| `dsh --profile oc --help` capability summary | ✅ | `src/tui/index.ts` `ocHelp`/`helpRequested` | `tests/tui/index.spec.ts`, `scripts/e2e-tui-help.sh` | this commit |
| DSH OC brand startup logo (replaces the OpenCode ASCII art) | ✅ | `tui-branding/` TUI plugin (generated by figlet, `scripts/generate-tui-branding-art.mjs`) + `prepareOpenCodeTuiState` injects `tui.json` | `tests/tui/branding-art.spec.ts`, `tests/tui/index.spec.ts`, `scripts/e2e-tui-brand.sh` | this commit |

## 8. Distribution

| Feature | Status | Route / implementation | How it is verified | Last updated |
|---|---|---|---|---|
| Multi-arch platform matrix (linux/darwin/windows × x64/arm64 + musl/baseline) | ✅ | `src/tui/platform.ts` | `tests/tui/platform.spec.ts`, `tests/scaffold.spec.ts` | this commit |
| Official npm platform package first (`@opencode/cli-<platform>-<arch>[-baseline][-musl]@2.1.0`) | ✅ | `src/tui/binary.ts` `npmPackage*`, `$DSH_HOME/opencode/packages/<key>` | `tests/tui/binary.spec.ts` (candidate order/fallback) | this commit |
| GitHub Release fallback with a per-platform independent `sha256` check | ❌ | the 2.1.0 migration removed `opencode-assets.json` and that fallback, and now takes the binary only from the npm platform package | `tests/tui/download.spec.ts`, `tests/scaffold.spec.ts` | this commit |
| Proxy / mirror | ✅ | `src/tui/download.ts` `resolveAssetUrl` | `tests/tui/download.spec.ts` | `f30b156` |

## 9. Tests

| Feature | Status | Implementation | How it is verified | Last updated |
|---|---|---|---|---|
| Unit/conversion/bridge/distribution tests | ✅ | `tests/**/*.spec.ts` | `pnpm test` | `f30b156` |
| API e2e route matrix + permission flow | ✅ | `scripts/e2e-api.sh` | `bash scripts/e2e-api.sh` | `f30b156` |
| TUI boot / turn / stream e2e | ✅ | `scripts/e2e-tui-boot.sh`, `scripts/e2e-tui-turn.sh`, `scripts/e2e-tui-stream.sh` | the corresponding script prints `PASSED` | `f30b156` |
| TUI timestamp e2e | ✅ | `scripts/e2e-tui-timestamps.sh` | `bash scripts/e2e-tui-timestamps.sh` | this commit |
| Offline start / version lock e2e | ✅ | `scripts/e2e-tui-offline.sh`, `scripts/e2e-tui-version-lock.sh` | the corresponding script prints `PASSED` | this commit |
| Help e2e | ✅ | `scripts/e2e-tui-help.sh` | `bash scripts/e2e-tui-help.sh` | this commit |
| Brand logo e2e | ✅ | `scripts/e2e-tui-brand.sh` | `bash scripts/e2e-tui-brand.sh` | this commit |
| `--dir` TUI e2e | ✅ | `scripts/e2e-tui-dir.sh` | `bash scripts/e2e-tui-dir.sh` | this commit |
| `--dir` relative path e2e | ✅ | `scripts/e2e-tui-dir.sh` uses the relative `sub-project` | `bash scripts/e2e-tui-dir.sh` | this commit |
| `--dir` directory filtering e2e | ✅ | `scripts/e2e-tui-dir-filter.sh`: new sessions land in the subdirectory, root sessions are filtered out | `bash scripts/e2e-tui-dir-filter.sh` | this commit |
| `--fork --session` TUI e2e | ✅ | `scripts/e2e-tui-fork.sh` | `bash scripts/e2e-tui-fork.sh` | this commit |
| `--continue` TUI e2e | ✅ | `scripts/e2e-tui-continue.sh` (resumes the latest session) | `bash scripts/e2e-tui-continue.sh` | this commit |
| `--mini` TUI + reply e2e | ✅ | `scripts/e2e-tui-mini.sh`: types a prompt and asserts the reply appears exactly once | `bash scripts/e2e-tui-mini.sh` | this commit |
| Exit splash note (full/`--mini`) | 🟡 | rendered by the official binary and cannot be replaced; when the session has content (new input or restored history) dsh-oc adds one hint line below it (the id is the dsh session id, resume with `dsh --profile oc --session`) | `tests/bridge-router.spec.ts`, `scripts/e2e-tui-mini.sh` | this commit |
| Esc interrupt/cancel (full/`--mini`) | ✅ | `turn.wait`/`turn.idle` events drive the TUI running state; `POST /api/session/:id/interrupt` → `session.cancel` stops the in-flight stream (two Esc presses in both the full TUI and mini) | `tests/bridge-events.spec.ts`, `scripts/e2e-tui-abort.sh` | this commit |
| New session inherits the most recent preset | ✅ | a `/preset X` selection is recorded in bridge state, and a session created with `/new` keeps that preset (the tool set changes with it) | `tests/bridge-router.spec.ts` | this commit |
| `--print-logs` passthrough e2e | ✅ | `scripts/e2e-tui-print-logs.sh` (fake binary argv assertion) | `bash scripts/e2e-tui-print-logs.sh` | this commit |
| Protocol probe (route inventory + binary/SDK version check) | ✅ | `scripts/probe-opencode.mjs`, `tests/fixtures/opencode/routes.json` | `pnpm run probe`, `tests/protocol-probe.spec.ts` | this commit |
| One-shot self-test entry | ✅ | `scripts/check-all.sh` (typecheck + unit tests + probe + performance smoke; `--e2e` for the full e2e; `--scale N` for load tests) | `bash scripts/check-all.sh` | this commit |
| GitHub Actions CI | ✅ | `.github/workflows/ci.yml` (automatic) + `.github/workflows/e2e.yml` (manual full e2e/load tests) | automatic on push/PR + workflow_dispatch | this commit |
| Streaming tool event API e2e | ✅ | `scripts/e2e-api.sh` asserts started/delta/called/success in the approval flow | `bash scripts/e2e-api.sh` | this commit |
| Feature matrix auto-tracking | ✅ | `scripts/update-feature-matrix.mjs` | `pnpm run features:update` | this commit |
| Session performance test (generator + metrics + report) | ✅ | `scripts/perf.mjs` + `scripts/perf-session-gen.mjs` (synthetic logs through the dsh Session API, zstd framed writes) | `pnpm run perf`, `tests/perf.spec.ts` | this commit |
| Large-session performance verification (200/1000/5000/10000) | ✅ | `docs/perf/results-2026-08-15.md`: SSE debounce + short TTL cache for list/history + upstream bottleneck record | `pnpm run perf -- --sessions 10000` | this commit |
| History read in-flight merging and derived page cache | ✅ | concurrent calls and startup prefetch share one `session.list`/`session.history` RPC; the full tail and the 100-message page derive from each other, and the TUI scans only once when it opens a session | `tests/bridge-router.spec.ts` | this commit |
| perf generator unit tests (encoding/round-trip/subagent scenarios) | ✅ | `tests/perf.spec.ts` | `pnpm test` | this commit |

## 10. Browser and Web UI

| Feature | Status | Route / implementation | How it is verified | Last updated |
|---|---|---|---|---|
| Official OpenCode Web UI served from the same origin as the API | ✅ | `src/bridge/web-ui.ts`: extracts the AppArchive inside the opencode binary to `$DSH_HOME/opencode/web-ui/<version>/` (`DSH_OC_WEB_UI` takes priority); `GET`/`HEAD` requests that match no route fall back to the SPA shell, and missing files under `_assets/`, `icons/` get 404 | `tests/bridge-web-ui.spec.ts` | this commit |
| Browser test of the official Web UI | 🟡 | the service is ready and the official 2.1.0 client can subscribe to `/api/event`; this machine has no real browser, so interaction was not verified | manual verification in an environment with a browser | this commit |
| CORS policy (aligned with the official server) | ✅ | `src/bridge/http.ts` `isAllowedCorsOrigin`/`corsHeaders`: localhost, 127.0.0.1, `oc://renderer`, tauri origins, `*.opencode.ai`, plus `DSH_OC_CORS`; echoes the request origin and sends `Access-Control-Allow-Credentials: true` | `tests/bridge-cors.spec.ts` | this commit |
| Project list (bridge working directory) | ✅ | `GET /api/project`, `GET /api/project/:projectID`, `PATCH /api/project/:projectID` (`projectInfo`; PATCH only echoes and does not persist) | `tests/bridge-web-ui.spec.ts` | this commit |
| SSE heartbeat (keeps clients from judging the stream dead) | ✅ | `src/bridge/sse.ts` writes one `: heartbeat\n\n` frame every 15 seconds (same style as the official server) | no unit test coverage yet | this commit |
| SSE status snapshot bounded | ✅ | `src/bridge/router.ts` `SESSION_STATUS_SNAPSHOT_LIMIT = 20` (running sessions + most recently touched sessions) | no unit test coverage yet | this commit |
| HTTP request tracing | ✅ | `DSH_OC_HTTP_LOG=1` → one `[bridge/http] <METHOD> <path>` line per request on stderr | manual verification | this commit |

<!-- FEATURES:AUTO:START -->
## Auto-tracked (generated)

> Run `pnpm run features:update` to regenerate. Generated at HEAD: `9b4dd18` (2026-10-22).

### Route registry

Routes registered by `src/bridge/router.ts` and `src/bridge/stubs.ts`. `/command`, `/skill`, `/reference`, `/integration` and their `/api/*` twins are registered dynamically in a `for` loop in the route sources, so this table lists the resolved literals plus the stub routes.

| Method | Route | Kind | Source |
|---|---|---|---|
| `GET` | `/experimental/capabilities` | json | `src/bridge/stubs.ts` |
| `GET` | `/experimental/console` | json | `src/bridge/stubs.ts` |
| `GET` | `/experimental/resource` | json | `src/bridge/stubs.ts` |
| `GET` | `/experimental/workspace` | json | `src/bridge/stubs.ts` |
| `GET` | `/experimental/workspace/status` | json | `src/bridge/stubs.ts` |
| `GET` | `/formatter` | json | `src/bridge/stubs.ts` |
| `GET` | `/lsp` | json | `src/bridge/stubs.ts` |
| `GET` | `/mcp` | json | `src/bridge/stubs.ts` |

### Test coverage

| Test file | Cases | Last updated |
|---|---|---|
| `tests/bin.spec.ts` | 5 | 050803b chore(release): bump version to 0.1.0 for first release |
| `tests/bridge-cors.spec.ts` | 6 | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `tests/bridge-errors.spec.ts` | 1 | fd1e411 feat(bridge): integrate dsh 0.1.2 host services |
| `tests/bridge-events.spec.ts` | 89 | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `tests/bridge-fs.spec.ts` | 5 | 2fc8dea feat(bridge): return extension-aware content types from fs read |
| `tests/bridge-git.spec.ts` | 1 | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `tests/bridge-mcp.spec.ts` | 3 | — |
| `tests/bridge-model.spec.ts` | 5 | 72109b4 fix(bridge): keep the configured model usable and brand the TUI footer |
| `tests/bridge-router.spec.ts` | 138 | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `tests/bridge-web-ui.spec.ts` | 9 | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `tests/contract/client.spec.ts` | 12 | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `tests/contract/events.spec.ts` | 19 | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `tests/contract/revert.spec.ts` | 8 | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `tests/contract/routes.spec.ts` | 1 | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `tests/convert/goal.spec.ts` | 5 | 34f5695 feat(bridge): goal projection, /goal command and sidebar todo merge |
| `tests/convert/message.spec.ts` | 9 | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `tests/convert/model.spec.ts` | 6 | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `tests/convert/permission.spec.ts` | 4 | 0af3147 feat(bridge): opencode-compatible HTTP/SSE bridge over dsh api proxy |
| `tests/convert/question.spec.ts` | 5 | 0af3147 feat(bridge): opencode-compatible HTTP/SSE bridge over dsh api proxy |
| `tests/convert/session.spec.ts` | 8 | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `tests/convert/todo.spec.ts` | 3 | 0af3147 feat(bridge): opencode-compatible HTTP/SSE bridge over dsh api proxy |
| `tests/convert/tool.spec.ts` | 19 | 3dc26cf feat(bridge): adapt to dsh 0.1.5 host ABI and assistant stream model |
| `tests/e2e/events.spec.ts` | 1 | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `tests/e2e/openchamber.spec.ts` | 1 | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `tests/e2e/revert.spec.ts` | 1 | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `tests/perf.spec.ts` | 5 | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `tests/protocol-probe.spec.ts` | 1 | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `tests/replay-corpus.spec.ts` | 2 | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `tests/rewind/rewind.spec.ts` | 12 | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `tests/scaffold.spec.ts` | 10 | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `tests/tui/binary.spec.ts` | 18 | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `tests/tui/branding-art.spec.ts` | 3 | 3c3984c feat(tui): generate DSH OC home logo with figlet tooling |
| `tests/tui/download.spec.ts` | 5 | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `tests/tui/index.spec.ts` | 39 | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `tests/tui/platform.spec.ts` | 7 | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |

### Key implementation, last updated

| File | Last updated |
|---|---|
| `src/bridge/convert/common.ts` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `src/bridge/convert/goal.ts` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `src/bridge/convert/message.ts` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `src/bridge/convert/model.ts` | 72109b4 fix(bridge): keep the configured model usable and brand the TUI footer |
| `src/bridge/convert/permission.ts` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `src/bridge/convert/question.ts` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `src/bridge/convert/session.ts` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `src/bridge/convert/todo.ts` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `src/bridge/convert/tool.ts` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `src/bridge/convert/wire.ts` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `src/bridge/dsh-types.ts` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `src/bridge/errors.ts` | fd1e411 feat(bridge): integrate dsh 0.1.2 host services |
| `src/bridge/events-util.ts` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `src/bridge/events.ts` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `src/bridge/file-uploads.ts` | 3dc26cf feat(bridge): adapt to dsh 0.1.5 host ABI and assistant stream model |
| `src/bridge/fs.ts` | 2fc8dea feat(bridge): return extension-aware content types from fs read |
| `src/bridge/git.ts` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `src/bridge/http.ts` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `src/bridge/index.ts` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `src/bridge/router-entry.ts` | 6928f8a feat(bridge): expose router entry and add minimal-server renderer attribution |
| `src/bridge/router.ts` | 0778b0d fix(bridge): diagnose an empty model catalog; harden the revert e2e |
| `src/bridge/routes.ts` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `src/bridge/routes/boot.ts` | 72109b4 fix(bridge): keep the configured model usable and brand the TUI footer |
| `src/bridge/routes/fs.ts` | 2fc8dea feat(bridge): return extension-aware content types from fs read |
| `src/bridge/routes/session-v2-extra.ts` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `src/bridge/routes/session-v2.ts` | 72109b4 fix(bridge): keep the configured model usable and brand the TUI footer |
| `src/bridge/routes/v2-client-compat.ts` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `src/bridge/routes/v2-shapes.ts` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `src/bridge/routes/v2-stubs.ts` | 72109b4 fix(bridge): keep the configured model usable and brand the TUI footer |
| `src/bridge/rpc.ts` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `src/bridge/shell.ts` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `src/bridge/sse.ts` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `src/bridge/state.ts` | 0778b0d fix(bridge): diagnose an empty model catalog; harden the revert e2e |
| `src/bridge/stubs.ts` | c281121 feat(bridge): serve real git info, status and diffs over /vcs |
| `src/bridge/web-ui.ts` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `src/help.ts` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `src/index.ts` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `src/rewind/index.ts` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `src/tui/binary.ts` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `src/tui/brand.ts` | eba383f feat(tui): print DSH OC brand before --mini launches |
| `src/tui/download.ts` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `src/tui/index.ts` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `src/tui/node-undici.d.ts` | 81920ee feat(tui): opencode binary resolution, download, spawn and signal handling |
| `src/tui/platform.ts` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `src/tui/temp.ts` | fd1e411 feat(bridge): integrate dsh 0.1.2 host services |
| `src/types.ts` | 153f781 feat(tui): show exit hint for resumed sessions with history, not only new input |
| `scripts/audit-local-sessions.sh` | fb50dbe fix(perf): write v3 session generation filenames |
| `scripts/build-replay-corpus.mjs` | 3dc26cf feat(bridge): adapt to dsh 0.1.5 host ABI and assistant stream model |
| `scripts/check-all.sh` | db87e31 fix(release): verify local dsh-oc resolution |
| `scripts/check-client-routes.mjs` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/check-docs-i18n.mjs` | — |
| `scripts/cleanup-e2e-runs.sh` | ec31177 chore: add e2e run directory cleanup script |
| `scripts/cleanup-merged-branches.sh` | 2f1ab51 chore(scripts): enumerate remote merged branches for cleanup |
| `scripts/e2e-api-attachment.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-api-goal.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-api-permission.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-api.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-cli-bin.sh` | e1817df test(e2e): assert dsh-oc --version dual output in cli-bin suite |
| `scripts/e2e-golden-trace.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-install-rollback.sh` | dacd2a2 chore(release): prepare v0.2.0-rc.3 |
| `scripts/e2e-minimal-server-repro.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-openchamber-bootstrap.mjs` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-openchamber.mjs` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-queued-order-repro.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-real-llm.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-real-queued-order.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-recovery-consistency.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-recovery-crash.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-recovery-sse-reconnect.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-revert-flow.mjs` | 0778b0d fix(bridge): diagnose an empty model catalog; harden the revert e2e |
| `scripts/e2e-tui-abort.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-tui-agent-lock.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-tui-agent-tab.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-tui-boot.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-tui-brand.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-tui-command.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-tui-continue.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-tui-dir-filter.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-tui-dir.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-tui-fork.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-tui-goal-command.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-tui-goal.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-tui-help.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-tui-mini.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-tui-offline.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-tui-permission-ext.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-tui-permission-mini.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-tui-permission.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-tui-preset-inherit.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-tui-print-logs.sh` | 7561559 test(e2e): assert --log-level value passthrough to opencode child |
| `scripts/e2e-tui-queue-live.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-tui-queue.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-tui-shell.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-tui-skill.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-tui-stream.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-tui-subagent.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-tui-timestamps.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-tui-tools.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-tui-turn.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/e2e-tui-version-lock.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/extract-opencode-web-ui.mjs` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/flake-mini-scan.sh` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/generate-tui-branding-art.mjs` | 3c3984c feat(tui): generate DSH OC home logo with figlet tooling |
| `scripts/minimal-oc-server.mjs` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/monitor-process-io.sh` | d94f52e fix(e2e): harden permission waits and monitor output |
| `scripts/normalize-golden-trace.mjs` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/perf-session-gen.mjs` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/perf.mjs` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/probe-opencode.mjs` | 47778b6 feat(bridge): speak the OpenCode 2.1 protocol and serve its web UI |
| `scripts/replay-corpus-manifest.mjs` | fb50dbe fix(perf): write v3 session generation filenames |
| `scripts/replay-session-audit.sh` | 54c9c31 test(bridge): add reusable real-session replay audit script |
| `scripts/scan-release-artifact-paths.sh` | f5f016f test(release): harden CI verification |
| `scripts/update-feature-matrix.mjs` | 8d95367 fix(docs): keep feature matrix generation idempotent |
| `scripts/update-local-install.sh` | db87e31 fix(release): verify local dsh-oc resolution |
| `scripts/update-opencode-assets.mjs` | 6ecf354 feat(tui): timestamps, feature matrix and multi-arch binary resolution |
| `scripts/upgrade-lane.sh` | 81effdd feat(tui): add candidate opencode upgrade lane with golden trace diff |
| `scripts/verify-release-artifacts.sh` | 3ed10a7 fix(release): invoke tsdown directly in artifact rebuild |
<!-- FEATURES:AUTO:END -->
