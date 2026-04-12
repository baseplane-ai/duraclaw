---
initiative: push-notifications-pwa
type: project
issue_type: feature
status: draft
priority: high
github_issue: 22
created: 2026-04-12
updated: 2026-04-12
phases:
  - id: p1
    name: "PWA Shell — manifest, service worker, install prompt"
    tasks:
      - "Add vite-plugin-pwa (v1.2+) with injectManifest strategy to vite.config.ts"
      - "Create src/sw.ts service worker source with Workbox precaching and push event handler stub"
      - "Configure web app manifest via plugin (name, icons, display: standalone, theme-color, shortcuts)"
      - "Generate PWA icon set (192px, 512px, 512px-maskable) and place in public/icons/"
      - "Source a short notification chime sound (.mp3, <1s, CC0/public domain from freesound.org or similar) and place in public/sounds/notification.mp3"
      - "Add virtual:pwa-register/react hook in __root.tsx for SW registration"
      - "Add offline detection banner component using navigator.onLine + online/offline events"
      - "Add SW update prompt toast when new version detected (via registerSW onNeedRefresh)"
    test_cases:
      - id: "manifest-served"
        description: "GET /manifest.webmanifest returns valid JSON with name, icons, display, start_url"
        type: "integration"
      - id: "sw-registered"
        description: "Service worker registers successfully on page load (navigator.serviceWorker.controller is set)"
        type: "e2e"
      - id: "install-prompt"
        description: "PWA install prompt fires on supported browsers (beforeinstallprompt event)"
        type: "e2e"
      - id: "offline-banner"
        description: "Offline banner appears when network disconnected, hides when reconnected"
        type: "e2e"
  - id: p2
    name: "Push subscription management — VAPID, D1 storage, subscribe/unsubscribe API"
    tasks:
      - "Generate VAPID key pair via pushforge CLI, store as wrangler secrets"
      - "Create D1 migration 0002_push_subscriptions.sql (push_subscriptions table)"
      - "Create D1 migration 0003_user_preferences.sql (user_preferences table)"
      - "Add POST /api/push/subscribe endpoint (accepts PushSubscription JSON, stores in D1)"
      - "Add POST /api/push/unsubscribe endpoint (removes subscription by endpoint)"
      - "Add GET /api/push/vapid-key endpoint (returns base64url public key)"
      - "Add client-side usePushSubscription hook (subscribe, unsubscribe, check permission state)"
      - "Add push opt-in banner component — dismissible dashboard banner with Enable button that fires Notification.requestPermission() on click (user gesture required by Firefox/Safari)"
      - "Add @pushforge/builder to orchestrator dependencies"
    test_cases:
      - id: "vapid-key-endpoint"
        description: "GET /api/push/vapid-key returns 200 with applicationServerKey string"
        type: "integration"
      - id: "subscribe-stores"
        description: "POST /api/push/subscribe stores subscription in D1, returns 201"
        type: "integration"
      - id: "subscribe-dedup"
        description: "POST /api/push/subscribe with same endpoint returns 200 (upsert, no duplicate)"
        type: "integration"
      - id: "unsubscribe-removes"
        description: "POST /api/push/unsubscribe removes subscription from D1, returns 204"
        type: "integration"
      - id: "subscribe-requires-auth"
        description: "POST /api/push/subscribe without session returns 401"
        type: "integration"
      - id: "opt-in-banner"
        description: "Banner appears on dashboard after login; clicking Enable triggers permission prompt; after grant, banner hides and localStorage push-prompt-dismissed is set; on next visit, banner does not reappear"
        type: "e2e"
  - id: p3a
    name: "Push dispatch + SW handlers — SessionDO fires push, SW shows notifications"
    tasks:
      - "Add sendPushNotification() helper in src/lib/push.ts using @pushforge/builder buildPushHTTPRequest()"
      - "Add dispatchPush() method to SessionDO that queries D1 via this.env.AUTH_DB for user subscriptions and sends push"
      - "Hook dispatchPush() into handleGatewayEvent() for ask_user, permission_request, result, and error events"
      - "Handle 410 Gone responses by auto-deleting stale subscriptions from D1; log and drop on 429/5xx/timeout (best-effort, no retry)"
      - "Add user preferences cascade check before dispatching (push.enabled master → event-specific key)"
      - "Implement push event handler in sw.ts — show notification with title, body, sessionId, tag, data"
      - "Implement notificationclick handler in sw.ts — clients.openWindow() to session deep link"
    test_cases:
      - id: "push-on-gate"
        description: "When session enters waiting_gate, push notification sent to all user subscriptions"
        type: "integration"
      - id: "push-on-complete"
        description: "When session completes, push notification sent with turns and cost in body"
        type: "integration"
      - id: "push-on-error"
        description: "When session errors, push notification sent with error message"
        type: "integration"
      - id: "push-stale-cleanup"
        description: "410 Gone response from push endpoint removes subscription from D1"
        type: "integration"
      - id: "push-respects-prefs"
        description: "No push sent when user has disabled the corresponding event type"
        type: "integration"
      - id: "notification-click-opens-session"
        description: "Clicking notification navigates to /sessions/:id"
        type: "e2e"
  - id: p3b
    name: "Action tokens + Chromium notification actions for gate resolution"
    tasks:
      - "Create src/lib/action-token.ts — generateActionToken(sid, gid, secret) and validateActionToken(token, secret)"
      - "Generate short-lived HMAC-SHA256 actionToken (session_id + gate.id + 5min expiry, signed with BETTER_AUTH_SECRET) in dispatchPush() for permission_request notifications"
      - "Add Bearer token auth check on tool-approval endpoint — accept actionToken as alternative to session cookie"
      - "Add notification actions for Chromium: approve/deny buttons on permission_request push payloads"
      - "Add notification action handler in sw.ts — POST to /api/sessions/:id/tool-approval with Bearer actionToken for approve/deny"
    test_cases:
      - id: "notification-action-resolves-gate"
        description: "Clicking approve/deny action on Chromium resolves gate without opening app"
        type: "e2e"
      - id: "action-token-valid"
        description: "Valid actionToken on tool-approval endpoint resolves gate, returns 200"
        type: "unit"
      - id: "action-token-expired"
        description: "Expired actionToken (>5 min) returns 401 with 'Token expired'"
        type: "unit"
      - id: "action-token-tampered"
        description: "Tampered actionToken returns 401 with 'Invalid token'"
        type: "unit"
  - id: p4
    name: "In-app notification bell, drawer, and preferences"
    tasks:
      - "Create NotificationBell component (lucide Bell icon + unread count badge)"
      - "Create NotificationDrawer component (Sheet from right on desktop, bottom on mobile)"
      - "Add notification items: icon per type, session name, timestamp, body text, mark-read action"
      - "Store in-app notifications in Zustand store (persisted to localStorage, 30 days TTL)"
      - "Extend ProjectRegistry to broadcast notification events on push-worthy status transitions (waiting_gate, completed, failed, error)"
      - "Wire ProjectRegistry notification broadcasts to Zustand notification store via useAgent connection"
      - "Add NotificationBell to Header component between SidebarTrigger and separator"
      - "Create NotificationPreferences component with toggles per event type + push + sound"
      - "Add GET/PUT /api/user/preferences endpoints backed by user_preferences D1 table"
      - "Wire preferences to push dispatch and in-app notification filtering"
    test_cases:
      - id: "bell-shows-count"
        description: "Bell icon displays red badge with unread count when notifications exist"
        type: "e2e"
      - id: "drawer-opens"
        description: "Clicking bell opens notification drawer with chronological list"
        type: "e2e"
      - id: "mark-read"
        description: "Clicking notification marks it as read and decrements badge count"
        type: "e2e"
      - id: "prefs-persist"
        description: "Toggling push.blocked off in preferences prevents blocked notifications"
        type: "integration"
      - id: "prefs-api"
        description: "PUT /api/user/preferences stores key-value pairs, GET retrieves them"
        type: "integration"
