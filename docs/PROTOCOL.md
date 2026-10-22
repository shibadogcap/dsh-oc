*English · [日本語](PROTOCOL.ja.md) · [中文](PROTOCOL.zh.md)*

# OpenCode TUI Protocol Probe and Compatibility Matrix

> This file is a companion to `PLAN.md`. Read it before running P0.
> Feature status entry point: read [FEATURES.md](FEATURES.md) first, then come back here to check route and protocol details.
> Probe baseline: `@opencode/cli@2.1.0` (GitHub Release `v2.1.0`, commit `4643e65`).

## 0.2.0-rc.4 implementation baseline

The current prerelease targets dsh `>=0.1.5-rc.2`. The `apiProxy` wording kept in the earlier tables below is the historical design source; the current implementation has completed the semantic re-integration of PR #1/#2/#3 and no longer depends on
`@deepseek-ai/dsh-host-apiproxy`.

RC.2 includes Issue #4's `POST /api/session/:id/shell`; RC.3 completes the reasoning effort sync for the official TUI prompt's top-level
`variant`; RC.4 adapts to dsh 0.1.5's host ABI and the assistant
streaming model (see §11).

- Session/list/history/prompt/cancel/model/fork/rename connect directly to
  `sessionController`; agent/preset, goal and skill each connect directly to their corresponding host services.
- SSE is composed of `session/event`, `agent/assistant-stream`,
  `sessionController.control`, and approval/question answerer event translation; it no longer consumes the old
  `apiProxy.events.mux()` envelope.
- `POST /api/session/:id/wait` uses the in-memory authoritative map of dsh `api-session/status`,
  with at most one `session.list` seed on cold start, so that TUI wait polling does not trigger whole-database I/O.
- The SSE client supports bounded `Last-Event-ID` ring replay; when a cursor is evicted it replays only the current
  status/control snapshot and does not scan history.

---

## 1. Protocol baseline: single-generation OpenCode 2.1.0 implementation

The dsh-oc bridge implements only one HTTP protocol: **OpenCode 2.1.0**:

- Everything the official client (`@opencode/client@2.1.0`) calls lives under `/api/*`.
- All OpenCode 1.x prefix routes (`/session`, `/config`, `/provider`, `/global/event`, …) have been removed, and the
  repo no longer depends on `@opencode-ai/sdk@1.18.18` types; `src/bridge/convert/wire.ts` uses local structural types
  to describe the 1.x shape projection that the SSE channel still publishes.
- `node scripts/check-client-routes.mjs` takes the official client chunks as the source of truth and verifies that the route set registered by the bridge
  covers every client route (`missing: 0`).

---

## 2. Probe method (reproducible)

### 2.1 Preparation

```bash
# Install the official binary
npm pack @opencode/cli@2.1.0
# Or unpack node_modules/@opencode/cli/bin/opencode.exe directly

# Clone the opencode source for comparison
git clone --depth 50 https://github.com/anomalyco/opencode.git ../opencode
git -C ../opencode checkout 4643e65
```

### 2.2 Record TUI startup requests

```bash
# 1. Start a real opencode server (only for recording the protocol, not the dsh-oc runtime)
DEEPSEEK_API_KEY=test \
OPENCODE_CONFIG_CONTENT='{"provider":{"deepseek":{"options":{"baseURL":"http://127.0.0.1:19876","apiKey":"test-key"}}},"enabled_providers":["deepseek"],"model":"deepseek/deepseek-chat","autoupdate":false,"share":"disabled"}' \
opencode serve --port 4097

# 2. Start the log proxy: 19877 -> 127.0.0.1:4097, printing method/url/headers/status
node tools/log-proxy.mjs

# 3. Start the TUI in a PTY (2.x uses the global --server to point at the bridge; --mini goes through the mini subcommand)
script -qec "opencode --server http://127.0.0.1:19877" /dev/null
script -qec "opencode mini --server http://127.0.0.1:19877" /dev/null

# 4. Capture the /api/event SSE and each response body, save under tests/fixtures/opencode/
```

### 2.3 Capture the schema

Authoritative schema sources:

- `../opencode/packages/sdk/openapi.json`
- `../opencode/packages/sdk/js/src/v2/gen/types.gen.ts` (after generation)
- `dist/promise/generated/types.d.ts` of the npm package `@opencode/client@2.1.0`

---

## 3. Measured startup route list (P0 must answer all of them)

Real requests during `opencode --server` startup (recorded 2026-08-15, TTY environment; 1.x prefix routes have been removed):

```text
GET /experimental/capabilities
GET /experimental/console
GET /api/event                           # SSE long-lived connection
GET /api/location
GET /api/agent
GET /api/integration
GET /api/model
GET /api/provider
GET /api/reference
GET /api/command
GET /api/skill
GET /lsp
GET /mcp
GET /experimental/resource
GET /formatter
GET /experimental/workspace
GET /experimental/workspace/status
GET /api/model?location[directory]=...
GET /api/provider?location[directory]=...
GET /api/reference
GET /api/integration?location[directory]=...
```

> In different directory/workspace modes, `/api/model` and `/api/provider` are requested several more times. The implementation must be idempotent.

---

## 4. Route classification

Legend:

- **MAP**: must be translated to a dsh service.
- **STUB**: returns schema-valid empty data.
- **LATER**: may be 501/empty in the first release, but is recorded in tests.

### 4.1 Non-`/api` routes

OpenCode 1.x's prefix routes (`/session`, `/config`, `/provider`, `/agent`, `/command`,
`/skill`, `/permission`, `/question`, `/vcs`, `/global/event` …) have all been removed. What remains below is only
the stubs and lifecycle endpoints that the TUI probes at startup.

