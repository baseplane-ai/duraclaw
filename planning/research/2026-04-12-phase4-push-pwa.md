# Phase 4: Push Notifications + PWA — Research

> Date: 2026-04-12
> Scope: Planning research for Phase 4 (roadmap subphases 4.1, 4.2, 4.3)

## Current Codebase State

### What Exists
- **Toast system** — Sonner v2.0.7, configured in `__root.tsx` with 5s duration
- **SessionDO state machine** — Clear state transitions for `waiting_gate` (permission/question), `completed`, `failed`, `error` — exactly the triggers needed for push
- **Gate model** — `gate: { id, type: 'permission_request' | 'ask_user', detail }` on SessionState
- **DO SQLite** — v3 schema (events, messages, kv tables) with migration runner
- **D1 auth** — Better Auth with users/sessions/accounts/verifications tables
- **ProjectRegistry DO** — Session index with user_id, status, summary (v5 schema)
- **Static assets** — Served via `wrangler.toml` `[assets]` binding from `dist/client/`

### What Does NOT Exist
- No service worker, manifest.json, or PWA setup
- No push notification deps, VAPID keys, or subscription storage
- No notification bell, drawer, or notification preferences
- No `public/` directory in orchestrator
- No `vite-plugin-pwa` or workbox

## Key Architecture Decisions

### Push Library: @pushforge/builder (confirmed)
- v2.0.4, zero deps, MIT, uses WebCrypto (not Node crypto)
- Explicitly targets CF Workers — has live demo on Workers
- API: `buildPushHTTPRequest()` returns ready-to-send fetch request
- VAPID key generation: `pushforge generate` CLI
- **Best option** — `web-push` needs `nodejs_compat` and may break; `@block65/webcrypto-web-push` is less active

### Subscription Storage: D1 (not DO SQLite)
- Subscriptions are per-user, not per-session — awkward in session-scoped DOs
- D1 already in stack for auth, has global read replicas
- Simple relational query: "all subscriptions for user X"
- New `push_subscriptions` table alongside auth tables

### PWA Plugin: vite-plugin-pwa with injectManifest
- v1.2.0 supports Vite 7
- `injectManifest` strategy — custom SW with push event handler + Workbox precaching
- Auto-generates manifest.webmanifest from config
- `virtual:pwa-register/react` for registration hooks

### Notification Actions: Chromium-only, graceful degradation
- Chrome/Edge: 2 action buttons (approve/deny) on notifications
- Firefox/Safari: Actions silently dropped, notification still shows
- Click-through to app is the universal fallback
- No inline text input — questions always require opening the app

## State Transition → Push Trigger Mapping

| DO State Transition | Push Event | Notification Content |
|---------------------|-----------|---------------------|
| `running` → `waiting_gate` (permission) | `blocked` | "Needs permission: {tool_name} on {file_path}" |
| `running` → `waiting_gate` (ask_user) | `blocked` | "Asking: {question_text}" |
| `running` → `completed` | `completed` | "Completed ({turns} turns, ${cost})" |
| `running` → `failed` | `error` | "Failed: {error_message}" |
| `running` → `error` | `error` | "Error: {error_message}" |

These transitions already happen in `session-do.ts:handleGatewayEvent()` (lines 498-579). Push dispatch hooks into this existing flow.

## Schema Additions Needed

### D1 Migration (push_subscriptions)
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

### D1 Migration (user_preferences)
```sql
CREATE TABLE user_preferences (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY (user_id, key)
);
```

Preferences keys: `push.enabled`, `push.blocked`, `push.completed`, `push.error`, `push.sound`

## Wrangler Secrets Needed

- `VAPID_PUBLIC_KEY` — base64url-encoded ECDSA P-256 public key
- `VAPID_PRIVATE_KEY` — base64url-encoded ECDSA P-256 private key
- `VAPID_SUBJECT` — `mailto:` or URL identifier

## Open Questions for Interview

1. **Push notification frequency** — Should completed notifications be batched if multiple sessions finish close together, or always fire individually?
2. **Notification sound** — Custom sound or browser default?
3. **In-app notification history** — How long to retain? All time, 30 days, or just current browser session?
4. **PWA scope** — Full app or just the notification/approval flow?
5. **Gate resolution from notification** — Approve/deny directly from Chrome notification actions, or always open app? (Chrome-only feature)
6. **Offline behavior** — Should the PWA show cached session list when offline, or just a "you're offline" banner? (Full offline is Phase 8)

## Risk Assessment

| Risk | Likelihood | Mitigation |
|------|-----------|------------|
| Push subscription churn (users change browsers) | Medium | Auto-cleanup on 410 Gone responses |
| Safari/Firefox no notification actions | Certain | Graceful degradation — click opens app |
| Service worker caching stale app versions | Medium | `vite-plugin-pwa` handles with `skipWaiting` + prompt |
| VAPID key rotation | Low | Store in Wrangler secrets, rotate procedure documented |
| Push rate limits (Chrome 144+) | Low | Duraclaw is engagement-heavy by nature (users approve gates) |

## Recommended Phase Order

1. **4.3 PWA Shell** — Foundation: manifest, SW registration, app shell caching, install prompt
2. **4.1 Push Notifications** — Requires SW from 4.3; VAPID, subscriptions, DO → push dispatch
3. **4.2 In-App Notifications** — Bell icon, drawer, preferences storage, pairs with push prefs

Rationale: PWA shell is prerequisite for push (needs service worker). In-app notifications build on push infrastructure (shared preferences, same event triggers).