---

## Overview

Duraclaw sessions run autonomously and frequently block on permission gates or user questions. Today, users must keep the browser tab open to notice these events. Phase 4 adds push notifications (Web Push API), a PWA shell for installability and instant load, and an in-app notification system so users never miss when Claude needs input — even from their lock screen.

## Feature Behaviors

### B1: PWA Installability

**Core:**
- **ID:** pwa-install
- **Trigger:** User visits the app in a supported browser
- **Expected:** Browser fires `beforeinstallprompt`; app is installable to home screen with standalone display, themed splash screen, and app shortcuts
- **Verify:** Open Chrome DevTools > Application > Manifest; confirm all fields populated, installability check passes, and "Install app" prompt appears in address bar
**Source:** `apps/orchestrator/vite.config.ts` (add vite-plugin-pwa plugin)

#### UI Layer
- No install button in the UI initially — rely on browser-native install prompt
- SW update toast via Sonner: "New version available — click to update" with "Reload" action button
- Offline banner: fixed top bar with yellow background, "You are offline" text, and "Retry" button

#### Data Layer
- Web app manifest generated by vite-plugin-pwa from vite.config.ts configuration
- Icon files: `public/icons/icon-192.png`, `public/icons/icon-512.png`, `public/icons/icon-512-maskable.png` (maskable for Android adaptive icon rendering). Placed in `public/` so Vite serves them at `/icons/*` as-is — vite-plugin-pwa injectManifest does NOT auto-copy icon files.
- Service worker source: `src/sw.ts` (new file, Workbox injectManifest)

