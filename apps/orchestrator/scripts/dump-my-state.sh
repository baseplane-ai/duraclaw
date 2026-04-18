#!/usr/bin/env bash
# dump-my-state.sh — capture the CURRENT user's DO state from a deployed
# worker into the JSON shape that scripts/export-do-state.ts expects.
#
# Limitation: this only captures the calling user's data because the
# deployed worker has no admin enumeration endpoint. A follow-up issue
# will add `GET /admin/dump-do-state` to produce a full multi-user dump.
# Until then, this is enough to seed a single-user rehearsal.
#
# Inputs (env vars):
#   WORKER_URL      — e.g. https://dura.baseplane.ai
#   SESSION_COOKIE  — value of the Better Auth session cookie (from devtools)
#   OUTPUT          — output path (default ./dump.json)

set -euo pipefail

if ! command -v jq >/dev/null 2>&1; then
  echo "ERROR: jq is required but not installed." >&2
  echo "  Install with: sudo apt-get install jq   (or: brew install jq)" >&2
  exit 1
fi

if [ -z "${WORKER_URL:-}" ]; then
  echo "ERROR: WORKER_URL is not set." >&2
  echo "  Example: WORKER_URL=https://dura.baseplane.ai" >&2
  exit 1
fi

if [ -z "${SESSION_COOKIE:-}" ]; then
  echo "ERROR: SESSION_COOKIE is not set." >&2
  echo "  Copy the Better Auth session cookie value from devtools." >&2
  exit 1
fi

OUTPUT="${OUTPUT:-./dump.json}"

TMPDIR="$(mktemp -d)"
trap 'rm -rf "$TMPDIR"' EXIT

SESSIONS_JSON="$TMPDIR/sessions.json"
TABS_JSON="$TMPDIR/tabs.json"
PREFS_JSON="$TMPDIR/preferences.json"

fetch() {
  local path="$1"
  local out="$2"
  curl -fsS \
    -H "Cookie: ${SESSION_COOKIE}" \
    -H "Accept: application/json" \
    "${WORKER_URL}${path}" \
    -o "$out"
}

echo "[dump-my-state] GET ${WORKER_URL}/api/sessions"
fetch /api/sessions "$SESSIONS_JSON"

echo "[dump-my-state] GET ${WORKER_URL}/api/user-settings/tabs"
fetch /api/user-settings/tabs "$TABS_JSON"

echo "[dump-my-state] GET ${WORKER_URL}/api/preferences"
fetch /api/preferences "$PREFS_JSON"

# Assemble into the shape export-do-state.ts expects:
#   { agent_sessions: [...], user_tabs: [...], user_preferences: [...] }
#
# user_preferences endpoint returns a single object — wrap in an array.
jq -n \
  --slurpfile sessions "$SESSIONS_JSON" \
  --slurpfile tabs "$TABS_JSON" \
  --slurpfile prefs "$PREFS_JSON" \
  '{
    agent_sessions: ($sessions[0] // []),
    user_tabs:      ($tabs[0]     // []),
    user_preferences: [ ($prefs[0] // {}) ]
  }' > "$OUTPUT"

# Summary
SESSIONS_COUNT=$(jq '.agent_sessions   | length' "$OUTPUT")
TABS_COUNT=$(jq     '.user_tabs        | length' "$OUTPUT")
PREFS_COUNT=$(jq    '.user_preferences | length' "$OUTPUT")

echo
echo "[dump-my-state] Wrote $OUTPUT"
echo "  agent_sessions:   $SESSIONS_COUNT"
echo "  user_tabs:        $TABS_COUNT"
echo "  user_preferences: $PREFS_COUNT"
