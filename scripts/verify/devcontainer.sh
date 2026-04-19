#!/usr/bin/env bash
# verify:devcontainer — static validation of the devcontainer config.
#
# Full "build + preflight inside container" verification requires docker +
# devcontainer-cli which are not part of the Duraclaw preflight toolchain.
# Treat this script as the repo-resident smoke for config correctness; the
# build/preflight evidence is captured per-contributor in
# .kata/verification-evidence/phase-devcontainer-<date>.md.

set -euo pipefail

source "$(dirname "$0")/common.sh"

require_cmd jq
require_cmd node

DEVCONTAINER_DIR="$VERIFY_ROOT/.devcontainer"
CONFIG="$DEVCONTAINER_DIR/devcontainer.json"
POST_CREATE="$DEVCONTAINER_DIR/post-create.sh"

print_section ".devcontainer presence"
test -f "$CONFIG" && echo "devcontainer.json found"
test -f "$POST_CREATE" && echo "post-create.sh found"
test -x "$POST_CREATE" && echo "post-create.sh is executable"

print_section "devcontainer.json shape"
jq -e '
  .image
  and (.features | type == "object")
  and (.forwardPorts | type == "array")
  and (.postCreateCommand | type == "string")
' "$CONFIG" >/dev/null
echo "Required fields present"

jq -e '
  (.forwardPorts | index(43173))
  and (.forwardPorts | index(9877))
  and (.forwardPorts | index(8787))
' "$CONFIG" >/dev/null
echo "Forward ports 43173 / 9877 / 8787 declared"

jq -e '
  .features | has("ghcr.io/shyim/devcontainers-features/bun:0")
' "$CONFIG" >/dev/null
echo "Bun feature declared"

print_section "post-create.sh sanity"
bash -n "$POST_CREATE"
echo "post-create.sh parses"

print_section "summary"
echo "Devcontainer config OK. Build + runtime verification lives in .kata/verification-evidence/."
