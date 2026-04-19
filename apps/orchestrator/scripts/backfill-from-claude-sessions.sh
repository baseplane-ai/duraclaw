#!/usr/bin/env bash
# backfill-from-claude-sessions.sh — crawl ~/.claude/projects/*/**.jsonl
# and produce INSERT statements for agent_sessions in D1.
#
# Each .jsonl file is one SDK session. We extract:
#   - sdk_session_id (filename without .jsonl)
#   - project (parent dir name, decoded)
#   - first user message → prompt (truncated to 500 chars)
#   - first timestamp → created_at
#   - last timestamp → updated_at / last_activity
#   - assistant turn count → num_turns
#   - model from first assistant message
#   - message count (user + assistant)
#
# Usage:
#   bash scripts/backfill-from-claude-sessions.sh > backfill.sql
#   wrangler d1 execute duraclaw-auth --remote --file=backfill.sql

set -euo pipefail

CLAUDE_PROJECTS="$HOME/.claude/projects"
USER_ID="${BACKFILL_USER_ID:-4MPlzz0B9gAAaWMJh7wT0jQQ7VWjJhDh}"

escape_sql() {
  printf '%s' "$1" | sed "s/'/''/g"
}

echo "-- Backfill from ~/.claude/projects JSONL files"
echo "-- Generated: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
echo "-- User: $USER_ID"
echo "BEGIN TRANSACTION;"

COUNT=0

for project_dir in "$CLAUDE_PROJECTS"/*/; do
  project_name=$(basename "$project_dir" | sed 's/^-/\//' | tr '-' '/')
  # Convert path-encoded name back to readable form
  # e.g. -data-projects-duraclaw-dev1 → duraclaw-dev1
  project_short=$(basename "$project_dir" | sed 's/^-data-projects-//')

  for jsonl in "$project_dir"*.jsonl; do
    [ -f "$jsonl" ] || continue

    sdk_session_id=$(basename "$jsonl" .jsonl)

    # Skip tiny files (< 500 bytes — likely empty/corrupt)
    fsize=$(stat -c%s "$jsonl" 2>/dev/null || stat -f%z "$jsonl" 2>/dev/null || echo 0)
    [ "$fsize" -lt 500 ] && continue

    # Extract fields via jq — single pass for performance
    read -r created_at updated_at num_turns msg_count model prompt_raw < <(
      jq -r '
        [., input_line_number] | .[0]
      ' "$jsonl" 2>/dev/null | jq -rs '
        def first_ts: [.[] | select(.timestamp != null) | .timestamp] | first // "";
        def last_ts:  [.[] | select(.timestamp != null) | .timestamp] | last  // "";
        def turns:    [.[] | select(.type == "assistant")] | length;
        def msgs:     [.[] | select(.type == "user" or .type == "assistant")] | length;
        def mdl:      [.[] | select(.type == "assistant") | .message.model // empty] | first // "";
        def prm:      [.[] | select(.type == "user") | .message.content | if type == "array" then .[0].text // "" elif type == "string" then . else "" end] | first // "";
        [first_ts, last_ts, (turns | tostring), (msgs | tostring), mdl, (prm | .[0:500])] | @tsv
      ' 2>/dev/null
    ) || continue

    [ -z "$created_at" ] && continue

    prompt_escaped=$(escape_sql "$prompt_raw")
    project_escaped=$(escape_sql "$project_short")

    cat <<EOSQL
INSERT INTO agent_sessions (id, user_id, project, status, model, sdk_session_id, created_at, updated_at, last_activity, num_turns, prompt, archived, message_count, origin, agent)
VALUES ('$sdk_session_id', '$USER_ID', '$project_escaped', 'completed', $([ -n "$model" ] && echo "'$model'" || echo "NULL"), '$sdk_session_id', '$created_at', '$updated_at', '$updated_at', $num_turns, '${prompt_escaped:0:500}', 0, $msg_count, 'duraclaw', 'claude')
ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at, last_activity = excluded.last_activity, num_turns = excluded.num_turns, message_count = excluded.message_count, model = excluded.model;
EOSQL

    COUNT=$((COUNT + 1))
  done
done

echo "COMMIT;"
echo "-- Total: $COUNT sessions" >&2