### B2: Push Subscription

**Core:**
- **ID:** push-subscribe
- **Trigger:** User logs in and clicks the "Enable notifications" banner on the dashboard (user gesture required by Firefox/Safari for `Notification.requestPermission()`)
- **Expected:** Browser prompts for notification permission; on grant, PushSubscription is created and stored in D1 linked to the user. Banner dismissed permanently (localStorage flag).
- **Verify:** After granting permission, query D1 `push_subscriptions` table and confirm a row exists with the user's ID, endpoint, p256dh, and auth keys
**Source:** new file `src/hooks/use-push-subscription.ts`, new file `src/api/push.ts`

#### UI Layer
- Permission prompt: dismissible banner on dashboard after login — "Enable push notifications to know when sessions need input" with "Enable" button. Clicking fires browser-native `Notification.requestPermission()`. Required because Firefox (v72+) and Safari silently suppress `requestPermission()` without a user gesture. Banner hidden after grant/deny/dismiss via localStorage flag `push-prompt-dismissed`.
- If denied: toast "Notifications blocked — enable in browser settings" (no repeated prompts)
- If granted: toast "Notifications enabled" with checkmark icon

#### API Layer
- `GET /api/push/vapid-key` — returns `{ publicKey: string }` (no auth required, public key is not secret)
- `POST /api/push/subscribe` — request: `{ endpoint, keys: { p256dh, auth } }`, response: 201 Created
- `POST /api/push/unsubscribe` — request: `{ endpoint }`, response: 204 No Content (POST instead of DELETE to avoid body-stripping issues with proxies/CDNs)
- All mutating endpoints require authenticated session. Error responses: `401 { error: 'Unauthorized' }` if no session, `400 { error: string }` if payload validation fails (missing keys, invalid endpoint URL)

#### Data Layer
- D1 migration `0002_push_subscriptions.sql`:
```sql
CREATE TABLE push_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  user_agent TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, endpoint)
);
```

### B3: Push on Gate (Blocked)

**Core:**
- **ID:** push-gate-blocked
- **Trigger:** SessionDO `handleGatewayEvent()` receives `ask_user` or `permission_request` event, transitioning status to `waiting_gate`
- **Expected:** Push notification sent to all of the session owner's subscriptions with the gate detail as body text
- **Verify:** Trigger a permission gate in a test session; confirm push notification appears on device within 5 seconds with correct title (session project name) and body ("Needs permission: {tool_name}" or "Asking: {question_text}")
**Source:** `apps/orchestrator/src/agents/session-do.ts:523-543` (ask_user and permission_request cases)

