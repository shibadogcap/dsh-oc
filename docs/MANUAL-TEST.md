*English · [日本語](MANUAL-TEST.ja.md) · [中文](MANUAL-TEST.zh.md)*

# dsh-oc manual test guide

This document lists the recommended path and the expected behavior for verifying
dsh-oc by hand, for a quick regression before a release or after an upgrade;
automated coverage is in [FEATURES.md](FEATURES.md) and `scripts/e2e-*.sh`.

Prerequisites: the release line uses `dsh plugin --profile oc add 'github:shibadogcap/dsh-oc#feat-opencode-2-1'`;
to test a local working tree, use `dsh plugin --profile oc add .` and run
`pnpm build`. Run `dsh --profile oc` in a clean terminal; the profile name is
always `oc`.

## 1. Startup and branding

- Expected: the startup screen shows the **DSH OC** ASCII art (no longer OPENCODE),
  then enters the opencode TUI, with opencode `2.1.0` shown at the bottom.
- Try: `dsh --profile oc`; `dsh --profile oc --help` shows the capability summary.

## 2. Basic conversation

- In a new session, type one plain sentence (for example "reply only OK").
- Expected: the model reply appears normally; input streams while it arrives;
  the status bar shows the model and the elapsed time.
- Try: the session list (`ctrl+x l` opens the Sessions list) shows the session and
  its real title (title → directory name → id fallback); after
  `--continue` / `--session <id>` the history is complete.
