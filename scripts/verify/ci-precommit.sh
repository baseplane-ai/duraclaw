#!/usr/bin/env bash

set -euo pipefail

source "$(dirname "$0")/common.sh"

require_cmd git
require_cmd node
require_cmd pnpm

print_section "prepare"
pnpm prepare | tee "$VERIFY_LOG_DIR/ci-prepare.log"

hooks_path="$(git config --get core.hooksPath || true)"
if [[ "$hooks_path" != ".git-hooks" ]]; then
  echo "Expected core.hooksPath=.git-hooks, found ${hooks_path:-unset}" >&2
  exit 1
fi

if [[ ! -x "$VERIFY_ROOT/.git-hooks/pre-commit" ]]; then
  echo "Expected executable hook at $VERIFY_ROOT/.git-hooks/pre-commit" >&2
  exit 1
fi

echo "Git hook installation OK"

temp_dir="$(mktemp -d)"
temp_file="$VERIFY_ROOT/precommit-verify.tmp.js"

cleanup() {
  rm -f "$temp_file"
  rm -rf "$temp_dir"
}

trap cleanup EXIT

export GIT_INDEX_FILE="$temp_dir/index"
git read-tree HEAD

cat >"$temp_file" <<'EOF'
const verifyPrecommit = true

if (!verifyPrecommit) {
  throw new Error('unreachable')
}
EOF

git add "$temp_file"

print_section "hook"
(
  cd "$VERIFY_ROOT"
  bash ./.git-hooks/pre-commit
) | tee "$VERIFY_LOG_DIR/ci-precommit.log"

print_section "summary"
echo "Verified repo-managed pre-commit hook with an isolated git index"
