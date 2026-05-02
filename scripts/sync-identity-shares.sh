#!/usr/bin/env bash
# ============================================================================
# sync-identity-shares.sh — make an identity HOME inherit the main user's
# tool configs (gh, gcloud, gitconfig, .config/*, etc.) via symlinks, while
# preserving the only thing that must stay per-HOME:
# `.claude/.credentials.json`.
#
# Why: identity HOMEs (under $IDENTITY_HOME_BASE) come up bare from
# `setup-identity.sh`, so a runner spawned under one cannot use `gh`,
# `gcloud`, `git`, `bun`, etc. — they all look in $HOME/.config or
# $HOME/.gitconfig and find nothing. The credentials those tools use are
# the VPS user's, not the LLM-account's, so they should be shared. The
# only thing that genuinely needs to be per-HOME is the Anthropic OAuth
# token at `.claude/.credentials.json` — that's what gives each identity
# a separate rate-limit envelope.
#
# Idempotent: re-running is safe. Existing correct symlinks pass through;
# real files in the identity HOME are never clobbered (logged + skipped).
#
# Special case for `.claude/projects/`: this is the SDK's per-session
# resume context (one `.jsonl` per session). Failover crosses HOMEs, so
# we need it shared to keep `query({resume:...})` working after a
# rate-limit hop. Before symlinking we rsync any newer content from the
# identity HOME up to /home/ubuntu/.claude/projects (the canonical
# location), so consolidation doesn't lose post-cutover sessions that
# only exist in an identity HOME.
#
# Usage:
#   scripts/sync-identity-shares.sh --name work1
#   scripts/sync-identity-shares.sh --all
#   scripts/sync-identity-shares.sh --all --dry-run
# ============================================================================

set -euo pipefail

MAIN_HOME="/home/ubuntu"
IDENTITY_HOME_BASE="${IDENTITY_HOME_BASE:-/home/ubuntu/duraclaw-homes}"
IDENTITY_HOME_BASE="${IDENTITY_HOME_BASE%/}"

# Top-level entries under MAIN_HOME we never link from.
TOP_BLACKLIST=(
  "duraclaw-homes"
  # `.claude.json` is the Claude CLI's settings/state file; it contains
  # `oauthAccount` + `userID` keyed to whichever Anthropic account
  # logged in. Sharing it across identity HOMEs would make every HOME
  # report the main user's account, which is wrong. Keep per-HOME —
  # the CLI will repopulate on first use from `.credentials.json`.
  ".claude.json"
)

# Entries under MAIN_HOME/.claude that must stay per-HOME.
CLAUDE_BLACKLIST=(
  ".credentials.json"
)

DRY_RUN=false
FORCE=false
NAMES=()

usage() {
  cat <<EOF
sync-identity-shares.sh — symlink shared CLI configs into identity HOMEs

Usage:
  $(basename "$0") --name <id>     sync a single identity (e.g. work1)
  $(basename "$0") --all           sync every dir under \$IDENTITY_HOME_BASE
  $(basename "$0") ... --dry-run   print actions without performing them
  $(basename "$0") ... --force     replace existing real files/dirs with
                                   symlinks (destructive — loses any
                                   identity-local content under conflicting
                                   paths; intended for HOMEs whose local
                                   content is just SDK caches)

Environment:
  IDENTITY_HOME_BASE   default: /home/ubuntu/duraclaw-homes
EOF
  exit 1
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --name) NAMES+=("$2"); shift 2 ;;
    --all)
      for d in "$IDENTITY_HOME_BASE"/*/; do
        NAMES+=("$(basename "$d")")
      done
      shift ;;
    --dry-run) DRY_RUN=true; shift ;;
    --force) FORCE=true; shift ;;
    -h|--help) usage ;;
    *) echo "unknown arg: $1" >&2; usage ;;
  esac
done

[ "${#NAMES[@]}" -gt 0 ] || usage

run() {
  if $DRY_RUN; then
    echo "DRY-RUN: $*"
  else
    echo "+ $*"
    "$@"
  fi
}

contains() {
  local needle="$1"; shift
  for v in "$@"; do [ "$v" = "$needle" ] && return 0; done
  return 1
}

# Make `linkpath` a symlink pointing at `target`.
# - already-correct symlink: no-op
# - stale symlink (different target): replaced
# - real file or dir: warn, skip (never clobber identity-local data)
ensure_symlink() {
  local target="$1" linkpath="$2"
  if [ -L "$linkpath" ]; then
    local current
    current="$(readlink "$linkpath")"
    if [ "$current" = "$target" ]; then
      return 0
    fi
    run rm "$linkpath"
  elif [ -e "$linkpath" ]; then
    if $FORCE; then
      echo "  - replacing real path with symlink: $linkpath"
      run rm -rf "$linkpath"
    else
      echo "  ! refusing to clobber real path: $linkpath -> would have linked $target (use --force)" >&2
      return 0
    fi
  fi
  run ln -s "$target" "$linkpath"
}

# Special handling for `.claude/projects` — consolidate any newer content
# up to /home/ubuntu/.claude/projects (the canonical location) before
# replacing with a symlink. This preserves SDK resume files written by
# runners that already spawned under this identity.
consolidate_projects() {
  local identity_projects="$1"
  if [ ! -d "$identity_projects" ] || [ -L "$identity_projects" ]; then
    return 0
  fi
  if [ -z "$(ls -A "$identity_projects" 2>/dev/null)" ]; then
    return 0
  fi
  echo "  consolidating $identity_projects -> $MAIN_HOME/.claude/projects (rsync --update)"
  run rsync -a --update "$identity_projects/" "$MAIN_HOME/.claude/projects/"
  run rm -rf "$identity_projects"
}

sync_identity() {
  local id="$1"
  local home="$IDENTITY_HOME_BASE/$id"
  if [ ! -d "$home" ]; then
    echo "no such identity HOME: $home" >&2
    return 1
  fi
  echo "== syncing $home =="

  # 1. Top-level entries: symlink each entry in MAIN_HOME into the identity
  #    HOME, except blacklist + .claude (handled below).
  while IFS= read -r entry; do
    contains "$entry" "${TOP_BLACKLIST[@]}" && continue
    [ "$entry" = ".claude" ] && continue
    ensure_symlink "$MAIN_HOME/$entry" "$home/$entry"
  done < <(ls -A "$MAIN_HOME")

  # 2. .claude/ stays a real dir (per-HOME credentials), but consolidate
  #    + symlink everything inside except .credentials.json.
  run mkdir -p "$home/.claude"

  consolidate_projects "$home/.claude/projects"

  while IFS= read -r entry; do
    contains "$entry" "${CLAUDE_BLACKLIST[@]}" && continue
    ensure_symlink "$MAIN_HOME/.claude/$entry" "$home/.claude/$entry"
  done < <(ls -A "$MAIN_HOME/.claude")
}

for n in "${NAMES[@]}"; do sync_identity "$n"; done

echo "done."
