*English · [日本語](PLAN.ja.md) · [中文](PLAN.zh.md)*

# dsh-oc implementation plan

> ⚠️ Historical archive: this document is the implementation plan from the project's early stage, and the features are largely in place. For current capabilities see
> [FEATURES.md](FEATURES.md), for the protocol see [PROTOCOL.md](PROTOCOL.md), for the next phase see [ROADMAP.md](ROADMAP.md),
> and for the development guide see [../AGENTS.md](../AGENTS.md).
>
> Status: the plan is confirmed and the main work is done.
> `0.2.0-rc.1` migrated to dsh `>=0.1.2-rc.1` host services; from `0.2.0-rc.4` it targets dsh `>=0.1.5-rc.2`.
> The `apiProxy` structure kept in this document is historical background only; the runtime follows AGENTS/PROTOCOL.
> Repository: `chiro2001/dsh-oc` (may later move to `chiro/dsh-oc`).
> Intended readers: the models and engineers who implement dsh-oc according to this plan.

---

## 1. Goals and boundaries

### 1.1 Goals

Use the OpenCode TUI as the terminal frontend for DeepSeek Harness (dsh):

- **Frontend**: the official opencode CLI runs in `attach` mode and handles only rendering, keyboard input, and the terminal lifecycle.
- **Backend**: dsh handles all agent logic, sessions, tools, model calls, permissions, and user questions.
- **Connection**: dsh-oc implements an OpenCode-compatible HTTP/SSE service inside the dsh process and translates the opencode TUI's protocol requests into dsh service calls.

### 1.2 Non-goals (not in the first version)

- Do not fork or copy the opencode TUI source; the TUI uses the official released binary.
- Do not let opencode start its own server / agent / session / tool runtime.
- Do not cover all 162 opencode HTTP routes; unimplemented peripheral capabilities return schema-valid empty data or an explicit 501.
- Do not change the dsh core repository; dsh-oc is an external profile bundle.
- Do not use Bun in the dsh runtime.

---

## 2. Architecture

```text
┌──────────────────────────── dsh (Node) ──────────────────────────────────┐
│                                                                          │
│ profile "oc" = dsh-base + dsh-oc                                         │
│                                                                          │
│ dsh-base:                                                                │
│   agents, sessions, tools, llm, approval, userQuestions,                 │
│   sessionProjections, attachments, settings, credentials                 │
│                                                                          │
│ extra mounts from the dsh-oc bundle:                                     │
│   - workspace registry (@deepseek-ai/dsh-workspace)                      │
│   - directory picker  (@deepseek-ai/dsh-host-directory-picker-auto)      │
│   - api proxy        (@deepseek-ai/dsh-host-apiproxy)                    │
│   - oc-bridge        this repo, /bridge subpath                          │
│   - oc-tui           this repo, /tui subpath                             │
│                                                                          │
│ oc-bridge:                                                               │
│   node:http loopback server                                              │
│   implements the OpenCode v1 + v2 compatible routes                      │
│   calls ctx.apiProxy.*                                                   │
│   subscribes to ctx.apiProxy.events.mux() and forwards SSE               │
│                                                                          │
│ oc-tui:                                                                  │
│   resolves/caches the opencode binary                                    │
│   spawns `opencode attach http://127.0.0.1:<port>`                       │
│   stdio: inherit                                                         │
└──────────────────────────────────┬───────────────────────────────────────┘
                                   │ HTTP + SSE, loopback only
                                   ▼
                  opencode official binary (attach mode)
                  · runs only TUI/client code
                  · does not create an opencode backend instance
                  · reads all state from oc-bridge
