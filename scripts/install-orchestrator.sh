#!/usr/bin/env bash
# Self-hoster install for the Duraclaw orchestrator (Cloudflare Workers).
#
# Idempotent bootstrap that:
#   1. verifies you're logged into wrangler against your own CF account,
#   2. creates the D1 database + R2 buckets if they don't exist,
#   3. applies remote D1 migrations,
#   4. prompts for the required secrets and pipes them to `wrangler secret put`,
#   5. builds the orchestrator and runs `wrangler deploy`.
#
# This is the SELF-HOSTING path. The baseplane infra pipeline takes a different
# route — it builds + uploads the mobile OTA bundle to R2 first, then deploys
# the Worker. See README.md → Deployment for the contract.
#
# Prereqs:
#   - bash, pnpm, jq
#   - wrangler available via `pnpm wrangler` (workspace already installs it)
#   - a Cloudflare account with Workers Paid (Durable Objects + SQLite-backed DOs)
#
# Inputs (env or interactive):
#   CF_ACCOUNT_ID        — your CF account ID (wrangler whoami exposes it)
#   D1_DATABASE_NAME     — defaults to `duraclaw-auth`
#   R2_MOBILE_BUCKET     — defaults to `duraclaw-mobile`
#   R2_MEDIA_BUCKET      — defaults to `duraclaw-session-media`
#   ORCH_CONFIG          — path to wrangler config; defaults to wrangler.toml
#                          (override with a self-host wrangler.local.toml)
#
# What this script will NOT do for you:
#   - rewrite `database_id` in wrangler.toml (the committed value points at
#     baseplane's account). Either replace it manually with the ID this script
#     prints, or copy wrangler.toml to wrangler.local.toml, edit it, and re-run
#     with `ORCH_CONFIG=wrangler.local.toml`.
#   - point the worker at a custom domain. The committed wrangler.toml has
#     `dura.baseplane.ai`; remove the `[[routes]]` block in your local copy
#     unless you own a domain you want to map.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ORCH_DIR="${REPO_ROOT}/apps/orchestrator"
ORCH_CONFIG="${ORCH_CONFIG:-wrangler.toml}"
D1_DATABASE_NAME="${D1_DATABASE_NAME:-duraclaw-auth}"
R2_MOBILE_BUCKET="${R2_MOBILE_BUCKET:-duraclaw-mobile}"
R2_MEDIA_BUCKET="${R2_MEDIA_BUCKET:-duraclaw-session-media}"

REQUIRED_SECRETS=(
  CC_GATEWAY_URL
  CC_GATEWAY_SECRET
  WORKER_PUBLIC_URL
  BETTER_AUTH_SECRET
  BETTER_AUTH_URL
  SYNC_BROADCAST_SECRET
)

OPTIONAL_SECRETS=(
  VAPID_PUBLIC_KEY
  VAPID_PRIVATE_KEY
  FCM_SERVICE_ACCOUNT_JSON
)

step() { printf '\n\033[1;36m▶ %s\033[0m\n' "$*"; }
note() { printf '\033[2m  %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m⚠ %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31m✖ %s\033[0m\n' "$*" >&2; exit 1; }

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || die "missing command: $1"
}

cd "${ORCH_DIR}"

# ── 0. prereqs ────────────────────────────────────────────────────────────────
step "Checking prereqs"
require_cmd pnpm
require_cmd jq
[[ -f "${ORCH_CONFIG}" ]] || die "no ${ORCH_CONFIG} in $(pwd)"
note "config: ${ORCH_CONFIG}"

# ── 1. wrangler login + account ──────────────────────────────────────────────
step "Verifying wrangler auth"
if ! pnpm wrangler whoami >/dev/null 2>&1; then
  warn "not logged in — running 'wrangler login' (browser flow)"
  pnpm wrangler login
fi
WHOAMI_JSON="$(pnpm wrangler whoami --output=json 2>/dev/null || true)"
if [[ -n "${WHOAMI_JSON}" ]]; then
  EMAIL="$(jq -r '.email // empty' <<<"${WHOAMI_JSON}")"
  ACCOUNT_NAME="$(jq -r '.accounts[0].name // empty' <<<"${WHOAMI_JSON}")"
  ACCOUNT_ID="${CF_ACCOUNT_ID:-$(jq -r '.accounts[0].id // empty' <<<"${WHOAMI_JSON}")}"
  note "user: ${EMAIL:-?}  account: ${ACCOUNT_NAME:-?} (${ACCOUNT_ID:-?})"
