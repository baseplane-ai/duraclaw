---
initiative: capacitor-android-mobile-shell
type: project
issue_type: feature
status: sunset
sunset_date: 2026-04-30
sunset_reason: "GH#132 P3 — replaced by Expo SDK 55 native target (apps/mobile-expo/, package com.baseplane.duraclaw.rn)"
priority: high
github_issue: 26
created: 2026-04-19
updated: 2026-04-30
prerequisites:
  - "GH#12 — Unify client data layer on TanStack DB collections (must be landed or in-flight)"
phases:
  - id: p1
    name: "Capacitor project scaffold + native SQLite persistence"
    tasks:
      - "Install Capacitor core: `pnpm add -w @capacitor/core @capacitor/cli`. Init: `npx cap init duraclaw com.baseplane.duraclaw --web-dir ../apps/orchestrator/dist/client`."
      - "Create `apps/mobile/` workspace: `capacitor.config.ts`, `android/` native project via `npx cap add android`. Add to `pnpm-workspace.yaml` and `turbo.json`."
      - "Install `@capacitor-community/sqlite`: `pnpm --filter @duraclaw/mobile add @capacitor-community/sqlite`. Run `npx cap sync android`."
      - "Create `apps/orchestrator/src/db/persistence-capacitor.ts`: import `@capacitor-community/sqlite`, open database 'duraclaw', export `createCapacitorPersistence()` returning a TanStack DB persistence handle compatible with `persistedCollectionOptions`. If TanStack ships `@tanstack/capacitor-db-sqlite-persistence`, use that; otherwise wrap `@capacitor-community/sqlite`'s async connection in the same `{exec, query}` interface that `@tanstack/browser-db-sqlite-persistence` consumes."
      - "Create `apps/orchestrator/src/lib/platform.ts` with `isNative()` using `import.meta.env.VITE_PLATFORM === 'capacitor'` (build-time flag, no runtime Capacitor import). This is created early in P1 because `db-instance.ts` needs it immediately. P3a will add `apiBaseUrl()`, `wsBaseUrl()`, `apiUrl()` helpers to the same file."
      - "Refactor `apps/orchestrator/src/db/db-instance.ts`: import `isNative()` from `platform.ts`. When `isNative()` is true, dynamically import `persistence-capacitor.ts` and call `createCapacitorPersistence()` instead of `openBrowserWASQLiteOPFSDatabase`. The dynamic `import()` ensures the Capacitor SQLite plugin is tree-shaken on web."
      - "Verify all 4+ TanStack DB collections (agent-sessions, messages, user-tabs, user-preferences, plus any from GH#12) initialise correctly on Android with native SQLite. Write a smoke test: launch app, create a session, kill and relaunch, verify cached data survives."
    test_cases:
      - id: "cap-init"
        description: "apps/mobile/android/ exists with valid build.gradle. `npx cap sync android` exits 0."
        type: "smoke"
      - id: "native-sqlite-persistence"
        description: "On Android emulator: open app, navigate to sessions list, sessions load into TanStack DB collection. Kill app process, relaunch — cached sessions render before network fetch completes."
        type: "integration"
      - id: "web-unchanged"
        description: "`pnpm build` succeeds. Web version still uses OPFS wa-sqlite. `Capacitor.isNativePlatform()` returns false on web. No regression."
        type: "smoke"

  - id: p2
    name: "Auth — Better Auth on Capacitor with bearer replay"
    tasks:
      - "Install `better-auth-capacitor`: `pnpm --filter @duraclaw/orchestrator add better-auth-capacitor`."
      - "Add build-time env var `VITE_API_BASE_URL`: on web defaults to `''` (same-origin relative), on Capacitor set to the deployed Worker URL (e.g. `https://duraclaw.baseplane.ai`). Wire into `vite.config.ts` via `define`."
      - "Refactor `apps/orchestrator/src/lib/auth-client.ts`: replace `window.location.origin` with `import.meta.env.VITE_API_BASE_URL || window.location.origin`. On Capacitor, add the `capacitorClient()` plugin from `better-auth-capacitor` which (a) disables default fetch redirect plugins, (b) stores the session token in `@capacitor/preferences`, (c) replays it as `Authorization: Bearer <token>` on every fetch."
      - "Refactor client-side fetch calls: audit `apps/orchestrator/src/api/index.ts` and all TanStack DB collection `queryFn` callbacks for relative-path fetch calls (e.g. `fetch('/api/sessions')`). Add `apiUrl(path: string): string` helper to the existing `platform.ts` (created in P1) that prepends `apiBaseUrl()` to the path. Replace all client-side fetch URLs with `apiUrl('/api/...')`. Note: server-side API handlers (using `env.CC_GATEWAY_URL`) are NOT affected — only client-to-Worker fetches need the base URL."
      - "On the server side (`apps/orchestrator/src/lib/auth.ts`): ensure Better Auth's `trustedOrigins` includes `capacitor://localhost` and the Android app's origin. Verify `bearer` plugin is enabled (Better Auth v1 includes it by default — confirm)."
      - "Add CORS configuration: the Worker currently has no explicit CORS middleware (verified: no `Access-Control` headers in `apps/orchestrator/src/`). Add a CORS handler in `apps/orchestrator/src/server.ts` (the main fetch export) that checks `Origin` against an allowlist including `capacitor://localhost` and the deployed Worker's origin, and sets `Access-Control-Allow-Origin`, `Access-Control-Allow-Headers`, `Access-Control-Allow-Credentials` on preflight and actual responses. This applies to ALL API routes — without it, fetch calls from the Capacitor WebView will be blocked by the browser's CORS policy in the native WebView."
      - "Test: launch on Android emulator, sign in with email/password, verify session persists across app restart without re-auth."
    test_cases:
      - id: "auth-sign-in"
        description: "On Android emulator: open app, navigate to login, enter credentials, submit. Redirected to dashboard. Session cookie/token persisted."
        type: "e2e"
      - id: "auth-persist"
        description: "After sign-in, kill app process, relaunch. App opens to dashboard (not login). No 401 errors in logcat."
        type: "e2e"
      - id: "auth-web-compat"
        description: "Web build still uses cookie-based auth with same-origin. No `better-auth-capacitor` plugin loaded on web (tree-shaken or platform-guarded)."
        type: "smoke"
      - id: "cors-headers"
        description: "From Android emulator, `adb logcat | grep -i cors` shows no CORS errors. Alternatively, use curl with `-H 'Origin: capacitor://localhost'` against the Worker and verify `Access-Control-Allow-Origin` header is present in the response."
        type: "integration"

  - id: p3a
    name: "Platform helpers + Agents SDK WebSocket base-URL override"
    tasks:
      - "Extend `apps/orchestrator/src/lib/platform.ts` (created in P1 with `isNative()`): add `apiBaseUrl()`, `wsBaseUrl()` exports. Verify `apiUrl()` (added in P2) and all existing consumers use these helpers consistently. Refactor useAgent calls to use `wsBaseUrl()`."
      - "In `apps/orchestrator/src/features/agent-orch/use-coding-agent.ts` (and `use-coding-agent-collection.ts`): the `useAgent()` call constructs its WS URL from the page origin. Add a `host` option pointing at `wsBaseUrl()`. Verify `agents/react`'s `useAgent` accepts a `host` param — if not, wrap in a Duraclaw-local hook that overrides the WS endpoint."
      - "Write vitest unit tests: `platform.test.ts` (isNative/apiBaseUrl/wsBaseUrl with mocked import.meta.env), `persistence-capacitor.test.ts` (mock @capacitor-community/sqlite, verify exec/query delegation)."
      - "Test: on Android emulator, open a session, send a message. Verify WS connects to the deployed Worker (check logcat for `wss://` connection). Verify streaming assistant response renders."
    test_cases:
      - id: "ws-connects"
        description: "On Android emulator: create or open a session. Logcat shows WebSocket connection to wss://<WORKER_PUBLIC_URL>/agents/session-agent/<id>. No connection errors."
        type: "e2e"
      - id: "streaming-works"
        description: "Send a message in the session. Assistant response streams in real-time (partial_assistant events render incrementally). Full response completes."
        type: "e2e"
      - id: "platform-unit-tests"
        description: "`pnpm test --filter @duraclaw/orchestrator -- platform.test` passes. Tests cover isNative() returns false when VITE_PLATFORM unset, true when 'capacitor'."
        type: "unit"

  - id: p3b
    name: "App lifecycle management + error recovery"
    tasks:
      - "Implement B6 (app lifecycle): add `@capacitor/app` listener for `appStateChange`. On background (`isActive === false`), set a 5s timeout to close the WS gracefully. On foreground (`isActive === true`), cancel any pending close timeout, trigger reconnection if WS is closed, and call `getMessages` RPC to hydrate missed events. Show 'Reconnecting...' in status bar while `wsReadyState !== 1`."
      - "Implement B7 (error recovery): add `navigator.onLine` and `window.addEventListener('online'/'offline')` listeners. Show 'Offline' banner component when offline. REST calls fail immediately with user-visible error toast (no offline queue — consistent with non-goal 'offline session creation'). On auth 401 after token refresh failure, redirect to `/login` with 'Session expired' message. SQLite fallback already handled in `db-instance.ts`."
      - "Handle notification permission denied (B5 edge case): if user denies push permission, silently degrade — no FCM token registered, no retry prompt on this app launch. Show a dismissible 'Enable notifications in Settings' hint in the settings/preferences page if permission state is 'denied'. This is not a separate behavior — it's the B5 denied-permission edge case."
    test_cases:
      - id: "reconnect-on-foreground"
        description: "Open session with active stream → background app for 10s → foreground → 'Reconnecting...' appears briefly → stream resumes, no duplicate messages."
        type: "e2e"
      - id: "offline-banner"
        description: "Enable airplane mode on emulator. 'Offline' banner appears. Disable airplane mode. Banner disappears, app reconnects."
        type: "e2e"
      - id: "session-expired-redirect"
        description: "Expire/revoke auth token server-side. Next API call from app triggers redirect to /login with 'Session expired' message."
        type: "e2e"

  - id: p4
    name: "Push notifications via Firebase Cloud Messaging"
    tasks:
      - "Install `@capacitor/push-notifications`: `pnpm --filter @duraclaw/mobile add @capacitor/push-notifications`."
      - "Create Firebase project, register Android app, download `google-services.json` into `apps/mobile/android/app/`."
      - "Create `apps/orchestrator/src/hooks/use-push-subscription-native.ts`: on Capacitor, use `@capacitor/push-notifications` to request permission, get FCM token, and POST it to a new server endpoint `POST /api/push/fcm-subscribe` with `{token, platform: 'android'}`."
      - "Refactor `apps/orchestrator/src/hooks/use-push-subscription.ts`: detect platform. On web, use existing VAPID/service-worker flow. On native, delegate to `use-push-subscription-native.ts`."
      - "Server-side: add `POST /api/push/fcm-subscribe` and `POST /api/push/fcm-unsubscribe` handlers in `apps/orchestrator/src/api/index.ts` (where all existing push routes live, near the existing `/api/push/subscribe` handler). Store FCM tokens in a new `fcmSubscriptions` table in D1 (userId, token, platform, createdAt). The subscribe endpoint should upsert: if the token already exists for this user, update `createdAt`; if it exists for a different user, reassign it (token rotation)."
      - "Server-side: create `apps/orchestrator/src/lib/push-fcm.ts`: send FCM push via Firebase Admin SDK (HTTP v1 API — `POST https://fcm.googleapis.com/v1/projects/<project>/messages:send`). Payload shape matches `PushPayload` from `push.ts`."
      - "In `apps/orchestrator/src/agents/session-do.ts`: where `sendPushNotification` is called for web-push, also fan out to FCM tokens for the same user via `sendFcmNotification`. Handle FCM send failures: on HTTP 404 or 410 (invalid/expired token), delete the stale token from `fcmSubscriptions`. On 5xx, log and continue (no retry in v1 — follow-up optimization). Cache the Google OAuth2 access token in a module-level variable with 50-minute TTL to avoid redundant token exchanges on fan-out."
      - "D1 migration (next available number after existing migrations — currently `0009` but check `apps/orchestrator/src/lib/migrations.ts` at implementation time, as GH#12 may have added migrations): `NNNN_fcm_subscriptions.sql`. Add `fcmSubscriptions` table with full DDL from B5 Data Layer section (includes FOREIGN KEY, UNIQUE index on token, index on userId). Register in `migrations.ts` following the existing pattern."
    test_cases:
      - id: "fcm-permission"
        description: "On Android emulator: app prompts for notification permission on first launch (or via settings). Granting permission registers FCM token with server."
        type: "e2e"
      - id: "fcm-delivery"
        description: "Start a session on web, background the mobile app. When session completes, Android system notification appears with session title and tap navigates to the session."
        type: "e2e"
      - id: "web-push-unchanged"
        description: "Web push still uses VAPID/service-worker path. No FCM code loaded on web."
        type: "smoke"

  - id: p5
    name: "Build pipeline + internal distribution"
    tasks:
      - "Add `apps/mobile/scripts/build-android.sh`: orchestrator build (`pnpm --filter @duraclaw/orchestrator build`), `npx cap sync android`, Gradle assembleRelease. Output: unsigned APK at `apps/mobile/android/app/build/outputs/apk/release/`."
      - "Add `apps/mobile/scripts/sign-android.sh`: sign APK with a keystore (generate dev keystore, document prod keystore provisioning). Output: signed APK ready for sideload."
      - "Add turbo pipeline: `pnpm --filter @duraclaw/mobile build:android` triggers orchestrator build → cap sync → Gradle build."
      - "Add `VITE_PLATFORM=capacitor`, `VITE_API_BASE_URL`, and `VITE_WORKER_PUBLIC_URL` to `apps/mobile/.env.production` pointing at the deployed Worker. `VITE_PLATFORM` is the primary platform detection flag used by `platform.ts` — without it, all native-specific code paths are disabled."
      - "Document internal distribution: APK shared via secure link (no Play Store). Include install instructions for enabling 'Install from unknown sources'."
      - "Add to CI (optional follow-up): GitHub Actions workflow for Android APK build on push to `main`. Uses `setup-java` + `setup-android-sdk` actions."
    test_cases:
      - id: "build-succeeds"
        description: "`pnpm --filter @duraclaw/mobile build:android` exits 0. APK exists at expected path."
        type: "smoke"
      - id: "apk-installs"
        description: "Signed APK installs on a physical Android device or emulator via `adb install`. App launches, login works, sessions load."
        type: "e2e"
