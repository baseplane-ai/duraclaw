#!/usr/bin/env bash
# ============================================================================
# setup-clone.sh — Bootstrap a freshly cloned duraclaw worktree
# ============================================================================
#
# What it does:
#   1. Copies .env.example → .env (if .env doesn't exist yet)
#   2. Prompts for / fills in required secrets from a source .env
#   3. Runs sync_dev_vars to generate apps/orchestrator/.dev.vars
#   4. Installs dependencies (pnpm install)
#   5. Prints the derived port pair so you know your URLs
#
# Usage:
#   scripts/setup-clone.sh                              # interactive — prompts for secrets
#   scripts/setup-clone.sh --from /path/.env            # copy secrets from another worktree's .env
#   scripts/setup-clone.sh --skip-install               # skip pnpm install
#   scripts/setup-clone.sh --reserve-for=arc:200        # stamp .duraclaw/reservation.json
#   scripts/setup-clone.sh --reserve-for=session:abcd   # session-bound reservation
#   scripts/setup-clone.sh --reserve-for=manual:branch  # manual operator reservation
#
# --reserve-for writes <ROOT>/.duraclaw/reservation.json so the gateway
# auto-discovery sweep (GH#115) classifies the clone correctly on first
# pass instead of falling back to the branch heuristic.
#
# ============================================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

FROM_ENV=""
SKIP_INSTALL=false
RESERVE_FOR=""

usage() {
  echo "Usage: $0 [--from /path/to/.env] [--skip-install] [--reserve-for=<kind>:<id>]" >&2
  echo "  <kind> ∈ { arc, session, manual }; arc <id> is parsed as integer." >&2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --from)
      FROM_ENV="$2"
      shift 2
      ;;
    --skip-install)
      SKIP_INSTALL=true
      shift
      ;;
    --reserve-for=*)
      RESERVE_FOR="${1#--reserve-for=}"
      shift
      ;;
    --reserve-for)
      RESERVE_FOR="$2"
      shift 2
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage
      exit 1
      ;;
  esac
done

echo "=== Duraclaw worktree setup ==="
echo "Root: $ROOT"
echo ""

# ---- Step 1: .env ----

if [[ -f "$ROOT/.env" ]]; then
  echo "[.env] Already exists — skipping copy"
else
  if [[ -n "$FROM_ENV" && -f "$FROM_ENV" ]]; then
    echo "[.env] Copying from $FROM_ENV"
    # Copy everything EXCEPT CC_GATEWAY_PORT (it's a footgun)
    grep -v '^CC_GATEWAY_PORT=' "$FROM_ENV" | grep -v '^# *CC_GATEWAY_PORT' > "$ROOT/.env"
    echo "[.env] Stripped CC_GATEWAY_PORT (ports are auto-derived per worktree)"
  elif [[ -n "$FROM_ENV" ]]; then
    echo "[.env] Source file not found: $FROM_ENV" >&2
    exit 1
  else
    echo "[.env] Creating from .env.example"
    cp "$ROOT/.env.example" "$ROOT/.env"
    echo "[.env] Edit $ROOT/.env and fill in the secrets, then re-run this script"
  fi
fi

# ---- Step 2: Validate required secrets ----

source_env_value() {
  local key="$1"
  local file="$ROOT/.env"
  if grep -q "^${key}=" "$file" 2>/dev/null; then
    grep "^${key}=" "$file" | head -1 | cut -d= -f2-
  fi
}

MISSING=()
for key in CC_GATEWAY_API_TOKEN; do
  val="$(source_env_value "$key")"
  if [[ -z "$val" ]]; then
    MISSING+=("$key")
  fi
done