```

---

## 3. Key decisions

| Decision | Conclusion | Rationale |
|---|---|---|
| TUI source | official `opencode-ai` binary + `opencode attach` | keep reusing official releases, maintain no UI fork |
| Backend ownership | dsh is the only backend | user goal: opencode acts only as the frontend |
| Protocol scope | implement the subset of v1 + v2 routes the TUI actually uses | probes prove the TUI calls both API generations |
| Model configuration | do not inject a DeepSeek API key into opencode | the dsh backend calls DeepSeek itself; the opencode TUI only shows the dsh model catalog |
| opencode data directory | isolate under `$DSH_HOME/opencode` | avoid reading the global opencode config, credentials, and sessions |
| Binary distribution | prefer the cache/installed copy, lazily download from the GitHub Release when missing | avoid the 350MB npm dual-binary dependency and postinstall self-repair |
| Process boundary | dsh=Node, opencode child process=official Bun self-contained binary | neither intrudes on the other |
| Compatibility strategy | return valid empty responses/501 for unimplemented routes, the UI does not break | keep the first version's scope under control |

---

## 4. Version and dependency baseline

### 4.1 opencode

- npm package: `opencode-ai@1.18.18`
- Source commit: `4643e65` (repository `anomalyco/opencode`, dev branch)
- GitHub Release: `v1.18.18`
- Release asset naming: `opencode-<linux|darwin|windows>-<x64|arm64>[-baseline][-musl].tar.gz` (`.zip` on Windows)
- Version updates: the dsh-oc repository keeps `opencode-version.json`; an upgrade means updating that file, regenerating the asset sha256 manifest, and running the protocol regression.

### 4.2 dsh

- The runtime is provided by the installed `@deepseek-ai/dsh` CLI (`dsh plugin --profile oc add ...`).
- During development use the same `deepseek-harness` checkout (cloning it next to dsh-oc is recommended).
- This repository references dsh packages through `peerDependencies` + `devDependencies`; at runtime they resolve through the profile's module fallback.
- dsh services/types used directly:
  - `@deepseek-ai/cordis`
  - `@deepseek-ai/dsh-cmdline` (`ctx.cmdlineArgs`, `ctx.appExit`)
  - `@deepseek-ai/dsh-home-paths` (`resolveDshHome`)
  - `@deepseek-ai/dsh-host-apiproxy` (`ctx.apiProxy` types; its plugin is mounted by the patch lines)
  - `@deepseek-ai/dsh-settings` / `dsh-credentials` (types and brand helpers)
  - `@deepseek-ai/dsh-session` (SessionEvent types)
  - `@deepseek-ai/dsh-llm` (ContentBlock / ModelSelection types)

---

## 5. Target repository structure

```text
dsh-oc/
├─ package.json
├─ tsconfig.json
├─ tsdown.config.ts
├─ cordis.patch.yml
├─ opencode-version.json            # pinned opencode version + commit
├─ opencode-assets.json             # generated: platform asset -> url/sha256/size
├─ src/
│  ├─ index.ts                      # bundle entry (exports types/constants only, no side effects)
│  ├─ bridge/
│  │  ├─ index.ts                   # oc-bridge plugin: server lifecycle + ctx.apiProxy wiring
│  │  ├─ router.ts                  # OpenCode v1/v2 route table
│  │  ├─ http.ts                    # node:http wrapper, CORS/error envelope
│  │  ├─ sse.ts                     # SSE encoder / client registry
│  │  ├─ events.ts                  # DSH mux frame -> OpenCode GlobalEvent
│  │  ├─ convert/
│  │  │  ├─ session.ts              # DSH SessionSummary -> OpenCode Session
│  │  │  ├─ message.ts              # DSH SessionEvent[] -> OpenCode Message/Part
│  │  │  ├─ tool.ts                 # tool/call + tool/result -> ToolPart
│  │  │  ├─ model.ts                # DSH ModelProviderGroup -> OpenCode Provider/Model
│  │  │  ├─ permission.ts           # DSH approval frame -> PermissionRequest
│  │  │  ├─ question.ts             # DSH question frame -> QuestionRequest
│  │  │  └─ todo.ts                 # DSH todos projection -> Todo[]
│  │  ├─ stubs.ts                   # schema-valid empty implementations for peripheral routes
│  │  └─ errors.ts                  # DSH RPC error -> OpenCode HTTP error
│  └─ tui/
│     ├─ index.ts                   # oc-tui plugin: spawn/signals/exit
│     ├─ binary.ts                  # binary location and lazy download
│     ├─ download.ts                # GitHub Release download + sha256 + atomic write
│     └─ platform.ts                # platform/arch/musl/AVX2 selection
├─ tests/
│  ├─ convert/*.spec.ts
│  ├─ bridge-router.spec.ts
│  ├─ binary.spec.ts
│  ├─ fixtures/
│  │  ├─ opencode/                  # request/response fixtures recorded by the protocol probe
│  │  └─ dsh/                       # DSH session-event fixtures
│  └─ e2e/
│     ├─ mock-llm.ts                # reuses dsh-llm-mock-server or a local mock
│     ├─ attach-boot.e2e.ts         # the official attach boots and requests oc-bridge
│     └─ session-turn.e2e.ts        # TUI sends a prompt -> DSH Agent -> messages flow back
└─ docs/
   ├─ PLAN.md                       # this document
   └─ PROTOCOL.md                   # protocol probe results and route list
```

---

## 6. package.json and cordis.patch.yml spec

### 6.1 package.json highlights

```json
{
  "name": "@chiro2001/dsh-oc",
  "version": "0.1.0-rc.1",
  "type": "module",
  "exports": {
    ".": "./lib/index.js",
    "./bridge": "./lib/bridge/index.js",
    "./tui": "./lib/tui/index.js",
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./package.json": "./package.json"
  },
  "files": ["lib", "cordis.patch.yml", "opencode-version.json", "opencode-assets.json"],
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    }
  },
  "dependencies": {
    "zod": "^4.0.0"
  },
  "peerDependencies": {
    "@deepseek-ai/cordis": ">=4.0.0",
    "@deepseek-ai/dsh-cmdline": ">=0.0.1-rc.1",
    "@deepseek-ai/dsh-home-paths": ">=0.0.1-rc.1"
  }
}
```

> Type-level devDependencies (not needed for publishing): `@deepseek-ai/dsh-host-apiproxy`, `@deepseek-ai/dsh-session`, `@deepseek-ai/dsh-llm`, `@deepseek-ai/dsh-settings`, `@deepseek-ai/dsh-credentials`.
> For the build, `tsdown` or `tsc` is recommended; the entry points produce `lib/bridge/index.js` and `lib/tui/index.js`.

### 6.2 cordis.patch.yml

```yaml
# Overlays on top of dsh-base; insertion order determines dependency activation order.
- insert:
    - id: workspace
      name: '@deepseek-ai/dsh-workspace'

    - id: directory-picker
      name: '@deepseek-ai/dsh-host-directory-picker-auto'

    - id: api-proxy
      name: '@deepseek-ai/dsh-host-apiproxy'

    - id: oc-bridge
      name: '@chiro2001/dsh-oc/bridge'
      inject: [apiProxy]

    - id: oc-tui
      name: '@chiro2001/dsh-oc/tui'
      inject: [ocBridge]
```

- `workspace` and `directory-picker` are static inject dependencies of `@deepseek-ai/dsh-host-apiproxy`, so dsh-oc must supply them.
- `oc-bridge` publishes the `ocBridge` service: `{ url: string, port: number }`.
- `oc-tui` starts only after `ocBridge` is ready; when `--help` is passed, does the launcher not attach `appExit` and terminate? The actual implementation follows the dsh app conventions.

### 6.3 Installation

```bash
# local development
cd dsh-oc
pnpm install && pnpm build
dsh plugin --profile oc add .
dsh --profile oc

# after release
dsh plugin --profile oc add chiro2001/dsh-oc
dsh --profile oc
```

`dsh plugin` initializes `$DSH_HOME/profiles/oc`, first writing `["@deepseek-ai/dsh-base"]`, and after detecting that this package declares `dsh.bundle`, appends it to become `["@deepseek-ai/dsh-base", "@chiro2001/dsh-oc"]`.

---

## 7. oc-bridge design

### 7.1 HTTP service

- Use `node:http`, listen on `127.0.0.1` with a random port (`port: 0`, read from `server.address()` after startup).
- Accept loopback connections only; all responses allow CORS `*` (attach mode needs no authentication; dsh/openCode-style basic auth can be added later).
- Shape JSON errors uniformly as opencode's `EffectHttpApiError*` / `NotFoundError` so the TUI does not treat a valid stub as a fatal error.
- After startup, expose `{ url }` through the Cordis service `ocBridge`.

### 7.2 DSH call wrapper

The methods of `ctx.apiProxy` use the RPC envelope style, which oc-bridge wraps uniformly:

```ts
async function call<K extends keyof DshApiProxy>(
  method: K,
  payload: RequestPayload<K>,
  signal?: AbortSignal,
): Promise<ResponseValue<K>> {
  const rpcId = randomUUID()
  const response = await api[method]({ rpcId, payload }, signal)
  return response.payload
}
```

All DSH RPC errors must be mapped to opencode HTTP errors, preserving `code`.

### 7.3 Route list (core subset)

The routes below are the ones **P1/P2 must implement**; the rest return stubs according to the table in `PROTOCOL.md`.

#### v1 (used by TUI sync and the main interaction)

| Method/path | Implementation |
|---|---|
| `GET /path` | Returns `{ path, worktree, directory }`, from `ctx.apiProxy.host` / `process.cwd()` |
| `GET /project/current` | Single-project stub; `id/worktree` generated as stable values from the dsh process cwd |
| `GET /project/global/directories` | Returns `[{ id, worktree: cwd, path: cwd }]` or an empty array |
| `GET /config` | Returns `{}` (opencode TUI local config is managed by the attach process's own `OPENCODE_CONFIG_DIR`) |
| `GET /config/providers` | Returns an empty config view, or a conversion from dsh `llm.providers` |
| `GET /provider` | Returns the dsh provider list (with models) |
| `GET /provider/auth` | Returns `{}`; dsh credentials are not managed by opencode |
| `GET /agent` | Returns one primary agent view or an empty array |
| `GET /command` | Converted from the dsh command registry; may be an empty array in the first version |
| `GET /session?start=…&path=…` | `apiProxy.sessions.list` → `Session[]` |
| `GET /session/status` | Returns `Record<id, SessionStatus>` based on the running flag from `apiProxy.sessions.list` |
| `POST /session` | `apiProxy.sessions.create`, returns an opencode `Session` |
| `GET /session/{id}` | `apiProxy.sessions.history` plus the matching entry in `list` → `Session` |
| `PATCH /session/{id}` | `apiProxy.sessions.rename` |
| `GET /session/{id}/message` | `apiProxy.sessions.history` → `Message[]` |
| `POST /session/{id}/prompt` | `apiProxy.sessions.prompt`; the content converts from opencode `PromptInput` to `PromptContentPart[]` |
| `POST /session/{id}/abort` | `apiProxy.sessions.cancel` |
| `GET /session/{id}/todo` | dsh `todos` projection → `Todo[]` |
| `GET /session/{id}/diff` | Convert when a produced-files projection exists, otherwise `[]` |
| `GET /global/event` | SSE: subscribe to `apiProxy.events.mux`, translate, and push |
| `GET /permission` | Current pending approvals → `PermissionRequest[]` |
| `POST /permission/{id}/reply` | Maps to the approval response of dsh `apiProxy.respond` |
| `GET /question` | Current pending questions → `QuestionRequest[]` |
| `POST /question/{id}/reply` | Maps to the question response of dsh `apiProxy.respond` |
| `POST /question/{id}/reject` | Calls `apiProxy.respond` with a cancelled client-response |

#### v2 (`/api/...`, used by the TUI data layer)

| Method/path | Implementation |
|---|---|
| `GET /api/location` | Returns `{ directory: cwd, workspaceID? }` |
| `GET /api/agent` | dsh subagent/preset information; an empty array or the primary agent in the first version |
| `GET /api/model` | `apiProxy.llm.models` → opencode `Model[]` |
| `GET /api/provider` | `apiProxy.llm.models/providers` → opencode `Provider[]` |
| `GET /api/command` | An empty array, or converted dsh commands |
| `GET /api/skill` | An empty array, or converted dsh skills |
| `GET /api/reference` | `[]` |
| `GET /api/integration` | `[]` |
| `GET /api/permission/saved` | `[]` (always-save is not supported in the first version) |
| `GET /api/session` | Same as the v1 list |
| `POST /api/session` | Same as the v1 create |
| `GET /api/session/{id}` | Same as the v1 get |
| `GET /api/session/{id}/message` | Same as the v1 messages |
| `GET /api/session/{id}/permission` | pending approvals for session |
| `POST /api/session/{id}/permission/{rid}/reply` | Same as the v1 permission reply |
| `GET /api/session/{id}/question` | pending questions for session |
| `POST /api/session/{id}/question/{rid}/reply` | Same as the v1 question reply |
| `POST /api/session/{id}/question/{rid}/reject` | Same as the v1 question reject |

> Note: probes show that the TUI calls both `/session*` and `/api/session*`; both sets must coexist and share one service implementation, with only the URL prefix differing.

### 7.4 SSE event bridge

`GET /global/event` keeps a long-lived connection:

1. Create one dsh mux consumer per SSE client:
   ```ts
   for await (const frame of apiProxy.events.mux({ rpcId, payload: {} }, signal)) {
     const event = convertMuxFrameToOpencodeEvent(frame)
     if (event) sse.write(`data: ${JSON.stringify(event)}\n\n`)
   }
   ```
2. Translate at least the following mux frames:
   - `session/event`:
     - `session/created`, `session/title` → `session.updated`
     - `turn/start` → `session.status` (busy)
     - `turn/end` → `session.idle`
     - `user/message`, `assistant/message`, `tool/result` → rebuild the corresponding `message.updated` / `message.part.updated`
     - `approval/asked|decided` → `permission.asked/replied`
     - `todo/write` → `todo.updated`
   - `approval/requested|resolved` → `permission.asked/replied`
   - `question/requested|resolved` → `question.asked/replied/rejected`
   - `session/queue` mirrors the pending inbox when the subscription is initialized (queued messages show as QUEUED in the TUI), maintained incrementally by `agent/inbox/spliced`; `session/jobs` is still ignored.
3. Events must carry `directory` (the session cwd) plus the optional `project`/`workspace` fields; the opencode TUI filters events by directory.
4. Cancel the dsh mux consumer when the SSE connection drops (with an `AbortController`).

### 7.5 Key object conversions

#### Session

Mapping between OpenCode `Session` and dsh `SessionSummary`:

```text
id            = dsh sessionId
slug          = id
directory     = summary.cwd ?? process.cwd()
projectID     = stable dsh-project-id (hash of cwd)
title         = summary.projections?.sessionTitle ?? ''
time.created  = dsh header.createdAt
time.updated  = summary.updatedAt
model         = the session's current model (the default when absent)
agent         = agentPreset ?? 'build'
```

#### Message / Part

Generated by folding the `events` of `apiProxy.sessions.history`:

- Each `user/message`:
  - produces a `UserMessage` plus a text `TextPart`; images become `FilePart` (the URL uses `GET /file/content` or a data URL; the first version may support text only).
- Each `assistant/message`:
  - produces an `AssistantMessage`;
  - text blocks in `message.content` → `TextPart`;
  - reasoning blocks → `ReasoningPart`;
  - `tool/result` paired with the corresponding `tool/call` produces a `ToolPart`;
  - the first version may rebuild the whole assistant message as a `message.updated` event to reduce part-level incremental events.
- `assistant/chunk`:
  - during SSE it may be left untranslated as a delta; send the full message at `assistant/message` or `turn/end` and prioritize correctness.

#### ToolPart

Mapping between dsh `tool/call` and `tool/result`:

```text
callId      = dsh callId
tool        = dsh tool name
state:
  call only       -> pending (raw input)
  result success  -> completed (input + output)
  result error    -> error
title        = the `title` of the tool presentation, or the tool name
metadata     = dsh meta (JSON-safe)
```

#### Model / Provider

Mapping of the `ModelProviderGroup` from `apiProxy.llm.models`:

- dsh provider `deepseek-official` → opencode provider id `deepseek` (display name `DeepSeek`).
- model id, name, and description pass through unchanged; `limit.context/output` uses the dsh capability values, falling back to safe defaults when missing (context 128000, output 8192).
- `capabilities` gets default values: `toolcall: true`, `reasoning: true`, `temperature: false`, input/output text.
- Model selection write-back: `POST /api/session/{id}/model` or the corresponding TUI call → `apiProxy.sessions.selectModel`.

#### Permission

- Keep an in-memory `opencodePermissionId -> dshRpcId` mapping table.
- When mux `approval/requested` arrives:
  - generate an opencode `PermissionRequest`:
    - `permission` uses the category matching `toolName` (bash → `bash`, fs → `edit`/`read`, others → `unknown`)
    - fill `patterns` and `metadata` with toolName/callId/reason
  - write both to the `/permission` list and to the SSE `permission.asked`.
- TUI submissions:
  - `once` → dsh `allowed-once`
  - `reject` → dsh `rejected`
  - `always` → handled as `allowed-once` in the first version, with the limitation recorded in `docs/PROTOCOL.md`.

#### Question

- Keep an `opencodeQuestionId -> dshRpcId` mapping table.
- Convert the `questions[]` (including `id`) of dsh `question/requested` into an opencode `QuestionRequest`:
  - opencode's `QuestionInfo[]` follows the dsh order; opencode answers return in array order.
  - Map answers back by index to dsh's `{ id, selected[], custom? }`.
- `multiSelect`, `header`, and `detail` pass through from the dsh fields unchanged.

#### Todo

- The dsh `todos` projection is a `TodoItem[]` whose fields are close to opencode `Todo`:
  - `status`: dsh `pending|in_progress|completed` → the same names in opencode; when there is no priority, use `medium`.
- Return `[]` when there is no projection.

### 7.6 Peripheral stub rules

`GET /lsp`, `/mcp`, `/formatter`, `/experimental/resource`, `/experimental/console`, `/experimental/capabilities`, `/vcs`, `/experimental/workspace*`:

- Return **valid empty arrays/objects**, never HTML or a bare 500.
- `experimental.capabilities` returns `{ backgroundSubagents: true }`; dsh sessions
  live on the server, the `subagent` tool runs in the background by default, and `POST /experimental/session/{id}/background`
  is a successful no-op (returns `true`).
- `vcs` returns a minimal shape such as `{ branch: '', status: [] }`.
- Every stub uses the real response of the same route on the official opencode server as a fixture to validate the schema.

---

## 8. oc-tui design

### 8.1 Binary acquisition priority

```text
1. env DSH_OC_OPENCODE_BIN (absolute path)
2. the $DSH_HOME/opencode/bin/<version>/opencode(.exe) cache, with --version matching
3. opencode on PATH, with --version matching
4. the official npm platform package (opencode-<platform>-<arch>[-baseline][-musl]@1.18.18),
   lazily installed into $DSH_HOME/opencode/packages/<platform-key>, verified with npm integrity
5. an opencode-ai package already installed in the profile (if present, run its official postinstall automatically, then use it)
6. lazy download of the official single-platform asset from the GitHub Release (per-platform sha256 manifest)
```

- The version comes from `opencode-version.json` and is currently pinned to `1.18.18`.
- Cache path: `$DSH_HOME/opencode/bin/1.18.18/opencode` (`.exe` on Windows).
- The candidate order for npm platform packages matches the official `postinstall.mjs`; the download URLs and the per-platform sha256 come from `opencode-assets.json`, which a script generates (see the `PROTOCOL.md` appendix).

### 8.2 Platform selection

Copy the selection logic from the official opencode postinstall:

- `process.platform` → darwin/linux/win32
- `process.arch` → x64/arm64
- Linux:
  - musl detection: `/etc/alpine-release` or `ldd --version`
  - x64 without AVX2: select `-baseline` (read `/proc/cpuinfo`)
- Asset suffix:
  - Linux/macOS: `.tar.gz`
  - Windows: `.zip`

### 8.3 Download, verification, writing to disk

1. Download with Node `fetch` into `$DSH_HOME/opencode/tmp/<uuid>`.
2. Verify the digest in `opencode-assets.json` with `crypto.createHash('sha256')`; on failure delete and retry once.
3. Unpack:
   - POSIX: `tar -xzf`
   - Windows: PowerShell `Expand-Archive`
4. `chmod 0755`, then atomically rename into the cache directory; run `--version` again to verify.
5. Proxy: respect `HTTPS_PROXY`/`HTTP_PROXY`; if Node fetch does not proxy automatically, add `undici`'s `ProxyAgent` or document the `DSH_OC_OPENCODE_MIRROR` mirror URL.
6. On download failure, print clear instructions:
   - set `DSH_OC_OPENCODE_BIN`
   - or `dsh plugin --profile oc add opencode-ai@1.18.18`
   - or download the asset manually and place it in the cache path.

### 8.4 Launch

```text
spawn(opencodeBin, ['attach', bridgeUrl, ...tuiArgs], {
  cwd: process.cwd(),
  stdio: 'inherit',
  env: childEnv,
})
```

- `tuiArgs` passes only the arguments `attach` supports: `--continue`, `--session`, `--fork`, `--dir`, `--mini` (P0 may support only `--continue/--session/--dir` at first).
- For arguments `attach` does not support (such as `--model`, `--prompt`), print a warning and ignore them; never drop them silently.
- `childEnv`:
  - inherit `process.env`
  - `OPENCODE_CONFIG_DIR=$DSH_HOME/opencode/config`
  - `XDG_DATA_HOME=$DSH_HOME/opencode/data`
  - `XDG_STATE_HOME=$DSH_HOME/opencode/state`
  - `XDG_CACHE_HOME=$DSH_HOME/opencode/cache`
  - **Do not set** `OPENCODE_CONFIG_CONTENT` to configure the DeepSeek provider/key; the dsh backend handles models and credentials.
  - When `DSH_OC_TUI_TIMESTAMPS=1`, additionally write `timestamps: show` into `$DSH_HOME/opencode/state/opencode/kv.json`
    and generate a `tui.json` with `ctrl+shift+t`.

### 8.5 Signals and exit

- The plugin reads arguments through `ctx.cmdlineArgs` and exits through `ctx.appExit(code)`.
- After a successful spawn:
  - the child process holds the terminal raw mode;
  - when the parent receives SIGINT/SIGTERM it forwards them to the child and does not force-kill the child before it exits;
  - after the child exits, call `ctx.appExit(childExitCode)`.
- If the child is still alive when the plugin is disposed: SIGTERM → 5s → SIGKILL.
- A PTY e2e must verify terminal restoration (alternate screen, cursor, raw mode reset).

---

## 9. Test strategy

### 9.1 Unit tests

| Module | Coverage |
|---|---|
| `convert/session.ts` | all fields of SessionSummary → Session |
| `convert/message.ts` | user/assistant/tool event folding, compaction replace, empty history |
| `convert/tool.ts` | the four states pending/running/completed/error |
| `convert/model.ts` | provider/model mapping, defaults for missing fields |
| `convert/permission.ts` | id mapping, once/reject/always semantics |
| `convert/question.ts` | order of multiple questions, multiSelect, custom |
| `bridge/router.ts` | 200/error/empty data for every core route |
| `bridge/events.ts` | the full set of mux frame → SSE event translations |
| `tui/platform.ts` | linux musl/AVX2, darwin, windows selection |
| `tui/binary.ts` | priority order, cache hit, self-healing, download failure |

### 9.2 Protocol regression

- Re-record fixtures with the methods in `docs/PROTOCOL.md`.
- Start a mock oc-bridge, run the official `opencode attach`, and assert:
  - the TUI enters full screen;
  - every `GET` returns 200 with a valid schema;
  - no unhandled error logs appear on the TUI side.

### 9.3 DSH backend e2e

- Reuse the dsh test infrastructure and mount a mock LLM (`@deepseek-ai/dsh-llm-mock-server` or a local HTTP mock).
- Test directly through the oc-bridge HTTP API:
  - create session → prompt → read history → messages/tool cards correct
  - cancel/steer
  - the full approval/question flow
- Run `dsh --profile oc` through a PTY and simulate key presses:
  - create a new session
  - type a prompt
  - wait for the DSH Agent reply
  - exit and confirm the terminal is restored

---

## 10. Implementation phases and acceptance gates

### P0: Protocol probe and minimal mock (goal: the official attach starts reliably)

Deliverables:
- `docs/PROTOCOL.md` updated (including the fixture generation script)
- `src/bridge/stubs.ts` covering every boot route the probe found
- `tests/e2e/attach-boot.e2e.ts`

Acceptance:
- `opencode attach http://127.0.0.1:<mock>` enters the TUI
- every boot request returns 200 with a valid schema
- no uncaught exceptions

### P1: Core session path (goal: the TUI can operate dsh sessions)

Deliverables:
- the dsh-oc bundle patch mounting workspace/directory-picker/api-proxy
- the oc-bridge core `/session*`, `/api/session*`, `/global/event`
- convert session/message/tool
- oc-tui binary resolver + spawn + signal

Acceptance:
- `dsh --profile oc` starts
- the TUI creates a new session
- the DSH Agent runs after a prompt is sent (with a mock LLM)
- text, reasoning, and tool cards appear in the TUI in real time
- the session list and history resume work correctly

### P2: Interaction and models (goal: a complete human-machine loop)

Deliverables:
- bidirectional permission/question mapping and SSE
- model/provider listing and model selection write-back
- todo/diff mapping
- error mapping

Acceptance:
- a bash tool triggers an approval, the TUI shows the permission prompt, and allow once/reject takes effect
- `ask_user_question` shows a dialog in the TUI and the answer returns to DSH
- the model selector shows the DSH catalog, and DSH uses the new model after a switch

### P3: Peripheral routes and hardening (goal: no visible UI breakage)

Deliverables:
- maps or valid stubs for command/skill/file-search/vcs and similar
- download cache, mirror, proxy
- basic Windows/macOS verification (at least binary resolver + attach boot)

Acceptance:
- every probe route returns 200/501 with a valid schema
- the TUI's main menus do not crash
- a cache hit starts the TUI while offline
- the protocol regression passes

### P4: Release

Deliverables:
- README installation/usage/limitations
- the `opencode-assets.json` generation script
- npm publish dry-run / CI

Acceptance:
- a new environment runs with the three README steps
- `dsh plugin --profile oc add .` successfully writes the bundle list

---

## 11. Risks and mitigation

| Risk | Mitigation |
|---|---|
| the opencode TUI depends on both v1/v2 and has many protocol details | record fixtures with the real binary in P0; share the implementation of core routes; run the regression on every version |
| differences between the DSH and opencode message models cause rendering loss | treat the event+view of DSH `history` as authoritative and send full messages over SSE rather than fine-grained deltas |
| `always` permission has no DSH equivalent | degrade to `once` in the first version and state it explicitly; evaluate extending DSH permission presets later |
| an opencode binary upgrade breaks the attach routes | pin the version exactly; every upgrade must pass the protocol regression |
| the download source is unreachable | cache first; support a mirror; support a user-installed `opencode-ai` |
| dsh RPC errors are not mapped correctly and the TUI crashes | a uniform error envelope + schema fixture tests |
| terminal raw mode fails to restore | the PTY e2e must cover normal exit, signal exit, and timeout force-kill |

---

## 12. Definition of Done

Criteria for finishing the first version:

1. After `dsh plugin --profile oc add chiro2001/dsh-oc`, `dsh --profile oc` starts the official opencode TUI.
2. The TUI connects only to the dsh-oc bridge; no opencode local server/agent path appears.
3. Session creation, listing, history, prompt, and cancel all run through dsh, and the TUI renders them correctly.
4. approval, ask_user_question, and model selection are operable in the TUI and write back to dsh.
5. The opencode binary comes from an official release, with version and sha256 verification.
6. The core PTY e2e and the protocol regression pass.
7. The behavior of unimplemented routes is stated explicitly in `docs/PROTOCOL.md`.
8. The README explains installation, argument pass-through limitations, session/data isolation, and the differences from dsh-web.

---

## 13. Reference material

- `docs/PROTOCOL.md`: probe results, route classification, fixture method
- opencode source (clone to `../opencode` during development):
  - `packages/tui/src/context/{sdk,sync,data}.tsx`
  - `packages/tui/src/component/prompt/index.tsx`
  - `packages/opencode/src/cli/cmd/attach.ts`
  - `packages/opencode/src/server/routes/instance/httpapi/`
  - `packages/sdk/openapi.json`
  - `packages/opencode/script/postinstall.mjs`
- dsh source (clone to `../deepseek-harness` during development):
  - `packages/host/apiproxy/src/api-proxy.ts`
  - `packages/host/apiproxy/src/api/{sessions,events,llm,approvals,questions}.ts`
  - `packages/core/session/src/types.ts`
  - `packages/core/agent/src/index.ts`
  - `packages/bundle/{base,web-app}/cordis.patch.yml`
  - `apps/cli/src/{args,profile-boot,plugin}.ts`

---

## 14. Implementation status snapshot (2026-08-15)

> This chapter is the current implementation status appended later; sections 1-13 keep the historical plan unchanged.

### Landed

| Phase | Status | Notes |
|---|---|---|
| scaffold | ✅ Landed | `src/`, `tests/`, `tsdown.config.ts`, `cordis.patch.yml`, `opencode-version.json`/`opencode-assets.json` are all in place |
| bridge | ✅ Landed | oc-bridge: OpenCode v1/v2 routes, SSE, session/model/permission/question conversion |
| tui | ✅ Landed | oc-tui: binary resolution/download/verification, `attach` argument filtering, signal forwarding, data isolation |
| e2e | ✅ Landed | `scripts/e2e-api.sh`, `e2e-tui-boot.sh`, `e2e-tui-turn.sh`, `e2e-tui-stream.sh`, `e2e-tui-timestamps.sh` driven by `tests/e2e/{env.mjs,common.sh}` |
| profile-fix | ✅ Landed | host rows (`storage`/`storage-json`/`storage-domain`/`webserver`) merged into the bundle patch; `dsh --profile oc` starts directly |
| release | ✅ Landed | README/PROTOCOL/PLAN finalized; npm tarball e2e with `DSH_OC_E2E_ADD_SPEC=<tgz>` |

### Key commits

```text
68d8be5 fix(profile): bundle storage and webserver host rows so dsh --profile oc boots directly
042b5d3 test(e2e): api route matrix, sse turn, dsh profile boot and real opencode tui attach
beca54d merge: integrate oc-bridge and oc-tui
0af3147 feat(bridge): opencode-compatible HTTP/SSE bridge over dsh api proxy
81920ee feat(tui): opencode binary resolution, download, spawn and signal handling
```

Follow-up release commit: `chore(release): documentation and npm tarball end-to-end verification` (written together with this snapshot commit).

### Verification results

- `pnpm install` / `pnpm build` / `pnpm typecheck` / `pnpm test` / `pnpm pack:dry` all pass; `pack:dry` has no warning/error.
- Local path install e2e (`dsh plugin --profile oc add .`): all five scripts `PASSED`.
- npm tarball install e2e (`DSH_OC_E2E_ADD_SPEC=<tgz>`): all five scripts `PASSED`, and the profile has the tarball installed.
- The tarball contains `lib/index.js`, `lib/bridge/**`, `lib/tui/**`, `cordis.patch.yml`, `opencode-version.json`, `opencode-assets.json`, `package.json`, `README.md`.
