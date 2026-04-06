#!/usr/bin/env bash

set -euo pipefail

source "$(dirname "$0")/common.sh"

require_cmd agent-browser
require_cmd curl
require_cmd jq

browser_session="${VERIFY_BROWSER_SESSION}-interaction"
snapshot_path="$VERIFY_LOG_DIR/session-interaction-snapshot.txt"
screenshot_path="$VERIFY_LOG_DIR/session-interaction.png"

bash "$VERIFY_ROOT/scripts/verify/auth.sh" >/dev/null

project_name="$(
  curl_json \
    -H "Origin: $VERIFY_ORIGIN" \
    -b "$VERIFY_COOKIE_JAR" \
    "$VERIFY_ORCH_URL/api/projects" | jq -r --arg verify_project "$VERIFY_PROJECT" '.projects | if $verify_project != "" then (map(select(.name == $verify_project))[0].name // "") else (.[0].name // "") end'
)"

if [[ -z "$project_name" ]]; then
  echo "No project available for session interaction verification" >&2
  exit 1
fi

create_session() {
  local prompt="$1"
  local payload
  payload="$(
    jq -nc \
      --arg project "$project_name" \
      --arg prompt "$prompt" \
      --arg model "claude-haiku-4-5" \
      '{project: $project, prompt: $prompt, model: $model}'
  )"

  curl_json \
    -H 'Content-Type: application/json' \
    -H "Origin: $VERIFY_ORIGIN" \
    -b "$VERIFY_COOKIE_JAR" \
    -X POST \
    "$VERIFY_ORCH_URL/api/sessions" \
    -d "$payload" | jq -r '.session_id'
}

wait_for_state() {
  local session_id="$1"
  local target_status="$2"
  local attempts="${3:-45}"

  for _ in $(seq 1 "$attempts"); do
    local state_json
    state_json="$(
      curl_json \
        -H "Origin: $VERIFY_ORIGIN" \
        -b "$VERIFY_COOKIE_JAR" \
        "$VERIFY_ORCH_URL/api/sessions/$session_id"
    )"
    local status_name
    status_name="$(jq -r '.session.status' <<<"$state_json")"
    if [[ "$status_name" == "$target_status" ]]; then
      printf '%s\n' "$state_json"
      return 0
    fi
    sleep 1
  done

  echo "Timed out waiting for session $session_id to reach $target_status" >&2
  return 1
}

wait_for_not_state() {
  local session_id="$1"
  local blocked_status="$2"
  local attempts="${3:-45}"

  for _ in $(seq 1 "$attempts"); do
    local state_json
    state_json="$(
      curl_json \
        -H "Origin: $VERIFY_ORIGIN" \
        -b "$VERIFY_COOKIE_JAR" \
        "$VERIFY_ORCH_URL/api/sessions/$session_id"
    )"
    local status_name
    status_name="$(jq -r '.session.status' <<<"$state_json")"
    if [[ "$status_name" != "$blocked_status" ]]; then
      printf '%s\n' "$state_json"
      return 0
    fi
    sleep 1
  done

  echo "Timed out waiting for session $session_id to leave $blocked_status" >&2
  return 1
}

wait_for_message_pattern() {
  local session_id="$1"
  local pattern="$2"
  local attempts="${3:-30}"

  for _ in $(seq 1 "$attempts"); do
    local message_json
    message_json="$(
      curl_json \
        -H "Origin: $VERIFY_ORIGIN" \
        -b "$VERIFY_COOKIE_JAR" \
        "$VERIFY_ORCH_URL/api/sessions/$session_id/messages"
    )"

    if jq -e --arg pattern "$pattern" 'any(.messages[]?; .type == "assistant" and (.data | test($pattern)))' <<<"$message_json" >/dev/null; then
      printf '%s\n' "$message_json"
      return 0
    fi

    sleep 1
  done

  echo "Timed out waiting for session $session_id messages to match: $pattern" >&2
  return 1
}

question_prompt='Before doing any work, call the AskUserQuestion tool exactly once with a single required confirmation question asking "Proceed with verification?" and wait for my response.'
tool_prompt='Use the Bash tool to run exactly this command in the project root: echo APPROVAL_CHECK > duraclaw-permission-check-bash.txt . Do not describe it; execute it.'

