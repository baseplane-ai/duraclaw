#!/usr/bin/env bash

set -euo pipefail

source "$(dirname "$0")/common.sh"

require_cmd curl
require_cmd jq
require_cmd agent-browser

print_section "commands"
echo "curl: $(command -v curl)"
echo "jq: $(command -v jq)"
echo "agent-browser: $(command -v agent-browser)"

print_section "gateway"
curl_json "$VERIFY_GATEWAY_READY_URL" | tee "$VERIFY_LOG_DIR/gateway-health.json" | jq -e '.status == "ok"' >/dev/null
echo "Gateway health OK"

print_section "orchestrator"
curl_json "$VERIFY_ORCH_READY_URL" | tee "$VERIFY_LOG_DIR/orchestrator-get-session.json" | jq -e '. == null or (.user != null)' >/dev/null
echo "Orchestrator auth endpoint OK"

print_section "summary"
echo "Artifacts written to $VERIFY_LOG_DIR"
