---
github_issue: 24
title: "UX Ergonomics — Chat-Native Session Orchestration"
status: approved
research: planning/research/2026-04-12-ux-ergonomics.md
created: 2026-04-12
phases:
  - id: p1
    name: "Foundation — Status Bar + Settings + Bug Fixes"
    behaviors: [B4, B5, B8, B9]
    tasks:
      - "Create StatusBar component with left/right sections, color-coded background"
      - "Add StatusBar to AuthenticatedLayout (fixed bottom)"
      - "Create user_preferences table in ProjectRegistry DO (migration)"
      - "Add GET/PUT /api/preferences routes"
      - "Create useUserDefaults() hook"
      - "Redesign settings page with Defaults, Notifications, Appearance sections"
      - "Fix ResultEvent handler in session-do.ts: completed → idle"
      - "Remove completed from SessionStatus type, update all references"
      - "Fix notification URLs to use /?session={id} format"
      - "Add redirect in session.$id.tsx route"
      - "Remove SessionMetadataHeader component (replaced by status bar)"
  - id: p2
    name: "Chat-Native — New Session Flow + Session List"
    behaviors: [B1, B2]
    tasks:
      - "Create QuickPromptInput component (centered prompt + config chips)"
      - "Replace empty-state in AgentOrchPage with QuickPromptInput"
      - "Implement config chips (project, model, permission) with click-to-cycle"
      - "Refactor SessionListItem for chat-list style (preview, dots, no badge)"
      - "Add last-message-preview to SessionRecord"
      - "Implement context menu (right-click/long-press) replacing dropdown"
      - "Add swipe gesture support for mobile (archive left, pin right)"
      - "Move SpawnAgentForm into Advanced expandable section"
  - id: p3
    name: "Command Palette + Workspaces"
    behaviors: [B3, B6]
    tasks:
      - "Extend CommandMenu component with session/project/action sections"
      - "Wire Cmd+K to command palette"
      - "Add fuzzy search over sessions, projects, actions"
      - "Add repo_origin to gateway /projects response"
      - "Implement workspace auto-detection (group by repo_origin)"
      - "Create WorkspaceSelector component (replaces TeamSwitcher)"
      - "Add workspace_preferences table + API routes"
      - "Wire workspace filter into session sidebar"
  - id: p4
    name: "Kata Status + Notifications + Tabs"
    behaviors: [B7, B10, B11]
    tasks:
      - "Add kata mode/phase to status bar with click-to-expand popover"
      - "Add kata mode badges to session sidebar items"
      - "Add action buttons to push notification payloads"
      - "Handle notification actions in service worker"
      - "Create TabBar component"
      - "Add tab keyboard shortcuts (Cmd+T/W/1-9)"
      - "Persist tab state in localStorage"
      - "Wire tab switching to session selection"
---

# UX Ergonomics — Chat-Native Session Orchestration

## Summary

Transform the orchestrator UI from a form-driven CRUD app into a chat-native agent orchestrator by adopting proven UX patterns from WhatsApp, Slack, Cursor, VS Code, and Claude.ai. The goal is: **type prompt, hit Enter, monitor at a glance**.

## Motivation

Current UX friction:
- Starting a session requires a form (project dropdown, model dropdown, prompt textarea, submit button) — 4 interactions minimum
- Session status is only visible inside a selected session's metadata header
- No keyboard navigation or command palette
- Settings page is empty (just sign-out)
- Permission mode can't be set as a default — must be configured per-session
- Completed sessions show "completed" instead of "idle" (non-resumable appearance)
- Notification links 404
- No workspace grouping for cloned repos (baseplane-dev1..dev6 appear unrelated)

---

## Behaviors

### B1: Zero-Friction New Session

**B1.1** When no session is selected, the main area shows a centered prompt input with inline config chips (project, model, permission mode) pre-filled from user defaults.

**B1.2** Typing a prompt and pressing Enter spawns a session immediately using the displayed defaults. No form, no modal, no extra clicks.

**B1.3** Config chips are clickable to cycle through options (click = next option, right-click or long-press = dropdown with all options).

**B1.4** The previous SpawnAgentForm is accessible via an "Advanced" toggle below the chips for max_budget, thinking mode, effort, system_prompt, and allowed_tools.

