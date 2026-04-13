#!/usr/bin/env bash
# Bootstrap the admin user account via token-protected endpoint.
# Run AFTER deploying migrations and the worker.
#
# Prerequisites:
#   - BOOTSTRAP_TOKEN must be set as a wrangler secret
#   - Migrations 0004 + 0005 must be applied
#
# Usage: ./scripts/seed-admin.sh [base-url]
#   base-url defaults to https://duraclaw.codevibesmatter.com

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
source "$SCRIPT_DIR/../.env"

BASE_URL="${1:-https://duraclaw.codevibesmatter.com}"

echo "Creating admin user: $ADMIN_EMAIL"

RESPONSE=$(curl -s -w "\n%{http_code}" \
  -X POST "$BASE_URL/api/bootstrap" \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $BOOTSTRAP_TOKEN" \
  -d "{\"email\":\"$ADMIN_EMAIL\",\"password\":\"$ADMIN_PASSWORD\",\"name\":\"Ben\"}")

HTTP_CODE=$(echo "$RESPONSE" | tail -1)
BODY=$(echo "$RESPONSE" | head -n -1)

if [ "$HTTP_CODE" = "200" ] || [ "$HTTP_CODE" = "201" ]; then
  echo "Admin user created successfully."
  echo "$BODY"
  echo ""
  echo "IMPORTANT: Now delete the BOOTSTRAP_TOKEN secret to lock down:"
  echo "  wrangler secret delete BOOTSTRAP_TOKEN"
else
  echo "Bootstrap failed (HTTP $HTTP_CODE): $BODY"
  exit 1
fi