- Queueing: give a long task (for example "write a 300-word essay and print it
  sentence by sentence"), then type a short message while the model is running.
  Expected: the second message appears at once with the QUEUED marker and starts
  automatically when the first finishes (verified against a real model; sending
  from the command line or the API works the same way).

## 3. Tools and permissions

Ask the model to run a command that needs elevation (for example put "run the
command" before `ls`) to trigger the `Permission required` dialog:

- `Allow once`: allows this call only; the same session asks again next time.
- `Allow always`: shows a confirmation; later calls to the same tool in the same
  session are allowed automatically; a new session still asks; the memory is
  cleared on restart.
- `Reject`: the command does not run, the TUI shows a rejection marker or error,
  and the file is not written.
- `Esc`: in standard mode this is equivalent to Reject; with `--mini` a
  "Reject permission" confirmation layer appears first, and Enter submits it.
- Question dialog (`ask_user_question`): `Down`/`Up` move between the options,
  Enter submits; Esc cancels, `/question` clears it and the turn ends.

## 4. Interrupt and cancel

- While the model outputs a long text: press Esc twice in a row in both the full
  TUI and `--mini`; the in-flight stream stops and the input becomes editable
  again; the thinking indicator must not keep spinning.
- Streaming error (for example SSE with no `[DONE]`, or an authentication
  failure): the sidebar shows readable error text (for example
  "SSE stream ended without [DONE]") instead of `[object Object]`.

## 5. Exit note

- Exit a session that has content (`exit`): the official opencode splash (logo +
  session id) still appears, and dsh-oc adds one line below it: the session id is
  the dsh session id, and `dsh --profile oc --session <id>` resumes it.
- `DSH_OC_DISABLE_EXIT_NOTE=1` turns the note off; exiting an empty session shows
  no splash.

## 6. agent / preset

- Empty session: `/preset` lists the available presets; `/preset minimal` or Tab
  switches the agent, and new sessions inherit the most recent choice.
- After `/preset minimal`, the `preset switched to minimal` card ends immediately;
  it must not stay at `QUEUED`, and clearing it must not need another message.
- Session that has started replying: dsh locks the switch; after the switch the
  first message shows one "Agent switch locked" notice instead of failing
  silently.

## 7. `!` shell mode

- In the official OpenCode TUI input, type `!` to enter Shell mode, then type
  `printf DSH_OC_SHELL_OK` and press Enter.
- Expected: one `bash` tool card appears, its status changes from running to
  completed, the output appears once, and no model reply is triggered; the
  `state.output` of the matching tool part in the API history contains
  `DSH_OC_SHELL_OK`. Then send a normal question about the command executed
  before; the model sees a command/output context clearly marked as "executed
  manually by the user"; the shell completion itself must not produce an extra
  model turn.
  Note: the command and its output are sent to the currently configured model, so
  do not run commands in `!` that leak tokens, passwords, or personal data; an
  over-long command or output shows an explicit truncation marker.
- Verification script: `scripts/e2e-tui-shell.sh`. The script uses its own tmux
  session, so ordinary shell commands do not kill other processes; shell
  execution inherits the current OS user's permissions, Agent maintenance manages
  idle ownership, and cancel applies only to that session's own exact child
  process or process group.

## 8. mini mode

- `dsh --profile oc --mini`: replies render once (no duplicates); press Esc twice
  in a row to interrupt a streaming turn; Esc on a permission adds one
  confirmation layer; exit behaves as in section 5.
- The three C-c presses in `scripts/e2e-tui-mini.sh` may produce `DSH_EXIT=130`
  (SIGINT), which is an acceptable exit code; whether 0 or 130, the dsh-oc exit
  note must appear.

## 9. subagent / Task panel

- Ask the model to call `subagent` or `subagent_fork`; the parent session shows
  the native `Spawn Task` / `Fork Task` card and the delegation description, not
  an unknown tool card.
- The Task card navigates to the actual child session; the child page still shows
  the correct parent relation, and the history of a one-shot child stays viewable
  after it finishes.
- Automated regression: `scripts/e2e-tui-subagent.sh` (isolated dsh profile +
  official `opencode --server` + observe-only monitor on the exact PID).

## 10. Other entry points

- `--dir <path>` changes the working directory (the base for paths and attachment
  validation); `--fork` forks from the current session; `--log-level` is passed
  through to opencode.
- Attachments: text and images can be sent; binaries such as PDF are rejected
  (400).
- `/goal` creates, views, pauses, resumes, and completes a goal, and the sidebar
  shows the same state. Typing `/goal <full goal>` directly in the TUI creates
  the full goal (regression: the input used to be split into `/goal` plus the
  previous message); an automatically started goal turn can be interrupted with
  Esc.
- `/help` shows the capability summary; `/preset` lists the agent presets.

## 11. Protocol endpoint smoke test (optional, developers)

After startup, take the bridge URL from the TUI process arguments
(`opencode --server http://127.0.0.1:<port>`):

```bash
B=http://127.0.0.1:<port>
curl -s $B/api/health                       # {"healthy":true}
curl -s $B/api/vcs                          # current git branch / default branch
curl -s $B/api/fs/read/README.md            # workspace file content
curl -s $B/api/fs/list                      # workspace directory
curl -s "$B/api/fs/find?query=README"       # file lookup
curl -s $B/api/permission/request           # {"data":[]} when nothing is pending
```

## 12. Known limitations review

- `Allow always` is cleared on restart; MCP/LSP/formatter/integration/reference
  are schema-valid stubs; the opencode exit splash cannot be replaced (only the
  note below it); the `multiple` option of `ask_user_question` has no visible
  multi-select interaction in the official TUI.

## 13. Display comparison with official opencode (2.1.0 + local mock)

Compare official `opencode --server` and dsh-oc item by item under the same mock
provider:

- Startup screen: official shows OPENCODE ASCII art; dsh-oc shows DSH OC ASCII
  art.
- Basic conversation: the user message and the assistant reply each render once;
  `+ Thought` shows while thinking, and the model and the elapsed time show when
  it finishes.
- Tool calls: one tool card (`$ <command>`) shows while running, and the output
  is appended when it completes; there is no "same call shown twice" and no
  "command card plus result card" duplication.
- Queued input: submit a new message while the model is busy; a QUEUED card
  appears at once and the message starts automatically when the first finishes;
  the same message never gets two cards.
- Exit: the official splash (logo + session id) and the dsh-oc note line both
  appear.
- A plain text reply (including reasoning) and the user message each render once;
  a tool call shows one tool card while running and the output plus the turn
  duration when it completes.

Reproduction steps: `scripts/e2e-tui-queue.sh`, `scripts/e2e-tui-abort.sh`,
`scripts/e2e-tui-permission.sh` cover most of the scenarios above; the real-model
regression is `scripts/e2e-real-llm.sh`.

Known residual difference (a live display limitation observed in official TUI
2.1.0): in the **live view** where a second message is queued while the model is
busy, the trailing text of a tool-call turn may render after the queued card; the
normalized bridge data already proves exactly-once and correct parentage (the
v1/v2 history merges the tool and the trailing text into the same message), and
the order is fully correct after re-entering the session with `--session`;
official opencode does not even keep that trailing text in the same scenario. The
precise attribution (renderer vs. bridge event validity) waits on a minimal
reproduction against official 2.1.0. `scripts/e2e-queued-order-repro.sh` was
added to record it: with a slow tool and a trailing text stream, queue a second
prompt from the keyboard, capture the panel order frame by frame during
streaming, and freeze the normalized SSE baseline
(`tests/fixtures/golden/queued-followup-1.18.18.sse.jsonl`); consecutive
mock-driven runs showed no transient misorder (61 frames per round). The
real-model version `scripts/e2e-real-queued-order.sh` (manual, real DeepSeek API)
reproduced the wire precondition in two consecutive runs: the trailing text
`message.part.delta` keeps arriving after the queued user event (seq 107/65)
(`wire_follow_after_queued=1`), and in 45 of 50 frames during streaming the reply
content renders below the queued card. Taken together the evidence supports the
direction that the official TUI live render order is affected by trailing text
that arrives after the queue. Official minimal-server attribution
(`scripts/minimal-oc-server.mjs` + `scripts/e2e-minimal-server-repro.sh`): no dsh
and no real model, only the bridge components feeding a scripted event sequence
to the official 2.1.0 TUI (queued-mid-followup fixture: trailing text part2
arrives after the queued user event), and the TUI still renders the complete
trailing text above the queued card (correct order, no transient misorder in 95
frames). That result points to a misorder that depends on an event interleaving
or message identity shape not covered in real sessions, and the final attribution
still needs the original event sequence of a real session reproduced on the
minimal server. The completion time of a turn message is now deferred to the end
of the turn, so the QUEUED marker stays correct until the whole turn finishes.

## 14. Process I/O observation (safe default)

`scripts/monitor-process-io.sh` only observes explicitly named PIDs by default
and never ends an external process; a normal exit is silent by default, and
reaching a threshold only warns on stderr and keeps recording. Add
`--report-exit` explicitly to report a normal exit. The log is TSV and contains
`read_bytes/write_bytes/rchar/wchar/RSS/CPU` plus the CPU delta: the log keeps
both the current cumulative value and the delta for this window; for an external
PID the first sample only establishes a baseline, while a `--start` process of
the script's own counts the counters already present in the first sample, and
PID/starttime guards against a negative delta caused by a child exiting or PID
reuse.

```bash
scripts/monitor-process-io.sh \
  --pid <pid> --include-descendants --interval 1 \
  --read-threshold 1073741824 --log /tmp/dsh-oc-io.tsv
```

A test process that the monitor script must start itself and clean up at the end
has to use `--start` explicitly; only that mode allows `--terminate-owned`, and
only for a process group the script created and verified:

```bash
scripts/monitor-process-io.sh --start --terminate-owned --samples 10 \
  --interval 1 --log /tmp/dsh-oc-owned.tsv -- sleep 30
```

Idle regression for the fake TUI binary: `tests/e2e/fake-opencode-idle.sh`. It
proves that the fixed fake binary no longer burns CPU/I/O in a busy loop on EOF.

Monitor safety self-tests: `tests/e2e/monitor-process-io-read.sh` verifies a
16 MiB `rchar` delta and the threshold warning;
`tests/e2e/monitor-process-io-owned.sh` verifies an owned child that ignores TERM,
a child that survives its root exiting early, and the protection against
terminating an external PID.

Real TUI e2e can set `DSH_OC_E2E_MONITOR_IO=1` optionally. It makes
`e2e_tui_wait_attach` resolve the exact `opencode --server` PID of the current run
and sample its process tree in observe-only mode; the log and the warnings go to
`E2E_RUN_DIR/opencode-attach-<pid>*.io.tsv` / `.io.warn` of the current run, and
warnings are still mirrored to stderr. The default sample interval is `0.25s` and
the read-window threshold is `32MiB`, overridable with
`DSH_OC_E2E_MONITOR_INTERVAL` and `DSH_OC_E2E_MONITOR_READ_THRESHOLD`. This
wiring passes no `--terminate-owned` and never ends the TUI by name; the monitor
ends by itself once the target exits. The matching shell regression without a TUI
is `tests/e2e/monitor-process-io-attach.sh`.

## 15. Profile isolation and dsh-tui troubleshooting

- Start dsh-oc only through `dsh --profile oc`; the bridge's compatibility shim
  exists only in that dsh process and does not leak into the `tui` or `dsh-tui`
  profile.
- The dsh-tui launcher always uses `dsh --profile dsh-tui`. `dsh --profile tui` is
  a different profile and may be empty or contain only dsh-base; confirm the
  actual composition tree with these read-only commands first:

  ```bash
  dsh --profile oc --dump-config
  dsh --profile tui --dump-config
  dsh --profile dsh-tui --dump-config
  ```

- If you really want to use the profile named `tui`, consider the suggested
  commands below; this round ran nothing against the user profile, and do not add
  the old dsh-dcp either:

  ```bash
  dsh plugin --profile tui add '@deepseek-harness-tui/dsh-tui@0.10.0-beta.5'
  dsh --profile tui
  ```

  The global `dsh-tui` command still looks for the `dsh-tui` profile and does not
  switch to `tui` automatically.

- If dsh-tui shows `turn error · events is not iterable`, check whether dsh-dcp
  still reads `session.events`. The interface in dsh 0.1.2 is
  `session.snapshotEvents()`; upgrade dsh-dcp, or disable `dcp` in the dsh-tui
  profile patch or a temporary diagnostic overlay. Do not install dsh-oc into the
  dsh-tui profile: it does not fix the ABI incompatibility, and it confuses
  profile isolation.