---

# Capacitor Android Mobile Shell — Cloud-Only Thin Client

> GitHub Issue: [#26](https://github.com/baseplane-ai/duraclaw/issues/26)
>
> Prerequisite: [GH#12 — Unify client data layer on TanStack DB collections](https://github.com/baseplane-ai/duraclaw/issues/12) (must land first or be in-flight with stable collection API)

## Overview

Ship Duraclaw as a native Android app via Capacitor, backed by platform-native SQLite (via `@capacitor-community/sqlite`) for the TanStack DB persistence layer, and FCM for push notifications. The app is a cloud-only thin client — all session execution runs on the existing CF Worker + VPS gateway deployment. The React UI bundle is shared with the web build (`orchestrator/dist/client`); the mobile delta is: (1) SQLite adapter swap in `db-instance.ts`, (2) auth flow via `better-auth-capacitor` bearer replay, (3) Agents SDK WS base-URL override, and (4) FCM push instead of Web Push.

Android-first. iOS follows as a separate phase (same Capacitor project, `npx cap add ios`). Internal APK distribution only — no Play Store listing in v1.

## Feature Behaviors

### B1: Native SQLite persistence

**Core:**
- **ID:** native-sqlite-persist
- **Trigger:** App launch on Android
- **Expected:** TanStack DB collections initialise with `@capacitor-community/sqlite` instead of wa-sqlite/OPFS. All collection data (sessions, messages, tabs, preferences) persists across app kills and device reboots.
- **Verify:** Launch app → load sessions → force-kill → relaunch → cached sessions render before any network fetch.
- **Source:** `apps/orchestrator/src/db/db-instance.ts:27-50`

#### UI Layer

No UI change — collections are consumed by the same React components. The persistence swap is invisible to the render layer.

#### API Layer

N/A — persistence is local-only.

#### Data Layer

New file: `apps/orchestrator/src/db/persistence-capacitor.ts`
- Opens `@capacitor-community/sqlite` connection named `'duraclaw'`
- Wraps in TanStack DB persistence interface (same `{exec, query}` contract as the browser adapter)
- If `@tanstack/capacitor-db-sqlite-persistence` exists on npm, use it directly

Modified: `apps/orchestrator/src/db/db-instance.ts`
- Platform detection: `Capacitor.isNativePlatform()` → capacitor path; else → existing OPFS path
- Dynamic `import()` of `@capacitor/core` to avoid bundling on web

---

### B2: Bearer-based auth on Capacitor

**Core:**
- **ID:** capacitor-auth-bearer
- **Trigger:** User taps "Sign in" on the Android app
- **Expected:** `better-auth-capacitor` plugin intercepts the auth flow, stores the session token in `@capacitor/preferences`, and replays it as `Authorization: Bearer <token>` on all subsequent fetches. No Safari/Chrome browser popup. Session survives app restart.
- **Verify:** Sign in → kill app → relaunch → app opens to dashboard (not login screen).
- **Source:** `apps/orchestrator/src/lib/auth-client.ts:1-14`

#### UI Layer

Login page unchanged. The `better-auth-capacitor` plugin handles the transport difference transparently.

#### API Layer

- `auth-client.ts`: `baseURL` reads `import.meta.env.VITE_API_BASE_URL || window.location.origin`
- On Capacitor: adds `capacitorClient()` plugin to `createAuthClient()`
- Server: `trustedOrigins` in Better Auth config includes `capacitor://localhost`

#### Data Layer

Session token stored in `@capacitor/preferences` (native KeyValue store — uses Android `SharedPreferences` under the hood). **Security note:** `SharedPreferences` are stored as plaintext XML in the app's private directory. On Android 10+ with file-based encryption enabled, data-at-rest protection is provided by the OS. On older devices, tokens are protected only by Linux file permissions (`MODE_PRIVATE`). Acceptable for v1 internal distribution; for public release, migrate to `EncryptedSharedPreferences` (Jetpack Security) or a Capacitor plugin wrapping it.

---

### B3: Remote WebSocket connection to SessionDO

**Core:**
- **ID:** ws-base-url-override
- **Trigger:** User opens a session in the Android app
- **Expected:** `useAgent()` connects via WebSocket to the deployed Worker at `wss://<WORKER_PUBLIC_URL>/agents/session-agent/<sessionId>`. Streaming assistant responses render identically to web.
- **Verify:** Open session → send message → see streaming response → check logcat for `wss://` connection.
- **Source:** `apps/orchestrator/src/features/agent-orch/use-coding-agent.ts:284`

#### UI Layer

No change — same `ChatThread.tsx` rendering pipeline.

#### API Layer

- `useAgent({ agent, name, host })` — pass `host` from `import.meta.env.VITE_WORKER_PUBLIC_URL` on native
- If `useAgent` doesn't accept `host`: create wrapper hook that constructs the WS URL and passes it via the connection options
- All REST API calls already prefixed via `apiUrl()` helper (from B2 work)

#### Data Layer

N/A — WebSocket is a transport, no schema change.

---

### B4: Platform detection helpers

**Core:**
- **ID:** platform-helpers
- **Trigger:** Any code path that differs between web and Capacitor
- **Expected:** Centralised `apps/orchestrator/src/lib/platform.ts` exports `isNative()`, `apiBaseUrl()`, `wsBaseUrl()`. All platform-conditional code uses these helpers instead of inline checks.
- **Verify:** `grep -r 'Capacitor.isNativePlatform' apps/orchestrator/src/ --include='*.ts' --include='*.tsx'` returns only `platform.ts`.

#### UI Layer

N/A

#### API Layer

```ts
// apps/orchestrator/src/lib/platform.ts
export function isNative(): boolean
export function apiBaseUrl(): string   // '' on web, VITE_API_BASE_URL on native
export function wsBaseUrl(): string    // '' on web, VITE_WORKER_PUBLIC_URL on native
```

#### Data Layer

N/A

---

### B5: FCM push notifications

**Core:**
- **ID:** fcm-push
- **Trigger:** Session completes (transitions to `idle` or `result`) while the Android app is backgrounded
- **Expected:** Android system notification appears with session title. Tapping it opens the app and navigates to the completed session.
- **Verify:** Start a session via web → background mobile app → session completes → notification appears on Android.
- **Source:** `apps/orchestrator/src/agents/session-do.ts` (push fan-out), `apps/orchestrator/src/hooks/use-push-subscription.ts`

#### UI Layer

- New hook: `use-push-subscription-native.ts` — uses `@capacitor/push-notifications` to request permission, get FCM token
- **FCM token refresh**: listen for `PushNotifications.addListener('registration', ...)` which fires on initial registration AND on token rotation. On every `registration` event, POST the new token to `/api/push/fcm-subscribe` (server upserts by userId — old token replaced via `ON CONFLICT(token)` or delete-then-insert).
- Existing `use-push-subscription.ts` detects platform and delegates to native or web path
- Notification tap handler: `@capacitor/push-notifications` `pushNotificationActionPerformed` listener → navigate to session via router

#### API Layer

New endpoints:
- `POST /api/push/fcm-subscribe` — body: `{token: string, platform: 'android'}` — stores FCM registration token
- `POST /api/push/fcm-unsubscribe` — body: `{token: string}` — removes FCM registration token

New server module: `apps/orchestrator/src/lib/push-fcm.ts`
- Sends via Firebase Cloud Messaging HTTP v1 API
- `POST https://fcm.googleapis.com/v1/projects/<projectId>/messages:send`
- Uses service account credentials (stored as Worker secret `FCM_SERVICE_ACCOUNT_JSON`)

#### Data Layer

New D1 table: `fcmSubscriptions`
```sql
CREATE TABLE fcmSubscriptions (
  id TEXT PRIMARY KEY,
  userId TEXT NOT NULL,
  token TEXT NOT NULL,
  platform TEXT NOT NULL DEFAULT 'android',
  createdAt TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (userId) REFERENCES users(id) ON DELETE CASCADE
);
CREATE INDEX idx_fcm_userId ON fcmSubscriptions(userId);
CREATE UNIQUE INDEX idx_fcm_token ON fcmSubscriptions(token);
```

---

### B6: App lifecycle — WebSocket background management

**Core:**
- **ID:** app-lifecycle-ws
- **Trigger:** User backgrounds the Android app (Home press, task switch) or foregrounds it
- **Expected:** On background: WebSocket disconnects gracefully after 5s (Android kills background WS connections anyway — disconnect proactively to avoid partial state). On foreground: WebSocket reconnects automatically and replays any missed messages from the SessionDO. A brief "Reconnecting..." indicator shows in the status bar during reconnect.
- **Verify:** Open session with active streaming → background app for 10s → foreground → stream resumes within 3s, no duplicate messages.
- **Source:** `apps/orchestrator/src/features/agent-orch/use-coding-agent.ts:284` (useAgent connection)

#### UI Layer

- Status bar shows "Reconnecting..." when `wsReadyState !== 1` after foregrounding
- Once WS reconnects and hydration completes, status bar returns to normal session state

#### API Layer

- Use `@capacitor/app` `App.addListener('appStateChange', ...)` to detect foreground/background transitions
- On `isActive === false`: call `connection.close()` (or let Android kill it)
- On `isActive === true`: `useAgent` reconnects automatically (Agents SDK handles reconnection); trigger a `getMessages` hydration RPC to catch up on missed events

#### Data Layer

N/A — messages already cached in `messagesCollection` (TanStack DB). Any messages received during the brief reconnect window are replayed from the SessionDO.

---

### B7: Error recovery on mobile networks

**Core:**
- **ID:** mobile-error-recovery
- **Trigger:** Network loss (airplane mode, tunnel), network switch (WiFi → cellular), auth token expiry, SQLite connection failure
- **Expected:** Each failure mode has a defined recovery path:
  - **Network loss**: UI shows "Offline" banner. REST calls fail immediately with a user-visible error toast ("You're offline — check your connection"). No offline queue (consistent with non-goal: no offline session creation). WS auto-reconnects when network returns.
  - **Network switch**: WS may drop — same reconnect logic as B6 foreground path.
  - **Auth token expiry**: `better-auth-capacitor` handles refresh transparently. If refresh fails (e.g. token revoked server-side), redirect to login screen with "Session expired" message.
  - **SQLite connection failure**: Fall back to in-memory collections (same as the web OPFS-unavailable path in `db-instance.ts:39-42`). Log warning.
- **Verify:** Enable airplane mode while streaming → "Offline" banner appears. Disable → stream resumes. Force-expire token → app redirects to login.

#### UI Layer

- "Offline" banner component: shown when `navigator.onLine === false` or WS reconnect fails 3 times
- "Session expired" toast + redirect to `/login` on 401 from auth refresh

#### API Layer

- `apiUrl()` helper: catch fetch errors and surface user-friendly messages instead of silent failures
- Auth client: `better-auth-capacitor` handles token refresh; on 401 after refresh attempt, fire a `session-expired` event

#### Data Layer

N/A — SQLite fallback to in-memory is already implemented in `db-instance.ts`.

---

### B8: Android build + internal distribution

**Core:**
- **ID:** android-build-dist
- **Trigger:** Developer runs `pnpm --filter @duraclaw/mobile build:android`
- **Expected:** Outputs a signed APK installable on any Android 8+ device. Build chain: orchestrator Vite build → `cap sync android` → Gradle assembleRelease → sign.
- **Verify:** Install APK on a physical device via `adb install`. App launches and functions end-to-end.

#### UI Layer

N/A — build tooling only.

#### API Layer

N/A

#### Data Layer

N/A

Build artifacts:
- `apps/mobile/android/app/build/outputs/apk/release/app-release.apk`
- `apps/mobile/scripts/build-android.sh`
- `apps/mobile/scripts/sign-android.sh`
- `apps/mobile/.env.production` with `VITE_API_BASE_URL` and `VITE_WORKER_PUBLIC_URL`

---

## Non-Goals

Explicitly out of scope for this feature:

- **iOS build** — follows as a separate phase using the same Capacitor project (`npx cap add ios`). This spec is Android-only.
- **Electron desktop** — separate spec, later priority.
- **Local agent execution on device** — mobile is a thin client. No Bun, no `session-runner`, no `agent-gateway` on device.
- **Play Store / App Store listing** — internal APK sideload only.
- **Offline session creation** — requires cloud connectivity for session execution. Offline read-only access to cached data comes "free" from SQLite persistence but is not a tested guarantee.
- **Capacitor-web target** — the web version continues to use the existing OPFS wa-sqlite path. Capacitor's web fallback (jeep-sqlite / IndexedDB) is not used.
- **Deep links / universal links** — follow-up feature.
- **Biometric auth** — follow-up feature.
- **Custom app icon / splash screen** — first APK ships with default Capacitor icon. Custom branding is a follow-up task before any public distribution.

## Open Questions

- [x] Does `agents/react`'s `useAgent` accept a `host` parameter? → Verify in P3; if not, create wrapper hook.
- [x] Does `@tanstack/capacitor-db-sqlite-persistence` exist as a published npm package? → Verify in P1; if not, write a thin adapter wrapping `@capacitor-community/sqlite`.
- [x] Firebase project ownership → Create under `baseplane-ai` org Google Cloud project. Service account key as Worker secret.
- [x] Minimum Android API level → API 26 (Android 8.0, Oreo). Covers 95%+ of active devices. Set `minSdkVersion 26` in `build.gradle`.
- [x] FCM service account key storage → Worker secret `FCM_SERVICE_ACCOUNT_JSON` (not D1 — secrets are for credentials, D1 is for relational data).

## Implementation Phases

See YAML frontmatter `phases:` above. Estimated effort:

| Phase | Description | Estimate |
|-------|-------------|----------|
| P1 | Capacitor scaffold + native SQLite | 3–4 hours |
| P2 | Auth (better-auth-capacitor) + CORS | 2–3 hours |
| P3a | Platform helpers + WS base-URL override | 2–3 hours |
| P3b | App lifecycle + error recovery | 2–3 hours |
| P4 | FCM push notifications | 3–4 hours |
| P5 | Build pipeline + distribution | 2–3 hours |
| **Total** | | **~14–20 hours** |

## Verification Strategy

### Test Infrastructure

- **Android emulator**: API 33 (Android 13, Google APIs image) via Android Studio or `avdmanager`. Capacitor apps run on the emulator via `npx cap run android`.
- **Existing test suite**: `pnpm test` (vitest) covers unit/integration for the orchestrator. Mobile-specific tests are e2e on emulator.
- **Unit tests for new modules**: Add vitest tests for `platform.ts` (mock `import.meta.env`), `persistence-capacitor.ts` (mock `@capacitor-community/sqlite`), `push-fcm.ts` (mock `fetch` + `jose`), and `apiUrl()` helper. These run in the existing vitest config, no emulator needed.
- **Build verification**: `pnpm build` (all packages) + `npx cap sync android` + Gradle build.
- **VP1 deterministic verification**: To confirm cache-first rendering, use `adb shell settings put global airplane_mode_on 1` before relaunch so network is blocked, proving the render comes from SQLite alone.

### Build Verification

```bash
pnpm build                                    # Verify web build not broken
pnpm --filter @duraclaw/mobile build:android  # Verify Android APK builds
```

## Verification Plan

### VP1: Native SQLite persistence survives app kill

Steps:
1. `adb install apps/mobile/android/app/build/outputs/apk/release/app-release-signed.apk`
   Expected: App installs successfully
2. Launch app, sign in, navigate to sessions list. Note session count.
   Expected: Sessions load from server and cache to local SQLite.
3. `adb shell am force-stop com.baseplane.duraclaw`
   Expected: App process killed.
4. Relaunch app from launcher.
   Expected: Sessions list renders immediately from SQLite cache before any network request completes. Same session count visible.

### VP2: Auth persists across restart

Steps:
1. Launch app, sign in with test credentials.
   Expected: Dashboard loads.
2. `adb shell am force-stop com.baseplane.duraclaw`
3. Relaunch app.
   Expected: Dashboard loads directly — no login screen. `adb logcat | grep 401` shows no auth failures.

### VP3: WebSocket streaming works

Steps:
1. Open a session in the Android app.
2. Type "Say hello" and send.
   Expected: Assistant response streams in incrementally (not all-at-once). `adb logcat | grep WebSocket` shows `wss://` connection to the Worker.

### VP4: FCM push notification delivery

Steps:
1. Sign in on Android app. Grant notification permission.
2. Background the app (press Home).
3. From web UI or another device, start a session and let it complete.
   Expected: Android notification appears within 30 seconds of session completion.
4. Tap the notification.
   Expected: App opens to the completed session.

### VP5: App lifecycle — background/foreground reconnection

Steps:
1. Open a session in the Android app. Send a message that triggers a long response.
   Expected: Streaming response begins.
2. Press Home to background the app. Wait 10 seconds.
   Expected: App is backgrounded. WS disconnects gracefully (logcat shows close).
3. Bring app to foreground.
   Expected: "Reconnecting..." indicator appears briefly in status bar. Within 3 seconds, WS reconnects and streaming resumes (or shows completed response if it finished while backgrounded). No duplicate messages in the chat thread.

### VP6: Web build regression check

Steps:
1. `pnpm build` — exits 0.
2. `pnpm dev` — open `http://localhost:43173` in Chrome.
3. Sign in, open a session, send a message.
   Expected: Everything works exactly as before. No Capacitor code loaded. DevTools console shows no `@capacitor` imports.

## Implementation Hints

### Dependencies

```bash
# Capacitor core (workspace root)
pnpm add -w @capacitor/core @capacitor/cli

# Mobile workspace
pnpm --filter @duraclaw/mobile add @capacitor-community/sqlite @capacitor/push-notifications @capacitor/preferences @capacitor/app

# Orchestrator (auth plugin)
pnpm --filter @duraclaw/orchestrator add better-auth-capacitor

# Server-side (FCM JWT signing — CF Workers compatible)
pnpm --filter @duraclaw/orchestrator add jose
```

### Key Imports

| Module | Import | Used For |
|--------|--------|----------|
| `@capacitor/core` | `{ Capacitor }` | `isNativePlatform()` detection |
| `@capacitor-community/sqlite` | `{ CapacitorSQLite, SQLiteConnection }` | Native SQLite database handle |
| `better-auth-capacitor` | `{ capacitorClient }` | Auth client plugin for bearer replay |
| `@capacitor/push-notifications` | `{ PushNotifications }` | FCM token registration + notification listeners |
| `@capacitor/preferences` | `{ Preferences }` | Session token persistence (used by better-auth-capacitor internally) |
| `@capacitor/app` | `{ App }` | App lifecycle events (foreground/background detection for B7) |
| `jose` | `{ SignJWT, importPKCS8 }` | RS256 JWT signing for FCM auth on CF Workers (server-side only) |

### Code Patterns

**Platform detection (centralised):**
```ts
// apps/orchestrator/src/lib/platform.ts
//
// Uses VITE_PLATFORM build-time flag set in apps/mobile/.env.production.
// Avoids runtime dynamic import of @capacitor/core on web entirely.

export function isNative(): boolean {
  return import.meta.env.VITE_PLATFORM === 'capacitor'
}

export function apiBaseUrl(): string {
  return isNative() ? (import.meta.env.VITE_API_BASE_URL ?? '') : ''
}

export function wsBaseUrl(): string {
  return isNative() ? (import.meta.env.VITE_WORKER_PUBLIC_URL ?? '') : ''
}
```

**Capacitor SQLite persistence:**
```ts
// apps/orchestrator/src/db/persistence-capacitor.ts
import { CapacitorSQLite, SQLiteConnection } from '@capacitor-community/sqlite'

export async function createCapacitorPersistence() {
  const sqlite = new SQLiteConnection(CapacitorSQLite)
  const db = await sqlite.createConnection('duraclaw', false, 'no-encryption', 1, false)
  await db.open()

  // Wrap in TanStack DB persistence interface
  return {
    async exec(sql: string) { await db.execute(sql) },
    async query(sql: string, params?: unknown[]) {
      const result = await db.query(sql, params as any[])
      return result.values ?? []
    },
  }
}
```

**Auth client with Capacitor plugin:**
```ts
// apps/orchestrator/src/lib/auth-client.ts
//
// authClient is lazily initialised because the Capacitor plugin must be
// dynamically imported (tree-shaken on web) and createAuthClient is
// synchronous. We resolve plugins first, then create the client once.

import { adminClient } from 'better-auth/client/plugins'
import { createAuthClient } from 'better-auth/react'
import { apiBaseUrl, isNative } from './platform'

const baseURL = typeof window === 'undefined'
  ? 'http://localhost/api/auth'
  : `${apiBaseUrl() || window.location.origin}/api/auth`

// Eagerly build plugins list — on web this resolves synchronously (no await)
// On native the dynamic import() adds ~1ms
async function buildAuthClient() {
  const plugins: any[] = [adminClient()]
  if (isNative()) {
    const { capacitorClient } = await import('better-auth-capacitor')
    plugins.push(capacitorClient())
  }
  return createAuthClient({ baseURL, plugins })
}

// Exported as a promise; consumers await or use in a top-level-await context
// (same pattern as dbReady in db-instance.ts)
export const authClientReady = buildAuthClient()

// For non-async call sites that only run after app bootstrap (guarded by
// entry-client.tsx top-level await), re-export the resolved client:
let _resolvedClient: any = null
authClientReady.then((c) => { _resolvedClient = c })
export function getAuthClient() {
  if (!_resolvedClient) throw new Error('authClient not yet initialised')
  return _resolvedClient
}
```

**FCM push (server-side, CF Workers compatible):**
```ts
// apps/orchestrator/src/lib/push-fcm.ts
//
// JWT signing on CF Workers: use `jose` library (pure JS, Web Crypto API
// compatible) for RS256 signing with the service account private key.
// Do NOT use Node.js `crypto` — not available in Workers runtime.
import { SignJWT, importPKCS8 } from 'jose'

interface ServiceAccount { project_id: string; client_email: string; private_key: string }

// Module-level cache: reuse access token for 50 minutes (tokens valid 60 min)
let _cachedToken: { token: string; expiresAt: number } | null = null

async function getGoogleAccessToken(sa: ServiceAccount): Promise<string> {
  if (_cachedToken && Date.now() < _cachedToken.expiresAt) return _cachedToken.token
  const privateKey = await importPKCS8(sa.private_key, 'RS256')
  const now = Math.floor(Date.now() / 1000)
  const jwt = await new SignJWT({
    iss: sa.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.messaging',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  }).setProtectedHeader({ alg: 'RS256' }).sign(privateKey)

  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`,
  })
  const { access_token } = await resp.json() as { access_token: string }
  _cachedToken = { token: access_token, expiresAt: Date.now() + 50 * 60 * 1000 }
  return access_token
}