#### API Layer
- `@pushforge/builder` `buildPushHTTPRequest()` constructs the fetch request with VAPID signature
- Push payload JSON (canonical schema, used by both B3 and B8): `{ title: string, body: string, url: string, tag: string, sessionId: string, actionToken?: string, actions?: Array<{ action: string, title: string }> }` (no `sound` field — Web Notification API sound property is deprecated; notification sound is handled in-app only via Audio() API, see B7) — tag prevents duplicate notifications for same session
- Notification actions (Chromium only): `[{ action: 'approve', title: 'Allow' }, { action: 'deny', title: 'Deny' }]` for permission_request; no actions for ask_user (must type answer in app)

#### Data Layer
- Reads `push_subscriptions` WHERE `user_id` matches session owner
- Preference check cascade (short-circuit): (1) check `push.enabled` — if `'false'`, skip all push; (2) check event-specific key (`push.blocked` for gates, `push.completed` for results, `push.error` for errors) — if `'false'`, skip this event type. All keys default to `'true'` when row doesn't exist (opt-out model).
- On 410 Gone from push endpoint: DELETE subscription row
- On 429/5xx/network timeout: log and drop (best-effort delivery, no retry queue). Push is non-critical — the in-app notification system (B6) is the reliable fallback for connected clients.

### B4: Push on Completion

**Core:**
- **ID:** push-session-complete
- **Trigger:** SessionDO `handleGatewayEvent()` receives `result` event (is_error = false)
- **Expected:** Push notification with "Completed ({turns} turns, ${cost})" body
- **Verify:** Complete a session; confirm push appears with correct turn count and cost
**Source:** `apps/orchestrator/src/agents/session-do.ts:545-561` (result case)

#### API Layer
- Same push dispatch flow as B3
- No notification actions — click opens session view

### B5: Push on Error

**Core:**
- **ID:** push-session-error
- **Trigger:** SessionDO `handleGatewayEvent()` receives `result` with `is_error = true` or `error` event
- **Expected:** Push notification with body text based on event type: `result` with `is_error: true` → "Failed: {result.error || 'Session failed'}", `error` event → "Error: {error.message}". Two distinct prefixes reflect the severity — "Failed" is a session that ran but ended badly, "Error" is an infrastructure-level fault.
- **Verify:** Force a session error; confirm push appears with error text
**Source:** `apps/orchestrator/src/agents/session-do.ts:545-578` (result + error cases)

### B6: Notification Bell + Drawer

**Core:**
- **ID:** notification-bell
- **Trigger:** Any push-worthy event occurs on any of the user's sessions (gate, complete, error)
- **Expected:** Bell icon in header shows red badge with unread count; clicking opens a chronological drawer of notifications
- **Verify:** Trigger a gate event; confirm bell badge increments; click bell; confirm drawer shows the notification with correct icon, title, timestamp, and body
**Source:** `apps/orchestrator/src/components/layout/header.tsx:44` (insert before SidebarTrigger separator)

#### UI Layer
- `NotificationBell` component: lucide `Bell` icon (24px), red dot badge with count (hidden when 0)
- `NotificationDrawer` component: Radix Sheet (side="right" on desktop, side="bottom" on mobile)
- Each notification item: type icon (Shield for gate, CheckCircle for complete, AlertTriangle for error), session name, relative timestamp, body snippet, click navigates to session
- "Mark all as read" button at top, "Clear all" at bottom
- Empty state: "No notifications yet" with muted text

#### Data Layer
- Zustand store `src/stores/notifications.ts` with localStorage persistence
- Schema: `{ id, type, sessionId, sessionName, title, body, timestamp, read, url }`
- Auto-prune entries older than 30 days on store hydration
- **Multi-session notification source:** The client connects to ProjectRegistry DO via `useAgent` for the session sidebar. SessionDO already calls `this.syncToRegistry()` on state transitions (status changes, completion, errors). Extend ProjectRegistry to broadcast a `notification` event to connected clients when it receives a status update matching a push-worthy transition (waiting_gate, completed, failed, error). This gives the client notifications for ALL sessions, not just the currently-viewed one. Payload: `{ type: 'notification', sessionId, sessionName: title || project, status, detail }`.
- The Zustand notification store subscribes to ProjectRegistry broadcasts and creates notification entries when: (a) status = `waiting_gate` → gate notification, (b) status = `completed` → completed notification, (c) status = `failed` or `error` → error notification.
- `sessionName` is sourced from the registry's `title` or `project` field (already synced by SessionDO).

