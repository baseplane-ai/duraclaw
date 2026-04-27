#!/usr/bin/env bash
#
# scripts/verify/gh27-vp-round-trip.sh
#
# Spec verification_plan: vp-round-trip
# > Edit in browser BlockNote → file on disk updates;
# > edit in vim → browser updates.
#
# Strategy:
#   1. Launch docs-runner against a 1-file tmp worktree.
#   2. Y.Doc peer (gh27-vp-yjs-client.mjs write-line BROWSER_MARKER):
#       a. Connect, sync, append a paragraph containing BROWSER_MARKER.
#       b. Wait until BROWSER_MARKER appears on disk via the runner
#          (DO → runner.onRemoteUpdate → bridge → SuppressedWriter).
#   3. vim-style disk edit appends DISK_MARKER. Then a second Yjs peer
#      (`wait-text DISK_MARKER`) connects and waits for DISK_MARKER to
#      appear in the DO's canonical document (runner.onLocalChange →
#      bridge → DO).
#   4. Both directions verified end-to-end.
#
# Exit 0 = pass.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=gh27-vp-common.sh
source "$SCRIPT_DIR/gh27-vp-common.sh"

vp_init "round-trip"

REL="trip.md"
vp_seed_file "$REL" $'# Round trip\n\nBaseline body.\n'
vp_write_cmd '["**/*.md"]'

vp_launch_runner
vp_wait_health "ok" 30

# Direction 1: peer (browser) → disk
BROWSER_MARKER="BROWSER_MARKER_$(date +%s)_$$"
REL_PATH="$REL" vp_yjs write-line "$BROWSER_MARKER" \
    >> "$VP_RUN_DIR/yjs-client.log" 2>&1 \
  || vp_fail "yjs-client write-line failed"
vp_log "browser peer wrote BROWSER_MARKER='$BROWSER_MARKER'"

for _ in $(seq 1 20); do
  if grep -q "$BROWSER_MARKER" "$VP_WORKTREE/$REL"; then
    vp_log "BROWSER_MARKER appeared on disk (peer → runner → disk)"
    break
  fi
  sleep 1
done
grep -q "$BROWSER_MARKER" "$VP_WORKTREE/$REL" \
  || { vp_log "$REL contents:"; cat "$VP_WORKTREE/$REL" >&2; vp_fail "browser → disk direction failed: BROWSER_MARKER missing"; }

# Settle: let chokidar's awaitWriteFinish (500ms) drain the runner's own
# write event before we make a separate manual edit. Without this, the
# two writes coalesce into one chokidar `change`, get swallowed by the
# B9 suppression entry, and the manual edit never reaches onLocalChange.
sleep 2

# Direction 2: disk (vim) → peer
DISK_MARKER="DISK_MARKER_$(date +%s)_$$"
printf '%s\n' "$DISK_MARKER" >> "$VP_WORKTREE/$REL"
vp_log "wrote DISK_MARKER='$DISK_MARKER' to disk (simulates vim edit)"

REL_PATH="$REL" vp_yjs wait-text "$DISK_MARKER" 30 \
    >> "$VP_RUN_DIR/yjs-client.log" 2>&1 \
  || { vp_log "yjs-client.log:"; tail -n 30 "$VP_RUN_DIR/yjs-client.log" >&2; vp_fail "disk → peer direction failed: DISK_MARKER not seen in DO within 30s"; }

vp_pass "round-trip: peer→disk and disk→peer both verified end-to-end"
