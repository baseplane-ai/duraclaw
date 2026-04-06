#!/usr/bin/env bash

set -euo pipefail

source "$(dirname "$0")/common.sh"

cd "$VERIFY_ROOT/apps/orchestrator"

if [[ -f "$VERIFY_ROOT/.env" ]]; then
  set -a
  source "$VERIFY_ROOT/.env"
  set +a
fi

export CC_GATEWAY_URL="$VERIFY_GATEWAY_WS_URL"
if [[ -z "${CC_GATEWAY_SECRET:-}" && -n "${CC_GATEWAY_API_TOKEN:-}" ]]; then
  export CC_GATEWAY_SECRET="${CC_GATEWAY_API_TOKEN}"
fi
export BETTER_AUTH_URL="$VERIFY_ORCH_URL"

exec pnpm exec vite dev --host 127.0.0.1 --port "$VERIFY_ORCH_PORT" --strictPort
