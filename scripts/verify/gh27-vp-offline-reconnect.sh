#!/usr/bin/env bash
#
# scripts/verify/gh27-vp-offline-reconnect.sh
#
# Spec verification_plan: vp-offline-reconnect
# > Kill orchestrator mid-edit; runner buffers via local Y.Doc, reconnects
# > on redeploy, CRDT-merges cleanly.
#
# Strategy:
#   1. Launch docs-runner against a 1-file tmp worktree.
#   2. Make a baseline disk edit (B5: pushes to DO). Confirm syncs_ok bumps.
#   3. Kill orch (simulates partition).
#   4. Make ANOTHER disk edit while orch is down. The runner should:
#       a. Apply the edit to the in-memory Y.Doc (B7 markdown→Y.Doc bridge).
#       b. Buffer the resulting Yjs update via the dial-back client's
#          inherent reconnect machinery. (No data is dropped because
#          y-protocols' sync step 1/2 handshake on reconnect re-syncs
#          state automatically.)
#   5. Restart orch via dev-up.sh.
#   6. Wait for runner to reconnect (/health=ok, reconnects increments).
#   7. Confirm the offline edit lands in the DO by connecting a
#      Y.Doc client (gh27-vp-yjs-client.mjs read) and asserting the
#      offline-added marker text is present in the canonical document.
#
# This is the canonical "edit while down, sync on reconnect" gate for B5.
#
# Exit 0 = pass.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=gh27-vp-common.sh
source "$SCRIPT_DIR/gh27-vp-common.sh"

vp_init "offline-reconnect"

REL="offline.md"
vp_seed_file "$REL" $'# Offline\n\nBaseline body.\n'
vp_write_cmd '["**/*.md"]'

vp_launch_runner
vp_wait_health "ok" 30

# 2. baseline edit while online — confirm the disk→DO direction works
# BEFORE we partition. We verify via a Y.Doc peer connecting to the DO
# rather than via metrics.syncs_ok (which only ticks on syncing-state
# transitions, not per-update pushes).
sleep 1
ONLINE_MARKER="ONLINE_BASELINE_$(date +%s)_$$"
printf '%s\n' "$ONLINE_MARKER" >> "$VP_WORKTREE/$REL"
REL_PATH="$REL" vp_yjs wait-text "$ONLINE_MARKER" 30 \
    >> "$VP_RUN_DIR/yjs-baseline.log" 2>&1 \
  || { tail -n 30 "$VP_RUN_DIR/yjs-baseline.log" >&2; vp_fail "online edit did not propagate to DO (baseline check)"; }
vp_log "online edit observed in DO via Yjs peer"

# 3. kill orch
reco_before="$(vp_health_field reconnects)"
vp_log "killing orchestrator (offline window starts)"
tmux kill-session -t "$ORCH_TMUX_SESSION" 2>/dev/null || true
vp_wait_log '\[dial-back-client\] connection dropped' 1 30
vp_log "runner detected disconnect"

# 4. make an offline edit
OFFLINE_MARKER="OFFLINE_EDIT_$(date +%s)_$$"
printf '%s\n' "$OFFLINE_MARKER" >> "$VP_WORKTREE/$REL"
vp_log "wrote offline marker '$OFFLINE_MARKER' to disk while orch is down"

# Give the runner time to ingest the disk change into the in-memory Y.Doc
# (B7 bridge). It can't push yet — connection is dropped — but the Y.Doc
# will hold the change for replay on reconnect.
sleep 3

# 5. bring orch back up
vp_log "restarting orchestrator"
bash "$SCRIPT_DIR/dev-up.sh" >> "$VP_RUN_DIR/dev-up-restart.log" 2>&1
vp_wait_health "ok" 60

# meta.reconnects only ticks on token-rotation per main.ts:446. Use the
# dial-back log signal as the cross-check (matches vp-redeploy).
recon_logs="$(vp_count_log '\[dial-back-client\] connection established')"
[[ "${recon_logs:-0}" -ge 2 ]] \
  || vp_fail "expected ≥2 connection-established log lines (initial + reconnect); got ${recon_logs:-0}"
vp_log "runner reconnected: connection-established log lines = ${recon_logs}"

# 6. confirm the offline edit landed in the DO via a separate Yjs peer
sleep 2
REL_PATH="$REL" vp_yjs wait-text "$OFFLINE_MARKER" 30 \
    >> "$VP_RUN_DIR/yjs-client.log" 2>&1 \
  || { vp_log "yjs-client log:"; tail -n 40 "$VP_RUN_DIR/yjs-client.log" >&2; vp_fail "offline marker did not appear in DO after reconnect"; }

vp_pass "offline-reconnect: edit during partition was buffered + replayed; DO sees marker '$OFFLINE_MARKER' after reconnect"
