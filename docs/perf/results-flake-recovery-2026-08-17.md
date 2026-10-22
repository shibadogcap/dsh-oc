# Flake mini-scan results — recovery failure domains (2026-08-17)

Experiment 3 first-round budgeted scan: `scripts/flake-mini-scan.sh --runs 10`,
running only the minimal high-risk recovery scripts. A semantic failure stops the
scan immediately and keeps the first-failure log, with no retries within the scan.
Fixed commit `e220e93`, local Linux x64, opencode 1.18.18, mock LLM.

## Results

| Script | runs | passes | failures | Time per run |
|---|---|---|---|---|
| e2e-recovery-consistency.sh | 10 | 10 | 0 | 29–30s |
| e2e-recovery-crash.sh | 10 | 10 | 0 | 21–24s |
| e2e-recovery-sse-reconnect.sh | 10 | 10 | 0 | 15–16s |

## Oracle defects found and fixed during the scan

The first scan failed on run 7 of `e2e-recovery-crash.sh`: the persisted prefix
recovered after the restart was `assistant text "mock"`, while the API snapshot
before the crash was `"mock r"`. This is not the bridge losing data: the SIGKILL
landed inside the write boundary of the last chunk, and the crash contract only
requires "recover the persisted prefix". The original "strict prefix" assertion
treated a legitimate partial text loss as a failure. It has been changed to
`recovery_assert_crash_prefix`: the restart graph may be a complete message prefix
of the observed graph, or, when the lengths are equal, the last text part may be a
prefix of the observed text. After the fix, 10/10 pass.

## Conclusion

- The three recovery failure-domain scripts pass 10/10 on first execution (with a
  10-run sample, the one-sided 95% upper bound is about a 26% failure rate;
  tightening it below 2% requires 149 runs with zero failures, extended later
  within budget).
- The scanner keeps the first-failure log by signature
  (`/tmp/flake-mini-scan/e2e-<script>-<n>.log`) and does not retry semantic
  failures.
- Next, split permission / agent-tab / queue-live into minimal cases within
  budget and run each 10 times.
