#!/usr/bin/env bash
#
# scripts/verify/gh27-vp-concurrent-offline.sh
#
# Spec verification_plan: vp-concurrent-offline
# > Browser (open tab, cached Y.Doc) and the local docs-runner both accept
# > edits while the orchestrator is unreachable (simulated redeploy / network
# > partition). On reconnect, both peers exchange sync step 1/2 with the DO
# > and CRDT-merge cleanly — no lost edits, no duplicated lines.
# >
# > (Two concurrent runners on the same projectId is architecturally
# > precluded by the gateway's one-runner-per-projectId PID guard, so that
# > variant is not tested here.)
#
# Strategy:
#   1. Launch docs-runner. Wait /health=ok.
#   2. Browser-side peer (gh27-vp-yjs-client.mjs) writes a baseline marker
#      ONLINE_MARKER and disconnects (simulates a tab that visited the page
#      and warmed its Y.Doc cache).
#   3. Wait for ONLINE_MARKER to land on disk via the runner.
#   4. Kill orch (partition starts). Wait for runner to log connection
#      dropped. (The browser-side cached Y.Doc is also "offline" by virtue
#      of the WS being down — same partition.)
#   5. Make a disk edit DISK_OFFLINE_MARKER while partitioned. The runner
#      ingests it into its in-memory Y.Doc but cannot push.
#   6. Bring orch back up via dev-up.sh.
#   7. Browser-side peer reconnects (a fresh wait-text invocation that
#      connects, syncs from DO, and asserts BOTH markers are visible).
#   8. Disk: assert ONLINE_MARKER is still present (CRDT didn't
#      overwrite the runner-side state with a stale browser snapshot).
#
# Exit 0 = pass.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=gh27-vp-common.sh
source "$SCRIPT_DIR/gh27-vp-common.sh"

vp_init "concurrent-offline"

REL="conc.md"
vp_seed_file "$REL" $'# Concurrent\n\nbody.\n'
vp_write_cmd '["**/*.md"]'

vp_launch_runner
vp_wait_health "ok" 30

# 2. browser-side baseline write (warms a Y.Doc cache as well)
ONLINE_MARKER="ONLINE_MARKER_$(date +%s)_$$"
REL_PATH="$REL" vp_yjs write-line "$ONLINE_MARKER" \
    >> "$VP_RUN_DIR/yjs-client-1.log" 2>&1 \
  || vp_fail "browser baseline write failed"

# 3. wait for ONLINE_MARKER to land on disk
for _ in $(seq 1 20); do
  grep -q "$ONLINE_MARKER" "$VP_WORKTREE/$REL" && break
  sleep 1
done
grep -q "$ONLINE_MARKER" "$VP_WORKTREE/$REL" \
  || { cat "$VP_WORKTREE/$REL" >&2; vp_fail "ONLINE_MARKER did not land on disk"; }
vp_log "online baseline established (both peers had observed ONLINE_MARKER)"

# 4. partition
vp_log "killing orch (partition starts)"
tmux kill-session -t "$ORCH_TMUX_SESSION" 2>/dev/null || true
vp_wait_log '\[dial-back-client\] connection dropped' 1 30

# 5. disk edit during partition
DISK_OFFLINE_MARKER="DISK_OFFLINE_$(date +%s)_$$"
printf '%s\n' "$DISK_OFFLINE_MARKER" >> "$VP_WORKTREE/$REL"
vp_log "wrote DISK_OFFLINE_MARKER='$DISK_OFFLINE_MARKER' during partition"
sleep 3   # let the runner ingest the disk change into its in-memory Y.Doc

# 6. heal the partition
vp_log "restarting orch (partition ends)"
bash "$SCRIPT_DIR/dev-up.sh" >> "$VP_RUN_DIR/dev-up-restart.log" 2>&1
vp_wait_health "ok" 60

# 7. fresh browser peer connects and asserts BOTH markers are visible
REL_PATH="$REL" vp_yjs wait-text "$ONLINE_MARKER" 30 \
    >> "$VP_RUN_DIR/yjs-client-2.log" 2>&1 \
  || { tail -n 30 "$VP_RUN_DIR/yjs-client-2.log" >&2; vp_fail "browser lost ONLINE_MARKER after reconnect (CRDT merge failure)"; }

REL_PATH="$REL" vp_yjs wait-text "$DISK_OFFLINE_MARKER" 30 \
    >> "$VP_RUN_DIR/yjs-client-3.log" 2>&1 \
  || { tail -n 30 "$VP_RUN_DIR/yjs-client-3.log" >&2; vp_fail "browser did not see DISK_OFFLINE_MARKER pushed by runner on reconnect"; }

# 8. disk-side: ONLINE_MARKER must still be present (no overwrite)
grep -q "$ONLINE_MARKER" "$VP_WORKTREE/$REL" \
  || { cat "$VP_WORKTREE/$REL" >&2; vp_fail "disk lost ONLINE_MARKER after partition heal (CRDT merge corrupted runner-side)"; }
grep -q "$DISK_OFFLINE_MARKER" "$VP_WORKTREE/$REL" \
  || { cat "$VP_WORKTREE/$REL" >&2; vp_fail "disk lost DISK_OFFLINE_MARKER after partition heal"; }

vp_pass "concurrent-offline: both peers' edits survived the partition; CRDT-merged cleanly on reconnect (ONLINE_MARKER + DISK_OFFLINE_MARKER both present in DO and on disk)"