| Route | Class | dsh data source / stub shape |
|---|---|---|
| `GET /lsp` | STUB | `[]` |
| `GET /mcp` | STUB | `{}` |
| `GET /formatter` | STUB | `[]` |
| `GET /experimental/resource` | STUB | `[]` |
| `GET /experimental/console` | STUB | `{ consoleManagedProviders: [], switchableOrgCount: 0 }` |
| `GET /experimental/capabilities` | MAP | `{ backgroundSubagents: true }` (dsh background subagents really are available) |
| `POST /experimental/session/{id}/background` | MAP | no-op success `true` (dsh sessions are resident on the server side) |
| `GET /experimental/workspace` | STUB | `[]` |
| `GET /experimental/workspace/status` | STUB | empty status |
| other unlisted routes | LATER | 501 or a schema-valid empty response |

> **Web UI fallback**: when the bridge has the official Web UI (see §4.4), `GET` / `HEAD`
> requests that match no route are served by the Web UI; without a Web UI they are still 501.

### User `!` shell mode

The official OpenCode enters shell mode when you press `!` in the input box, and sends
`POST /api/session/{id}/shell` on submit. The request body must contain a non-empty `command`; `agent` is optional and
defaults to the session's current agent. `agent`, when given, must be the current session's agent and must be an available preset;
an empty value, a mismatch, or an unavailable agent returns 400. The route returns 204 on success, and the visible card goes out over SSE.

