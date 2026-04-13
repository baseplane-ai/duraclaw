---
initiative: mobile-session-cards-nav-cleanup
type: project
issue_type: feature
status: review-complete
priority: high
github_issue: 29
created: 2026-04-13
updated: 2026-04-13
phases:
  - id: p1
    name: "Mobile Session Cards Layout + Master-Detail Route"
    note: "Kata state caching (task 6-7) is deferrable — card layout works without it (badge hidden when no data). Can be split to a separate phase if DO migration is complex."
    tasks:
      - "Extract StatusDot, formatTimeAgo, and other shared utils from SessionListItem.tsx to a new session-utils.ts (they are currently module-private)"
      - "Create SessionCardList component with full-width card layout (minimal: status dot, title, time-ago, kata badge)"
      - "Add responsive breakpoint switch: cards on <640px, SessionSidebar on >=640px"
      - "Implement date-based grouping (Today, Yesterday, This Week, This Month, Older) in card view"
      - "Wire SessionCardList into AgentOrchPage with same props as SessionSidebar (excluding collapsed/onToggleCollapse which don't apply to cards)"
      - "Update existing session.$id.tsx route: remove beforeLoad redirect, render AgentDetailView on all viewports. On desktop, use CSS to also show sidebar (same as index page layout). On mobile, show detail-only with back button. This avoids viewport detection in route loader (SSR-unsafe)."
      - "Add kata state columns (kata_mode, kata_issue, kata_phase) to SessionAgent DO SQLite schema + include in SessionSummary type"
      - "Add kata_state VpsEvent handling in executor (packages/agent-gateway): emit kata_state event when kata enters/changes mode or phase, and in SessionAgent DO: handle incoming kata_state events to update SQLite columns"
    test_cases:
      - "At viewport <640px, session list renders as full-width cards, not sidebar"
      - "At viewport >=640px, existing SessionSidebar renders unchanged"
      - "Cards with kata state show badge (e.g. 'impl #29 P2')"
      - "Cards without kata state show NO badge element (hidden, not empty)"
      - "Date groups render with correct headers and sessions sorted within groups"
      - "Tapping a card on mobile navigates to /session/:id with back button to card list"
      - "/session/:id renders detail view on both mobile and desktop (no redirect)"
  - id: p2
    name: "Active Strip + Card Gestures"
    tasks:
      - "Install @use-gesture/react and @react-spring/web dependencies"
      - "Build ActiveStrip component: horizontal scrolling pill bar for active sessions (running/waiting + idle <2h)"
      - "Wire ActiveStrip into both mobile card view and desktop sidebar (above session list)"
      - "Implement @use-gesture/react useDrag + react-spring animated values for swipe gestures on mobile SessionCardList cards (desktop SessionListItem keeps existing raw touch handlers)"
      - "Hide strip entirely when no qualifying sessions exist"
    test_cases:
      - "Active strip shows running/waiting sessions plus idle sessions active within last 2 hours"
      - "Strip appears on both mobile (above cards) and desktop (top of sidebar)"
      - "Tapping a pill in the active strip switches to that session"
      - "Swipe-left on card archives (existing behavior preserved with gesture lib + spring physics)"
      - "Long-press on card opens context menu (existing behavior preserved)"
      - "Strip hides when no sessions qualify (no empty placeholder)"
  - id: p3
    name: "Navigation Cleanup + Filter Chips + Embedded History"
    note: "Nav removal and filter chip replacement ship as one atomic phase — never remove history access without the embedded replacement."
    tasks:
      - "Remove 'Dashboard' nav item from sidebar-data.ts"
      - "Remove 'History' nav item from sidebar-data.ts"
      - "Delete /history route file (apps/orchestrator/src/routes/_authenticated/history.tsx)"
      - "Remove WorkspaceSelector from sidebar header in app-sidebar.tsx, replace with app branding (AppTitle)"
      - "Build FilterChipBar component with workspace, status, and date-range chips"
      - "Refactor SessionHistory into embeddable table component (remove page wrapper, keep table + pagination + sort)"
      - "Add collapsible 'Older Sessions' section below recent cards/list items in both SessionCardList and SessionSidebar"
      - "Wire filter chips into both SessionSidebar (desktop) and SessionCardList (mobile)"
      - "Persist workspace filter selection to localStorage (key: session-workspace-filter)"
    test_cases:
      - "Sidebar nav shows only: Sessions, Settings, Admin (no Dashboard, no History)"
      - "/history URL returns 404 or redirects to /"
      - "Workspace selector no longer appears in sidebar header"
      - "Route tree regenerates cleanly after history.tsx deletion"
      - "Filter chip bar appears in session list header with workspace, status, date-range chips"
      - "Selecting a workspace chip filters sessions by that workspace"
      - "Selecting a status chip filters sessions by status"
      - "Date-range chip defaults to 'This Week', shows sessions from this week as cards/list items"
      - "Collapsible 'Older Sessions' section shows sessions outside the date range"
      - "When date-range is 'All', 'Older Sessions' section is hidden (all sessions in recent)"
      - "Workspace filter persists across page reloads"
  - id: p4
    name: "Polish + Spring Physics"
    tasks:
      - "Tune @use-gesture/react drag config: velocity threshold, rubberband factor"
      - "Tune @react-spring/web spring configs: tension, friction for snap-back and archive reveal"
      - "Add overscroll-behavior: none to prevent browser gesture conflicts on mobile"
      - "Test gesture performance on mobile viewport (no jank at 60fps)"
      - "Add empty states for mobile card view, filter-no-results, and active strip loading"
    test_cases:
      - "Swipe gestures feel native: velocity-based flick detection, spring snap-back"
      - "No browser back/forward gesture interference on swipe"
      - "Card transitions are smooth (no dropped frames visible)"
      - "Empty state message shows when no sessions exist"
      - "Empty state message shows when filters match no sessions"
