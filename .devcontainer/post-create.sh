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

cat <<'EOF'

==> Duraclaw dev container ready

Next steps:
  1. Authenticate Cloudflare once:           npx wrangler login
  2. Authenticate GitHub CLI (optional):     gh auth login
  3. Start the dev stack:                    pnpm dev
  4. Run the baseline verify suite:          pnpm verify:smoke

Local test credentials (from CLAUDE.md):
  email:    agent.verify+duraclaw@example.com
  password: duraclaw-test-password

Forwarded ports:
  43173  Orchestrator (Vite SPA)
  9877   Agent Gateway (WS)
  8787   Miniflare

EOF
