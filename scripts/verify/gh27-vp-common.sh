#!/usr/bin/env bash
#
# scripts/verify/gh27-vp-common.sh
#
# Shared helpers for the GH#27 verification_plan harnesses
# (gh27-vp-*.sh). Each VP sources this and uses:
#
#   vp_init                 # one-shot: source common.sh, set up paths/env
#   vp_setup_worktree DIR   # create a tmp docs worktree with a seed .md
#   vp_launch_runner        # start docs-runner against $VP_WORKTREE; bg
#   vp_wait_health <st> <s> # poll /health for a status (ok|degraded|down)
#   vp_health_field <key>   # echo a top-level json field from /health
#   vp_stop_runner          # graceful TERM (or KILL) of current runner
#   vp_kill9_runner         # forced -9 of the runner pid
#   vp_runner_alive         # 0 if runner pid still running
#   vp_log/vp_fail/vp_pass  # stdout helpers
#
# Each VP gets its own per-run temp directory under /tmp/duraclaw-vp/<id>/
# and a per-run projectId so the DO state is fresh (no cross-run bleed).
#
# Side effects: assumes the dev stack is already up via dev-up.sh. If not,
# vp_init exits with a clear message.

set -euo pipefail

VP_SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VP_REPO_ROOT="$(cd "$VP_SCRIPT_DIR/../.." && pwd)"

# shellcheck source=common.sh
source "$VP_SCRIPT_DIR/common.sh"

VP_TMP_ROOT="${VP_TMP_ROOT:-/tmp/duraclaw-vp}"
mkdir -p "$VP_TMP_ROOT"

vp_log() { printf '[vp:%s] %s\n' "${VP_NAME:-?}" "$*"; }
vp_fail() { printf '[vp:%s][FAIL] %s\n' "${VP_NAME:-?}" "$*" >&2; exit 1; }
vp_pass() { printf '[vp:%s][PASS] %s\n' "${VP_NAME:-?}" "$*"; }

# Initialise per-VP state. Call once at the top of each gh27-vp-*.sh.
#   $1 — VP name (used for logging + tmp dir naming)
vp_init() {
  VP_NAME="$1"
  VP_RUN_ID="${VP_NAME}-$(date +%s)-$$"
  VP_RUN_DIR="$VP_TMP_ROOT/$VP_RUN_ID"
  VP_WORKTREE="$VP_RUN_DIR/worktree"
  VP_RUNNER_DIR="$VP_RUN_DIR/runner"
  VP_PROJECT_ID="$VP_RUN_ID"
  mkdir -p "$VP_WORKTREE" "$VP_RUNNER_DIR"

  VP_CMD_FILE="$VP_RUNNER_DIR/cmd.json"
  VP_PID_FILE="$VP_RUNNER_DIR/pid.json"
  VP_EXIT_FILE="$VP_RUNNER_DIR/exit.json"
  VP_META_FILE="$VP_RUNNER_DIR/meta.json"
  VP_BG_PID_FILE="$VP_RUNNER_DIR/bg.pid"
  VP_RUNNER_LOG="$VP_RUN_DIR/runner.log"

  # The orchestrator (DO) reads DOCS_RUNNER_SECRET from .dev.vars in dev mode
  # via wrangler/miniflare bindings. We MUST send a matching bearer or the DO
  # rejects with close 4401 invalid_token. Source the live value from
  # .dev.vars unless the caller has already pinned one in env.
  if [[ -z "${DOCS_RUNNER_SECRET:-}" ]]; then
    local _dv="$VP_REPO_ROOT/apps/orchestrator/.dev.vars"
    if [[ -f "$_dv" ]]; then
      DOCS_RUNNER_SECRET="$(grep -E '^DOCS_RUNNER_SECRET=' "$_dv" | head -n1 | cut -d= -f2-)"
    fi
  fi
  VP_DOCS_RUNNER_SECRET="${DOCS_RUNNER_SECRET:-vp-shared-token}"

  # Health port: derive from worktree default + offset by hash of run id so
  # parallel VP harnesses on the same worktree don't collide on bind().
  local _hash
  _hash="$(printf '%s' "$VP_RUN_ID" | cksum | awk '{print $1}')"
  VP_HEALTH_PORT="$(( (CC_DOCS_RUNNER_PORT) + (_hash % 30) + 1 ))"

  # Confirm dev stack is up
  if ! curl -fsS "http://127.0.0.1:${VERIFY_ORCH_PORT}/api/auth/get-session" >/dev/null 2>&1; then
    vp_fail "orchestrator not responding on :${VERIFY_ORCH_PORT} — run scripts/verify/dev-up.sh first"
  fi
  if ! curl -fsS -H "Authorization: Bearer $CC_GATEWAY_API_TOKEN" \
        "http://127.0.0.1:${CC_GATEWAY_PORT}/sessions" >/dev/null 2>&1; then
    vp_fail "gateway not responding on :${CC_GATEWAY_PORT}"
  fi

  vp_log "init projectId=${VP_PROJECT_ID} worktree=${VP_WORKTREE} healthPort=${VP_HEALTH_PORT}"

  # Cleanup hook — fires on EXIT for any reason.
  trap _vp_cleanup EXIT
}