---

## Overview

Replace the sidebar-based mobile session list with a card-based layout optimized for one-handed phone operation, and clean up redundant navigation (Dashboard, History, workspace selector in header) to simplify the information architecture. This is Phase 11.1-11.2 of the UX Overhaul roadmap, targeting the north-star goal of full mobile session parity.

## Feature Behaviors

### B1: Responsive Session List Layout

**Core:**
- **ID:** responsive-session-layout
- **Trigger:** User loads the authenticated index page (`/`) on any viewport
- **Expected:** On viewports <640px, sessions render as full-width vertical cards. On viewports >=640px, the existing `SessionSidebar` renders in its current sidebar position. The breakpoint is evaluated via CSS media query or a `useMediaQuery` hook, not `window.innerWidth` (SSR-safe).
- **Verify:** Open `http://localhost:43173/` at 400px width — see full-width session cards. Resize to 800px — see sidebar layout. No layout flash on initial load.
**Source:** `apps/orchestrator/src/features/agent-orch/AgentOrchPage.tsx:206-244`

#### UI Layer
- New component: `SessionCardList` in `apps/orchestrator/src/features/agent-orch/SessionCardList.tsx`
- Shares core props with `SessionSidebar`: sessions, selectedSessionId, onSelectSession, onSpawn, onArchiveSession, onRenameSession, onTagSession, onForkSession. Omits `collapsed` and `onToggleCollapse` (not applicable to full-width card layout)
- `AgentOrchPage` renders `SessionCardList` when mobile, `SessionSidebar` when desktop
- Mobile layout: master-detail pattern. `/` shows full-width card list. Tapping a card navigates to `/session/:id` which shows the detail view. Back navigation: render an explicit "← Sessions" button in the detail view header that calls `router.navigate({ to: '/' })` (not `history.back()` — which breaks on deep-link). Route file `apps/orchestrator/src/routes/_authenticated/session.$id.tsx` already exists (currently redirects to `/?session=$id`) — update it to render `AgentDetailView` directly on all viewports (remove `beforeLoad` redirect). On desktop, the route renders the same sidebar+detail layout as the index page with the session pre-selected. On mobile, it renders detail-only with back button. This avoids viewport detection in the route loader (which runs server-side and can't access `window`).

### B2: Session Card Design

**Core:**
- **ID:** session-card-design
- **Trigger:** Session data available in mobile card list
- **Expected:** Each card renders a minimal layout: status dot (colored per session status), title, time-ago string, and a kata badge showing mode + issue number + phase (e.g., "impl #29 P2"). Cards in the "recent" section are grouped by date sub-headers (Today, Yesterday, Earlier This Week, etc.) — these sub-headers always appear within the recent section regardless of the active date-range filter. Tapping a card navigates to `/session/:id` detail view (master-detail pattern with back button).
- **Verify:** Create 3+ sessions across different dates. Cards display status dot, title, time-ago, kata badge. Date group headers appear between groups. Tapping a card navigates to detail view. Back button returns to card list.
**Source:** `apps/orchestrator/src/features/agent-orch/SessionListItem.tsx` (reuse `StatusDot`, `formatTimeAgo`)

#### UI Layer
- Reuse `StatusDot` from `SessionListItem.tsx` (extract to shared if needed)
- Reuse `getDateGroup` and `DATE_GROUP_ORDER` from `SessionSidebar.tsx`
- Card layout: rounded border, full-width, padding. Row 1: status dot + title + time-ago. Row 2: kata badge (mode + issue + phase)
- Selected card gets `border-primary bg-accent` highlight (matches existing `SessionListItem`)
- Kata badge: small `Badge` component showing e.g. "impl #29 P2". Hidden when session has no kata state.
- **Accessibility:** Card list uses `role="list"`, each card is `role="listitem"`. Date group headers use `role="group"` with `aria-labelledby` pointing to the header text. Cards are keyboard-focusable with Enter to select. Screen readers announce: "{title}, {status}, {time-ago}" per card.

#### Data Layer
- Kata state is pushed from executor to DO via a new `kata_state` VpsEvent type:
  ```typescript
  interface KataStateEvent {
    type: 'kata_state'
    kata_mode: string | null    // e.g. "implementation", "planning", "debug"
    kata_issue: number | null   // e.g. 29 (GitHub issue number, integer)
    kata_phase: string | null   // e.g. "p1", "p2", "p3a" (lowercase phase ID)
  }
  ```
- The SessionAgent DO stores these as nullable TEXT/INTEGER columns in its SQLite session table. **Migration:** Add internal migration v4 to `session-do-migrations.ts` (current is v3): `ALTER TABLE sessions ADD COLUMN kata_mode TEXT; ALTER TABLE sessions ADD COLUMN kata_issue INTEGER; ALTER TABLE sessions ADD COLUMN kata_phase TEXT;`. Note: per project constraints, never remove deployed migrations.
- These fields are included in the `SessionSummary` type returned by `GET /api/sessions`. Badge format: `{kata_mode} #{kata_issue} {kata_phase}` → e.g. "impl #29 P2". Fields are nullable — sessions without kata state simply don't show a badge.

### B3: Active Strip

**Core:**
- **ID:** active-strip
- **Trigger:** At least one session qualifies: status is `running`, `waiting_gate`, `waiting_input`, `waiting_permission`, OR status is `idle` and `updated_at` is within the last 2 hours
- **Expected:** A horizontal scrolling pill bar appears at the top of the session list on BOTH mobile (above cards) and desktop (top of sidebar). Each pill shows status color, project initials (first 2 chars of project name), and is tappable to switch to that session. The strip hides entirely when no sessions qualify — no empty placeholder.
- **Verify:** Start a session so it enters `running` status. Active strip appears with a green pill showing project initials. Tap the pill — session detail view opens. Stop all sessions and wait >2h (or mock time) — strip disappears completely.

#### UI Layer
- New component: `ActiveStrip` in `apps/orchestrator/src/features/agent-orch/ActiveStrip.tsx`
- Horizontal scroll container with `overflow-x: auto`, `scrollbar-width: none`, `-webkit-overflow-scrolling: touch`
- Each pill: `rounded-full px-3 py-1.5`, background color from status (green=running, yellow=waiting, blue=spawning), white text with project initials (first 2 chars of `session.project` field from SessionSummary — this is the workspace project name set at session creation). **Fallback when `session.project` is null/empty:** show first 2 chars of `session.title`, or "??" if both are empty
- Strip positioned above the card list on mobile, above the session list in sidebar on desktop
- Strip renders in both `SessionCardList` (mobile) and `SessionSidebar` (desktop) — shared component
- **Accessibility:** Each pill has `aria-label="Switch to session: {title}"` and `role="button"`. The strip container has `role="toolbar"` and `aria-label="Active sessions"`. Arrow keys navigate between pills.
- **Loading state:** Strip does not render while sessions are still loading (same as empty state — hidden). No skeleton/spinner for the strip.
- **Error state:** If session fetch fails, strip is hidden (consistent with empty). Error is shown in the main card/list area, not in the strip.

### B4: Card Gestures with @use-gesture/react

**Core:**
- **ID:** card-gestures
- **Trigger:** User swipes left on a session card (mobile `SessionCardList` cards only), or long-presses
- **Expected:** Swipe-left reveals archive action (existing behavior). Long-press opens context menu (existing behavior). All gestures use `@use-gesture/react` `useDrag` with velocity-based flick detection and `@react-spring/web` animated values for spring physics. No swipe-right gesture — the active strip is auto-populated by status + recency. Desktop `SessionListItem` retains its existing raw touch handlers (migration to @use-gesture on desktop is a separate concern).
- **Verify:** On mobile viewport, swipe a card left — archive button reveals with spring animation. Long-press — context menu opens. Gestures feel smooth with spring snap-back. No swipe-right action.
**Source:** `apps/orchestrator/src/features/agent-orch/SessionListItem.tsx:136-228` (replace raw touch handlers)

#### UI Layer
- Replace `handleTouchStart`, `handleTouchMove`, `handleTouchEnd` in `SessionListItem` with `useDrag` from `@use-gesture/react`
- Use `useSpring` from `@react-spring/web` for animated `transform` values (spring snap-back, archive reveal)
- Drag config: `axis: 'x'`, `filterTaps: true`, `rubberband: true`
- Swipe-left threshold: 80px (existing `SWIPE_THRESHOLD`)
- Add `touch-action: pan-y` on card to prevent horizontal scroll interference
- Add `overscroll-behavior: none` on the card list container
- **Accessibility:** Archive action is also available via the context menu (long-press / right-click), so swipe is a convenience shortcut, not the only path. No keyboard-only alternative for swipe needed since context menu covers it.

### B5: Remove Dashboard Nav Item

**Core:**
- **ID:** remove-dashboard-nav
- **Trigger:** App renders sidebar navigation
- **Expected:** "Dashboard" nav item no longer appears. "Sessions" remains as the first nav item pointing to `/`. The sidebar nav shows: Sessions, Settings, Admin (for admin users).
- **Verify:** Log in and inspect sidebar. Only Sessions, Settings, and Admin (if admin) appear. No "Dashboard" item.
**Source:** `apps/orchestrator/src/components/layout/data/sidebar-data.ts:14-17`

#### UI Layer
- Remove the `Dashboard` entry from `sidebarData.navGroups[0].items` in `sidebar-data.ts`
- Keep `Sessions` entry at `url: '/'`

### B6: Remove History Route

**Core:**
- **ID:** remove-history-route
- **Trigger:** User navigates to `/history` or looks for History in nav
- **Expected:** `/history` no longer exists as a route. The "History" nav item is removed from the sidebar. Session history is accessible via a two-section layout: recent session cards at top, collapsible "Older Sessions" section below with the existing SessionHistory table (sort, paginate, search). The date-range filter chip controls what counts as "recent".
- **Verify:** Navigate to `/history` — see 404 or redirect to `/`. Sidebar has no "History" link. Session list shows recent cards + collapsible "Older Sessions" table below. Expanding the table shows sortable, paginated history.
- **Filter interaction:** The date-range chip controls the "recent" section boundary. When set to "This Week", the recent section shows this week's sessions as cards, and the "Older Sessions" section contains everything before this week. When set to "All", the "Older Sessions" section is hidden (all sessions are in the recent section). Workspace and status filters apply to BOTH sections (AND logic).
**Source:** `apps/orchestrator/src/routes/_authenticated/history.tsx` (delete), `apps/orchestrator/src/components/layout/data/sidebar-data.ts:23-26` (remove)

#### UI Layer
- Delete `apps/orchestrator/src/routes/_authenticated/history.tsx`
- Remove the `History` entry from `sidebarData.navGroups[0].items` in `sidebar-data.ts`
- Two-section layout in both mobile cards and desktop sidebar:
  - **Top**: Recent sessions (cards on mobile, list items on desktop) — controlled by date-range filter chip
  - **Bottom**: Collapsible "Older Sessions" section using existing `SessionHistory` table component (refactored to be embeddable, not a standalone page)
- `SessionHistory` component refactored: remove page wrapper/header, keep table + pagination + sort as an embeddable component
- **Mobile adaptation (<640px):** On mobile, the "Older Sessions" section renders as a simplified list (session title + time-ago + status dot per row) instead of the full table with columns. The table's sort and multi-column layout don't work well at narrow widths. Pagination ("Load more") still applies.

### B7: Demote Workspace Selector to Filter Chip

**Core:**
- **ID:** workspace-filter-chip
- **Trigger:** User views the session list (mobile or desktop)
- **Expected:** The workspace selector no longer appears in the sidebar header. Instead, a "Workspace" filter chip appears in the session list's filter bar. Clicking it opens a dropdown with workspace options (All, plus discovered workspaces). Selecting a workspace filters the session list.
- **Verify:** Sidebar header shows app title or logo, not workspace dropdown. Filter chip bar in session list contains a workspace chip. Click workspace chip — dropdown shows workspace options. Select a workspace — sessions filter correctly.
**Source:** `apps/orchestrator/src/components/layout/app-sidebar.tsx:24` (remove WorkspaceSelector), `apps/orchestrator/src/components/workspace-selector.tsx` (refactor to chip)

#### UI Layer
- Remove `<WorkspaceSelector />` from `AppSidebar` header
- Replace sidebar header with app branding or a simple "Duraclaw" title using `AppTitle`
- New component: `FilterChipBar` in `apps/orchestrator/src/features/agent-orch/FilterChipBar.tsx`
- `FilterChipBar` renders horizontal row of chips: Workspace (dropdown), Status (dropdown), Date Range (dropdown)
- Each chip shows current filter value, clickable to change
- Chip bar appears in both `SessionSidebar` (replacing the existing search/filter section) and `SessionCardList`
- Reuse workspace fetching logic from `WorkspaceSelector` (fetch `/api/gateway/projects`, group by repo origin)
- Workspace selection persists to localStorage (key: `session-workspace-filter`), defaults to "All"

### B8: Filter Chip Bar (Workspace + Status + Date Range)

**Core:**
- **ID:** filter-chip-bar
- **Trigger:** User views the session list on any viewport
- **Expected:** A horizontal chip bar appears below the session list header. Chips: Workspace (from B7), Status (all/running/completed/failed — replaces existing dropdown), Date Range (today/week/month/all — replaces History page's time browsing). Chips are compact, scrollable horizontally on mobile. Active filters show as filled chips, inactive as outlined.
- **Verify:** Filter chip bar visible in both desktop sidebar and mobile card view. Click Status chip — dropdown appears with options. Select "Running" — only running sessions show. Click Date Range chip — dropdown with time ranges. Select "This Week" — only sessions from this week show. Multiple filters combine (AND logic).

#### UI Layer
- `FilterChipBar` component with props: `statusFilter`, `onStatusChange`, `dateRange`, `onDateRangeChange`, `workspace`, `onWorkspaceChange`
- Each chip: `Badge` variant with dropdown trigger, `variant="default"` when active filter, `variant="outline"` when showing "All"
- Date range options: All, Today, Yesterday, This Week, This Month. **Default: "This Week"** — provides a useful initial scope without overwhelming with all-time data. The "Older Sessions" collapsible section shows sessions outside the selected date range.
- Horizontal scroll with `overflow-x: auto` on mobile, flex-wrap on desktop
- Replaces the existing `<Select>` status filter in `SessionSidebar` (the dropdown becomes a chip)
- Search `<Input>` remains as a separate element above the chip bar (text search is not a chip — it stays as an input field)
- **Loading state:** Workspace chip shows "Workspace" label with disabled state while projects are fetching. Status and Date Range chips are immediately interactive (static options).
- **Error state:** If workspace fetch fails, chip shows "Workspace" with an error indicator. Tapping opens a retry prompt. Other chips unaffected.

## Non-Goals

- **No swipe-between-sessions in detail view** — that is Phase 11.5, scoped to issue #31
- **No live card previews** (streaming output on cards, inline answer) — that is Phase 11.6, scoped to issue #31
- **No Cmd+K fuzzy finder or keyboard navigation shortcuts** — that is Phase 11.3-11.4, scoped to issue #30
- **No CSS scroll-snap carousel** — deferred to Phase 11.5
- **No changes to the session detail view** (AgentDetailView, ChatThread) — this issue only changes session list and navigation
- **No mobile-specific session detail layout** — the existing detail view works on mobile; optimization is a separate effort
- **No `pinned` field or manual pin gesture** — active strip is auto-populated by status + recency, no user-driven pinning
- **No backend API changes** beyond kata state caching — the existing `/api/sessions` endpoints are sufficient
- **No changes to authentication or admin pages**

## Verification Plan

### Prerequisites
```bash
cd apps/orchestrator && pnpm dev
# Wait for dev server at http://localhost:43173
```

### V1: Mobile Card Layout (after P1)
```bash
# Open in desktop viewport first
chrome-devtools-axi open http://localhost:43173/login
chrome-devtools-axi snapshot
chrome-devtools-axi fill @<email-ref> agent.verify+duraclaw@example.com
chrome-devtools-axi fill @<password-ref> duraclaw-test-password
chrome-devtools-axi click @<submit-ref>
chrome-devtools-axi snapshot
# Expect: SessionSidebar visible on left with session list (desktop layout)

# Switch to mobile viewport via DevTools device emulation
chrome-devtools-axi eval "await page.emulate({viewport: {width: 400, height: 800}, userAgent: 'Mozilla/5.0 (iPhone)'})" 
# Alternative: use CDP to set device metrics
chrome-devtools-axi eval "const cdp = await page.createCDPSession(); await cdp.send('Emulation.setDeviceMetricsOverride', {width: 400, height: 800, deviceScaleFactor: 2, mobile: true})"
chrome-devtools-axi open http://localhost:43173/
chrome-devtools-axi screenshot
# Expect: Full-width session cards, no sidebar column
# Each card shows: status dot, title, time-ago, kata badge
# Cards grouped by date headers (Today, Yesterday, etc.)

# Verify master-detail: tap a card, verify /session/:id loads with back button
chrome-devtools-axi snapshot
chrome-devtools-axi click @<first-card-ref>
chrome-devtools-axi snapshot
# Expect: Detail view with "← Sessions" back button in header
```

### V2: Active Strip (after P2)
```bash
# Create a session to get a running state
chrome-devtools-axi eval "document.documentElement.style.maxWidth = '400px'"
chrome-devtools-axi screenshot
# Expect: If running/waiting sessions exist, horizontal pill bar at top
# Each pill: colored background (green/yellow), project initials text
# Tap pill switches to session detail

# If no running sessions, strip should be hidden
chrome-devtools-axi snapshot
# Expect: No active strip element in accessibility tree when all sessions idle
```

### V3: Card Gestures (after P2)
```bash
# On mobile viewport with session cards visible
chrome-devtools-axi eval "document.documentElement.style.maxWidth = '400px'"
chrome-devtools-axi screenshot
# Verify swipe-left archive:
chrome-devtools-axi eval "document.querySelector('[data-session-card]')?.getBoundingClientRect()"
# Programmatic gesture simulation:
chrome-devtools-axi eval "const card = document.querySelector('[data-session-card]'); const rect = card.getBoundingClientRect(); card.dispatchEvent(new PointerEvent('pointerdown', {clientX: rect.x + rect.width/2, clientY: rect.y + rect.height/2, bubbles: true})); setTimeout(() => card.dispatchEvent(new PointerEvent('pointermove', {clientX: rect.x + rect.width/2 - 100, clientY: rect.y + rect.height/2, bubbles: true})), 50); setTimeout(() => card.dispatchEvent(new PointerEvent('pointerup', {bubbles: true})), 100)"
chrome-devtools-axi screenshot
# Expect: Archive action revealed on swiped card
# Verify NO swipe-right action (strip is auto-populated, no pin gesture)
# Verify long-press opens context menu
# Verify spring snap-back animation (visual check via screenshot sequence)
```

### V4: Navigation Cleanup (after P3)
```bash
chrome-devtools-axi open http://localhost:43173/
chrome-devtools-axi snapshot
# Expect sidebar nav items: Sessions, Settings (and Admin if admin user)
# Expect: NO "Dashboard" item
# Expect: NO "History" item
# Expect: NO workspace selector dropdown in sidebar header

# Verify /history is gone
chrome-devtools-axi open http://localhost:43173/history
chrome-devtools-axi snapshot
# Expect: 404 page or redirect to /

# Verify filter chips
chrome-devtools-axi open http://localhost:43173/
chrome-devtools-axi snapshot
# Expect: Filter chip bar with Workspace, Status, Date Range chips
# Click workspace chip — shows workspace options dropdown
# Click status chip — shows All/Running/Completed/Failed
# Click date range chip — shows All/Today/This Week/This Month
```

### V5: Unit Tests + Typecheck
```bash
# Unit tests (Vitest) — test files should be created alongside components:
# - src/features/agent-orch/__tests__/active-strip-utils.test.ts
#   - isQualifyingSession(running) → true
#   - isQualifyingSession(waiting_input) → true
#   - isQualifyingSession(idle, updatedAt: 1h ago) → true
#   - isQualifyingSession(idle, updatedAt: 3h ago) → false
#   - isQualifyingSession(completed) → false
#
# - src/features/agent-orch/__tests__/filter-utils.test.ts
#   - applyFilters(sessions, {workspace: "foo", status: "running"}) → only running in "foo"
#   - applyFilters(sessions, {dateRange: "today"}) → only today's sessions
#   - getRecentAndOlder(sessions, "this-week") → {recent: [...], older: [...]}
#   - getRecentAndOlder(sessions, "all") → {recent: [...], older: []}
#
# - src/features/agent-orch/__tests__/session-utils.test.ts
#   - getDateGroup(today) → "Today"
#   - getDateGroup(yesterday) → "Yesterday"
#   - formatTimeAgo(now - 30min) → "30m ago"
#   - getProjectInitials("my-project") → "my"
#   - getProjectInitials(null, "Session Title") → "Se"
#   - getProjectInitials(null, null) → "??"

cd /data/projects/duraclaw/apps/orchestrator && pnpm vitest run --reporter=verbose
# Expect: all tests pass

cd /data/projects/duraclaw && pnpm typecheck
# Expect: exit code 0, no type errors
```

## Implementation Hints

### Key Imports

```typescript
// Gesture + animation libraries (new deps — add to apps/orchestrator/package.json)
import { useDrag } from '@use-gesture/react'
import { useSpring, animated } from '@react-spring/web'

// Existing utilities to reuse
import { getDateGroup, DATE_GROUP_ORDER } from './SessionSidebar' // date grouping
import { formatTimeAgo, StatusDot } from './SessionListItem' // shared helpers (extract if not already exported)
import { useWorkspaceStore } from '~/stores/workspace' // workspace filtering
import { cn } from '~/lib/utils' // className merging

// For responsive breakpoint
// Option A: CSS-only with Tailwind (preferred — no JS needed)
// <div className="hidden sm:block">  — desktop sidebar
// <div className="sm:hidden">         — mobile cards
// Option B: Hook-based if JS logic needed
import { useSyncExternalStore } from 'react'
```

### Code Patterns

**Responsive layout switch (Tailwind breakpoint approach):**
```tsx
// In AgentOrchPage render:
<div className="flex h-[calc(100vh-4rem-28px)] overflow-hidden">
  {/* Desktop: sidebar */}
  <div className="hidden sm:block">
    <SessionSidebar {...sidebarProps} />
  </div>
  {/* Mobile: card list */}
  <div className="sm:hidden">
    <SessionCardList {...sidebarProps} />
  </div>
  <div className="flex flex-1 flex-col overflow-hidden">
    <TabBar onSelectSession={handleSelectSession} />
    {/* ... detail view */}
  </div>
</div>
```

**@use-gesture/react + @react-spring/web replacing raw touch handlers:**
```tsx
import { useDrag } from '@use-gesture/react'
import { useSpring, animated } from '@react-spring/web'

// Starting spring config (P4 tunes these values)
const [{ x }, api] = useSpring(() => ({ x: 0, config: { tension: 200, friction: 24 } }))

const bind = useDrag(
  ({ movement: [mx], active, cancel }) => {
    if (!active && mx < -80) {
      // Swipe left: archive — spring back then fire
      api.start({ x: 0, onRest: () => onArchive?.(!session.archived) })
      return
    }
    // During drag: spring-driven translate
    api.start({ x: active ? mx : 0, immediate: active })
  },
  { axis: 'x', filterTaps: true, rubberband: true }
)

// Apply: <animated.div {...bind()} style={{ x }}>
```

**Filter chip pattern:**
```tsx
function FilterChip({ label, value, options, onChange }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Badge
          variant={value ? 'default' : 'outline'}
          className="cursor-pointer whitespace-nowrap"
        >
          {value || label}
        </Badge>
      </DropdownMenuTrigger>
      <DropdownMenuContent>
        {options.map(opt => (
          <DropdownMenuItem key={opt.value} onClick={() => onChange(opt.value)}>
            {opt.label}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
```

### Gotchas

1. **SSR hydration mismatch**: Do not use `window.innerWidth` for responsive logic. Use Tailwind `sm:` breakpoints (CSS-only, no hydration issue) or `useSyncExternalStore` with a `matchMedia` subscription for JS-based checks.

2. **@use-gesture/react + @react-spring/web peer deps**: Both require `react >= 16.8`. Already satisfied. Install with `pnpm add @use-gesture/react @react-spring/web` in `apps/orchestrator/`.

3. **Route tree regeneration**: After deleting `history.tsx`, the TanStack Router route tree at `src/routeTree.gen.ts` must be regenerated. Run `pnpm dev` (Vite plugin auto-generates) or check for a `generate-routes` script.

4. **StatusDot and formatTimeAgo are not exported**: `SessionListItem.tsx` defines these as module-internal functions. Extract them to a shared file (e.g., `session-utils.ts`) or export them from `SessionListItem.tsx` before importing in `SessionCardList`.

5. **getDateGroup is already exported**: `SessionSidebar.tsx` line 31 exports `getDateGroup` and `DATE_GROUP_ORDER` — reuse directly.

6. **WorkspaceSelector fetch**: The workspace selector fetches `/api/gateway/projects` on mount. The new `FilterChipBar` should use the same pattern but lift the fetch to a shared hook or store to avoid duplicate requests (the workspace store already exists at `~/stores/workspace`).

7. **touch-action CSS**: When using `@use-gesture/react`, add `touch-action: pan-y` to swipeable card elements so the browser allows vertical scroll but lets the gesture lib handle horizontal.

8. **Existing SessionSidebar search/filter**: Phase 3 replaces the `<Input>` search and `<Select>` status filter in `SessionSidebar` with the `FilterChipBar`. The search input stays as a standalone element; only the dropdown filters become chips.

### Reference Docs

- `@use-gesture/react` docs: https://use-gesture.netlify.app/docs/gestures/ — API reference for `useDrag`, config options, gesture state
- TanStack Router file-based routing: https://tanstack.com/router/latest/docs/framework/react/guide/file-based-routing — route deletion and tree regeneration
- Tailwind responsive design: https://tailwindcss.com/docs/responsive-design — `sm:` breakpoint at 640px
- radix-ui DropdownMenu: https://www.radix-ui.com/primitives/docs/components/dropdown-menu — for filter chip dropdowns