print_section "question-create"
question_session_id="$(create_session "$question_prompt")"
echo "Question session: $question_session_id"

question_state="$(wait_for_state "$question_session_id" "waiting_input")"
question_text="$(jq -r '.session.pending_question.questions[0].question // .session.pending_question.questions[0].text // empty' <<<"$question_state")"
if [[ -z "$question_text" ]]; then
  echo "Question session reached waiting_input without question text" >&2
  exit 1
fi

agent-browser --session "$browser_session" close >/dev/null 2>&1 || true
agent-browser --session "$browser_session" open "$VERIFY_ORCH_URL/login" >/dev/null
agent-browser --session "$browser_session" wait 1000 >/dev/null
agent-browser --session "$browser_session" fill 'input[placeholder="Email"]' "$VERIFY_AUTH_EMAIL" >/dev/null
agent-browser --session "$browser_session" fill 'input[placeholder="Password"]' "$VERIFY_AUTH_PASSWORD" >/dev/null
agent-browser --session "$browser_session" focus 'input[placeholder="Password"]' >/dev/null
agent-browser --session "$browser_session" press Enter >/dev/null
wait_for_browser_text "$browser_session" "Projects" body 24 250 >/dev/null
agent-browser --session "$browser_session" set viewport 1280 900 >/dev/null

print_section "question-browser"
agent-browser --session "$browser_session" open "$VERIFY_ORCH_URL/session/$question_session_id" >/dev/null
wait_for_browser_text "$browser_session" "Proceed with verification?" body 24 250 >/dev/null
body_text="$(agent-browser --session "$browser_session" get text body)"
if ! grep -q "Proceed with verification?" <<<"$body_text"; then
  echo "Expected AskUserQuestion prompt in session UI" >&2
  exit 1
fi

agent-browser --session "$browser_session" click '[data-testid="question-option-question-0-0"]' >/dev/null
agent-browser --session "$browser_session" click '[data-testid="question-submit"]' >/dev/null
agent-browser --session "$browser_session" wait 1200 >/dev/null
post_answer_state="$(wait_for_not_state "$question_session_id" "waiting_input")"
post_answer_status="$(jq -r '.session.status' <<<"$post_answer_state")"
if [[ "$post_answer_status" == "waiting_input" ]]; then
  echo "Question session did not accept the browser answer" >&2
  exit 1
fi

print_section "tool-create"
tool_session_id="$(create_session "$tool_prompt")"
echo "Tool detail session: $tool_session_id"
wait_for_not_state "$tool_session_id" "running" 90 >/dev/null || true
tool_messages="$(wait_for_message_pattern "$tool_session_id" 'duraclaw-permission-check-bash.txt' 30)"
if ! jq -e 'any(.messages[]?; .type == "assistant" and (.data | test("duraclaw-permission-check-bash.txt")))' <<<"$tool_messages" >/dev/null; then
  echo "Tool detail session did not record the expected bash command" >&2
  exit 1
fi

print_section "tool-browser"
agent-browser --session "$browser_session" open "$VERIFY_ORCH_URL/session/$tool_session_id" >/dev/null
wait_for_browser_visibility "$browser_session" '[data-testid="tool-part-toggle"]' true 24 250 >/dev/null
agent-browser --session "$browser_session" click '[data-testid="tool-part-toggle"]' >/dev/null
wait_for_browser_text "$browser_session" "duraclaw-permission-check-bash.txt" body 20 250 >/dev/null
tool_body_text="$(agent-browser --session "$browser_session" get text body)"
if ! grep -q "duraclaw-permission-check-bash.txt" <<<"$tool_body_text"; then
  echo "Expected bash tool details in session UI" >&2
  exit 1
fi

agent-browser --session "$browser_session" snapshot -i >"$snapshot_path"
agent-browser --session "$browser_session" screenshot "$screenshot_path" >/dev/null
agent-browser --session "$browser_session" close >/dev/null

print_section "summary"
echo "Session interaction verification OK"
echo "Snapshot:   $snapshot_path"
echo "Screenshot: $screenshot_path"