**Acceptance criteria:**
- New session can be started with exactly 2 interactions: type prompt + Enter
- Default project = last-used project (persisted in localStorage), fallback to first available
- Default model = user preference from settings, fallback to `claude-opus-4-6`
- Default permission mode = user preference from settings, fallback to `default`

### B2: Chat-List Session Sidebar

**B2.1** Each session row in the sidebar shows: status dot (colored), title/name, last message preview (truncated to 1 line), time-ago, and cost/turns as secondary text.

**B2.2** Status dots use pre-attentive color coding:
- Green solid = running
- Yellow solid = waiting (gate/question/permission)
- Grey outline = idle (resumable)
- Red solid = error/failed/aborted
- Blue pulse = spawning/connecting

**B2.3** Sessions waiting for user action (gate, permission, question) show the gate reason as the preview text (e.g., "Waiting: approve file edit").

**B2.4** Long-press (or right-click on desktop) opens a context menu with: Rename, Tag, Fork, Archive/Unarchive. Replaces the current `...` dropdown button.

**B2.5** Swipe-left on mobile archives the session. Swipe-right pins/stars it.

**Acceptance criteria:**
- Last message preview is visible without clicking into the session
- Status is conveyed by color dot, not text badge
- Gate/permission status is shown as preview text
- Context menu works on both mobile (long-press) and desktop (right-click)

### B3: Command Palette (Cmd+K)

**B3.1** Pressing Cmd+K (or Ctrl+K) opens a command palette overlay with fuzzy search.

**B3.2** Search sections (in order): Recent Sessions (top 5), All Sessions, Projects, Actions.

**B3.3** Session results show: title, project, status dot, time-ago. Selecting navigates to the session.

**B3.4** Project results show: project name, branch, worktree status (dirty/clean). Selecting starts a new session on that project (with prompt focus).

**B3.5** Actions include: "New session", "Stop all running", "Toggle permission mode", "Open settings", "Switch workspace".

**B3.6** Typing while the palette is open filters results immediately (debounced at 50ms).