The working directory is passed only through the query `directory` (not `cwd`, and not the body's `workdir`):
a recorded session cwd takes precedence; the query value is used only when the session cwd has not been recorded yet (cold start),
a relative query path resolves against the bridge cwd, and an absolute path is used as is; with no query it falls back to the bridge
cwd. `--dir` changes the bridge cwd but does not override a recorded session cwd.

dsh-oc obtains real idle ownership through the dsh Agent's `runMaintenance`; it then starts the shell as the current OS
user, because an explicit `!` from the user is the authorization boundary for this path. On POSIX it uses
`$SHELL` only when it is an absolute path, otherwise it falls back to `/bin/sh`; on Windows it uses `ComSpec`, falling back to
`cmd.exe` when missing. This path does not claim dsh model-tool approval or sandbox protection, and it does not fabricate
dsh turn/tool durable events. SSE first publishes a running tool part, and after completion publishes the completed/error
tool part, the authoritative idle status, and exactly one `session.idle`.
stdout/stderr are capped at 1 MiB each; beyond that, reading continues and a truncation marker is written into the output, and the child process is never
actively killed because the output exceeded the threshold.
This shell path publishes the retained output only after the child process exits; it provides no real-time stdout/stderr stream.

`POST /api/session/{id}/interrupt` first aborts the exact shell child process/process group registered for that bridge/session,
then still calls dsh `session.cancel`; it does not search by process name or kill other processes.
On POSIX it terminates its own process group; on Windows it terminates the `taskkill /T` tree of its own PID, and it does not disguise the
Windows shell as a dsh `pwsh` sandbox.

This deliberately does not call `ctx.tools.execute({ agent, name: 'bash' })`: under PTC
presentation, dsh-tools judges model-direct root bash as `UNKNOWN_TOOL`, and its nested
parent token can only be created by the real `run_code` transport, which the bridge cannot forge; at the same time
dsh-user-approval's `approval.request()` requires an open turn, and shell maintenance
is not a model turn itself. So no legitimate user-shell host seam can claim
model-tool approval/sandbox semantics at the same time; the bridge adopts upstream's equivalent explicit user authorization plus exact child-process
ownership, and reports an explicit error when the `Agent.runMaintenance` ABI is missing.

This request is not part of the model agent-loop's turn/step, so it cannot fabricate dsh `tool/call` /
`tool/result` durable events; the completion card is kept only in the per-session bounded bridge in-memory command-result
store (last 20), and is not written to dsh durable history. It is injected into
`GET /api/session/{id}/message` hydration; it is not injected into
`/api/session/{id}/history`, `/context`, or a single `/message/{messageID}`, which only
return durable dsh history. After the command completes, the bridge uses the dsh Agent's `inject()` to append a
non-waking plugin context (`plugin: dsh-oc`, `form: notice`) whose content explicitly marks it as a "command executed manually
by the user" together with stdout/stderr, truncation markers and exit status; model injection has a separate UTF-8 budget:
commands at most 16 KiB, stdout/stderr at most 64 KiB each, and the full context text at most about 144 KiB; the TUI
tool card still keeps a 1 MiB display budget per stream. Shell output is sent to the currently configured model, and commands or output
may contain tokens, passwords, personal data and other sensitive information, so the user must confirm before executing `!`. If injection fails,
the shell card still completes, but `[dsh-oc] ... was not added to model context` is appended to the output.
That context is first persisted as a valid dsh `agent/inbox/spliced` (`next-step` pending)
event, and only enters that step's model request after a later step claims it; the injection itself does not wake the Agent,
does not open a new turn, and does not automatically trigger a model reply. For the same session, the next real prompt is guaranteed to see
that context (unless the session is cleaned up); restart/recovery rebuilds inbox entries that have not been claimed. After a
claim, if compaction occurs, dsh may summarize or drop the verbatim text, so verbatim retention after compaction is not guaranteed.
If the Agent already has a turn/maintenance, the endpoint returns 409; if the session does not exist it returns 404; a missing/invalid
`agent` or an empty command returns 400.

### 4.2 v2 `/api` routes

| Route | Class | dsh data source / stub shape |
|---|---|---|
| `GET /api/location` | MAP | `{ directory: cwd }` |
| `GET /api/health` | MAP | `{ healthy: true }` (client liveness probe) |
| `GET /api/project` | MAP | bare `Project[]`: the bridge's working directory (`projectInfo`) |
| `GET /api/project/{projectID}` | MAP | bare `Project`; id mismatch 404 |
| `PATCH /api/project/{projectID}` | MAP | bare `Project` (currently only echoes back, no persistence); id mismatch 404 |
| `GET /api/agent` | STUB/LATER | `[]` |
| `GET /api/integration` | MAP | one entry per provider with a usable credential (`methods: []`, a credential connection labelled `dsh profile`; the label is what keeps the row visible); a hint entry when none, so the dialog can explain the profile |
| `POST /api/integration/{id}/connect/*` | REJECT | 400 `integration/profile-configured`: credentials live in the dsh profile |
| `GET /api/vcs` | MAP | `{ provider: "git", branch: { current, default } }`, `null` outside a worktree |
| `GET /api/vcs/base` | MAP | merge base with the default branch (`source: "default"`), first commit otherwise |
| `GET /api/vcs/status` | MAP | `git status --porcelain` with `git diff --numstat HEAD` counts |
| `GET /api/vcs/branch` | MAP | local branches (`git branch --format=%(refname:short)`) |
| `GET /api/vcs/diff` | MAP | `mode=working` (`git diff HEAD`, untracked files as added patches), `branch`/`committed` against the merge base; capped at 200 files |
| `GET /api/config` | MAP | one document: dsh model + default agent, plus the stored `shell` |
| `GET /api/config/shell` | MAP | `/etc/shells` plus `$SHELL` as `{ path, name, acceptable }` |
| `PATCH /api/experimental/config` | MAP | stores `{ shell }` in `$DSH_HOME/opencode/config/opencode.json` (204); a shell that cannot run is 400 |
| `GET /api/model` | MAP | `sessionController.modelCatalog` |
| `GET /api/provider` | MAP | `sessionController.modelCatalog` providers |
| `GET /api/provider/{id}` | MAP | single provider `{ location, data: ProviderV2Info }`; 404 when not found |
| `GET /api/mcp` | MAP | connected MCP servers: the names come from the `mcp__<server>__<tool>` entries in the dsh tool registry, each returned as `{ name, status: { status: "connected" } }` |
| `POST /api/mcp`, `DELETE /api/mcp/{name}`, `POST /api/mcp/{name}/connect`, `POST /api/mcp/{name}/disconnect` | REJECT | 400 `mcp/profile-configured`: dsh configures MCP servers as `mcp-client` plugins, so the profile owns the change |
| `GET /api/reference` | STUB | `[]` |
| `GET /api/command` | MAP | registers `/preset`, `/goal`, `/help` |
| `GET /api/skill` | STUB/LATER | `[]` |
| `GET /api/session` | MAP | `sessionController.list` (paging + `cursor`) |
| `GET /experimental/session` | MAP | GlobalSession list (search/directory filter/limit subset, reusing `convertSessionSummary`) |
| `GET /api/session/active` | MAP | currently active sessions; returns `{ data: { [sessionId]: { type: "running" } } }` only for sessions actually `running`, otherwise `{}` |
| `POST /api/session/{id}/wait` | MAP | waits for the agent loop to go idle: polls `session.list` for ≤30s, 204 when idle, 503 on timeout, 404 when the session does not exist |
| `POST /api/session` | MAP | `sessionController.create` |
| `POST /api/session/{id}/fork` | MAP | `sessionController.fork` (the client's `before` is an **exclusive** boundary: only messages before that message are copied), returns a v2 envelope |
| `POST /api/session/{id}/compact` | MAP | dsh `/compact` command registry (SDK v2 route, 204) |
| `POST /api/session/{id}/interrupt` | MAP | `sessionController.cancel` + abort the shell child process registered for that session (SDK v2 interrupt entry point) |
| `GET /api/session/{id}` | MAP | history + summary; subagent children keep `parentID` and `metadata.origin` (even though the SDK v2 generated types do not declare that extension field) |
| `GET /api/session/{id}/message` | MAP | `sessionController.follow/page` history; `cursor.previous` provides the previous-page anchor |
| `GET /api/session/{id}/history` | MAP | v2 history paging: `limit` + `after` (exclusive upper bound, mapped to dsh `beforeSeq` for paging backwards), returns `{ data, hasMore, next }` |
| `GET /api/session/{id}/context` | MAP | `{ data: SessionMessage[] }` (reuses the v2 message conversion, no cursor) |
| `GET /api/session/{id}/message/{messageID}` | MAP | `{ data: SessionMessage }` single lookup; 404 when not found |
| `POST /api/session/{id}/prompt` | MAP | `sessionController.prompt` (`id` optional; slash commands go through the command registry) |
| `POST /api/session/{id}/model` | MAP | v2 model selection (including `variant`, with `reconcileModelSelection` as a fallback) |
| `POST /api/session/{id}/agent` | MAP | v2 agent switch (`switchAgentPreset` + broadcast `session.updated`) |
| `POST /api/session/{id}/revert/stage` | MAP | records the **exclusive** boundary `{ messageID }`, returns `{ data: { messageID, files? } }`; also rolls back in place the files changed by the turns after the boundary |
| `DELETE /api/session/{id}/revert` | MAP | clears the staged boundary and puts the files rolled back at stage time back to their original state (204) |
| `POST /api/session/{id}/revert/commit` | MAP | forks at the event before the boundary message (exclusive: the boundary message and every later message are dropped), and the opencode session id then points at that fork; the rolled-back files are kept (204) |
| `GET /api/session/{id}/event` | MAP | per-session filtered SSE event stream (a subset of `/api/event`) |
| `GET /api/session/{id}/permission` | MAP | pending approvals per session |
| `GET /api/session/{id}/permission/{rid}` | MAP | single pending approval (404 when the session does not match) |
| `POST /api/session/{id}/permission/{rid}/reply` | MAP | approval answerer |
| `GET /api/session/{id}/question` | MAP | pending questions per session |
| `POST /api/session/{id}/question/{rid}/reply` | MAP | question answerer |
| `POST /api/session/{id}/question/{rid}/reject` | MAP | question answerer cancelled |
| `GET /api/permission/request` | MAP | SDK v2 global pending approvals alias, `{ location, data }` |
| `GET /api/question/request` | MAP | SDK v2 global pending questions alias, `{ location, data }` |
| `GET /api/permission/saved` | MAP | in-memory always grants list (`PermissionSavedInfo` + `sessionID/grantedAt`) |
| `DELETE /api/permission/saved/{id}` | MAP | deletes the `sessionID:toolName` in-memory grant (404 when absent) |
| `GET /api/fs/read/{path}` | MAP | reads the raw bytes of a file inside the workspace (`*` wildcard path, 400 when out of bounds, limit 5 MiB) |
| `GET /api/fs/list` | MAP | lists a directory (`{ location, data: FileSystemEntry[] }`, directories first) |
| `GET /api/fs/find` | MAP | recursive find (query/type/limit, skips dependency and build directories) |
| `GET /global/health` | MAP | `{ healthy: true, version }` |
| `POST /global/dispose` / `POST /instance/dispose` | MAP | no-op confirming `true` (dsh owns the process lifecycle) |
| other unlisted routes | LATER | 501 or a schema-valid empty response |

> `after` is an **exclusive upper bound**: it returns the page of messages whose event seq is strictly less than `after`, and
> `next` is the oldest anchor seq on that page (so standalone clients can page forward continuously); `after` must be a
> non-negative integer, otherwise 400. When a paging boundary cuts through a tool turn, the cross-page cursor
> guarantees no missing or duplicated pages (covered by the recovery e2e).

### 4.3 Session revert

OpenCode 2.1.0 revert has three steps: stage records the boundary, the user confirms, and finally commit.
The boundary is **exclusive**: the designated message and everything after it disappear together when commit takes effect.

| Route | Request | Response |
|---|---|---|
| `POST /api/session/{id}/revert/stage` | `{ messageID, files? }` | `200 { data: { messageID, files? } }` |
| `DELETE /api/session/{id}/revert` | — | `204` |
| `POST /api/session/{id}/revert/commit` | — | `204` |

- stage: the position of the boundary message in the dsh event log (`R.locateMessage`) also determines which
  turn it belongs to. The `files` in the response are the diffs of the files this revert will affect, each item a `FileDiffInfo`
  (`file` / `patch` / `additions` / `deletions` / `status`); the `files` in the request body
  is ignored, and the diff is computed from the bridge's own file snapshots. The diff is computed **before** the rollback; after the rollback the
  files already hold the old content, so the diff becomes empty. stage then rolls those files back to their pre-change content
  (`restoreFilesAfter`), and the workspace immediately shows the reverted state; the current content from before the rollback is kept,
  `clear` puts the files back to their original state (`undoRestore`), and `commit` keeps the rollback result (`commitRestore`).
- The file set is grouped by turn (copy-on-write snapshots in `src/rewind/`, grouped by `turn/start`).
  The rollback range is the turns **after** the turn containing the boundary message; when the boundary message is a user prompt,
  the files of its own turn are rolled back as well (`includeTurn: true`, because the assistant reply comes after the prompt);
  when the boundary message is an assistant reply, the current turn is not rolled back (`includeTurn: false`).
- commit: dsh's `sessionController.fork` copies the event prefix that **includes** `atSeq`,
  while OpenCode's boundary is exclusive, so the cut point is the event before the boundary message
  (`R.atSeqBeforeMessage`). Messages after the cut point (including the boundary message itself) do not appear in the new
  session.
- `POST /api/session/{id}/fork`'s `before` has the same exclusive semantics and uses the same cut-point computation
  (the forked session does not contain the message `before` points at); it does not create an alias, and what the fork produces is
  a new session id.
- After commit the **session id does not change**: the bridge records an alias between the opencode session id and the forked dsh id
  (`InteractionState.setSessionAlias`), so
  - all subsequent dsh calls are rewritten to the fork (`resolveSessionPayload` in `rpc()`);
  - the session list publishes the fork under the **original opencode id**, and the replaced session
    disappears from the list;
  - `GET /api/session/{id}` and `GET /api/session/{id}/message` read the fork's
    summary and history;
  - the fork's SSE events are rewritten back to the original opencode id (`mapEventSessionId`);
  - session-level state (model, agent preset, title, message id mapping) is copied onto the fork
    (`inheritSessionState`), so the message ids the client sees do not change.
- Commit timing: as in OpenCode, when the next prompt arrives the staged revert is committed first
  (`POST /api/session/{id}/prompt` calls `commitStagedRevert` first), and the prompt then lands in the
  rewritten session; `POST /api/session/{id}/revert/commit` is the explicit entry point for the same path.
- The session record carries the staged boundary: `Session.Info.revert = { messageID, files? }`
  (visible in `GET /api/session/{id}`; it disappears after commit or clear).
- Errors: missing `messageID` → 400; message not in history → 400
  `message not found for fork`; cut point before the first message → 400
  `cannot cut before the first message` (dsh's
  `atSeq` must be a non-negative integer and cannot express an empty fork).
- Known limitation: the file diff is **one coarse hunk** between the first and last changed lines (the same shape as the bridge's own file-change
  diff), not a full LCS diff; the `files` list appears in the stage response and on the session
  record, and the official TUI renders it.

### 4.4 Official Web UI (same origin as the API)

The official `opencode serve` serves the API and the Web UI from the same origin: the UI in the browser reaches the API through
`location.origin`, so it needs neither CORS nor a login. The dsh-oc bridge
copies this setup (`src/bridge/web-ui.ts`).

- The official opencode binary packs the Web UI into an `AppArchive` (opencode source
  `packages/cli/src/app-archive.ts`): the little-endian u32 byte length of the JSON index, the index itself
  (each asset's `[offset, length]`), and the brotli-compressed asset bodies.
- The bridge unpacks that archive once into `$DSH_HOME/opencode/web-ui/<version>/` (`<version>`
  is the pinned opencode version, currently `2.1.0`), and after that serves those files itself.
- Directory lookup order: the directory set by `DSH_OC_WEB_UI` → `$DSH_HOME/opencode/web-ui/<version>/`.
  A directory without `index.html` is treated as unset.
- The binary is only **looked up** and never installed by the bridge: the TUI plugin already requires the opencode binary,
  so the Web UI appears from the next start. When no binary is found, no Web UI is served and the API is unaffected.
- `scripts/extract-opencode-web-ui.mjs` can extract the assets to any directory offline
  (`node scripts/extract-opencode-web-ui.mjs --bin <opencode binary> --out <directory>`).

Route behavior (the fallback in `src/bridge/http.ts` + `src/bridge/web-ui.ts`):

| Request | Response |
|---|---|
| matches an API route | API response (highest priority) |
| `GET` / `HEAD` that matches no route | the Web UI's `index.html` (single-page app; unknown paths also get the shell) |
| missing files under `_assets/`, `icons/` | 404 |
| unmatched routes for other methods | 501 `not implemented by oc-bridge` |

> Note: the fallback does not distinguish the `/api/` prefix, so unregistered `/api/*` paths get the
> SPA shell when a Web UI is present, not a JSON 404.

Static file headers: `content-type` comes from the extension (the same type table as the official server);
`index.html` / `sw.js` / `registerSW.js` are `cache-control: no-cache`, everything else is
`public, max-age=31536000, immutable`; with `x-content-type-options: nosniff`.
Paths that escape the Web UI directory are not served.

> **Measured status**: the Web UI is served, and the official OpenCode 2.1.0 client (Node, not a browser)
> can subscribe to the bridge's `/api/event` and receives `server.connected` in about 40 ms. There is no real
> browser on this machine, so interaction has **not** been verified in a real browser.

### 4.5 CORS policy

`isAllowedCorsOrigin()` / `corsHeaders()` in `src/bridge/http.ts` match the official
opencode server (source `packages/server/src/cors.ts`):

- `http://localhost:<port>` and `http://127.0.0.1:<port>` are always allowed;
- `oc://renderer`, the tauri origins (`tauri://localhost`,
  `http://tauri.localhost`, `https://tauri.localhost`) and `*.opencode.ai` are always allowed;
- origins listed in `DSH_OC_CORS` (comma-separated) are also allowed, matching the official server's `cors` option,
  for browser UIs on the LAN.

When allowed, the response echoes the request's own `Origin` and carries:

```text
Access-Control-Allow-Origin: <request origin>
Access-Control-Allow-Methods: GET, POST, PATCH, PUT, DELETE, OPTIONS
Access-Control-Allow-Headers: Content-Type, Authorization, X-Requested-With, Last-Event-ID
Access-Control-Allow-Credentials: true
Access-Control-Max-Age: 86400
```

Disallowed origins get no CORS headers at all; `OPTIONS` preflight returns 204 directly. Requests without an `Origin` header
(non-browser clients) are treated as same-origin and get `*`.

> The old implementation always returned `Access-Control-Allow-Origin: *`, and browsers reject credentialed requests
> ("credentialed request requires Access-Control-Allow-Origin '<origin>'"),
> so the browser UI could not connect at all.

### 4.6 Request tracing

`DSH_OC_HTTP_LOG=1` makes the bridge print every HTTP request to stderr:

```text
[bridge/http] GET /api/info
[bridge/http] GET /api/event
```

Lines are written when the request arrives, so long-lived connections (SSE) show up as well. This is the debugging means for
confirming the browser UI's call pattern in an environment without a browser.

---

## 5. SSE event mapping table

dsh 0.1.2 currently produces host frames from Cordis `session/event`, `sessionController.control` and the
approval/question answerers, and oc-bridge translates them into opencode
`GlobalEvent`; the old `apiProxy.events.mux()` is only a historical protocol source.

| DSH mux frame | opencode GlobalEvent |
|---|---|
| `session/event: session/created` | `session.created` (properties.sessionID, info=Session) |
| `session/event: session/title` | `session.updated` |
| `session/event: turn/start` | `session.status` (busy) |
| `session/event: turn/end` | `session.status` (idle) + `session.idle` |
| `session/event: user/message` | rebuild the Session, then send `message.updated` |
| `session/event: assistant/message` | `message.updated` + `message.part.updated` |
| `session/event: assistant/chunk (tool-call-delta)` | `session.next.tool.input.started/delta/ended` + v1 ToolPart increments (throttled and merged) |
| `session/event: tool/call` | `session.next.tool.called` + `progress` + `message.part.updated` (ToolPart pending; dsh `subagent*` is OpenCode `task`) |
| `session/event: tool/result` | `session.next.tool.success/failed` + `message.part.updated` (ToolPart completed/error; the Task child `sessionId` is linked from the host child lineage, not from result meta) |
| `session/event: todo/write` | `todo.updated` |
| `session/event: goal/change` | `todo.updated` (goal merged in as the first item) |
| `session/event: approval/asked\|decided` | persisted record, the bridge stays silent (permission interaction is driven by the mux frames `approval/requested\|resolved`) |
| `approval/requested` | `permission.asked` |
| `approval/resolved` | `permission.replied` |
| `question/requested` | `question.asked` |
| `question/resolved` | `question.replied` / `question.rejected` |
| `session/projection: todos` | `todo.updated` |
| `session/projection: goal` | `todo.updated` (goal merged in as the first item) |
| `session/projection: produced-files` | `session.diff` |
| `session/queue` (subscription init) | on first use for that session, mirror the pending inbox → `message.updated` + `message.part.updated` per user message (the TUI shows QUEUED) |
| `session/event: agent/inbox/spliced` | increments: an inserted user message → `message.updated`; `outcome: canceled` removal → `message.removed`; a claim (no outcome) does not delete, and waits for `user/message` with the same id to upsert |
| `session/jobs` | ignored |

> **Task subagent linkage**: the built-in OpenCode TUI reads the 1.18.18-shaped
> `ToolPart.state.input.description` / `subagent_type` to render a Task, and reads
> `ToolPart.state.metadata.sessionId` to navigate to the child.
> dsh `api-session/added`, `subagent/descriptor` and the `subagent` projection may arrive across
> sessions, so the bridge stages them by parent pending call, and for history binds parent-local by label/FIFO;
> all child v1/v2 Sessions and `session.updated` replacements keep
> `parentID` and `metadata.origin`.

> **Queued message visibility**: dropping the old `session/queue` left queued prompts with no feedback in the
> TUI, so users thought the send failed and re-sent, the queue backed up, and the model replied to old messages. Now
> `session/queue` only does the initial projection (a full frame cannot distinguish claim from cancel), and later
> increments are maintained by `agent/inbox/spliced`; an assistant message that still contains unfinished tool calls does not set
> `time.completed`, and it is filled in at `step/end`/`turn/end`, so that the official TUI's QUEUED determination
> (a user message after the last unfinished assistant message) takes effect.

> **prompt delivery semantics (steer)**: every user prompt is submitted with dsh `session.prompt`
> `mode: 'steer'` (equivalent to official opencode's "append to the session stream, and the running loop handles it at the next
> step"). A running turn sees the inserted message at the next step boundary,
> instead of waiting for the whole turn to end as with `mode: 'queue'` (which once made the user insert a title/correction during a long search turn
> and the model keep idling for minutes before it saw it, see session e0336d8b).
> Multiple queued messages are merged in order into the same request at the next step; the QUEUED badge is still determined by the TUI
> from the timeline itself.

> **Known behavior (text deltas duplicated in pairs)**: the old dsh/dcp rc.6 emitted the same streaming text as both
> `assistant/chunk` (text-delta) and packed `text-chunks`, and a new mux subscription
> replays history before going live, so the bridge's `message.part.delta` may send the same character
> twice (the two encodings chunk/offset differently and cannot be merged losslessly). The built-in TUI relies on the full text of the final
> `message.updated` and renders normally with no duplication in measurement; the v2 part of `e2e-tui-abort.sh`
> detects "a delta appears on the new SSE stream" and does not depend on delta text continuity.

GlobalEvent required fields:

```ts
{
  directory: string,
  project?: string,
  workspace?: string,
  payload: { id: string, type: ..., properties: ... }
}
```

> **Stream first-frame contract**: 2.x clients reject an event stream that does not start with `server.connected`, so
> `GET /api/event` (and the session-filtered `GET /api/session/{id}/event`) always sends a `server.connected` frame first
> after connecting, then does `Last-Event-ID` replay and status/control snapshot
> replay. `server.connected` does not enter the ring and does not consume a replay cursor.

### 5.1 OpenCode 2.x native event vocabulary (read by OpenChamber 2.5)

The built-in TUI reads `payload.type` + `payload.properties`; OpenChamber 2.5 reads
OpenCode 2.x's native vocabulary (`session.text.delta`, `session.tool.called`…), and it does not understand
`message.updated` / `message.part.updated`. So the same SSE connection publishes both projections at once:

* `payload.properties` keeps the 1.18.18 shape (the TUI path is unchanged).
* `payload.data` is the 2.x shape; the SSE top level additionally flattens `id`/`created`/`type`/`durable`/
  `location`/`data`, so 2.x clients can parse it without understanding the 1.18.18 wrapper.
* Events whose name is the same in both vocabularies (`session.status`, `session.idle`, `permission.replied`)
  need only one event: `data` is already the 2.x shape.
* `permission.asked` differs between the two shapes, so the same event's `properties` goes to the TUI and
  `data` goes to 2.x clients.

dsh → 2.x mapping:

| dsh source | 2.x event |
|---|---|
| `turn/start` | `session.execution.started` |
| `turn/end` (completed / max-tokens) | `session.execution.succeeded` |
| `turn/end` (error) | `session.execution.failed` (`error: {type, message}`) |
| `turn/end` (aborted / blocked) | `session.execution.interrupted` (`reason: user\|superseded\|shutdown`) |
| assistant step start | `session.step.started` (`assistantMessageID`/`agent`/`model`) |
| assistant step end | `session.step.ended` (`finish`/`cost`/`tokens`); an interrupted step sends `session.step.failed` |
| text block | `session.text.started` / `.delta` / `.ended` |
| reasoning block | `session.reasoning.started` / `.delta` / `.ended` |
| tool input | `session.tool.input.started` / `.delta` / `.ended` + `session.tool.called` |
| tool result | `session.tool.success` / `session.tool.failed` (+ `session.tool.progress`) |
| user message accepted / delivered | `session.inbox.enqueued` / `session.inbox.delivered` |
| session known / renamed | `session.created` / `session.renamed` |
| preset / model switch | `session.agent.selected` / `session.model.selected` |
| approval request / reply | `permission.asked` / `permission.replied` |
| question / reply / cancel | `form.created` / `form.replied` / `form.cancelled` |
| compaction | `session.compaction.started` / `.delta` / `.ended` |
| client-driven revert (stage / clear / commit) | `session.revert.staged` / `session.revert.cleared` / `session.revert.committed` |

`ordinal` is the index of a text block or reasoning block within the assistant message (starting at 0, with the two kinds
counted separately); `assistantMessageID` is the bridge's provisional assistant message id, the same id
the 1.18.18 `message.updated` uses.

The three revert events have no dsh counterpart (revert is client-driven) and are published directly by the revert routes:

| Event | `data` |
|---|---|
| `session.revert.staged` | `{ sessionID, revert: { messageID, files? } }` |
| `session.revert.cleared` | `{ sessionID }` |
| `session.revert.committed` | `{ sessionID, to }` (`to` is the boundary message id) |

> After a revert commit the session is switched to the fork, and the fork's events carry the new dsh session id; before
> broadcasting, the bridge rewrites those ids back to the opencode session id the client knows (`mapEventSessionId`),
> so the session id the client sees stays the same throughout.

### 5.2 Heartbeat and status snapshot

- **Heartbeat**: `SseHub` writes the same comment frame the official server uses,
  `: heartbeat\n\n`, to every connection every 15 seconds (the official implementation is in `packages/server/src/handlers/event.ts`).
  Without a heartbeat, a quiet session's stream looks dead: the official client disconnects with "Event stream stalled"
  and reconnects, and OpenChamber's upstream reader gives up after 20 seconds, so both fall into a reconnect loop.
  The comment frame is transparent to every SSE parser but counts as "data received". The heartbeat timer is
  `unref`ed and does not keep the process alive on its own.
- **The status snapshot is bounded**: on SSE connect, `replaySessionStatusSnapshot()` replays
  `session.status` to tell reconnecting clients which sessions are busy. The limit is
  `SESSION_STATUS_SNAPSHOT_LIMIT = 20`: running sessions first, and the remaining slots go to
  the most recently changed sessions by `sessionStatusUpdatedAt`. The old implementation reported every session the bridge had ever
  seen, and the official Web UI read hundreds of session records on every connection, so initial loading never finished.

---

## 6. Key opencode type locations

The following types are the authoritative basis for implementing `convert/*`:

```text
@opencode/client/dist/promise/generated/types.d.ts:
  SessionInfo, SessionMessageInfo, SessionMessageUser,
  SessionMessageAssistant, SessionMessageAssistantText,
  SessionMessageAssistantReasoning, SessionMessageAssistantTool,
  ModelInfo, ProviderInfo, ModelRef, AgentInfo, CommandInfo,
  PermissionRequest, FormInfo, SessionStatus, FileDiffInfo
```

The 1.x shape projection the SSE channel still publishes (`message.updated` / `message.part.updated` /
`session.updated`) has no 2.1.0 counterpart type, and is described by local structural types in `src/bridge/convert/wire.ts`:
`WireMessageInfo`, `WirePart`, `WireToolPart`, `WireSessionInfo`.

dsh type locations:

```text
deepseek-harness/packages/core/session/src/types.ts:
  SessionEvent, SessionEventMap, SurfaceOp, UserMessage, AssistantMessage
deepseek-harness/packages/host/apiproxy/src/api/:
  sessions.ts, events.ts, llm.ts, approvals.ts, questions.ts, rpc.ts
deepseek-harness/packages/host/apiproxy/src/api-proxy.ts:
  createApiProxy / ApiProxyService
```

---

## 7. opencode binary sources

`opencode-assets.json` was removed with the 2.1.0 migration, and the repo no longer maintains its own asset manifest.
Official 2.x distribution is only the npm platform packages `@opencode/cli-<platform>-<arch>[-baseline][-musl]`,
and dsh-oc installs these packages lazily per platform to obtain the binary.

```text
env DSH_OC_OPENCODE_BIN → versioned cache → PATH → official npm platform package
  → opencode-ai / @opencode/cli package in the profile → download fallback
```

- Official npm platform packages install into `$DSH_HOME/opencode/packages/<platform-key>`, with candidate order matching
  the platform/arch/musl/AVX2 selection of the official `postinstall.mjs`.
- An explicit `DSH_OC_OPENCODE_BIN` must report the pinned version `2.1.0`, otherwise it errors out directly and never silently
  falls back to another version on PATH.
- Covers these platform keys:
  - `linux-x64`, `linux-x64-baseline`, `linux-x64-musl`, `linux-x64-baseline-musl`
  - `linux-arm64`, `linux-arm64-musl`
  - `darwin-x64`, `darwin-x64-baseline`, `darwin-arm64`
  - `windows-x64`, `windows-x64-baseline`, `windows-arm64`
- When the manifest is missing, the download path only gives recovery guidance (set `DSH_OC_OPENCODE_BIN`, install
  `opencode-ai@2.1.0` / `@opencode/cli@2.1.0`, or place the executable manually), and no longer fails
  silently.

### 7.1 Multi-arch binary distribution

Priority in `src/tui/binary.ts` (details in README and FEATURES.md):

```text
env DSH_OC_OPENCODE_BIN → versioned cache → PATH → official npm platform package
  → opencode-ai / @opencode/cli package in the profile → npm platform package install fallback
```

Official npm platform packages install into `$DSH_HOME/opencode/packages/<platform-key>`, with candidate order matching
the platform/arch/musl/AVX2 selection of the official `postinstall.mjs`; each platform is verified independently through its own
platform package, not by a single global hash.

---

## 8. Known protocol limitations (first release)

1. **`always` permission downgrade**: the opencode TUI offers `Allow always`, while dsh approval only has `allowed-once / rejected`. The first release maps `always` to `allowed-once` and logs a notice outside the TUI. If dsh later adds persistent permission presets, this goes back to a real `always`.
2. **TUI launch method**: the 2.x CLI has no `attach` subcommand, so dsh-oc launches the TUI as `opencode --server <bridge-url>` (`--mini` goes through `opencode mini --server <bridge-url>`). `--dir` is consumed by dsh-oc itself and rewrites the bridge cwd; it is not forwarded to the CLI. Arguments such as `dsh --profile oc --model X` print a warning and are ignored in the first release; model switching goes through the in-TUI model selector.
3. **File attachments**: the `file` part supports text (data URL / local file inside cwd) and images (data URL), mapped to dsh `text`/`image` parts; binary attachments such as PDF return 400.
4. **session diff**: returns `[]` when there is no produced-files projection; it does not fabricate a diff.
5. **opencode 2.1.0 single protocol**: any upgrade must re-run the §2 probe and update this file.

## 9. e2e measured implementation status (2026-08-15)

The statuses below come from real e2e after profile-fix on the `chore-release` branch (mock LLM +
dsh 0.1.2-rc.1 + opencode 1.18.18, with both the TUI and the bridge actually running; the 2.1.0 route shapes match the
§4 tables):

| Route/capability | Status | Notes |
|---|---|---|
| §3 startup GET matrix (including `/api/model?location[...]` with query, etc.) | 200 + JSON | all asserted via curl+jq |
| `GET /api/event` | 200 SSE | `retry: 3000` first frame; every frame carries `directory` |
| `GET /api/agent` | MAP | returns a single `build` main agent (with `model`), otherwise the TUI prompt cannot be submitted |
| `POST /api/session/{id}/prompt` | MAP | opencode SDK v2 official route, returns `{ data: SessionInputAdmitted }` |
| `POST /api/session/{id}/fork` | MAP | dsh fork; the child session's `parentID` is correct |
| `POST /api/session/{id}/compact` | MAP | TUI `/compact` runs `/compact` through the dsh command registry |
| `GET /api/session` | MAP | child sessions output `parentID`; subagents carry `metadata.origin` and a title marker |
| `GET /api/model` | MAP | returns `{ location, data: ModelV2Info[] }` (a protocol object, not a bare array) |
| `GET /api/permission/request` + `POST /api/session/{id}/permission/{rid}/reply` | MAP | at least one SSE connection must stay open (as with a real TUI) to receive mux approval frames |
| `goal/change` | MAP | goal and todos merged (goal first), published via the `todo.updated` event |
| `POST /api/session/{id}/command` `/goal` | MAP | creates/views a goal; visible in the real TUI sidebar (`scripts/e2e-tui-goal.sh`) |
| `DSH_PERMISSION_MODE=ask` | not supported | dsh only accepts `read-only`/`workspace-write`/`danger-full-access`; approval=ask uses `workspace-write` |
| oc profile host lines | merged into the bundle patch | `storage`/`storage-json`/`storage-domain`/`webserver` are already mounted by `cordis.patch.yml`; `dsh --profile oc` starts directly (no host overlay needed) |
| `--print-logs` | passed through | oc-tui already passes `--print-logs` to `opencode --server` (an opencode top-level global option, setting `OPENCODE_PRINT_LOGS=1`) |
| timestamps | on by default | `DSH_OC_TUI_TIMESTAMPS=1` writes `timestamps: show` into `kv.json` and binds `ctrl+shift+t` / `/timestamps`; e2e in `scripts/e2e-tui-timestamps.sh` |
| tarball install e2e | PASSED | under `DSH_OC_E2E_ADD_SPEC=<tgz>`, `e2e-api.sh` / `e2e-tui-boot.sh` / `e2e-tui-turn.sh` / `e2e-tui-timestamps.sh` all pass; the profile installs the npm tarball and no longer uses a local path |

---

## 10. Automated protocol probe

`scripts/probe-opencode.mjs` checks against `tests/fixtures/opencode/routes.json`
(the real request list of the official 2.1.0 client) whether oc-bridge has registered every route, and validates
the version pinning of the opencode binary and `@opencode/client`:

```bash
pnpm run probe
node scripts/probe-opencode.mjs --version 2.1.0 --bin /path/to/opencode \
  --out .e2e/protocol-probe.json
```

Output: missing routes (`FAIL missing-route` plus a fix suggestion), binary/client version mismatch;
when everything is green it exits 0 and prints `PASSED`. The opencode upgrade procedure:

1. Update `opencode-version.json`;
2. run `pnpm install` (client version) and then `pnpm run probe`;
3. run `node scripts/check-client-routes.mjs` and confirm the official client routes report `missing: 0`;
4. fill in routes or stubs according to the probe result, and update this file's compatibility matrix.

There is also `node scripts/check-client-routes.mjs`: it parses the `@opencode/client` chunks directly, compares the official client's
route set with the route set the bridge registers, and only prints `missing: 0` when coverage is complete.

---

## 11. dsh 0.1.5 migration points (0.2.0-rc.4)

dsh 0.1.5 has two breaking changes to the host ABI that dsh-oc uses; the opencode-side protocol and the
2.1.0 probe matrix are unchanged.

### 11.1 session-controller's fileUploads

`dsh-api-session-controller`'s `static inject` adds `fileUploads`. The official provider
`@deepseek-ai/dsh-client-file-upload` is a browser transport plugin (injecting `connection`), and
oc-bridge does not mount a Web transport, so the bundle patch inserts a headless line before `session-controller`:

```yaml
- id: oc-file-uploads
  name: '@chiro2001/dsh-oc/file-uploads'
```

Service implementation (`src/bridge/file-uploads.ts`):
- `registerAgentResolver` / `retirePrompt` are no-ops;
- `bindPrompt` returns `{ commit(), [Symbol.dispose]() }` for a prompt without a receipt
  — 0.1.5 wraps that return value in explicit resource management (`using`), and a missing `Symbol.dispose` makes the
  prompt fail with `session/agent-busy`;
- `resolve` / `uploadStream` fail loudly for real file receipts (the bridge has no upload route;
  opencode attachments are mapped to prompt content in the convert layer and do not go through dsh upload).

### 11.2 assistant streaming and history

| Dimension | dsh 0.1.2 | dsh 0.1.5 (current) |
|---|---|---|
| real-time increments | persisted `assistant/chunk` session events | in-process `agent/assistant-stream` frames (`start`→`chunk`→`end`; `chunk.chunk` is still the same `StreamChunk` union) |
| attempt settlement | none | `assistant/attempt` (no surface, ignored) |
| history records | `SessionHistoryRecord = SessionEventEntry \| SessionChunkRun` (`chunkrow/*`) | only `SessionEventEntry`; `assistant/message.stream` / `assistant/attempt.stream` embed packed runs + raw chunks |
| part durations | block-start event time | live frames' `time`; cold reads use `assistantStreamTiming` reading raw `block-start`/`block-end` |
| finish reason | live `finish` chunk | same as above |
| dedup key | `sessionId:seq` | live `${sessionId}:${attemptId}:${revision}:${index}`; history rows still by seq |

`src/bridge/rpc.ts#expandRecord` expands embedded runs back into the
`text-chunks`/`reasoning-chunks`/`tool-call-chunks` rows that the 0.1.2-era translation layer already consumed, and appends the settlement event itself;
`src/bridge/convert/message.ts` uses `assistantStreamTiming` to merge raw part boundaries.
So history v1/v2, SSE ring replay and the opencode semantics of the golden trace stay stable.

### 11.3 File tools

dsh 0.1.5's `str_replace_editor` is no longer mounted by dsh-base (a base line in 0.1.2; 0.1.5 requires an
explicit opt-in); the default preset (`minimal`) only contains the persistent shell, and the host layer still provides
`dsh-tool-fs`'s `read`/`write`/`edit`. The bridge's tool-name mapping already covers
`write`/`edit`, and when a new file `write`'s result meta has empty diffs it synthesizes
`metadata.diff` from the call arguments; the e2e untracked write scenario now uses `write` (the `str_replace_editor`
mapping and its unit test are kept for deployments that explicitly opt in).
