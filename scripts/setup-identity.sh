#!/usr/bin/env bash
# ============================================================================
# setup-identity.sh — Bootstrap a new Claude runner identity (GH#119, GH#129)
# ============================================================================
#
# An "identity" is a logical name (e.g. work2, personal) that maps to an
# isolated $HOME directory containing its own ~/.claude/.credentials.json.
# The DO selects an available identity at spawn time and the gateway sets
# HOME=<runner_home> in the runner process env so the SDK picks up that
# identity's auth.
#
# GH#129: the HOME path is derived as ${IDENTITY_HOME_BASE}/${name} — admins
# no longer pass --home. Set IDENTITY_HOME_BASE in env (default
# /srv/duraclaw/homes); it must match the orchestrator's binding so the
# physical HOME the script creates and the path the runner is spawned
# under stay in lockstep.
#
# Usage:
#   scripts/setup-identity.sh --name work2
#       Create the HOME skeleton at ${IDENTITY_HOME_BASE}/work2 and print
#       next-step instructions.
#
#   scripts/setup-identity.sh --name work2 --copy-from work1
#       Clone settings.json (NOT credentials) from another identity's HOME
#       so the new identity inherits MCP servers, hooks, etc. The argument
#       is another identity name; its HOME is resolved via the same base.
#
#   scripts/setup-identity.sh --name work2 --register
#       After authenticating the new HOME, register it with the orchestrator
#       (POST /api/admin/identities). Reads ORCH_URL and ADMIN_TOKEN from env.
#
# Environment:
#   IDENTITY_HOME_BASE   Base directory for identity HOMEs.
#                        Default: /srv/duraclaw/homes
#   ORCH_URL             Orchestrator base URL (--register only).
#                        Default: http://localhost:43613
#   ADMIN_TOKEN          Admin bearer token (--register only).
#                        Prompted interactively if unset.
#
# ============================================================================

set -euo pipefail

NAME=""
COPY_FROM=""
DO_REGISTER=false

IDENTITY_HOME_BASE="${IDENTITY_HOME_BASE:-/srv/duraclaw/homes}"
# Strip trailing slash(es) so concatenation stays single-separator.
IDENTITY_HOME_BASE="${IDENTITY_HOME_BASE%/}"

usage() {
  cat <<'EOF'
setup-identity.sh — Bootstrap a Claude runner identity (GH#119, GH#129)

Usage:
  scripts/setup-identity.sh --name <name> [--copy-from <other-name>] [--register]
  scripts/setup-identity.sh --help

Flags:
  --name        Logical identity name (e.g. work2). Required.
                Must match [A-Za-z0-9_-]{1,64} — also enforced server-side.
  --copy-from   Another identity name whose ~/.claude/settings.json to clone
                (credentials are NOT copied). Resolved via IDENTITY_HOME_BASE.
  --register    POST the identity to the orchestrator. Reads ORCH_URL +
                ADMIN_TOKEN from env.
  --help        Show this message.

Environment:
  IDENTITY_HOME_BASE   Base for identity HOMEs (default: /srv/duraclaw/homes).
                       Must match the orchestrator's binding.
  ORCH_URL             Base URL of the orchestrator (default: http://localhost:43613)
  ADMIN_TOKEN          Admin session bearer token. If unset, the script prompts.
EOF
}

# Validate identity-name shape — same regex enforced server-side. Bash's
# `=~` keeps this dependency-free.
validate_name() {
  local n="$1"
  if [[ ! "$n" =~ ^[A-Za-z0-9_-]{1,64}$ ]]; then
    echo "[setup-identity] Invalid name '$n' — must match [A-Za-z0-9_-]{1,64}" >&2
    exit 1
  fi
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --name)
      NAME="${2:-}"
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
validate_name "$NAME"
if [[ -n "$COPY_FROM" ]]; then
  validate_name "$COPY_FROM"
fi

HOME_PATH="$IDENTITY_HOME_BASE/$NAME"
CLAUDE_DIR="$HOME_PATH/.claude"

if [[ "$DO_REGISTER" != "true" ]]; then
  if [[ -e "$HOME_PATH" ]]; then
    echo "[setup-identity] Refusing to overwrite existing path: $HOME_PATH" >&2
    echo "[setup-identity] Remove it manually or pick a different --name" >&2
    exit 1
  fi

  echo "[setup-identity] Creating $CLAUDE_DIR"
  mkdir -p "$CLAUDE_DIR"

  if [[ -n "$COPY_FROM" ]]; then
    src_settings="$IDENTITY_HOME_BASE/$COPY_FROM/.claude/settings.json"
    if [[ -f "$src_settings" ]]; then
      echo "[setup-identity] Copying settings.json from $src_settings"
      cp "$src_settings" "$CLAUDE_DIR/settings.json"
    else
      echo "[setup-identity] No settings.json at $src_settings — skipping" >&2
    fi
  fi

  # Wire shared symlinks (gh, gcloud, gitconfig, .config/*, .claude tools,
  # etc.) from the VPS user's HOME into this identity HOME. The only
  # thing left per-HOME is `.claude/.credentials.json` — that's what
  # gives each identity its own Anthropic rate-limit envelope. Default
  # mode is non-destructive: never clobbers a real file (so any
  # --copy-from settings.json above is preserved as a real file rather
  # than replaced by the shared symlink).
  SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
  if [[ -x "$SCRIPT_DIR/sync-identity-shares.sh" ]]; then
    echo "[setup-identity] Wiring shared symlinks via sync-identity-shares.sh"
    IDENTITY_HOME_BASE="$IDENTITY_HOME_BASE" \
      "$SCRIPT_DIR/sync-identity-shares.sh" --name "$NAME"
  else
    echo "[setup-identity] sync-identity-shares.sh not found — skipping shared symlinks" >&2
  fi

  echo ""
  echo "[setup-identity] HOME skeleton ready at $HOME_PATH"
  echo "[setup-identity] (derived from IDENTITY_HOME_BASE=$IDENTITY_HOME_BASE)"
  echo ""
  echo "Next steps:"
  echo "  1. Authenticate this identity:"
  echo "       HOME=$HOME_PATH claude /login"
  echo ""
  echo "  2. Register with the orchestrator (admin-only):"
  echo "       scripts/setup-identity.sh --name $NAME --register"
  echo "     or POST manually:"
  echo "       curl -X POST \${ORCH_URL}/api/admin/identities \\"
  echo "         -H 'Content-Type: application/json' \\"
  echo "         -H 'Cookie: <admin session cookie>' \\"
  echo "         -d '{\"name\":\"$NAME\"}'"
  exit 0
fi

# --- --register path ---

# `jq` is a runtime dependency of --register only — the bootstrap path above
# (HOME skeleton creation) does not need it. We build the JSON payload via
# `jq -n --arg` so values containing `"`, `\`, or newlines in $NAME can't
# break out of the JSON shape (a naive `printf '{"name":"%s"}'` would emit
# malformed JSON or worse).
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
payload=$(jq -n --arg n "$NAME" '{name: $n}')
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
