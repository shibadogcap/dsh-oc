# Flake mini-scan results — high-risk TUI scripts (2026-08-17, second round)

Following `scripts/flake-mini-scan.sh`: a semantic failure stops the scan
immediately, there are no retries within a scan, and the first-failure log is
kept. commit `9a591f2`, local Linux x64, opencode 1.18.18, mock LLM.

## Results

| Script | runs | passes | failures | Time per run |
|---|---|---|---|---|
| e2e-tui-queue-live.sh | 10 | 10 | 0 | 19–20s |
| e2e-tui-agent-tab.sh | 10 | 10 | 0 | 11–12s |
| e2e-tui-permission-mini.sh | 10 | 10 | 0 | 10–11s |

## Conclusion

- The two TUI scripts that flaked occasionally in CI (queueing while busy, Tab
  switching the agent) are 10/10 green on the first run at the fixed commit, with
  no semantic failures found.
- permission has been split into the minimal case `e2e-tui-permission-mini.sh` (a
  single Allow-once loop, 10–11s), 10/10 green on the first run; it is now in the
  stable suite. The full permission matrix is still covered on every regression by
  `e2e-tui-permission.sh` / `-ext`.