**B3.7** Fuzzy search uses a lightweight client-side library (e.g., `fuse.js` or `cmdk`'s built-in scoring). The existing `CommandMenu` uses cmdk — extend it rather than replacing.

**Acceptance criteria:**
- Palette opens in <100ms (no layout shift)
- Fuzzy matching works on session title, prompt text, project name, tag
- Arrow keys + Enter for keyboard-only navigation
- Escape closes the palette
- Built on top of existing cmdk-based `CommandMenu` component

### B4: VS Code Status Bar (Bottom)

**B4.1** A persistent status bar is rendered at the bottom of the viewport, below all content, spanning the full width (including under the sidebar).

**B4.2** Left section shows (for the currently selected session): WS connection dot, session status text, project name, model, turn count, cost, context usage bar.

**B4.3** Right section shows: permission mode (clickable to cycle), kata mode/phase (if active), elapsed timer (when running), Stop/Interrupt buttons (when running).

**B4.4** Status bar background color changes based on session state:
- Default (muted/dark) = idle or no session
- Blue = running
- Orange/amber = waiting for user (gate/permission)
- Red = error/failed

**B4.5** Every item in the status bar is clickable (when a session is selected):
- Project name → open project switcher
- Model → open model picker
- Permission mode → cycle through modes (sends `SetPermissionModeCommand`)
- Kata status → toggle kata detail popover
- Context bar → show detailed token count tooltip
- When no session is selected, items are inert (no click handlers)

**B4.6** When no session is selected, the status bar shows "No session selected" in muted text.

**Acceptance criteria:**
- Status bar is always visible (fixed bottom, z-50)
- Height is exactly 28px (compact, terminal-style)
- Uses monospace font for data items
- Background color reflects session state
- SessionMetadataHeader at top is removed (its data moves to status bar)

### B5: Settings & User Defaults

**B5.1** Settings page is redesigned with sections: Account, Defaults, Notifications, Appearance.

**B5.2** Defaults section includes:
- Permission mode (radio group: default, acceptEdits, bypassPermissions, plan, dontAsk, auto)
- Model (select from MODEL_OPTIONS)
- Max budget (number input, USD)
- Thinking mode (adaptive/enabled/disabled)
- Effort level (low/medium/high/max)

**B5.3** User defaults are stored in the ProjectRegistry DO in a new `user_preferences` table (keyed by user_id). Note: push notification subscriptions already live in D1 — general preferences go in the DO to keep them co-located with session data and avoid cross-storage complexity.

**B5.4** Defaults are loaded on app init and available via a `useUserDefaults()` hook.

**B5.5** The spawn flow (B1) reads from these defaults. Per-session overrides are possible via chips or advanced form.

**B5.6** Notifications section shows push notification preferences (moved from `notification-preferences.tsx` component into settings page).

**B5.7** Appearance section consolidates theme, sidebar variant, layout, and direction settings (moved from config-drawer).

**Acceptance criteria:**
- Permission mode default is applied automatically to new sessions
- Model default is applied automatically to new sessions
- Settings persist across browser sessions (stored server-side in DO)
- Existing config-drawer still works but settings page is canonical

### B6: Workspace Grouping

**B6.1** The gateway `/projects` endpoint returns `repo_origin` (git remote origin URL) per project alongside existing fields.

**B6.2** Workspaces are auto-detected: projects sharing the same `repo_origin` are grouped into a workspace named after the repo (e.g., `github.com/org/baseplane` → "Baseplane").

**B6.3** A workspace selector appears at the top of the session sidebar. Options: "All" (default), then each detected workspace. Selecting a workspace filters the session list to its projects.

**B6.4** Users can rename workspaces via a "Manage Workspaces" option in the selector dropdown.

**B6.5** Each workspace can have its own defaults (model, permission mode, budget) that override user defaults. Workspace defaults stored in `workspace_preferences` table in ProjectRegistry DO.

**B6.6** The workspace selector replaces the current hardcoded `TeamSwitcher` component.

**Acceptance criteria:**
- Projects with the same git remote are automatically grouped
- Workspace filter is instant (client-side)
- Workspace names are editable
- Per-workspace defaults override user defaults for sessions in that workspace

### B7: Kata Status in Status Bar

**B7.1** When the selected session has kata state, the status bar shows `kata: {mode}/{phase}` (e.g., `kata: impl/p2`).

**B7.2** Clicking the kata status opens a popover showing: mode, phase, issue number (linked), session type, completed phases as badges, and a phase progress bar.

**B7.3** In the session sidebar list, sessions with kata state show a small colored mode badge:
- Planning = blue
- Implementation = green
- Research = purple
- Debug = red
- Verify = orange
- Task/freeform = grey

**Acceptance criteria:**
- Kata status is visible in the status bar without clicking anything
- Popover shows full kata detail on click
- Sidebar badges show kata mode per session

### B8: Bug Fix — Session Status `completed` → `idle`

**B8.1** When a session finishes successfully (ResultEvent with `is_error: false`), the DO sets status to `idle`, not `completed`. Fix at `session-do.ts:660`.

**B8.2** When a session finishes with an error (ResultEvent with `is_error: true`), the DO sets status to `failed`.

**B8.3** The `completed` value is removed from `SessionStatus` type. All references updated to use `idle` for finished-resumable sessions.

**B8.4** The `sendMessage` resume check at `session-do.ts:435` currently checks `status === 'completed'` — update to check `status === 'idle'` (or remove since idle is already checked).

**B8.5** The sidebar filter "Completed" is renamed to "Idle" or "Finished".

**Acceptance criteria:**
- After a successful session run, status shows `idle`
- Session remains resumable (can send new messages via sendMessage)
- No references to `completed` status remain in codebase

### B9: Bug Fix — Notification Links

**B9.1** All push notification URLs in `session-do.ts` are fixed from `/sessions/{id}` (wrong, 404s) to `/?session={id}` (correct). Affected lines: 611, 641, 679, 690, 719.

**B9.2** The `/session/{id}` route (`session.$id.tsx`) redirects to `/?session={id}`.

**B9.3** Push notification click handler in the service worker opens the correct URL.

**B9.4** In-app notification drawer links also use `/?session={id}` format.

**Acceptance criteria:**
- Clicking a notification navigates to the correct session
- No 404s on notification click
- Both in-app drawer and push notifications use the same URL scheme

### B10: Notification Actions

**B10.1** Push notifications for `ask_user` and `permission_request` gates include action buttons: "Approve" and "Open".

**B10.2** Push notifications for session completion include action buttons: "Open" and "New Session".

**B10.3** The "Approve" action sends a POST to `/api/sessions/{id}/gate` with `{ approved: true }` via the service worker.

**B10.4** The "Open" action opens the session URL in the browser.

**B10.5** Inline reply (text input in notification) is supported where the platform allows it (Chrome Android). The reply text is sent as a user message to the session.

**Acceptance criteria:**
- Gate notifications show Approve/Open buttons
- Approve action resolves the gate without opening the browser
- Reply input works on supported platforms

### B11: Agent Tabs

**B11.1** A tab bar appears above the chat area showing open sessions as horizontal tabs.

**B11.2** Cmd+T opens the currently selected session in a new tab (or creates a new empty tab).

**B11.3** Cmd+1/2/3/...9 switches to the Nth tab.

**B11.4** Cmd+W closes the current tab (does not stop the session).

**B11.5** Each tab shows: session name (truncated), status dot, close button on hover.

**B11.6** Tabs are persisted in localStorage so they survive page reload.

**Acceptance criteria:**
- Multiple sessions can be viewed by switching tabs
- Keyboard shortcuts work for tab navigation
- Tab state persists across page reloads
- Closing a tab does not affect the session

---

## Non-Goals

- **Split-view / multi-panel layout** — Tabs (B11) provide session switching; side-by-side split is a future enhancement.
- **Drag-and-drop session reordering** — Not needed for initial release.
- **Offline session management** — PWA shell exists but full offline is out of scope.
- **Custom keyboard shortcut remapping** — Use standard shortcuts (Cmd+K, Cmd+T, etc.) only.
- **Per-session notification preferences** — Notifications are global; per-session control is future work.

---

## Implementation Phases

### Phase 1: Foundation — Status Bar + Settings + Bug Fixes (B4, B5, B8, B9)

**Tasks:**
1. Create `StatusBar` component with left/right sections, color-coded background
2. Add `StatusBar` to `AuthenticatedLayout` (fixed bottom)
3. Create `user_preferences` table in ProjectRegistry DO (migration)
4. Add `GET/PUT /api/preferences` routes
5. Create `useUserDefaults()` hook
6. Redesign settings page with Defaults, Notifications, Appearance sections
7. Fix ResultEvent handler in session-do.ts: `completed` → `idle`
8. Remove `completed` from SessionStatus type, update all references
9. Fix notification URLs to use `/?session={id}` format
10. Add redirect in `session.$id.tsx` route
11. Remove `SessionMetadataHeader` component (replaced by status bar)

**Files touched:**
- `components/status-bar.tsx` (new)
- `components/layout/authenticated-layout.tsx`
- `agents/project-registry.ts` + migrations
- `api/` (new preferences routes)
- `hooks/use-user-defaults.ts` (new)
- `routes/_authenticated/settings.tsx`
- `agents/session-do.ts`
- `packages/shared-types/src/index.ts`
- `features/agent-orch/SessionMetadataHeader.tsx` (delete)
- `features/agent-orch/AgentDetailView.tsx`
- `components/notification-bell.tsx`
- `sw.ts`
- `routes/_authenticated/session.$id.tsx`

### Phase 2: Chat-Native — New Session Flow + Session List (B1, B2)

**Tasks:**
1. Create `QuickPromptInput` component (centered prompt + config chips)
2. Replace empty-state in `AgentOrchPage` with `QuickPromptInput`
3. Implement config chips (project, model, permission) with click-to-cycle
4. Refactor `SessionListItem` for chat-list style (preview, dots, no badge)
5. Add last-message-preview to `SessionRecord` (fetch from DO or include in list response)
6. Implement context menu (right-click/long-press) replacing `...` dropdown
7. Add swipe gesture support for mobile (archive left, pin right)
8. Move `SpawnAgentForm` into "Advanced" expandable section

**Files touched:**
- `components/quick-prompt-input.tsx` (new)
- `features/agent-orch/AgentOrchPage.tsx`
- `features/agent-orch/SessionListItem.tsx`
- `features/agent-orch/SessionSidebar.tsx`
- `features/agent-orch/SpawnAgentForm.tsx`
- `features/agent-orch/use-agent-orch-sessions.ts`
- `agents/project-registry.ts` (add last_message field)

### Phase 3: Command Palette + Workspaces (B3, B6)

**Tasks:**
1. Extend `CommandMenu` component with session/project/action sections
2. Wire Cmd+K to command palette (ensure no conflicts)
3. Add fuzzy search over sessions, projects, actions
4. Add `repo_origin` to gateway `/projects` response
5. Implement workspace auto-detection (group by repo_origin)
6. Create `WorkspaceSelector` component (replaces `TeamSwitcher`)
7. Add `workspace_preferences` table + API routes
8. Wire workspace filter into session sidebar

**Files touched:**
- `components/command-menu.tsx`
- `components/layout/team-switcher.tsx` → `components/workspace-selector.tsx`
- `components/layout/app-sidebar.tsx`
- `components/layout/data/sidebar-data.ts`
- `packages/agent-gateway/src/` (add repo_origin to projects endpoint)
- `packages/shared-types/src/index.ts` (add `repo_origin` to `ProjectInfo`)
- `agents/project-registry.ts` + migrations
- `api/` (workspace routes)

### Phase 4: Kata Status + Notifications + Tabs (B7, B10, B11)

**Tasks:**
1. Add kata mode/phase to status bar with click-to-expand popover
2. Add kata mode badges to session sidebar items
3. Add action buttons to push notification payloads
4. Handle notification actions in service worker (approve, reply, open)
5. Create `TabBar` component
6. Add tab keyboard shortcuts (Cmd+T/W/1-9)
7. Persist tab state in localStorage
8. Wire tab switching to session selection

**Files touched:**
- `components/status-bar.tsx` (extend)
- `features/agent-orch/SessionListItem.tsx` (add kata badge)
- `lib/push.ts` (add actions to payload)
- `sw.ts` (handle notificationclick actions)
- `components/tab-bar.tsx` (new)
- `features/agent-orch/AgentOrchPage.tsx`
- `features/agent-orch/AgentDetailView.tsx`

---

## Verification Plan

### VP1: Status Bar
- [ ] Status bar visible at bottom of viewport on all authenticated pages
- [ ] Background color changes: blue when running, orange when waiting, red on error
- [ ] All items clickable (model picker, permission cycle, etc.)
- [ ] Shows "No session selected" when nothing is selected

### VP2: Settings & Defaults
- [ ] Settings page has Defaults section with permission mode, model
- [ ] Changing permission mode default persists across page reload
- [ ] New session uses permission mode default automatically
- [ ] New session uses model default automatically

### VP3: Zero-Friction New Session
- [ ] Empty state shows prompt input with config chips
- [ ] Type prompt + Enter starts session with correct defaults
- [ ] Config chips show and are clickable

### VP4: Chat-List Sidebar
- [ ] Sessions show status dot (colored), preview text, time-ago
- [ ] Gate/permission sessions show reason as preview
- [ ] Context menu on right-click with Rename/Tag/Fork/Archive

### VP5: Command Palette
- [ ] Cmd+K opens palette
- [ ] Typing filters sessions, projects, actions
- [ ] Selecting a session navigates to it
- [ ] Arrow keys + Enter for keyboard navigation

### VP6: Bug Fixes
- [ ] After session completes, status shows "idle" not "completed"
- [ ] Notification click navigates to correct session (no 404)
- [ ] `/session/{id}` redirects to `/?session={id}`

### VP7: Workspaces
- [ ] Projects with same git remote grouped into workspace
- [ ] Workspace selector filters session list
- [ ] Workspace names editable

### VP8: Notification Actions
- [ ] Gate notifications show Approve/Open buttons
- [ ] Approve action resolves gate without opening browser

### VP9: Agent Tabs
- [ ] Tab bar shows open sessions
- [ ] Cmd+1/2/3 switches tabs
- [ ] Tab state persists across reload (localStorage, intentionally client-side not server-side)

### VP10: Mobile Gestures
- [ ] Swipe-left on session list item shows archive action
- [ ] Long-press on session list item opens context menu
- [ ] Touch interactions don't interfere with scroll