_vp_cleanup() {
  local code=$?
  if [[ -n "${VP_BG_PID_FILE:-}" && -f "$VP_BG_PID_FILE" ]]; then
    local pid
    pid="$(cat "$VP_BG_PID_FILE" 2>/dev/null || true)"
    if [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null; then
      kill -TERM "$pid" 2>/dev/null || true
      sleep 1
      kill -KILL "$pid" 2>/dev/null || true
    fi
  fi
  if [[ "$code" -ne 0 && -f "${VP_RUNNER_LOG:-/dev/null}" ]]; then
    printf '[vp:%s] runner log tail (cleanup):\n' "${VP_NAME:-?}" >&2
    tail -n 60 "$VP_RUNNER_LOG" >&2 || true
  fi
}

# Lay down a seed file in the tmp worktree.
#   $1 — relative path
#   $2 — contents
vp_seed_file() {
  local rel="$1" body="$2"
  mkdir -p "$VP_WORKTREE/$(dirname "$rel")"
  printf '%s' "$body" > "$VP_WORKTREE/$rel"
}

# Write the cmd-file JSON the runner expects. Runs after vp_seed_file.
vp_write_cmd() {
  local watch_json="${1:-["**/*.md"]}"
  cat > "$VP_CMD_FILE" <<EOF
{
  "type": "docs-runner",
  "projectId": "${VP_PROJECT_ID}",
  "docsWorktreePath": "${VP_WORKTREE}",
  "callbackBase": "ws://127.0.0.1:${VERIFY_ORCH_PORT}/api/collab/repo-document",
  "bearer": "${VP_DOCS_RUNNER_SECRET}",
  "watch": ${watch_json},
  "ignored": [],
  "healthPort": ${VP_HEALTH_PORT}
}
EOF
}

# Build the docs-runner once per session (idempotent) so each VP can launch.
vp_build_runner() {
  if [[ -f "$VP_REPO_ROOT/packages/docs-runner/dist/main.js" ]]; then
    return 0
  fi
  vp_log "building @duraclaw/docs-runner"
  ( cd "$VP_REPO_ROOT" && pnpm --filter @duraclaw/docs-runner build ) \
    > "$VP_RUN_DIR/build.log" 2>&1 \
    || { vp_log "build failed; tail:"; tail -n 40 "$VP_RUN_DIR/build.log" >&2; vp_fail "docs-runner build failed"; }
}

# Spawn the runner detached, write its bg pid to $VP_BG_PID_FILE.
vp_launch_runner() {
  vp_build_runner
  rm -f "$VP_PID_FILE" "$VP_EXIT_FILE" "$VP_META_FILE" "$VP_RUNNER_LOG"
  vp_log "launching docs-runner; log → ${VP_RUNNER_LOG}"
  (
    DOCS_RUNNER_SECRET="$VP_DOCS_RUNNER_SECRET" \
    bun "$VP_REPO_ROOT/packages/docs-runner/dist/main.js" \
      "$VP_PROJECT_ID" "$VP_CMD_FILE" "$VP_PID_FILE" "$VP_EXIT_FILE" "$VP_META_FILE" \
      > "$VP_RUNNER_LOG" 2>&1 &
    echo $! > "$VP_BG_PID_FILE"
  )
  vp_log "runner bg pid=$(cat "$VP_BG_PID_FILE")"
}

# Poll /health until top-level "status" matches $1, or timeout $2 (default 30s).
vp_wait_health() {
  local want="${1:-ok}" timeout="${2:-30}"
  local url="http://127.0.0.1:${VP_HEALTH_PORT}/health"
  for ((i = 0; i < timeout; i++)); do
    if curl -fsS "$url" 2>/dev/null | grep -q "\"status\":\"$want\""; then
      vp_log "/health=$want after ${i}s"
      return 0
    fi
    sleep 1
  done
  vp_log "tail of runner log:"
  tail -n 60 "$VP_RUNNER_LOG" >&2 || true
  vp_fail "/health never reached \"$want\" within ${timeout}s"
}

# Echo a JSON field from /health. Uses jq when available; falls back to a
# loose grep for the simple top-level numeric/string cases used by VP scripts.
vp_health_field() {
  local key="$1"
  local url="http://127.0.0.1:${VP_HEALTH_PORT}/health"
  local body
  body="$(curl -fsS "$url" 2>/dev/null || true)"
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$body" | jq -r ".$key // empty"
  else
    printf '%s' "$body" | grep -Eo "\"$key\":\s*[0-9a-zA-Z\"._-]+" | head -n1 \
      | sed -E "s/^\"$key\":\s*//; s/^\"//; s/\"$//"
  fi
}

vp_runner_alive() {
  local pid; pid="$(cat "$VP_BG_PID_FILE" 2>/dev/null || true)"
  [[ -n "$pid" ]] && kill -0 "$pid" 2>/dev/null
}

vp_stop_runner() {
  if vp_runner_alive; then
    local pid; pid="$(cat "$VP_BG_PID_FILE")"
    kill -TERM "$pid" 2>/dev/null || true
    for _ in $(seq 1 10); do
      kill -0 "$pid" 2>/dev/null || return 0
      sleep 0.3
    done
    kill -KILL "$pid" 2>/dev/null || true
  fi
}

vp_kill9_runner() {
  if vp_runner_alive; then
    local pid; pid="$(cat "$VP_BG_PID_FILE")"
    kill -KILL "$pid" 2>/dev/null || true
  fi
}

# Count occurrences of a regex in the runner log.
vp_count_log() {
  local pat="$1"
  grep -c -E "$pat" "$VP_RUNNER_LOG" 2>/dev/null || echo 0
}

# Wait for at least N matches of regex in the runner log, timeout $3 secs.
vp_wait_log() {
  local pat="$1" want="${2:-1}" timeout="${3:-30}"
  for ((i = 0; i < timeout; i++)); do
    local n; n="$(vp_count_log "$pat")"
    [[ "$n" -ge "$want" ]] && { vp_log "log /\"$pat\"/ ≥ $want after ${i}s (n=$n)"; return 0; }
    sleep 1
  done
  vp_fail "log /\"$pat\"/ did not reach $want within ${timeout}s (n=$(vp_count_log "$pat"))"
}

# Compute SHA256 of a file relative to the worktree.
vp_hash_rel() {
  sha256sum "$VP_WORKTREE/$1" | awk '{print $1}'
}

# Invoke gh27-vp-yjs-client.mjs with proper module resolution.
#
# The script imports yjs / y-protocols / ws, which only resolve from
# packages/docs-runner/node_modules (pnpm doesn't hoist these to the
# workspace root). We run the client from that cwd so Bun's resolver
# walks up into the right node_modules tree, while passing the absolute
# script path so the file itself stays under scripts/verify/ for
# discoverability.
#
# Usage:  vp_yjs <op> <args...>
# Env (set per call):
#   PROJECT_ID, REL_PATH, ORCH_URL, DOCS_RUNNER_SECRET
vp_yjs() {
  # Run from inside packages/docs-runner so Bun resolves yjs / y-protocols /
  # ws against that package's node_modules. The .mjs lives in
  # packages/docs-runner/scripts/ for resolution; scripts/verify/ holds a
  # symlink for discoverability.
  local script_abs="$VP_REPO_ROOT/packages/docs-runner/scripts/vp-yjs-client.mjs"
  ( cd "$VP_REPO_ROOT/packages/docs-runner" && \
      PROJECT_ID="$VP_PROJECT_ID" \
      REL_PATH="${REL_PATH:?REL_PATH required}" \
      ORCH_URL="${ORCH_URL:-ws://127.0.0.1:${VERIFY_ORCH_PORT}}" \
      DOCS_RUNNER_SECRET="$VP_DOCS_RUNNER_SECRET" \
      bun "$script_abs" "$@" )
}
