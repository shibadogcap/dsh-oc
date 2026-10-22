*English · [日本語](README.ja.md) · [中文](README.zh.md)*

# dsh-oc

An OpenCode TUI frontend for DeepSeek Harness (dsh): it uses the official OpenCode
terminal interface, and dsh provides the agent, sessions, tools, models, permissions
and questions.

[![CI](https://github.com/shibadogcap/dsh-oc/actions/workflows/ci.yml/badge.svg)](https://github.com/shibadogcap/dsh-oc/actions/workflows/ci.yml)
[![e2e](https://github.com/shibadogcap/dsh-oc/actions/workflows/e2e.yml/badge.svg)](https://github.com/shibadogcap/dsh-oc/actions/workflows/e2e.yml)

## How it works

- **Interface**: the official `opencode --server` TUI. It handles only terminal rendering, keyboard interaction and lifecycle.
- **Backend**: dsh provides the agent, sessions, tools, models, permissions and user questions.
- **Bridge**: dsh-oc serves an OpenCode-compatible HTTP/SSE bridge inside the dsh process and starts the official TUI.

```text
dsh (Node) ── dsh-oc bundle ── oc-bridge (HTTP/SSE) <── opencode TUI (--server)
                  │
                  └─ DSH Agent/Session/Tools/LLM/Approval/Questions
```

Current compatibility baseline: dsh `0.2.1-rc.2`, official opencode `2.1.0`. This
fork tracks the `feat-opencode-2-1` branch, which carries the dsh 0.2.1 and OpenCode
2.1.0 work; upstream `main` still points at the `v0.2.0-rc.4` prerelease. The package
keeps the upstream name `@chiro2001/dsh-oc` and is not published to the npm registry, so
installation and updates go through the GitHub source.

## Install and start

### Install from the fork

```bash
dsh plugin --profile oc add 'github:shibadogcap/dsh-oc#feat-opencode-2-1'
dsh --profile oc
```

The profile name here is `oc`, not `dsh-oc`. To update from the same source, run the
install command above again.

### Pinning a commit and the development lane

A branch is a moving ref, so pin a full commit SHA when you need a reproducible install:

```bash
dsh plugin --profile oc add 'github:shibadogcap/dsh-oc#<full-sha>'
```

To follow the branch again, re-run the install command from the section above. The npm
package name is `@chiro2001/dsh-oc`, but it is not published to the npm registry yet.

For local development you can link a working tree with
`dsh plugin --profile oc add .`; after changing TypeScript, run `pnpm build` and the
profile uses the new build.

After installation you can also use the `dsh-oc` shorthand. Add the profile's bin
directory to PATH:

```bash
export PATH="$HOME/.dsh/profiles/oc/node_modules/.bin:$PATH"
dsh-oc                        # same as dsh --profile oc
dsh-oc --mini                 # same as dsh --profile oc --mini
dsh-oc --version              # prints both the dsh-oc and dsh versions
```

pnpm warnings about missing peers such as `@deepseek-ai/cordis` are expected; the dsh
host provides those dependencies at runtime.

## Getting started in 5 minutes

Once started, you can type an ordinary task directly, for example "reply with only OK".
The common control commands are:

| Input | Effect |
|---|---|
| `!`, then a shell command | Run a shell command you specify in the full OpenCode TUI |
| `/preset` | List the available dsh agent presets |
| `/preset minimal` | Switch to the `minimal` preset without triggering a model turn |
| `/goal <objective>` | Create or view a goal; the state is synced to the sidebar |
| `/help` | Show a capability summary in the TUI |

### `!` shell mode

Type `!` in the full TUI input, then for example `printf DSH_OC_SHELL_OK` and press
Enter. dsh-oc starts the exact shell subprocess as the current OS user (on POSIX it uses
`$SHELL -c` with an absolute path, otherwise it falls back to `/bin/sh`; on Windows it
uses `ComSpec`, falling back to `cmd.exe` when that is missing). The `!` itself is the
user authorization boundary; the command does not go through dsh's model tools, approval
or sandbox waterfall. The TUI shows a shell tool card, the output and the exit result,
but no model reply is triggered; when the command finishes it is injected into the next
real prompt as a non-waking context explicitly labeled as user-executed, so the model can
see the command and its output. The injection itself does not open a new turn, and it is
not delivered late when the session is cleaned up.
stdout and stderr are each kept up to 1 MiB; past that the subprocess is still drained,
but a truncation marker is appended to the card, and the command is not killed for
exceeding the threshold. The context sent to the model has its own budget: at most 16 KiB
for the command, at most 64 KiB each for stdout and stderr, and about 144 KiB of total
text, with explicit truncation markers.
The command and its output are sent to the currently configured model and may contain
tokens, passwords or personal data; before using `!`, confirm that you are not leaking
sensitive information.

`--dir <path>` sets the bridge cwd; a recorded session cwd takes precedence, and the
value is used as the shell cwd fallback only on a cold start. The shell card is a
short-lived projection of the bridge and does not fake dsh agent-loop events; the
finished output can be reloaded from history within the current bridge lifetime.

### `/preset`

After you select an agent with `/preset <name>` or Tab in an empty session, the current
session and sessions created afterwards use that preset. The result card for `/preset`
ends as soon as the command completes, so you do not need to send another message to
clear the `QUEUED` state.

Once a session has produced a reply, dsh locks the agent preset; switching at that point
shows `Agent switch locked` once, so create a new session before switching.

## Browser access (official Web UI)

Besides the API, the bridge also serves the official OpenCode Web UI from the same origin,
so you can use it by opening the bridge address directly in a browser:

```bash
dsh --profile oc
```

The `bridge listening on http://127.0.0.1:<port>` line in the startup log is the address
to open in the browser. The official Web UI reaches the API through `location.origin`, so
with the same origin it needs neither CORS nor a login.

The Web UI files are resources embedded in the opencode binary. On its first run the
bridge extracts them to `$DSH_HOME/opencode/web-ui/<version>/` (currently `2.1.0`). The
bridge only looks for the opencode binary and does not install it for you; the TUI plugin
needs that binary anyway, so the Web UI appears from the next start. When the binary is
not found there is no Web UI, and the API is unaffected.

Note: the verification environment for dsh-oc has no real browser, so the Web UI
interactions were not exercised here. Two things are confirmed: the UI assets can be
served, and the official OpenCode 2.1.0 client can subscribe to the bridge event stream.

### Related environment variables

| Variable | Effect |
|---|---|
| `DSH_OC_HOST` | Bind address for the bridge, default `127.0.0.1` |
| `DSH_OC_PORT` | Listen port for the bridge, default is a random port |
| `DSH_OC_CORS` | Comma-separated list of origins allowed for cross-origin access, for a browser UI on the LAN. By default `localhost`, `127.0.0.1`, `oc://renderer`, the tauri origins and `*.opencode.ai` are allowed |
| `DSH_OC_WEB_UI` | Directory of the official Web UI (must be an extracted directory containing `index.html`). When unset, `$DSH_HOME/opencode/web-ui/<version>/` is used |
| `DSH_OC_HTTP_LOG` | Set to `1` to print every HTTP request to stderr (`[bridge/http] GET /api/info`), which shows the UI's call pattern when you have no browser |

## Capability status

> See [docs/FEATURES.md](docs/FEATURES.md) for the full matrix and
> [docs/PROTOCOL.md](docs/PROTOCOL.md) for protocol details; `dsh --profile oc --help`
> shows an offline capability summary.

| Capability | Status |
|---|---|
| Session list/new/continue/fork/compact, SSE streaming messages | ✅ |
| Official OpenCode Web UI (same origin as the API; open the bridge address in a browser) | ✅ |
| Session revert: stage/clear/commit, per-turn file rollback, session id unchanged, next prompt commits automatically | ✅ |
| Session titles, history restore and directory filtering | ✅ |
| Model catalog, reasoning effort, agent preset switching | ✅ |
| `!` shell mode (user-authorized OS shell, fixed bash tool card) | ✅ |
| Tool cards (bash/read/write/edit), argument streaming, diff and Modified Files | ✅ |
| Permission/question flow, subagent session tree and background subagents | ✅ |
| Goal create/view/pause/resume/complete | ✅ |
| Text/image attachments | ✅ (binaries such as PDF are not supported yet) |
| `Allow always` permission | 🟡 (remembered in memory for the current session only) |
| MCP servers configured in the dsh profile (tools appear as `mcp__<server>__<tool>`) | ✅ |
| git state: branch label, changed files, diff viewer (read-only) | ✅ |
| Provider entries in the integration dialog (credentials stay in the dsh profile) | ✅ |
| Default shell setting, persisted under `$DSH_HOME/opencode/config` | ✅ |
| Peripheral routes such as LSP / formatter / reference | ❌ (schema-valid stub) |

## MCP servers

MCP servers are dsh plugins, not bridge state. The bridge passes their tools
through unchanged and lists the servers whose tools registered, which is how
dsh signals a live connection. Install the client once, then add one entry per
server to the profile's `cordis.patch.yml`:

```bash
dsh plugin --profile oc add @deepseek-ai/dsh-mcp-client@0.2.1-rc.2
```

```yaml
- insert:
    - id: mcp-github
      name: "@deepseek-ai/dsh-mcp-client"
      config:
        serverName: github
        transport: stdio
        command: npx
        args: ["-y", "@modelcontextprotocol/server-github"]
        env:
          GITHUB_TOKEN: !!js process.env.GITHUB_TOKEN
```

For a remote server use `transport: streamable-http` with `url` and `headers`
instead of `command`/`args`/`env`. Restart dsh afterwards: the server's tools
appear to the model as `mcp__<serverName>__<tool>` and in the TUI as ordinary
tool cards, and the MCP panel lists the server as connected. Adding, removing
or toggling a server at runtime returns 400, because the profile owns the
configuration.

## Demo

<img src="docs/demo/dsh-oc-demo.gif" alt="dsh-oc core feature demo (real DeepSeek model)" width="900">

A real recording: branded startup screen → a real model runs `pnpm test` → all unit tests
pass → the exit prompt. To reproduce it, install from the fork as described above and run
`dsh --profile oc`.

## Startup arguments

These arguments are passed through to the official opencode TUI (dsh-oc starts the TUI as
`opencode --server <bridge-url>`; `--mini` uses `opencode mini --server <bridge-url>`):

- `--continue` / `-c`, `--session` / `-s`, `--fork`, `--dir`, `--mini`,
  `--print-logs`, `--log-level`

Example:

```bash
dsh --profile oc --session <session-id>
dsh --profile oc --dir ~/project --mini
```

Any other argument prints an explicit `ignored unsupported arg` warning and is never
dropped silently.

## Data, security and limits

- OpenCode configuration, data, state and cache are isolated under `$DSH_HOME/opencode`;
  models and credentials are managed by the dsh backend, and dsh-oc does not inject a
  provider or key into OpenCode.
- The official Web UI and the API share one port. The bridge binds to `127.0.0.1` by
  default, so the Web UI is reachable only from the local machine as well; before you
  change `DSH_OC_HOST` or `DSH_OC_CORS` to put the service on the LAN, think through that
  exposure.
- The official binary is pinned to `2.1.0`; auto-update, remote model catalog fetching and
  LSP downloads are all disabled.
- Shell mode is authorized by the user typing `!` explicitly and inherits the current OS
  user's permissions and the session cwd; it does not claim dsh approval/sandbox
  protection. Cancellation targets only the exact subprocess or process group registered
  by the current bridge/session and does not kill other processes by name; POSIX uses its
  own process group, and Windows uses `taskkill /T` on its own PID tree. Windows uses
  `ComSpec` (not dsh's pwsh sandbox), and that platform difference should be accepted
  separately on a Windows host.
- The shell path publishes the retained stdout/stderr only after the subprocess exits and
  provides no live output stream; each stream keeps up to 1 MiB, then continues draining
  and appends a truncation marker. The shell-only card is a bridge in-memory projection;
  there is also a dsh `agent/inbox/spliced` pending context for the next prompt, and after
  it is claimed it is not guaranteed to be kept verbatim through compaction.
- `Allow always` is remembered only within the current session and is cleared on restart.
- The official exit splash cannot be replaced; dsh-oc adds one line below it with dsh
  resume instructions, which you can turn off with `DSH_OC_DISABLE_EXIT_NOTE=1`.
- `--mini` does not load the TUI branding plugin, so the entry screen may still show the
  official OpenCode ASCII art; dsh-oc prints the DSH OC branding before startup.
- During a streaming turn, both the full TUI and `--mini` need two Esc presses to
  interrupt; dsh-oc turns that into `session.cancel`.
- While a tool turn is busy, a second message is queued and the official TUI's immediate
  transcript order may be temporarily off; content is neither lost nor duplicated, and the
  order is correct after you re-enter the session.
- Peripheral routes such as LSP/formatter/reference currently provide only
  schema-valid stubs and do not fake results.
- The session revert boundary is exclusive: the specified message and every message after
  it are discarded together at commit, and the session id stays the same (after the commit
  the conversation continues on a dsh fork). dsh cannot express an empty fork, so a cut
  point before the first message returns 400; the file diff is one coarse hunk between the
  first and last changed lines, not a full LCS diff.

## Troubleshooting: profile isolation and dsh-tui

`dsh-oc` loads only in the dsh process started by `dsh --profile oc`. Its bridge, OpenCode
configuration and compatibility shim are all local state of that process and do not modify
another profile across processes; do not install dsh-oc into the profile dsh-tui uses in
order to fix dsh-tui.

The dsh-tui launcher currently hardcodes `dsh --profile dsh-tui`, not the generic `tui`.
Both can exist at the same time; to inspect the actual composed tree read-only:

```bash
dsh --profile oc --dump-config
dsh --profile tui --dump-config
dsh --profile dsh-tui --dump-config
```

If you specifically want the profile name to be `tui`, you can install the dsh-tui bundle
and use that profile directly (the commands below are suggestions only; this round did not
run them against your profiles):

```bash
dsh plugin --profile tui add '@deepseek-harness-tui/dsh-tui@0.10.0-beta.5'
dsh --profile tui
```

Do not add the older dsh-dcp on that install path; the global `dsh-tui` command still
looks for the `dsh-tui` profile and does not redirect to `tui`.

If dsh-tui shows `turn error · events is not iterable`, check its dsh-dcp version and peer
ABI first. Older dsh-dcp still reads `session.events`, which dsh 0.1.2 removed, while the
new interface is `session.snapshotEvents()`; this is not a conflict between dsh-oc and
dsh-tui. Upgrade to a dsh-dcp that matches the current dsh ABI, or temporarily disable
`dcp` only in dsh-tui's own profile patch or diagnostic overlay (`- id: dcp` /
`disabled: true`), and report the issue upstream to dsh-dcp/dsh-tui.

## Updates and development

See [docs/RELEASE.md](docs/RELEASE.md) for stable versions, release candidates and the
full release gate; see [docs/CHANGELOG.md](docs/CHANGELOG.md) for the change log. See
[AGENTS.md](AGENTS.md) and [CONTRIBUTING.md](CONTRIBUTING.md) for the development
environment, branch strategy and self-test gate. See
[docs/MANUAL-TEST.md](docs/MANUAL-TEST.md) for manual regression steps and
[docs/ROADMAP.md](docs/ROADMAP.md) for the next stage of work.

Quick self-test:

```bash
pnpm run e2e:api   # quick API regression
pnpm run e2e       # full e2e (real opencode TUI)
```

## Acknowledgements

This fork builds on other people's work.

- [dsh-oc](https://github.com/shibadogcap/dsh-oc): the upstream project this fork
  follows. Its bridge design, protocol coverage and test suite are the
  foundation.
- [OpenCode](https://github.com/sst/opencode): the terminal UI, web UI and client
  protocol this project embeds and speaks. dsh-oc runs the official binary
  unchanged.
- DeepSeek Harness (dsh): the agent loop, sessions, tools, models, approvals and
  questions behind the bridge.
- OpenChamber: the compatibility suite the bridge is verified against.
- The MCP server and client implementers: the bridge passes their protocol
  through unchanged.
