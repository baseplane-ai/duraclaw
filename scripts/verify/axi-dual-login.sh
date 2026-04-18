#!/usr/bin/env bash
#
# GH#8: End-to-end multi-user verify stack setup — idempotent.
#
# After running this you have:
#   - Browser A signed in as $VERIFY_USER_A_EMAIL
#   - Browser B signed in as $VERIFY_USER_B_EMAIL
# Each browser has its own cookie jar (separate user-data-dir), so the two
# sessions are fully independent.
#
# Preconditions: the orchestrator must be reachable at $VERIFY_ORCH_URL.
# This script will launch the dual browsers itself (idempotent) but won't
# start the app stack — use dev-up.sh or portless-up.sh for that first.
#
# Usage:
#     scripts/verify/axi-dual-login.sh
#
# To drive each user afterward:
#     scripts/verify/axi-a snapshot
#     scripts/verify/axi-b snapshot
#     scripts/verify/axi-both eval 'document.title'

set -euo pipefail

source "$(dirname "$0")/common.sh"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

require_cmd curl
require_cmd jq

print_section "preflight"
if ! curl --silent --show-error --fail "$VERIFY_ORCH_READY_URL" >/dev/null; then
  echo "Orchestrator not reachable at $VERIFY_ORCH_READY_URL" >&2
  echo "Run scripts/verify/dev-up.sh (or portless-up.sh) first." >&2
  exit 1
fi

print_section "browsers"
# Idempotent — no-op if both already listening.
bash "$SCRIPT_DIR/browser-dual-up.sh"

print_section "login A"
bash "$SCRIPT_DIR/axi-login" a

print_section "login B"
bash "$SCRIPT_DIR/axi-login" b

echo
echo "User A: $VERIFY_USER_A_EMAIL  →  scripts/verify/axi-a ..."
echo "User B: $VERIFY_USER_B_EMAIL  →  scripts/verify/axi-b ..."
echo "Both:                          scripts/verify/axi-both ..."