fi

# ── 2. D1 database ───────────────────────────────────────────────────────────
step "Ensuring D1 database '${D1_DATABASE_NAME}' exists"
EXISTING_D1="$(pnpm wrangler d1 list --json 2>/dev/null | jq -r --arg n "${D1_DATABASE_NAME}" '.[] | select(.name == $n) | .uuid' || true)"
if [[ -n "${EXISTING_D1}" ]]; then
  note "found: ${EXISTING_D1}"
else
  note "creating…"
  pnpm wrangler d1 create "${D1_DATABASE_NAME}"
  EXISTING_D1="$(pnpm wrangler d1 list --json | jq -r --arg n "${D1_DATABASE_NAME}" '.[] | select(.name == $n) | .uuid')"
  warn "new database_id: ${EXISTING_D1}"
  warn "patch this into ${ORCH_CONFIG}'s [[d1_databases]] block before continuing,"
  warn "then re-run this script."
  exit 1
fi

CONFIG_D1="$(grep -A2 'binding = "AUTH_DB"' "${ORCH_CONFIG}" | sed -n 's/.*database_id = "\(.*\)"/\1/p' | head -1 || true)"
if [[ -n "${CONFIG_D1}" && "${CONFIG_D1}" != "${EXISTING_D1}" ]]; then
  warn "${ORCH_CONFIG} has database_id=${CONFIG_D1} but your account has ${EXISTING_D1}"
  warn "patch ${ORCH_CONFIG} (or use a wrangler.local.toml + ORCH_CONFIG=…) and re-run."
  exit 1
fi

# ── 3. R2 buckets ────────────────────────────────────────────────────────────
step "Ensuring R2 buckets exist"
for bucket in "${R2_MOBILE_BUCKET}" "${R2_MEDIA_BUCKET}"; do
  if pnpm wrangler r2 bucket info "${bucket}" >/dev/null 2>&1; then
    note "found: ${bucket}"
  else
    note "creating: ${bucket}"
    pnpm wrangler r2 bucket create "${bucket}"
  fi
done

# ── 4. D1 migrations ─────────────────────────────────────────────────────────
step "Applying D1 migrations (remote)"
pnpm wrangler d1 migrations apply "${D1_DATABASE_NAME}" --remote --config "${ORCH_CONFIG}"

# ── 5. Secrets ───────────────────────────────────────────────────────────────
step "Setting Worker secrets (skip with empty input)"
existing_secrets="$(pnpm wrangler secret list --config "${ORCH_CONFIG}" --output=json 2>/dev/null | jq -r '.[].name' || true)"
prompt_and_put() {
  local name="$1"
  local required="$2"
  if grep -qx "${name}" <<<"${existing_secrets}"; then
    note "${name} already set — skipping (re-run with 'pnpm wrangler secret put ${name}' to rotate)"
    return 0
  fi
  local label="${name}"
  [[ "${required}" == "y" ]] && label="${name} [required]" || label="${name} [optional, blank=skip]"
  printf "  %s: " "${label}"
  read -rs val
  printf "\n"
  if [[ -z "${val}" ]]; then
    if [[ "${required}" == "y" ]]; then
      die "${name} is required"
    fi
    return 0
  fi
  printf '%s' "${val}" | pnpm wrangler secret put "${name}" --config "${ORCH_CONFIG}" >/dev/null
  note "${name} set"
}
for s in "${REQUIRED_SECRETS[@]}"; do prompt_and_put "${s}" y; done
for s in "${OPTIONAL_SECRETS[@]}"; do prompt_and_put "${s}" n; done

# ── 6. build + deploy ────────────────────────────────────────────────────────
step "Building orchestrator"
APP_VERSION="$(git -C "${REPO_ROOT}" rev-parse --short HEAD)"
VITE_APP_VERSION="${APP_VERSION}" pnpm build

step "Deploying to Cloudflare"
pnpm wrangler deploy --config "${ORCH_CONFIG}"

step "Done"
note "tail logs:   pnpm wrangler tail --config ${ORCH_CONFIG}"
note "rotate secret:  pnpm wrangler secret put NAME --config ${ORCH_CONFIG}"
note "next step: install the gateway on your VPS — bash packages/agent-gateway/systemd/install.sh"
