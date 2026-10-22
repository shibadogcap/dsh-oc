*English · [日本語](OPENCHAMBER.ja.md)*

# OpenChamber 2.5 compatibility

## Connection

The dsh-oc bridge serves the OpenCode v2 API (`/api/*`). OpenChamber 2.5 accepts
the connection when the version in `GET /api/info` is `2.0.20` or higher.

```
# 1. Start the bridge
dsh --profile oc

# 2. Check the bridge URL (the "bridge listening on ..." line in the startup log)
#    DSH_OC_PORT pins the port
DSH_OC_PORT=41800 dsh --profile oc

# 3. Start OpenChamber in external-host connection mode
OPENCODE_HOST=http://127.0.0.1:41800 OPENCODE_SKIP_START=true openchamber
```

`DSH_OC_HOST` changes the bind address and `DSH_OC_PORT` the listening port. The
defaults are `127.0.0.1` and a random port.

The official OpenCode Web UI is served from the same source as the bridge.
Opening `http://127.0.0.1:<port>/` in a browser starts the official UI, and the
UI calls the API against `location.origin`, so neither CORS nor login is needed.
The UI files are extracted from the opencode binary into
`$DSH_HOME/opencode/web-ui/<version>/` (`DSH_OC_WEB_UI` selects a different
directory).

## Verification

### Routes the UI calls at startup

dsh-oc answers every one of the following routes that
`packages/ui/src/sync/bootstrap.ts` calls at startup.

| Call | Route | dsh-oc response |
| --- | --- | --- |
| `server.info` | `GET /api/info` | version 2.1.0 |
| `location.get` | `GET /api/location` | directory and project |
| `project.list` | `GET /api/project` | the bridge's working directory (`Project`) |
| `config.get` | `GET /api/config` | empty configuration |
| `model.list` | `GET /api/model` | the dsh model catalog |
| `provider.list` | `GET /api/provider` | dsh providers |
| `agent.list` | `GET /api/agent` | dsh agent presets |
| `session.list` | `GET /api/session` | the dsh session list |
| `session.active` | `GET /api/session/active` | running sessions |
| `permission.request.list` | `GET /api/permission/request` | pending approvals |
| `form.list` | `GET /api/form` | pending questions |
| `vcs.get` | `GET /api/vcs` | working tree status |
| `shell.list` | `GET /api/shell` | background shells |
| `command.list` | `GET /api/command` | slash commands |
| `skill.list` | `GET /api/skill` | dsh skills |
| Events | `GET /api/event` | SSE stream |

### Send flow

| Call | Route | Notes |
| --- | --- | --- |
| `session.create` | `POST /api/session` | can specify `agent` |
| `session.prompt` | `POST /api/session/:id/prompt` | the v2 body is `{ id?, text, files?, agents?, skills? }` |
| `message.list` | `GET /api/session/:id/message` | `{ data, cursor }` |
| `session.get` | `GET /api/session/:id` | `{ data }` |
| `session.interrupt` | `POST /api/session/:id/interrupt` | `{ interrupted }` |

### Revert

OpenChamber's revert UI calls three routes. dsh-oc implements all three, and the
boundary is exclusive as in OpenCode 2.1.0 (the named message itself and every
later message are dropped at commit).

| Call | Route | dsh-oc response |
| --- | --- | --- |
| `session.revert.stage` | `POST /api/session/:id/revert/stage` | `{ data: { messageID, files? } }`. `files` is the diff of the files to roll back (those changed by the turns after the boundary) |
| `session.revert.clear` | `DELETE /api/session/:id/revert` | 204. Restores the files rolled back at stage |
| `session.revert.commit` | `POST /api/session/:id/revert/commit` | 204. Only the messages before the boundary message remain in the new conversation |

The files are already rolled back at stage time. The diff is computed before the
rollback, so it is not empty, and clear can restore it (commit keeps the
rolled-back content).

Commit forks the dsh session and **keeps the opencode session id** (an alias
points at the fork). The session list, the history, and SSE all remain reachable
under the original id (the list publishes the fork under the original id, and the
replaced session disappears). As in OpenCode, the next prompt first commits the
staged revert, and that prompt lands in the forked session.

The UI updates its state from three events: `session.revert.staged`,
`session.revert.cleared`, and `session.revert.committed`. dsh has no counterpart
for these three, so the revert routes emit them directly. The 1.18.18 SSE wrapper
(`payload.*`) carries the same `data` and streams at the same time.

OpenChamber's reducer maps `session.revert.staged` / `session.revert.cleared` to
`session.patched` (`patch.revert`) and keeps `session.revert.committed` as a sync
event unchanged. The UI uses all three, so keep emitting all three.

### Verification commands

```
# Are all 137 routes the official client can call registered?
pnpm run check:client-routes

# Run the startup calls and the send flow against a real bridge
pnpm run e2e:openchamber -- --bridge http://127.0.0.1:41800

# Run the bridge events through OpenChamber's own reducer
pnpm run e2e:openchamber-events -- --bridge http://127.0.0.1:41800

# Check in a browser, UI included (through Obscura)
node scripts/e2e-openchamber.mjs --bridge http://127.0.0.1:41800 \
     --chamber http://127.0.0.1:3000 --password <ui-password>
```

The browser E2E stops at the `/api/event` stream (see "Known failures" below).
Verify through the two paths: the API path and the reducer path.

`tests/contract/client.spec.ts` applies `@opencode/client` 2.1.0 to a real bridge
and checks that it is answered according to the contract.
`tests/contract/routes.spec.ts` compares the 137 routes of the official client
with the routes registered on the bridge and fails on any difference.
`tests/contract/events.spec.ts` checks that dsh events are converted to the v2
vocabulary.

## Event vocabulary

The bridge streams both the 1.18.18 event names and the 2.x event names. The
1.18.18 names stay because the bundled TUI reads them, and the 2.x names are read
by OpenChamber's reducer. The mapping table is in section 5.1 of
`docs/PROTOCOL.md`.

SSE frames are wrapped in the 2.x envelope (`id`, `created`, `type`, `durable`,
`location`, `data`) and also carry the 1.18.18 wrapper (`payload.*`) at the same
time.

## Known failures

- The authentication guard is mounted as `app.use('/api', ...)`, so an
  unauthenticated `/api/*` response has `Content-Type` `text/plain`. An OpenCode v2
  client checks the response content type first, so the response shows up as
  `UnsupportedContentType`. Authenticate first with `POST /auth/session`, and
  `/api/*` returns `application/json`.
- Obscura's browser cannot deliver a streaming HTTP response to `fetch()`. A
  header that promises a chunked response never resolves and the request hangs.
  Both OpenChamber 2.5 and the official OpenCode Web app stop at `/api/event`. A
  bare Node HTTP server that writes the same headers as the official opencode
  server (`text/event-stream`, no content-length) shows the same symptom, while
  responses that complete (such as `GET /api/info`) arrive.
  The official OpenCode 2.1.0 client (Node, not a browser) subscribes to the
  bridge's `/api/event` and receives `server.connected` in about 40 ms, so the
  stream on the bridge side is correct.
  In other words, a browser-level E2E (a Web UI that uses streaming) cannot run
  on Obscura as available in this environment. This is a limitation of the local
  tooling, not a dsh-oc limitation and not an OpenChamber limitation.
