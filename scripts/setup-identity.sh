#!/usr/bin/env bash
# ============================================================================
# setup-identity.sh — Bootstrap a new Claude runner identity (GH#119)
# ============================================================================
#
# An "identity" is a logical name (e.g. work2, personal) that maps to an
# isolated $HOME directory containing its own ~/.claude/.credentials.json.
# The DO selects an available identity at spawn time and the gateway sets
# HOME=<runner_home> in the runner process env so the SDK picks up that
# identity's auth.
#
# Usage:
#   scripts/setup-identity.sh --name work2 --home /srv/duraclaw/homes/work2
#       Create the HOME skeleton and print next-step instructions.
#
#   scripts/setup-identity.sh --name work2 --home <path> --copy-from <path>
#       Clone settings.json (NOT credentials) from an existing HOME so the
#       new identity inherits MCP servers, hooks, etc.
#
#   scripts/setup-identity.sh --name work2 --home <path> --register
#       After authenticating the new HOME, register it with the orchestrator
#       (POST /api/admin/identities). Reads ORCH_URL and ADMIN_TOKEN from env.
#
# ============================================================================

set -euo pipefail

NAME=""
HOME_PATH=""
COPY_FROM=""
DO_REGISTER=false

usage() {
  cat <<'EOF'
setup-identity.sh — Bootstrap a Claude runner identity (GH#119)

Usage:
  scripts/setup-identity.sh --name <name> --home <home_path> [--copy-from <existing-home>] [--register]
  scripts/setup-identity.sh --help

Flags:
  --name        Logical identity name (e.g. work2). Required.
  --home        Absolute path to the new HOME directory. Required.
  --copy-from   Existing HOME whose ~/.claude/settings.json to clone (credentials are NOT copied).
  --register    POST the identity to the orchestrator. Reads ORCH_URL + ADMIN_TOKEN from env.
  --help        Show this message.

Environment (for --register):
  ORCH_URL       Base URL of the orchestrator (default: http://localhost:43613)
  ADMIN_TOKEN    Admin session bearer token. If unset, the script prompts.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --name)
      NAME="${2:-}"
      shift 2
      ;;
    --home)
      HOME_PATH="${2:-}"
      shift 2
      ;;
    --copy-from)
      COPY_FROM="${2:-}"
      shift 2
      ;;
    --register)
      DO_REGISTER=true
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "[setup-identity] Unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [[ -z "$NAME" ]]; then
  echo "[setup-identity] Missing required --name" >&2
  exit 1
fi
if [[ -z "$HOME_PATH" ]]; then
  echo "[setup-identity] Missing required --home" >&2
  exit 1
fi

CLAUDE_DIR="$HOME_PATH/.claude"

if [[ "$DO_REGISTER" != "true" ]]; then
  if [[ -e "$HOME_PATH" ]]; then
    echo "[setup-identity] Refusing to overwrite existing path: $HOME_PATH" >&2
    echo "[setup-identity] Remove it manually or pick a different --home" >&2
    exit 1
  fi

  echo "[setup-identity] Creating $CLAUDE_DIR"
  mkdir -p "$CLAUDE_DIR"

  if [[ -n "$COPY_FROM" ]]; then
    src_settings="$COPY_FROM/.claude/settings.json"
    if [[ -f "$src_settings" ]]; then
      echo "[setup-identity] Copying settings.json from $src_settings"
      cp "$src_settings" "$CLAUDE_DIR/settings.json"
    else
      echo "[setup-identity] No settings.json at $src_settings — skipping" >&2
    fi
  fi

  echo ""
  echo "[setup-identity] HOME skeleton ready at $HOME_PATH"
  echo ""
  echo "Next steps:"
  echo "  1. Authenticate this identity:"
  echo "       HOME=$HOME_PATH claude /login"
  echo ""
  echo "  2. Register with the orchestrator (admin-only):"
  echo "       scripts/setup-identity.sh --name $NAME --home $HOME_PATH --register"
  echo "     or POST manually:"
  echo "       curl -X POST \${ORCH_URL}/api/admin/identities \\"
  echo "         -H 'Content-Type: application/json' \\"
  echo "         -H 'Cookie: <admin session cookie>' \\"
  echo "         -d '{\"name\":\"$NAME\",\"home_path\":\"$HOME_PATH\"}'"
  exit 0
fi

# --- --register path ---

# `jq` is a runtime dependency of --register only — the bootstrap path above
# (HOME skeleton creation) does not need it. We build the JSON payload via
# `jq -n --arg` so values containing `"`, `\`, or newlines in $NAME / $HOME_PATH
# can't break out of the JSON shape (a naive `printf '{"name":"%s",...}'`
# would emit malformed JSON or worse).
if ! command -v jq >/dev/null 2>&1; then
  echo "[setup-identity] error: --register requires 'jq' (install with apt-get install jq)" >&2
  exit 1
fi

ORCH_URL="${ORCH_URL:-http://localhost:43613}"
TOKEN="${ADMIN_TOKEN:-}"
if [[ -z "$TOKEN" ]]; then
  read -r -s -p "[setup-identity] Admin bearer token (input hidden): " TOKEN
  echo ""
fi
if [[ -z "$TOKEN" ]]; then
  echo "[setup-identity] No admin token provided — aborting" >&2
  exit 1
fi

echo "[setup-identity] Registering '$NAME' at ${ORCH_URL}/api/admin/identities"
payload=$(jq -n --arg n "$NAME" --arg p "$HOME_PATH" '{name: $n, home_path: $p}')
http_code=$(curl -sS -o /tmp/setup-identity.resp -w '%{http_code}' \
  -X POST "${ORCH_URL}/api/admin/identities" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${TOKEN}" \
  -d "$payload" || true)

if [[ "$http_code" == "201" ]]; then
  echo "[setup-identity] OK — identity registered"
  cat /tmp/setup-identity.resp
  echo ""
else
  echo "[setup-identity] Register failed (HTTP $http_code):" >&2
  cat /tmp/setup-identity.resp >&2 || true
  echo "" >&2
  exit 1
fi
