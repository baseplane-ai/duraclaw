#!/usr/bin/env bash

set -euo pipefail

source "$(dirname "$0")/common.sh"

require_cmd curl
require_cmd jq

bash "$VERIFY_ROOT/scripts/verify/auth.sh" >/dev/null

project_name="$(
  curl_json \
    -H "Origin: $VERIFY_ORIGIN" \
    -b "$VERIFY_COOKIE_JAR" \
    "$VERIFY_ORCH_URL/api/projects" | jq -r --arg verify_project "$VERIFY_PROJECT" '.projects | if $verify_project != "" then (map(select(.name == $verify_project))[0].name // "") else (.[0].name // "") end'
)"

if [[ -z "$project_name" ]]; then
  echo "No project available for ownership verification" >&2
  exit 1
fi

create_payload="$(
  jq -nc \
    --arg project "$project_name" \
    --arg prompt "Reply with exactly OWNER and nothing else." \
    --arg model "claude-haiku-4-5" \
    '{project: $project, prompt: $prompt, model: $model}'
)"

print_section "ownership-create"
session_id="$(
  curl_json \
    -H "Content-Type: application/json" \
    -H "Origin: $VERIFY_ORIGIN" \
    -b "$VERIFY_COOKIE_JAR" \
    -X POST \
    "$VERIFY_ORCH_URL/api/sessions" \
    -d "$create_payload" | jq -r '.session_id'
)"

if [[ -z "$session_id" || "$session_id" == "null" ]]; then
  echo "Ownership verification could not create a session" >&2
  exit 1
fi

echo "Created session: $session_id"

print_section "ownership-authenticated"
curl_json \
  -H "Origin: $VERIFY_ORIGIN" \
  -b "$VERIFY_COOKIE_JAR" \
  "$VERIFY_ORCH_URL/api/sessions/$session_id" | tee "$VERIFY_LOG_DIR/session-ownership-authenticated.json" | jq -e --arg id "$session_id" '.session.id == $id and (.session.userId // "") != ""' >/dev/null
echo "Authenticated owner access OK"

print_section "ownership-unauthenticated-http"
state_status="$(
  curl --silent --output "$VERIFY_LOG_DIR/session-ownership-unauthenticated-state.txt" --write-out "%{http_code}" \
    "$VERIFY_ORCH_URL/api/sessions/$session_id"
)"
if [[ "$state_status" != "401" ]]; then
  echo "Expected 401 for unauthenticated session state, got $state_status" >&2
  exit 1
fi

messages_status="$(
  curl --silent --output "$VERIFY_LOG_DIR/session-ownership-unauthenticated-messages.txt" --write-out "%{http_code}" \
    "$VERIFY_ORCH_URL/api/sessions/$session_id/messages"
)"
if [[ "$messages_status" != "401" ]]; then
  echo "Expected 401 for unauthenticated messages, got $messages_status" >&2
  exit 1
fi
echo "Unauthenticated HTTP access blocked"

print_section "ownership-unauthenticated-websocket"
set +e
ws_output="$(
  curl --silent --show-error --output "$VERIFY_LOG_DIR/session-ownership-unauthenticated-ws.txt" --write-out "%{http_code}" \
    -H "Connection: Upgrade" \
    -H "Upgrade: websocket" \
    -H "Sec-WebSocket-Version: 13" \
    -H "Sec-WebSocket-Key: SGVsbG8sIHdvcmxkIQ==" \
    "$VERIFY_ORCH_URL/api/sessions/$session_id/ws"
)"
ws_exit=$?
set -e

if [[ "$ws_exit" -eq 0 && "$ws_output" == "401" ]]; then
  echo "Unauthenticated WebSocket upgrade rejected with 401"
elif [[ "$ws_exit" -eq 52 ]]; then
  printf '%s\n' "Cloudflare Vite dev closed the unauthenticated upgrade before sending a response body; treated as blocked access." \
    >"$VERIFY_LOG_DIR/session-ownership-unauthenticated-ws-note.txt"
  echo "Unauthenticated WebSocket access blocked (empty upgrade close in local dev)"
else
  echo "Unexpected unauthenticated websocket result: exit=$ws_exit status=${ws_output:-none}" >&2
  exit 1
fi