### B7: Notification Preferences

**Core:**
- **ID:** notification-prefs
- **Trigger:** User opens notification preferences (from drawer gear icon or future settings page)
- **Expected:** User can toggle push and in-app notifications per event type (blocked, completed, error) and toggle notification sound
- **Verify:** Disable "completed" push; complete a session; confirm no push is sent but in-app notification still appears
**Source:** new file `src/components/notification-preferences.tsx`

#### UI Layer
- Rendered inside NotificationDrawer as a collapsible section (gear icon toggle)
- Toggle switches per event type: "Gate blocked", "Session completed", "Session error"
- Master toggle: "Push notifications" (disables all push when off)
- Sound toggle: "Notification sound" — plays a custom chime via `Audio()` API for **in-app notifications only** (the Web Notification API `sound` property is deprecated and unsupported across all browsers; push notifications use OS-default sounds). Sound file: `/sounds/notification.mp3`, sourced from web during implementation.
- Changes save immediately via PUT /api/user/preferences (optimistic UI)

#### API Layer
- `GET /api/user/preferences` — returns `{ [key: string]: string }` for all keys for the authenticated user
- `PUT /api/user/preferences` — request: `{ key: string, value: string }`, response: 200 OK
- Both require authenticated session

#### Data Layer
- D1 migration `0003_user_preferences.sql`:
```sql
CREATE TABLE user_preferences (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (user_id, key)
);
```
- Preference keys: `push.enabled`, `push.blocked`, `push.completed`, `push.error`, `push.sound`
- All default to `'true'` when row does not exist (opt-out model, not opt-in)

### B8: Service Worker Push Handler

**Core:**
- **ID:** sw-push-handler
- **Trigger:** Push event received by service worker while app may or may not be in foreground
- **Expected:** Notification displayed with correct title, body, icon, and deep link; clicking opens or focuses the app at the session URL
- **Verify:** Close the app tab entirely; trigger a gate event from another client; confirm notification appears; click it; confirm app opens at correct session URL
**Source:** new file `src/sw.ts`

