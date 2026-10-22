# Flake consolidated scan — current HEAD (2026-08-17)

`scripts/flake-mini-scan.sh --runs 10`, 10 runs each of 6 minimal high-risk
scripts, fixed commit `e1817df`, local Linux x64, opencode 1.18.18, mock LLM. A
semantic failure stops the scan immediately, there are no retries within a scan,
and the first-failure log is kept.

| Script | runs | passes | failures | Time per run |
|---|---|---|---|---|
| e2e-recovery-consistency.sh | 10 | 10 | 0 | 29–30s |
| e2e-recovery-crash.sh | 10 | 10 | 0 | 19–21s |
| e2e-recovery-sse-reconnect.sh | 10 | 10 | 0 | 13–14s |
| e2e-tui-permission-mini.sh | 10 | 10 | 0 | 10–11s |
| e2e-tui-queue-live.sh | 10 | 10 | 0 | 19–20s |
| e2e-tui-agent-tab.sh | 10 | 10 | 0 | 11–12s |

60 first runs in total, all green. With a 10-run sample, the one-sided 95% upper
bound is about 26%; tightening it below 2% requires 149 runs with zero failures
(follow-up runs are extended as needed within the release-lane budget).
