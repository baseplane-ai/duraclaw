#!/usr/bin/env bash
# Duraclaw dev container post-create hook.
# Runs once when the container is first built.

set -euo pipefail

cd "$(dirname "$0")/.."

echo "==> Enabling corepack + pinning pnpm from package.json"
corepack enable
corepack prepare --activate

echo "==> Installing workspace deps"
pnpm install --frozen-lockfile

echo "==> Setting up git hooks (precommit)"
pnpm run prepare || echo "   (prepare step failed — rerun 'pnpm run prepare' after first pull)"

ENV_SEEDED="no"
if [[ ! -f .env && -f .env.example ]]; then
  cp .env.example .env
  ENV_SEEDED="yes"
fi

# Surface the per-worktree derived ports so the contributor knows which
# numbers to look for — the static forwardPorts ranges in devcontainer.json
# cover the whole derivation space, but only one pair is live.
DERIVED_ORCH_PORT=""
DERIVED_GATEWAY_PORT=""
if [[ -r scripts/verify/common.sh ]]; then
  # Source in a subshell — common.sh has side effects (exports, state dirs)
  # that we don't want to inherit into this banner script.
  eval "$(
    # shellcheck disable=SC1091
    source scripts/verify/common.sh >/dev/null 2>&1
    printf 'DERIVED_ORCH_PORT=%s\nDERIVED_GATEWAY_PORT=%s\n' \
      "${VERIFY_ORCH_PORT:-}" "${VERIFY_GATEWAY_PORT:-}"
  )"
fi

cat <<EOF

==> Duraclaw dev container ready

Next steps:
  1. Authenticate Cloudflare once:           npx wrangler login
  2. Authenticate GitHub CLI (optional):     gh auth login
  3. Fill in required secrets in .env:       CC_GATEWAY_API_TOKEN, BOOTSTRAP_TOKEN
  4. Start the dev stack:                    pnpm dev
  5. Smoke the devcontainer config:          pnpm verify:devcontainer

(Full 'pnpm verify:smoke' additionally requires seeded users via /api/bootstrap
and a running gateway — see CLAUDE.md > "Verify-mode local stack".)

Local test credentials (from CLAUDE.md):
  email:    agent.verify+duraclaw@example.com
  password: duraclaw-test-password

EOF

if [[ "$ENV_SEEDED" == "yes" ]]; then
  cat <<'EOF'
==> Seeded .env from .env.example — fill in CC_GATEWAY_API_TOKEN and
    BOOTSTRAP_TOKEN before running 'pnpm dev' or the gateway will refuse
    authentication. See .env.example for the full list.

EOF
fi

cat <<EOF
Forwarded ports (per-worktree derived — see CLAUDE.md port table):
  Orchestrator (Vite SPA):  ${DERIVED_ORCH_PORT:-43000-43799}
  Agent Gateway (WS):       ${DERIVED_GATEWAY_PORT:-9800-10599}
  Miniflare:                8787

EOF