if [[ ${#MISSING[@]} -gt 0 ]]; then
  echo ""
  echo "[warn] Missing required secrets in .env:"
  for k in "${MISSING[@]}"; do
    echo "  - $k"
  done
  echo ""
  echo "Fill them in and re-run, or use: $0 --from /data/projects/duraclaw/.env"
fi

# ---- Step 3: Generate .dev.vars ----

echo ""
echo "[.dev.vars] Generating via sync_dev_vars..."
# Source common.sh to get port derivation + sync_dev_vars
source "$ROOT/scripts/verify/common.sh"
sync_dev_vars
echo "[.dev.vars] Written to $ROOT/apps/orchestrator/.dev.vars"

# ---- Step 3b: Optional .duraclaw/reservation.json (GH#115) ----

if [[ -n "$RESERVE_FOR" ]]; then
  if [[ "$RESERVE_FOR" != *:* ]]; then
    echo "[reserve] Invalid --reserve-for value: '$RESERVE_FOR' (expected <kind>:<id>)" >&2
    usage
    exit 1
  fi
  RESERVE_KIND="${RESERVE_FOR%%:*}"
  RESERVE_ID="${RESERVE_FOR#*:}"

  case "$RESERVE_KIND" in
    arc|session|manual) ;;
    *)
      echo "[reserve] Invalid kind: '$RESERVE_KIND' (must be arc, session, or manual)" >&2
      exit 1
      ;;
  esac

  if [[ -z "$RESERVE_ID" ]]; then
    echo "[reserve] Missing id after kind in '$RESERVE_FOR'" >&2
    exit 1
  fi

  # arc id is an integer (GitHub issue number); session/manual are
  # arbitrary strings. Emit the JSON literal accordingly.
  if [[ "$RESERVE_KIND" == "arc" ]]; then
    if ! [[ "$RESERVE_ID" =~ ^[0-9]+$ ]]; then
      echo "[reserve] arc id must be a positive integer (got '$RESERVE_ID')" >&2
      exit 1
    fi
    ID_LITERAL="$RESERVE_ID"
  else
    # JSON-quote the string id and escape any embedded quotes/backslashes.
    ESCAPED_ID="${RESERVE_ID//\\/\\\\}"
    ESCAPED_ID="${ESCAPED_ID//\"/\\\"}"
    ID_LITERAL="\"$ESCAPED_ID\""
  fi

  RESERVE_USER_ID="${CC_DEFAULT_DISCOVERY_OWNER_USER_ID:-}"

  mkdir -p "$ROOT/.duraclaw"
  RESERVATION_FILE="$ROOT/.duraclaw/reservation.json"
  if [[ -n "$RESERVE_USER_ID" ]]; then
    ESCAPED_USER="${RESERVE_USER_ID//\\/\\\\}"
    ESCAPED_USER="${ESCAPED_USER//\"/\\\"}"
    cat > "$RESERVATION_FILE" <<EOF
{
  "kind": "$RESERVE_KIND",
  "id": $ID_LITERAL,
  "userId": "$ESCAPED_USER"
}
EOF
  else
    cat > "$RESERVATION_FILE" <<EOF
{
  "kind": "$RESERVE_KIND",
  "id": $ID_LITERAL
}
EOF
  fi
  echo "[reserve] Wrote $RESERVATION_FILE"
fi

# ---- Step 4: Install deps ----

if [[ "$SKIP_INSTALL" == "true" ]]; then
  echo ""
  echo "[deps] Skipped (--skip-install)"
else
  echo ""
  echo "[deps] Running pnpm install..."
  (cd "$ROOT" && pnpm install --frozen-lockfile 2>&1 | tail -5)
fi

# ---- Step 5: Link kata CLI ----

echo ""
echo "[kata] Linking kata CLI..."
"$ROOT/scripts/link-kata.sh"

# ---- Step 6: Print summary ----

echo ""
echo "=== Setup complete ==="
echo ""
echo "Worktree:     $ROOT"
echo "Orch port:    $VERIFY_ORCH_PORT  → http://127.0.0.1:$VERIFY_ORCH_PORT"
echo "Gateway port: $CC_GATEWAY_PORT   → http://127.0.0.1:$CC_GATEWAY_PORT"
if [[ -n "$RESERVE_FOR" ]]; then
  echo "Reservation:  $RESERVE_FOR (GH#115; gateway sweep will register on next pass)"
fi
echo ""
echo "Start local stack:  scripts/verify/dev-up.sh"
echo "Stop local stack:   scripts/verify/dev-down.sh"
echo "Seed test users:    scripts/verify/axi-dual-login.sh"
