#!/usr/bin/env bash

set -euo pipefail

source "$(dirname "$0")/common.sh"

require_cmd curl
require_cmd jq

bash "$VERIFY_ROOT/scripts/verify/auth.sh" >/dev/null

print_section "gateway-projects"
curl_json "${VERIFY_GATEWAY_AUTH_ARGS[@]}" "$VERIFY_GATEWAY_URL/projects" | tee "$VERIFY_LOG_DIR/gateway-projects.json" | jq -e 'type == "array"' >/dev/null

selected_project="$(
  jq -r \
    --arg verify_project "$VERIFY_PROJECT" \
    'if $verify_project != "" then (map(select(.name == $verify_project))[0].name // "") else (.[0].name // "") end' \
    "$VERIFY_LOG_DIR/gateway-projects.json"
)"

if [[ -z "$selected_project" ]]; then
  echo "Gateway returned no projects to verify" >&2
  exit 1
fi

echo "Using project: $selected_project"

print_section "gateway-files"
curl_json "${VERIFY_GATEWAY_AUTH_ARGS[@]}" "$VERIFY_GATEWAY_URL/projects/$selected_project/files?depth=1" | tee "$VERIFY_LOG_DIR/gateway-files.json" | jq -e '.entries | type == "array"' >/dev/null
echo "Project file tree OK"

print_section "gateway-git-status"
curl_json "${VERIFY_GATEWAY_AUTH_ARGS[@]}" "$VERIFY_GATEWAY_URL/projects/$selected_project/git-status" | tee "$VERIFY_LOG_DIR/gateway-git-status.json" | jq -e '.files | type == "array"' >/dev/null
echo "Project git status OK"

print_section "orchestrator-projects"
curl_json \
  -H "Origin: $VERIFY_ORIGIN" \
  -b "$VERIFY_COOKIE_JAR" \
  "$VERIFY_ORCH_URL/api/projects" | tee "$VERIFY_LOG_DIR/orchestrator-projects.json" | jq -e --arg project "$selected_project" '.projects | type == "array" and any(.[]?; .name == $project)' >/dev/null
echo "Orchestrator project proxy OK"
