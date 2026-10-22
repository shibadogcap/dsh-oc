#!/usr/bin/env bash
# dsh-oc goal API e2e: mock LLM drives create_goal, the bridge translates
# the durable goal/change into a merged todo.updated SSE event, and /goal
# works through the command registry.
set -euo pipefail
cd "$(dirname "$0")/.."
source tests/e2e/common.sh

SCRIPT_START=$SECONDS
E2E_ACTIVE_SESSION=""
SSE_PID=""

cleanup() {
  local code=$?
  if [[ -n "$SSE_PID" ]]; then
    kill "$SSE_PID" 2>/dev/null || true
    wait "$SSE_PID" 2>/dev/null || true
  fi
  if [[ -n "$E2E_ACTIVE_SESSION" ]]; then
    e2e_stop_dsh "$E2E_ACTIVE_SESSION" || true
  fi
  if [[ -n "$E2E_RUNID" ]]; then
    node "$E2E_ENV_JS" stop "$E2E_RUNID" >/dev/null 2>&1 || true
  fi
  exit "$code"
}
trap cleanup EXIT

e2e_new_run "api-goal" "danger-full-access" "tool_call_success,success" "0" \
  '{"objective":"ship e2e goal support"}' \
  "create_goal"
E2E_ACTIVE_SESSION="dsh-oc-api-goal"
e2e_start_dsh "$E2E_ACTIVE_SESSION"
e2e_wait_bridge_url
BRIDGE="$E2E_BRIDGE_URL"

curl -s "$BRIDGE/api/command" | jq -e '([.data[].name] | index("goal") != null)' >/dev/null
echo "  /api/command advertises /goal"

SSE_FILE="$E2E_RUN_DIR/goal-sse.txt"
curl -sN --max-time 120 "$BRIDGE/api/event" > "$SSE_FILE" &
SSE_PID=$!
sleep 2

# The v2 command route answers with 204, so the visible result of a command
# and the merged goal/todo list both travel over the SSE stream.
wait_sse() {
  local want="$1"
  local deadline=$((SECONDS + 90))
  while (( SECONDS < deadline )); do
    if grep -q -- "$want" "$SSE_FILE"; then return 0; fi
    sleep 1
  done
  echo "e2e: SSE payload not seen: $want" >&2
  return 1
}

wait_todo_state() {
  local content="$1"
  local status="$2"
  local deadline=$((SECONDS + 90))
  while (( SECONDS < deadline )); do
    if grep -q -- "\"content\":\"$content\",\"status\":\"$status\"" "$SSE_FILE"; then return 0; fi
    sleep 1
  done
  echo "e2e: todo $content / $status not seen" >&2
  return 1
}

# Run the goal surface on the standard preset: the goal tool must be in the
# session's catalog, which a deployment may restrict away from minimal.
SESSION="$(curl -s -X POST "$BRIDGE/api/session" -H 'Content-Type: application/json' -d '{"agent":"standard"}' | jq -er .data.id)"
echo "  goal session: $SESSION"
curl -s -X POST "$BRIDGE/api/session/$SESSION/prompt" -H 'Content-Type: application/json' \
  -d '{"parts":[{"type":"text","text":"e2e: create a goal"}]}' | jq -e --arg s "$SESSION" '.data.sessionID == $s' >/dev/null
echo "  goal prompt accepted"

wait_sse "Goal created: ship e2e goal support"
wait_todo_state "Goal: ship e2e goal support" "in_progress"
echo "  todo.updated carries the active goal"

curl -s -X POST "$BRIDGE/api/session/$SESSION/command" -H 'Content-Type: application/json' \
  -d '{"name":"goal","text":""}' >/dev/null
wait_sse "Status: active"
echo "  POST /api/session/$SESSION/command /goal shows the current goal"

SESSION2="$(curl -s -X POST "$BRIDGE/api/session" -H 'Content-Type: application/json' -d '{}' | jq -er .data.id)"
curl -s -X POST "$BRIDGE/api/session/$SESSION2/command" -H 'Content-Type: application/json' \
  -d '{"name":"goal","text":"ship a second goal"}' >/dev/null
wait_sse "Goal created: ship a second goal"
echo "  POST /api/session/$SESSION2/command /goal <objective> creates a goal"

curl -s -X POST "$BRIDGE/api/session/$SESSION2/command" -H 'Content-Type: application/json' \
  -d '{"name":"goal","text":"complete"}' >/dev/null
wait_sse "Goal completed"
echo "  /goal complete -> visible completion"
wait_todo_state "Goal: ship a second goal" "completed"
echo "  completed goal reflected in todo"

SESSION3="$(curl -s -X POST "$BRIDGE/api/session" -H 'Content-Type: application/json' -d '{}' | jq -er .data.id)"
curl -s -X POST "$BRIDGE/api/session/$SESSION3/command" -H 'Content-Type: application/json' \
  -d '{"name":"goal","text":"ship a paused goal"}' >/dev/null
curl -s -X POST "$BRIDGE/api/session/$SESSION3/command" -H 'Content-Type: application/json' \
  -d '{"name":"goal","text":"pause"}' >/dev/null
wait_todo_state "Goal: ship a paused goal" "pending"
echo "  /goal pause -> visible pause"
echo "  paused goal reflected as pending todo"

curl -s -X POST "$BRIDGE/api/session/$SESSION3/command" -H 'Content-Type: application/json' \
  -d '{"name":"goal","text":"resume"}' >/dev/null
wait_todo_state "Goal: ship a paused goal" "in_progress"
echo "  /goal resume -> visible resume"
echo "  resumed goal reflected as in_progress todo"

curl -s -X POST "$BRIDGE/api/session/$SESSION3/command" -H 'Content-Type: application/json' \
  -d '{"name":"goal","text":"clear"}' >/dev/null
wait_sse "Goal cleared"
echo "  /goal clear -> visible clear"
if grep -q -- '"content":"Goal: ship a paused goal"' "$SSE_FILE"; then
  # The cleared goal still appears in earlier todo.updated frames; the last
  # one must not carry it any more.
  LAST_TODO="$(grep -- '"type":"todo.updated"' "$SSE_FILE" | tail -1)"
  if grep -q -- '"content":"Goal: ship a paused goal"' <<<"$LAST_TODO"; then
    echo "e2e: cleared goal still present in todo" >&2
    exit 1
  fi
fi
echo "  cleared goal removed from todo"

kill "$SSE_PID" 2>/dev/null || true
wait "$SSE_PID" 2>/dev/null || true
SSE_PID=""
grep '^data: ' "$SSE_FILE" | sed 's/^data: //' > "$E2E_RUN_DIR/goal-sse-data.txt"
grep -q '"type":"todo.updated".*ship e2e goal support' "$E2E_RUN_DIR/goal-sse-data.txt"
echo "  SSE todo.updated carries the goal"

e2e_stop_dsh "$E2E_ACTIVE_SESSION"
e2e_stop_run

echo "e2e-api-goal: PASSED in $((SECONDS - SCRIPT_START))s"
