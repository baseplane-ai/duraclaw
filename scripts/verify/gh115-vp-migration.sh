#!/usr/bin/env bash
#
# scripts/verify/gh115-vp-migration.sh
#
# VP: migration 0027 applies cleanly on a synthetic pre-migration
# fixture, and the post-state matches B-MIGRATION-1 expectations:
#   - worktrees table exists with a non-null id per row
#   - stale rows (stale=1) have been pre-cleaned
#   - agent_sessions.worktreeId is backfilled where a join was possible
#   - agent_sessions.worktree_info_json column has been dropped
#
# Strategy:
#   The fixture is hand-rolled SQL mirroring the legacy schema (pre-0027:
#   worktreeReservations table + agent_sessions w/ worktree_info_json).
#   We apply it to a temp sqlite database, then run the actual migration
#   file at apps/orchestrator/migrations/0027_worktrees_first_class.sql,
#   then assert via PRAGMA + SELECTs.
#
# Run: bash scripts/verify/gh115-vp-migration.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=gh115-vp-common.sh
source "$SCRIPT_DIR/gh115-vp-common.sh"

if ! command -v sqlite3 >/dev/null 2>&1; then
  vp_fail "sqlite3 not on PATH; install with 'apt-get install sqlite3'"
fi

MIGRATION="$VERIFY_ROOT/apps/orchestrator/migrations/0027_worktrees_first_class.sql"
if [[ ! -f "$MIGRATION" ]]; then
  vp_fail "migration file not found: ${MIGRATION}"
fi

TMPDIR_VP="$(mktemp -d)"
TMPDB="$TMPDIR_VP/test-0027.db"
PRE="$TMPDIR_VP/pre.sql"

cleanup_migration() {
  rm -rf "$TMPDIR_VP"
}
trap cleanup_migration EXIT

# Pre-migration fixture. Field names match the pre-0027 schema:
# worktreeReservations (camelCase columns from drizzle), and the legacy
# agent_sessions.worktreeInfoJson column that 0027 drops.
cat > "$PRE" <<'EOF'
-- Minimal pre-migration fixture. Mirrors pre-0027 schema enough for
-- migration 0027 to chew through.

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  name TEXT,
  email TEXT,
  role TEXT
);
INSERT INTO users VALUES ('u1', 'admin', 'admin@example.com', 'admin');

CREATE TABLE worktreeReservations (
  worktree TEXT PRIMARY KEY,
  issueNumber INTEGER NOT NULL,
  ownerId TEXT NOT NULL,
  heldSince TEXT NOT NULL,
  lastActivityAt TEXT NOT NULL,
  modeAtCheckout TEXT NOT NULL,
  stale INTEGER NOT NULL DEFAULT 0
);
INSERT INTO worktreeReservations VALUES
  ('duraclaw-dev1', 115, 'u1', '2026-04-27 00:00:00', '2026-04-27 12:00:00', 'implementation', 0),
  ('duraclaw-stale', 99, 'u1', '2026-01-01 00:00:00', '2026-01-15 00:00:00', 'implementation', 1);

CREATE TABLE agent_sessions (
  id TEXT PRIMARY KEY,
  userId TEXT,
  project TEXT,
  status TEXT,
  kataIssue INTEGER,
  worktreeInfoJson TEXT,
  createdAt INTEGER
);
INSERT INTO agent_sessions VALUES
  ('s1', 'u1', 'duraclaw-dev1', 'completed', 115, NULL, 1714000000000);
EOF

vp_log "Loading pre-migration fixture into ${TMPDB}"
sqlite3 "$TMPDB" < "$PRE"

vp_log "Applying migration ${MIGRATION}"
if ! sqlite3 "$TMPDB" < "$MIGRATION" 2> "$TMPDIR_VP/migration.err"; then
  vp_log "migration stderr:"
  cat "$TMPDIR_VP/migration.err" >&2
  vp_fail "migration 0027 failed to apply (sqlite3 returned non-zero)"
fi

# --- Post-condition assertions ---
vp_log "Asserting post-migration invariants"

# B-MIGRATION-1 step 1: stale rows pre-cleaned. We seeded 2 rows; 1 was
# stale=1; expect exactly 1 to remain.
ROW_COUNT="$(sqlite3 "$TMPDB" 'SELECT count(*) FROM worktrees;')"
if [[ "$ROW_COUNT" -ne 1 ]]; then
  vp_log "worktrees rows:"
  sqlite3 "$TMPDB" 'SELECT * FROM worktrees;' >&2 || true
  vp_fail "expected 1 worktrees row (stale row pre-cleaned), got ${ROW_COUNT}"
fi
vp_pass "stale row pre-cleaned (rows=${ROW_COUNT})"

# B-MIGRATION-1 step 2: every row has a non-null id.
NULL_IDS="$(sqlite3 "$TMPDB" 'SELECT count(*) FROM worktrees WHERE id IS NULL;')"
if [[ "$NULL_IDS" -ne 0 ]]; then
  vp_fail "${NULL_IDS} worktrees rows have NULL id; backfill broken"
fi
vp_pass "all worktrees rows have non-null id"

# B-MIGRATION-1 step 3: agent_sessions.worktreeId backfilled where the
# join was possible (kataIssue=115 + project=duraclaw-dev1 -> reservedBy.id=115).
WTID_ON_SESSION="$(sqlite3 "$TMPDB" 'SELECT count(*) FROM agent_sessions WHERE worktreeId IS NOT NULL;')"
if [[ "$WTID_ON_SESSION" -lt 1 ]]; then
  vp_log "agent_sessions:"
  sqlite3 "$TMPDB" 'SELECT id, kataIssue, project, worktreeId FROM agent_sessions;' >&2 || true
  vp_fail "agent_sessions.worktreeId not backfilled (expected ≥ 1 row with worktreeId set)"
fi
vp_pass "agent_sessions.worktreeId backfilled (rows=${WTID_ON_SESSION})"

# B-MIGRATION-1 step 4: worktree_info_json / worktreeInfoJson dropped.
DROPPED_COL_SNAKE="$(sqlite3 "$TMPDB" "PRAGMA table_info(agent_sessions);" | grep -c 'worktree_info_json' || true)"
DROPPED_COL_CAMEL="$(sqlite3 "$TMPDB" "PRAGMA table_info(agent_sessions);" | grep -c 'worktreeInfoJson' || true)"
if [[ "$DROPPED_COL_SNAKE" -ne 0 || "$DROPPED_COL_CAMEL" -ne 0 ]]; then
  vp_log "agent_sessions schema:"
  sqlite3 "$TMPDB" "PRAGMA table_info(agent_sessions);" >&2 || true
  vp_fail "agent_sessions still has worktree_info_json / worktreeInfoJson column"
fi
vp_pass "worktreeInfoJson column dropped from agent_sessions"

vp_pass "migration 0027 applied; backfill + drops match B-MIGRATION-1 expectations"
exit 0