#### Data Layer
- Push payload schema (canonical, shared with B3): `{ title: string, body: string, url: string, tag: string, sessionId: string, actionToken?: string, actions?: Array<{ action: string, title: string }> }` (no `sound` field — Web Notification API sound property is deprecated; notification sound is handled in-app only via Audio() API, see B7)
- `actionToken` is a short-lived HMAC-SHA256 signed token (session_id + gate_id + expiry, signed with `BETTER_AUTH_SECRET`). Included only for permission_request notifications. The SW uses this token as a Bearer header when POSTing gate resolution, bypassing cookie-based auth (service workers don't have cookie access for cross-origin fetches).
- `tag` field: `session-{sessionId}` to replace rather than stack notifications for the same session
- `notificationclick` handler: if action is `approve`, POST to `/api/sessions/{id}/tool-approval` with `{ approved: true }`; if `deny`, POST with `{ approved: false }`; otherwise `clients.openWindow(url)`. Auth via signed token embedded in notification data (see B8).

### B9: Gate Action Token Auth

**Core:**
- **ID:** gate-action-token
- **Trigger:** Service worker POSTs to `/api/sessions/:id/tool-approval` with `Authorization: Bearer <actionToken>` (no session cookie available)
- **Expected:** Endpoint validates HMAC-SHA256 signature using `BETTER_AUTH_SECRET`, checks expiry (5 min TTL), extracts session_id and gate_id, resolves the gate
- **Verify:** Unit test with 3 cases: (1) valid token → 200, gate resolved; (2) expired token (>5 min) → 401 `{ error: 'Token expired' }`; (3) tampered token (modified payload) → 401 `{ error: 'Invalid token' }`
**Source:** `apps/orchestrator/src/api/index.ts` (tool-approval route), new file `src/lib/action-token.ts`

#### API Layer
- Token format: `base64url(JSON.stringify({ sid, gid, exp }))` + `.` + `base64url(HMAC-SHA256(payload, secret))`
- `sid` = session_id, `gid` = `state.gate.id` (which is the `tool_call_id` used by the existing tool-approval endpoint), `exp` = Unix timestamp (now + 300s)
- Generated in `dispatchPush()` when building permission_request push payloads
- Validated in tool-approval route: parse payload, verify signature via `crypto.subtle.verify()`, check `exp > Date.now()/1000`
- No replay protection needed — gate resolution is idempotent (re-resolving an already-resolved gate is a no-op)

## Non-Goals

- **Offline session list caching** — PWA caches app shell and static assets only. Full offline data access is Phase 8 scope.
- **Capacitor / native app wrapper** — moved to Phase 8.3 per roadmap. PWA is the mobile story for now.
- **Inline text input from notifications** — Chrome supports it but Safari/Firefox do not. Questions always require opening the app.
- **Notification batching** — each event fires individually. Batching adds complexity (timers in DOs) with minimal value given the low volume of events per user.
- **Email notifications** — push and in-app only. Email is a separate channel if needed later.
- **Settings page** — preferences live inside the notification drawer for now. Phase 6 builds the full settings page and will consume the same user_preferences table.

## Implementation Phases

**Phase 1: PWA Shell** (2-3 hours)
Foundation layer. Adds vite-plugin-pwa with injectManifest, web app manifest, service worker with Workbox precaching, offline banner, and SW update toast. No push logic yet — SW has a stub push handler.

**Phase 2: Push Subscription Management** (2-3 hours)
VAPID key generation, D1 migrations for subscriptions and preferences, API endpoints for subscribe/unsubscribe/vapid-key, and the client-side usePushSubscription hook with permission prompt flow.

**Phase 3a: Push Dispatch + SW Handlers** (2-3 hours)
Push sending via @pushforge/builder, hooks into SessionDO state transitions (B3-B5), handles 410 cleanup and error logging, respects user preferences cascade, implements SW push event handler and basic notificationclick (open session URL). Covers B3, B4, B5, B8 (sans action buttons).

**Phase 3b: Action Tokens + Notification Actions** (1-2 hours)
Action token generation and validation (B9), Bearer auth on tool-approval endpoint, Chromium notification action buttons for approve/deny. Isolates the security-sensitive code for focused review.

**Phase 4: In-App Notifications** (2-3 hours)
NotificationBell and NotificationDrawer components, ProjectRegistry notification broadcasts, Zustand notification store with localStorage persistence, notification preferences UI, and the user preferences API endpoints.

## Verification Plan

### Phase 1 Verification

1. Run `cd /data/projects/duraclaw/apps/orchestrator && pnpm build` — confirm clean build with no errors
2. Run `pnpm dev` and open `http://localhost:43173` in Chrome
3. Open Chrome DevTools > Application > Manifest — confirm manifest loads with:
   - `name: "Duraclaw"`
   - `display: "standalone"`
   - `start_url: "/"`
   - Icons at 192px and 512px
4. Open Chrome DevTools > Application > Service Workers — confirm SW is registered and active
5. In DevTools > Network, toggle "Offline" checkbox — confirm yellow offline banner appears at top of page
6. Toggle "Offline" off — confirm banner disappears
7. Run `pnpm typecheck` — confirm no type errors

### Phase 2 Verification

1. Run `wrangler d1 migrations apply duraclaw-auth --local` to apply new migrations
2. Start dev server with `pnpm dev`
3. Open `http://localhost:43173/api/push/vapid-key` — confirm JSON response `{ "publicKey": "<base64url string>" }`
4. Log in as test user, open browser console, run:
   ```js
   const reg = await navigator.serviceWorker.ready
   const sub = await reg.pushManager.subscribe({
     userVisibleOnly: true,
     applicationServerKey: '<vapid-public-key>'
   })
   await fetch('/api/push/subscribe', {
     method: 'POST',
     headers: { 'Content-Type': 'application/json' },
     body: JSON.stringify(sub.toJSON()),
   })
   ```
   Confirm 201 response
5. Run `wrangler d1 execute duraclaw-auth --local --command "SELECT * FROM push_subscriptions"` — confirm row exists
6. Verify push opt-in banner: log in as test user → confirm "Enable push notifications" banner on dashboard → click Enable → confirm browser permission dialog fires → after grant, confirm banner disappears → refresh page → confirm banner does not reappear
7. Run `pnpm typecheck` — confirm no type errors

### Phase 3a Verification

1. Start dev server, log in, and subscribe to push notifications (Phase 2 flow)
2. Create a new session and send a prompt that triggers a permission gate (e.g., file edit)
3. Confirm push notification appears on device within 5 seconds with:
   - Title: project/session name
   - Body: "Needs permission: {tool_name}"
4. Click the notification body — confirm app opens at the session URL
5. Let a session complete — confirm "Completed (N turns, $X.XX)" notification appears
6. Force a session error — confirm "Error: {message}" notification appears
7. Close the browser tab entirely, trigger a gate from another device/tab — confirm notification still arrives
8. Disable `push.completed` preference, complete a session — confirm no push notification
9. Run `pnpm typecheck` — confirm no type errors

### Phase 3b Verification

1. Start dev server, trigger a permission gate
2. On Chromium: confirm "Allow" and "Deny" action buttons visible on notification
3. Click "Allow" on the notification — confirm gate resolves in the session without opening the app
4. Trigger another gate, click "Deny" — confirm gate is denied
5. Wait 6 minutes, attempt to use a captured actionToken — confirm 401 "Token expired"
6. Run action token unit tests — confirm valid/expired/tampered cases all pass
7. Run `pnpm typecheck` — confirm no type errors

### Phase 4 Verification

1. Start dev server, log in, trigger a gate event on a session
2. Confirm bell icon in header shows red badge with "1"
3. Click the bell — confirm drawer slides out from right with the notification
4. Confirm notification shows: shield icon, session name, relative time ("just now"), gate detail
5. Click the notification item — confirm it navigates to the session page and marks as read
6. Confirm bell badge decrements to 0 (or hides)
7. Open notification preferences (gear icon in drawer) — confirm toggles for blocked/completed/error and push/sound
8. Disable "completed" toggle, complete a session — confirm no in-app notification for completion
9. Re-enable, complete another session — confirm notification appears
10. Run `pnpm typecheck` — confirm no type errors

## Implementation Hints

### Key Imports

```ts
// vite-plugin-pwa registration hook (client-side)
import { useRegisterSW } from 'virtual:pwa-register/react'

// Push building (server-side, in DO or API route)
import { buildPushHTTPRequest } from '@pushforge/builder'

// Workbox precaching (inside sw.ts)
import { precacheAndRoute } from 'workbox-precaching'

// Lucide icons for notification UI
import { Bell, Shield, CheckCircle, AlertTriangle } from 'lucide-react'

// Radix Sheet for drawer
import { Sheet, SheetContent, SheetTrigger } from '~/components/ui/sheet'
```

### Code Patterns

**vite-plugin-pwa config (vite.config.ts):**
```ts
import { VitePWA } from 'vite-plugin-pwa'

// Add to plugins array:
VitePWA({
  strategies: 'injectManifest',
  srcDir: 'src',
  filename: 'sw.ts',
  registerType: 'prompt',
  manifest: {
    name: 'Duraclaw',
    short_name: 'Duraclaw',
    description: 'Claude Code session orchestrator',
    theme_color: '#09090b',
    background_color: '#09090b',
    display: 'standalone',
    start_url: '/',
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icons/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ],
    shortcuts: [
      { name: 'New Session', url: '/?new=1', icons: [{ src: '/icons/icon-192.png', sizes: '192x192' }] },
      { name: 'Dashboard', url: '/', icons: [{ src: '/icons/icon-192.png', sizes: '192x192' }] },
    ],
  },
})
```

**Push dispatch from SessionDO (session-do.ts):**
```ts
// Inside handleGatewayEvent, after state update:
case 'permission_request':
  this.updateState({ status: 'waiting_gate', gate: { ... } })
  this.dispatchPush({
    title: this.state.project || 'Duraclaw',
    body: `Needs permission: ${event.tool_name}`,
    url: `/sessions/${this.state.session_id}`,
    tag: `session-${this.state.session_id}`,
    actions: [
      { action: 'approve', title: 'Allow' },
      { action: 'deny', title: 'Deny' },
    ],
  })
  break
```

**SW push event handler (sw.ts):**
```ts
self.addEventListener('push', (event) => {
  const data = event.data?.json()
  if (!data) return
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icons/icon-192.png',
      tag: data.tag,
      data: { url: data.url, sessionId: data.sessionId, actionToken: data.actionToken },
      actions: data.actions ?? [],
    })
  )
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const { url, sessionId, actionToken } = event.notification.data ?? {}
  if ((event.action === 'approve' || event.action === 'deny') && sessionId && actionToken) {
    // POST to existing tool-approval endpoint with signed token for auth
    event.waitUntil(
      fetch(`/api/sessions/${sessionId}/tool-approval`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${actionToken}`,
        },
        body: JSON.stringify({ approved: event.action === 'approve' }),
      })
    )
    return
  }
  event.waitUntil(clients.openWindow(url || '/'))
})
```

**Zustand notification store pattern (matches existing stores/ convention):**
```ts
import { create } from 'zustand'
import { persist } from 'zustand/middleware'

