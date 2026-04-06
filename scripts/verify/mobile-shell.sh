#!/usr/bin/env bash

set -euo pipefail

source "$(dirname "$0")/common.sh"

require_cmd agent-browser

browser_session="${VERIFY_BROWSER_SESSION}-mobile-shell"
snapshot_path="$VERIFY_LOG_DIR/mobile-shell-snapshot.txt"
screenshot_path="$VERIFY_LOG_DIR/mobile-shell.png"

bash "$VERIFY_ROOT/scripts/verify/auth.sh" >/dev/null

agent-browser --session "$browser_session" close >/dev/null 2>&1 || true
agent-browser --session "$browser_session" open "$VERIFY_ORCH_URL/login" >/dev/null
agent-browser --session "$browser_session" wait 1000 >/dev/null
agent-browser --session "$browser_session" fill 'input[placeholder="Email"]' "$VERIFY_AUTH_EMAIL" >/dev/null
agent-browser --session "$browser_session" fill 'input[placeholder="Password"]' "$VERIFY_AUTH_PASSWORD" >/dev/null
agent-browser --session "$browser_session" focus 'input[placeholder="Password"]' >/dev/null
agent-browser --session "$browser_session" press Enter >/dev/null
wait_for_browser_text "$browser_session" "Projects" body 24 250 >/dev/null

print_section "mobile"
agent-browser --session "$browser_session" set viewport 320 740 >/dev/null
agent-browser --session "$browser_session" open "$VERIFY_ORCH_URL/" >/dev/null
wait_for_browser_visibility "$browser_session" '[data-testid="bottom-tabs"]' true 24 250 >/dev/null

bottom_tabs_visible="$(browser_is_visible "$browser_session" '[data-testid="bottom-tabs"]')"
if [[ "$bottom_tabs_visible" != "true" ]]; then
  echo "Expected bottom tabs to be visible at 320px" >&2
  exit 1
fi

agent-browser --session "$browser_session" click '[data-testid="bottom-tab-settings"]' >/dev/null
wait_for_browser_text "$browser_session" "Settings" body 20 250 >/dev/null
settings_text="$(agent-browser --session "$browser_session" get text body)"
if ! grep -q "Settings" <<<"$settings_text"; then
  echo "Expected settings page content at mobile viewport" >&2
  exit 1
fi

agent-browser --session "$browser_session" click '[data-testid="bottom-tab-dashboard"]' >/dev/null
wait_for_browser_text "$browser_session" "Projects" body 20 250 >/dev/null
dashboard_text="$(agent-browser --session "$browser_session" get text body)"
if ! grep -q "Projects" <<<"$dashboard_text"; then
  echo "Expected dashboard content after returning from mobile settings tab" >&2
  exit 1
fi

agent-browser --session "$browser_session" click '[data-testid="bottom-tab-sessions"]' >/dev/null
wait_for_browser_visibility "$browser_session" '[data-testid="mobile-session-drawer"]' true 16 200 >/dev/null
drawer_visible="$(browser_is_visible "$browser_session" '[data-testid="mobile-session-drawer"]')"
if [[ "$drawer_visible" != "true" ]]; then
  echo "Expected mobile sessions drawer to open" >&2
  exit 1
fi
agent-browser --session "$browser_session" click '[data-testid="mobile-drawer-close"]' >/dev/null
wait_for_browser_visibility "$browser_session" '[data-testid="mobile-session-drawer"]' false 16 200 >/dev/null

overflow_check="$(
  agent-browser --session "$browser_session" eval '
    document.documentElement.scrollWidth <= window.innerWidth &&
    document.body.scrollWidth <= window.innerWidth
      ? "ok"
      : JSON.stringify({
          body: document.body.scrollWidth,
          doc: document.documentElement.scrollWidth,
          inner: window.innerWidth,
        })
  '
)"
overflow_check="${overflow_check%\"}"
overflow_check="${overflow_check#\"}"
if [[ "$overflow_check" != "ok" ]]; then
  echo "Detected horizontal overflow at mobile viewport: $overflow_check" >&2
  exit 1
fi

print_section "tablet"
agent-browser --session "$browser_session" set viewport 768 900 >/dev/null
agent-browser --session "$browser_session" open "$VERIFY_ORCH_URL/" >/dev/null
wait_for_browser_visibility "$browser_session" '[data-testid="mobile-menu-button"]' true 20 250 >/dev/null
wait_for_browser_visibility "$browser_session" '[data-testid="bottom-tabs"]' false 20 250 >/dev/null
tablet_menu_visible="$(browser_is_visible "$browser_session" '[data-testid="mobile-menu-button"]')"
tablet_tabs_visible="$(browser_is_visible "$browser_session" '[data-testid="bottom-tabs"]')"
if [[ "$tablet_menu_visible" != "true" || "$tablet_tabs_visible" != "false" ]]; then
  echo "Tablet shell did not expose overlay menu without bottom tabs" >&2
  exit 1
fi

print_section "desktop"
agent-browser --session "$browser_session" set viewport 1440 900 >/dev/null
agent-browser --session "$browser_session" open "$VERIFY_ORCH_URL/" >/dev/null
wait_for_browser_visibility "$browser_session" '[data-testid="project-sidebar"]' true 20 250 >/dev/null
wait_for_browser_visibility "$browser_session" '[data-testid="mobile-menu-button"]' false 20 250 >/dev/null
desktop_sidebar_visible="$(browser_is_visible "$browser_session" '[data-testid="project-sidebar"]')"
desktop_menu_visible="$(browser_is_visible "$browser_session" '[data-testid="mobile-menu-button"]')"
if [[ "$desktop_sidebar_visible" != "true" || "$desktop_menu_visible" != "false" ]]; then
  echo "Desktop shell did not show sidebar / hide mobile menu as expected" >&2
  exit 1
fi

agent-browser --session "$browser_session" snapshot -i >"$snapshot_path"
agent-browser --session "$browser_session" screenshot "$screenshot_path" >/dev/null
agent-browser --session "$browser_session" close >/dev/null

print_section "summary"
echo "Mobile shell verification OK"
echo "Snapshot:   $snapshot_path"
echo "Screenshot: $screenshot_path"
