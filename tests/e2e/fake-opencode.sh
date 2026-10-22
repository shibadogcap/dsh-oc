#!/usr/bin/env bash
# Fake opencode binary used by the API e2e: answers `--version` and records
# every TUI argument into $DSH_OC_FAKE_LOG, then sleeps until signalled.
#
# OpenCode 2.x dropped the `attach` subcommand. The TUI now runs as
# `opencode --server <bridge-url>`; `--mini` selects the `mini` subcommand
# (`opencode mini --server <bridge-url>`).
set -u

case "${1:-}" in
  --version)
    printf '%s\n' '2.1.0'
    exit 0
    ;;
  --server)
    ;;
  mini)
    if [[ "${2:-}" != "--server" ]]; then exit 1; fi
    ;;
  *)
    exit 1
    ;;
esac

log="${DSH_OC_FAKE_LOG:?DSH_OC_FAKE_LOG must be set}"
printf '%s\n' "$@" > "$log"
sleep_pid=''
cleanup() {
  trap - TERM INT
  if [[ -n "$sleep_pid" ]]; then
    kill "$sleep_pid" 2>/dev/null || true
    wait "$sleep_pid" 2>/dev/null || true
  fi
  exit 0
}
trap cleanup TERM INT
while :; do
  # `read -t ... < /dev/null` returns EOF immediately and spins at 100%
  # CPU. Keep a real child wait instead; signals are handled by cleanup.
  sleep 3600 &
  sleep_pid=$!
  status=0
  wait "$sleep_pid" || status=$?
  sleep_pid=''
  [[ "$status" == 0 ]] || exit 0
done