export async function sendFcmNotification(
  token: string, payload: PushPayload, sa: ServiceAccount,
) {
  const accessToken = await getGoogleAccessToken(sa)
  const resp = await fetch(
    `https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        message: {
          token,
          notification: { title: payload.title, body: payload.body },
          data: { url: payload.url, sessionId: payload.sessionId },
        },
      }),
    }
  )
  return { ok: resp.ok, status: resp.status }
}
```

### Gotchas

- **`@capacitor-community/sqlite` uses SQLCipher** — subject to US encryption export regulations. Use `encrypted: false` mode to avoid compliance burden.
- **Capacitor CORS**: native WebView doesn't enforce same-origin, but the CF Worker may reject `Origin: capacitor://localhost`. Add it to `trustedOrigins` in Better Auth and any CORS middleware.
- **`@capacitor/core` import on web**: must be dynamic `import()` or behind `try/catch require()` — the package throws on `globalThis.__capacitor` absence in a bare browser.
- **FCM on emulator**: Google Play Services required. Use a Google APIs system image, not a plain AOSP image.
- **Vite `define` for env vars**: `VITE_API_BASE_URL` and `VITE_PLATFORM=capacitor` must be set in `.env.production` for the Capacitor build, but left empty/unset for the web build. Use `apps/mobile/.env.production` (Capacitor-specific) alongside `apps/orchestrator/.env` (web).
- **FCM JWT signing on Workers**: CF Workers use Web Crypto API, not Node.js `crypto`. The `jose` library is the standard pure-JS solution for RS256 JWT signing in edge runtimes. Do NOT attempt to use `jsonwebtoken` or `google-auth-library` — both depend on Node.js crypto.
- **FCM token rotation**: FCM tokens silently rotate (typically weeks/months). If the app doesn't re-register on rotation, push stops working with no error. Always listen for `PushNotifications.addListener('registration', ...)` on every app launch, not just the first.

### Reference Docs

- [Capacitor — Getting Started](https://capacitorjs.com/docs/getting-started) — project init, `cap add`, `cap sync`
- [@capacitor-community/sqlite README](https://github.com/capacitor-community/sqlite) — API reference, connection lifecycle
- [better-auth-capacitor](https://github.com/daveyplate/better-auth-capacitor) — plugin config, cookie handling
- [TanStack DB 0.6 blog](https://tanstack.com/blog/tanstack-db-0.6-app-ready-with-persistence-and-includes) — persistence adapter pattern
- [Firebase Cloud Messaging HTTP v1 API](https://firebase.google.com/docs/cloud-messaging/send-message) — server-side send
- [@capacitor/push-notifications](https://capacitorjs.com/docs/apis/push-notifications) — client-side FCM registration
- [`jose` library](https://github.com/panva/jose) — RS256 JWT signing compatible with Web Crypto API (CF Workers)
- [Duraclaw research: Capacitor + Electron native targets](../research/2026-04-19-capacitor-electron-native-targets.md) — feasibility study

---