interface Notification {
  id: string
  type: 'gate' | 'completed' | 'error'
  sessionId: string
  sessionName: string
  body: string
  timestamp: string
  read: boolean
  url: string
}

export const useNotificationStore = create(
  persist<{ notifications: Notification[]; addNotification: (n: Notification) => void; markRead: (id: string) => void }>(
    (set) => ({
      notifications: [],
      addNotification: (n) => set((s) => ({ notifications: [n, ...s.notifications] })),
      markRead: (id) => set((s) => ({
        notifications: s.notifications.map((n) => n.id === id ? { ...n, read: true } : n),
      })),
    }),
    { name: 'duraclaw-notifications' }
  )
)
```

### Gotchas

1. **vite-plugin-pwa + @cloudflare/vite-plugin ordering** — vite-plugin-pwa must come BEFORE the cloudflare plugin in the plugins array, otherwise the SW build output may not be included in the asset manifest. Test by checking `dist/client/sw.js` exists after build.

2. **D1 access from Durable Objects** — Use `this.env.AUTH_DB` directly. Cloudflare DOs CAN access D1 bindings when they share the same Worker script — and SessionDO's `Env` type already includes `AUTH_DB`. No internal API route needed. Call `this.env.AUTH_DB.prepare(...).bind(...).all()` directly in `dispatchPush()`.

3. **Service worker scope with Cloudflare** — The `[assets]` binding in wrangler.toml serves from `dist/client/`. The SW file must end up at the root scope (`/sw.js`). vite-plugin-pwa handles this, but verify the output path after build.

4. **Push subscription endpoint URL stability** — Push endpoints are opaque URLs from the browser's push service. They can change without notice. Always use the UNIQUE(user_id, endpoint) constraint and handle upsert (INSERT OR REPLACE) to avoid constraint violations.

5. **VAPID subject format** — Must be either a `mailto:` URI or an `https://` URL. Use `mailto:` for simplicity: `mailto:push@codevibesmatter.com`.

6. **Notification permission state persistence** — The browser remembers the permission grant/deny, but the app does not know if the user later revoked it in browser settings. Always check `Notification.permission` before attempting to subscribe, and handle `denied` gracefully.

### Reference Docs

- [@pushforge/builder API](https://github.com/draphy/pushforge) — `buildPushHTTPRequest(subscription, payload, vapidKeys)` returns `{ url, headers, body }` ready for fetch
- [vite-plugin-pwa docs](https://vite-pwa-org.netlify.app/) — injectManifest strategy, registerType: 'prompt', virtual module usage
- [Web Push Protocol (RFC 8030)](https://datatracker.ietf.org/doc/html/rfc8030) — underlying protocol for push message delivery
- [Notification API MDN](https://developer.mozilla.org/en-US/docs/Web/API/Notification) — showNotification options, actions, tag deduplication
- [Workbox precaching](https://developer.chrome.com/docs/workbox/modules/workbox-precaching) — `precacheAndRoute(self.__WB_MANIFEST)` pattern for injectManifest
