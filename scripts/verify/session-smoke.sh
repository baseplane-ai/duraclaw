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
    "$VERIFY_ORCH_URL/api/projects" | tee "$VERIFY_LOG_DIR/session-projects.json" | jq -r --arg verify_project "$VERIFY_PROJECT" '.projects | if $verify_project != "" then (map(select(.name == $verify_project))[0].name // "") else (.[0].name // "") end'
)"

if [[ -z "$project_name" ]]; then
  echo "No project available for session smoke verification" >&2
  exit 1
fi

create_payload="$(
  jq -nc \
    --arg project "$project_name" \
    --arg prompt "Reply with exactly VERIFY and nothing else." \
    --arg model "claude-haiku-4-5" \
    '{project: $project, prompt: $prompt, model: $model}'
)"

print_section "session-create"
session_id="$(
  curl_json \
    -H "Content-Type: application/json" \
    -H "Origin: $VERIFY_ORIGIN" \
    -b "$VERIFY_COOKIE_JAR" \
    -X POST \
    "$VERIFY_ORCH_URL/api/sessions" \
    -d "$create_payload" | tee "$VERIFY_LOG_DIR/session-create.json" | jq -r '.session_id'
)"

if [[ -z "$session_id" || "$session_id" == "null" ]]; then
  echo "Session creation did not return a session_id" >&2
  exit 1
fi

printf '%s\n' "$session_id" >"$VERIFY_STATE_DIR/latest-session-id.txt"
echo "Created session: $session_id"

print_section "session-poll"
session_state_file="$VERIFY_LOG_DIR/session-state.json"
for _ in $(seq 1 60); do
  curl_json \
    -H "Origin: $VERIFY_ORIGIN" \
    -b "$VERIFY_COOKIE_JAR" \
    "$VERIFY_ORCH_URL/api/sessions/$session_id" >"$session_state_file"

  status="$(jq -r '.session.status' "$session_state_file")"
  if [[ "$status" == "idle" ]]; then
    break
  fi
  if [[ "$status" == "failed" || "$status" == "aborted" ]]; then
    jq '.' "$session_state_file" >&2
    echo "Session ended in non-success state: $status" >&2
    exit 1
  fi
  sleep 2
done

jq -e '.session.status == "idle" and .session.sdk_session_id != null and (.session.num_turns // 0) >= 1' "$session_state_file" >/dev/null
echo "Session completed successfully"

print_section "session-messages"
curl_json \
  -H "Origin: $VERIFY_ORIGIN" \
  -b "$VERIFY_COOKIE_JAR" \
  "$VERIFY_ORCH_URL/api/sessions/$session_id/messages" >"$VERIFY_LOG_DIR/session-messages.json"

jq -e '.messages | any(.[]?; .role == "assistant" and (.data | fromjson | .content | tostring | contains("VERIFY")))' "$VERIFY_LOG_DIR/session-messages.json" >/dev/null
echo "Assistant response persisted"
