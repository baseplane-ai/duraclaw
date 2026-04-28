#!/usr/bin/env bash
#
# scripts/verify/gh27-vp-runner-crash.sh
#
# Spec verification_plan: vp-runner-crash
# > kill -9 the runner while a Yjs peer adds content, THEN vim-edit the same
# > file on disk before restarting the runner → on runner restart, B7 Case C
# > fires; merged result contains BOTH the peer-added marker AND the disk
# > marker, in Yjs insertion-order. The test asserts both strings are
# > present in the final file, not their exact order.
#
# Strategy:
#   1. Launch docs-runner.
#   2. Use gh27-vp-yjs-client.mjs to add a paragraph block PEER_MARKER to
#      the DO's Y.Doc (acts as the "browser" peer). Confirm it lands on
#      disk via the runner.
#   3. kill -9 the runner.
#   4. Edit the file directly on disk (vim-style), inserting DISK_MARKER.
#   5. Restart the runner against the same worktree. On startup the runner
#      must:
#       a. Connect to the DO and observe the peer-side document state
#          (which still contains PEER_MARKER from step 2).
#       b. Reconcile against the disk's now-modified contents (which
#          contain BOTH markers — PEER_MARKER from the prior live sync,
#          plus DISK_MARKER from step 4).
#       c. Commit the merged result (B7 Case C: three-way merge).
#   6. Assert the on-disk file contains BOTH markers after the second
#      runner has stabilised. Assert /health=ok throughout.
#
# Exit 0 = pass.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=gh27-vp-common.sh
source "$SCRIPT_DIR/gh27-vp-common.sh"

vp_init "runner-crash"

REL="crash.md"
vp_seed_file "$REL" $'# Crash test\n\nBaseline body.\n'
vp_write_cmd '["**/*.md"]'

vp_launch_runner
vp_wait_health "ok" 30

# 2. peer adds content via Yjs (simulates browser before runner death)
PEER_MARKER="PEER_MARKER_$(date +%s)_$$"
REL_PATH="$REL" vp_yjs write-line "$PEER_MARKER" \
    >> "$VP_RUN_DIR/yjs-client-1.log" 2>&1 \
  || vp_fail "yjs-client write-line failed"
vp_log "peer added PEER_MARKER='$PEER_MARKER' via Y.Doc"

# wait for the peer's update to round-trip to the runner and land on disk
for _ in $(seq 1 20); do
  if grep -q "$PEER_MARKER" "$VP_WORKTREE/$REL"; then
    vp_log "peer marker landed on disk"
    break
  fi
  sleep 1
done
grep -q "$PEER_MARKER" "$VP_WORKTREE/$REL" \
  || vp_fail "PEER_MARKER did not propagate to disk via runner — $REL contents:\n$(cat "$VP_WORKTREE/$REL")"

# 3. kill -9 the runner mid-flow
vp_log "kill -9 runner pid=$(cat "$VP_BG_PID_FILE")"
vp_kill9_runner
sleep 2

# 4. vim-style disk edit while runner is dead
DISK_MARKER="DISK_MARKER_$(date +%s)_$$"
printf '%s\n' "$DISK_MARKER" >> "$VP_WORKTREE/$REL"
vp_log "wrote DISK_MARKER='$DISK_MARKER' to disk while runner is down"

# 5. relaunch runner against the same worktree
vp_log "relaunching runner"
vp_launch_runner
vp_wait_health "ok" 30

# 6. give the merge a moment, then assert both markers are present
for _ in $(seq 1 30); do
  if grep -q "$PEER_MARKER" "$VP_WORKTREE/$REL" && grep -q "$DISK_MARKER" "$VP_WORKTREE/$REL"; then
    break
  fi
  sleep 1
done

errs="$(vp_health_field 'metrics.syncs_err')"
[[ "${errs:-0}" -eq 0 ]] || vp_fail "syncs_err=${errs} after crash-recovery (expected 0)"

if ! grep -q "$PEER_MARKER" "$VP_WORKTREE/$REL"; then
  vp_log "$REL contents after merge:"
  cat "$VP_WORKTREE/$REL" >&2
  vp_fail "PEER_MARKER lost from disk after crash-recovery merge (B7 Case C violation)"
fi
if ! grep -q "$DISK_MARKER" "$VP_WORKTREE/$REL"; then
  vp_log "$REL contents after merge:"
  cat "$VP_WORKTREE/$REL" >&2
  vp_fail "DISK_MARKER lost from disk after crash-recovery merge (B7 Case C violation)"
fi

vp_pass "runner-crash: B7 Case C merge preserved both PEER_MARKER and DISK_MARKER after kill -9 + disk edit + restart"
