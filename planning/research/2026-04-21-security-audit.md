# Security audit — orchestrator, gateway/runner trust chain, mobile/OTA, secrets

**Date:** 2026-04-21
**Mode:** research (RE-efc5-0421)
**Scope:** read-only audit of `apps/orchestrator`, `packages/agent-gateway`,
`packages/session-runner`, `packages/shared-transport`, `apps/mobile`,
plus secrets / OTA pipeline. No code changes proposed in-line — fixes
belong in follow-up `task` / `implementation` sessions.

## TL;DR — issue ranking

| # | Severity | Area | Finding | File:line |
|---|----------|------|---------|-----------|
| 1 | **HIGH** | Mobile | `WebView.setWebContentsDebuggingEnabled(true)` unconditional in MainActivity → ships in release APK | `apps/mobile/android/app/src/main/java/com/baseplane/duraclaw/MainActivity.java:11` |
| 2 | **HIGH** | OTA | Capgo bundle applied with no signature/checksum verification we control; manifest pointer in R2 is single-source-of-truth | `apps/orchestrator/src/lib/mobile-updater.ts:41-45`, `apps/orchestrator/src/api/index.ts:777-834` |
| 3 | **HIGH** | WS auth | Browser session WS + collab WS authenticate the *user* but never verify the user owns the `sessionId` in the URL → known session-id grants connect | `apps/orchestrator/src/server.ts:87,121-141`, `agents/session-do.ts` (`onConnectInner`) |
| 4 | **MEDIUM** | DO↔DO | `UserSettingsDO` `/broadcast` bearer compared with `!==` (not timing-safe) — inconsistent with other DO bearer checks that use `constantTimeEquals` | `apps/orchestrator/src/agents/user-settings-do.ts:103-104` |
| 5 | **MEDIUM** | Gateway | Default-allow when `CC_GATEWAY_API_TOKEN` unset; same default-allow in `PROJECT_PATTERNS`/`WORKTREE_PATTERNS` | `packages/agent-gateway/src/auth.ts:21`, `src/projects.ts:10,25-26` |
| 6 | **MEDIUM** | Gateway | Runner spawned with `callback_url` + bearer token in argv → visible in `/proc/<pid>/cmdline` and any `ps` for the same uid | `packages/agent-gateway/src/handlers.ts:192` |
| 7 | **MEDIUM** | Bootstrap | `/api/bootstrap` unconditionally promotes seeded user to `admin`; no rate limit; documented as left-on-in-prod | `apps/orchestrator/src/api/index.ts:535-570` |
| 8 | **MEDIUM** | Mobile | R2 assets passthrough has no key allowlist — `/api/mobile/assets/<anything>` will stream any object in `MOBILE_ASSETS` | `apps/orchestrator/src/api/index.ts:841-856` |
| 9 | **MEDIUM** | Mobile | APK signing script takes keystore password as env → leaks via `ps`/CI logs unless wrappers scrub | `apps/mobile/scripts/sign-android.sh:36-42,97-98` |
| 10 | **LOW** | DO RPCs | SessionDO `@callable` RPCs trust the connecting wire's `x-user-id` (set by REST middleware before forwarding) — fine *iff* item #3 is fixed | `apps/orchestrator/src/agents/session-do.ts` |
| 11 | **LOW** | Gateway | `sessionId` from gateway POST body is not regex-validated against UUID before being joined into `/run/duraclaw/sessions/<id>.*` paths | `packages/agent-gateway/src/handlers.ts:159-162` |
| 12 | **LOW** | FCM push | Service-account private key loaded from a Worker secret JSON; JWT claims minimally validated post-sign | `apps/orchestrator/src/lib/push-fcm.ts:28-36` |
| 13 | **LOW** | Mobile | `apps/mobile/.gitignore` does not list `*.jks` / `*.keystore` explicitly | `apps/mobile/.gitignore` |
| 14 | **INFO** | Worktree locks | `/api/chains/:issue/checkout` returns winning `ownerId` on 409 conflict (intentional UX, leak is just a user id) | `apps/orchestrator/src/api/index.ts:2156-2212` |

---

## 1. HIGH — Release APK ships with WebView debugging on

```java
// apps/mobile/android/app/src/main/java/com/baseplane/duraclaw/MainActivity.java
@Override
protected void onCreate(Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);
    WebView.setWebContentsDebuggingEnabled(true);   // ← unconditional
}
```

**Impact.** Any APK the infra pipeline ships exposes the WebView to
Chrome DevTools Protocol over USB / wireless ADB. An attacker with
physical access (or a malicious app holding `WRITE_SECURE_SETTINGS`)
can attach DevTools, read the better-auth bearer out of `localStorage`
(the `better-auth-capacitor` swap), inject JS that drives the
authenticated session, and exfiltrate the user's full message history.
Affects every install once a signed release lands.

**Fix shape.** Wrap in `BuildConfig.DEBUG` (so only debug-signed builds
get DevTools) — out of scope for this audit, but the line is small.

## 2. HIGH — OTA bundle has no integrity gate we own

```ts
// apps/orchestrator/src/lib/mobile-updater.ts
const dl = await CapacitorUpdater.download({
  url: manifest.url,
  version: manifest.version,
  // checksum?: manifest.checksum  // not populated; no signature verified
})
await CapacitorUpdater.set({ id: dl.id })
```

The manifest route (`/api/mobile/updates/manifest`) reads
`ota/version.json` from the `duraclaw-mobile` R2 bucket and returns
`{version, url}`. The native shell downloads the zip via
`/api/mobile/assets/ota/bundle-<sha>.zip` and applies it.

**Impact.** The trust root is "whoever can write `ota/version.json` and
`ota/bundle-<sha>.zip` to the R2 bucket". That's the infra deploy
pipeline today — fine — but there is **no second factor**: no
public-key signature embedded in the APK that the bundle has to
satisfy. A compromised CI token, a misrouted CF API token, or a stray
bucket-writer policy ships arbitrary JS to **every** installed APK on
the next foreground. This is the classic "OTA is a backdoor unless
signed" pattern.

**Defenses to consider** (not implemented now): sign `version.json`
with a key whose public half is bundled in the native shell; require
Capgo's checksum field; enforce R2 object versioning + alarm on
unexpected writes.

## 3. HIGH — Browser WS routes don't verify session ownership

```ts
// apps/orchestrator/src/server.ts
// Browser → SessionDO  (line 121-141)
const session = await getRequestSession(env, authRequest)
if (!session) return new Response('unauthorized', { status: 401 })
// ↓ x-user-id forwarded to DO; DO trusts it
return env.SessionAgent.get(idFromName(sessionId)).fetch(req, {
  headers: { ...req.headers, 'x-user-id': session.user.id },
})
```

The middleware confirms the WS request belongs to *some* logged-in
user, but **doesn't check that user owns `sessionId`**. The same
pattern recurs in `/api/collab/:sessionId/ws` (`server.ts:81-95`) for
the `SESSION_COLLAB` DO.

REST endpoints under `/api/sessions/:id/*` correctly call
`getOwnedSession()` (which returns 404 — not 403 — to avoid existence
disclosure). The WS path bypasses that check.

**Why it's HIGH (not critical).** Session IDs are server-minted
`crypto.randomUUID()` values not enumerable from the REST surface, so
exploitation requires an out-of-band leak (e.g., the worktree-
checkout 409 leaks an *owner id*, not a session id; a shared screenshot
of a URL would qualify). But once an attacker knows a victim's session
id, any logged-in account can connect to that session's WS and emit
RPCs (`@callable` `spawn`, `stop`, `requestSnapshot`, etc.).

**Fix shape.** In `SessionDO.onConnectInner` reject when
`x-user-id !== persisted_owner_user_id`; same in `SessionCollabDO`.
Cheap and contained.

## 4. MEDIUM — Non-timing-safe bearer compare on `UserSettingsDO /broadcast`

```ts
// apps/orchestrator/src/agents/user-settings-do.ts:103-104
const expected = `Bearer ${this.env.SYNC_BROADCAST_SECRET ?? ''}`
if (!auth || auth !== expected) return new Response('unauthorized', { status: 401 })
```

Every other bearer check in the worker (gateway projects sync
`api/index.ts:670`, gateway dial-back token in `session-do.ts:519`)
uses `constantTimeEquals`. This one is a `!==`. Practical exploitability
of timing on a CF Worker is low (network jitter dominates), but the
inconsistency is exactly the kind of footgun that lands wrong in the
next refactor. Cheap to fix; has a clear local idiom to follow.

## 5. MEDIUM — Default-allow gateway auth + project filter

```ts
// packages/agent-gateway/src/auth.ts:21
if (!process.env.CC_GATEWAY_API_TOKEN) return // allow all
```

```ts
// packages/agent-gateway/src/projects.ts:10
const PATTERNS = (process.env.PROJECT_PATTERNS ?? '').split(',').filter(Boolean)
// when empty → every git repo under /data/projects/ accepted
```

A misdeploy that empties the env (or a fresh box without the secret
imported) silently turns auth and the project allowlist off. This is
the "fail-open" pattern. Small misconfig → big blast radius. The
documented fixture for dev (default-allow when developing on the
loopback) is a reasonable convenience — but production deploys should
pass through a startup assertion that the token is set, ideally with a
distinct env flag (`DURACLAW_DEV_ALLOW_NO_AUTH=1`) to opt into the
loose mode explicitly.

## 6. MEDIUM — Callback bearer token in runner argv

```ts
// packages/agent-gateway/src/handlers.ts:192
spawn(runnerBin, [sessionId, cmdFile, callbackUrl, callbackToken,
                  pidFile, exitFile, metaFile], { detached: true, ... })
```

`callbackToken` is the per-session bearer the runner uses to dial the
SessionDO back. Linux makes argv visible to anyone with the same uid
via `/proc/<pid>/cmdline` and `ps`. On a single-tenant VPS this is
"only the duraclaw service user reads it" → contained; but any future
sidecar (log shipper, monitoring agent) running as the same user
inherits the secret. Cleaner: pass via env (`spawn(..., { env: {...,
DURACLAW_CALLBACK_TOKEN: token }})`) or via the existing `.cmd` file
which is already mode 0700.

The token's *URL form* (`?token=...&role=gateway`) is constructed
inside `DialBackClient` (`shared-transport/src/dial-back-client.ts:119`)
and is the actual WS connect URL. CF tail does not log WS upgrade
query strings by default, but a `console.log(callbackUrl)` anywhere on
the worker side would write the secret to logs — worth grepping
before each deploy.

## 7. MEDIUM — `/api/bootstrap` always promotes to admin

```ts
// apps/orchestrator/src/api/index.ts:535-570
// disabled unless BOOTSTRAP_TOKEN is set; bearer-gated
await db.update(users).set({ role: 'admin' }).where(eq(users.email, body.email))
```

The CLAUDE.md doc explicitly states `BOOTSTRAP_TOKEN` is *kept set as
a Worker secret in prod* so seed scripts can re-run. Trade-off: every
bearer-leak path = "create a new admin". No rate-limiting, no
per-email cooldown, no audit row. The admin gate is currently used by
exactly one route (`/api/deploys/state`) so the immediate blast is
narrow, but admin-only routes will accumulate.

**Compensating control to consider:** strip the admin promotion on
non-empty user table (only the *first* call ever returns admin); or
require a separate `BOOTSTRAP_ADMIN_TOKEN` in addition to
`BOOTSTRAP_TOKEN` so seeding test users without admin elevation is the
default.

## 8. MEDIUM — Unscoped R2 passthrough

```ts
// apps/orchestrator/src/api/index.ts:841-856
app.get('/api/mobile/assets/*', async (c) => {
  if (!c.env.MOBILE_ASSETS) return c.body('Not found', 404)
  const key = url.pathname.replace(/^\/api\/mobile\/assets\//, '')
  if (!key) return c.body('Not found', 404)
  const obj = await c.env.MOBILE_ASSETS.get(key)   // ← any key in bucket
```

R2 keys are flat (no real `..` traversal), but the route will happily
stream **any** object in `MOBILE_ASSETS`. The bucket today holds
`ota/bundle-<sha>.zip`, `ota/version.json`, `apk/duraclaw-<ver>.apk`,
`apk/version.json`. Adding *anything* else to that bucket — debug
artifacts, signing diagnostic dumps, internal release notes — exposes
it on a public route by accident. Tighten with an allowlist regex
(`^(ota|apk)/[A-Za-z0-9._-]+$`) or split into two buckets, one of
which is never bound to the worker.

## 9. MEDIUM — Keystore secrets via env

`apps/mobile/scripts/sign-android.sh` requires `KEYSTORE_PASS` /
`KEY_PASS` exported, then passes them to `apksigner` as flags. Two
risks:

1. `apksigner --ks-pass pass:$KEYSTORE_PASS` puts the secret in
   `/proc/<pid>/cmdline` for the duration of the sign; `ps -ef` from
   the same uid sees it.
2. CI runners that echo env to job logs (or `set -x` in a wrapper)
   leak it.

Switch to `--ks-pass env:KEYSTORE_PASS` (apksigner reads env var by
name without putting it in argv) and `--key-pass env:KEY_PASS`. Same
fix touches the keystore handling on the infra server.

## 10. LOW — SessionDO RPC trust model assumes WS auth holds

The `@callable` RPC methods on `SessionDO` (`spawn`, `stop`,
`requestSnapshot`, `rewind`, etc.) don't re-check `userId` per call —
they trust the connection that delivered the call. That is *correct
layering* iff item #3 is fixed (WS auth verifies session ownership).
If we leave #3 unfixed, every RPC inherits the same flaw. Group these
two in any patch.

## 11. LOW — `sessionId` shape unvalidated on gateway

```ts
// packages/agent-gateway/src/handlers.ts:159-162
const cmdFile  = path.join(SESSIONS_DIR, `${sessionId}.cmd`)
const pidFile  = path.join(SESSIONS_DIR, `${sessionId}.pid`)
// ...
```

Today `sessionId` arrives from the SessionDO (which generates UUIDs),
so input is trusted. If anyone ever adds another caller, a path
component like `../foo` in `sessionId` would write outside
`SESSIONS_DIR`. One-line guard:
`if (!/^[0-9a-f-]{36}$/.test(sessionId)) return 400`.

## 12. LOW — FCM service-account JSON on the worker

`push-fcm.ts:28-36` signs FCM JWTs with the private key from
`FCM_SERVICE_ACCOUNT_JSON`. Standard pattern, secret correctly held
as a Worker secret. Two minor notes:

- `console.error('[fcm] send failed:', err)` (push-fcm.ts:92) — verify
  the FCM error body shape doesn't reflect the JWT or its claims.
- The signed `aud` is `sa.token_uri` (the Google OAuth endpoint); JWT
  scope is the FCM scope. Tight enough; flagged for posterity.

## 13. LOW — `*.jks` / `*.keystore` not explicit in mobile gitignore

`apps/mobile/.gitignore` covers `*.apk`, `*.aab`, `node_modules/`,
build outputs. A misclick that drops `release.keystore` into
`apps/mobile/` won't be matched. Single-line addition.

## 14. INFO — Worktree-checkout 409 reveals owner id

```ts
// apps/orchestrator/src/api/index.ts:2156-2212
// On unique-constraint conflict the response includes the existing reservation's ownerId
```

This is design intent (the 409 lets the caller see who's holding the
lock), and `userId` isn't a credential. Calling out so a future
"hide-team-membership" feature doesn't get blindsided.

---

## What I did *not* find

- **No SQL injection** surface — all D1 access goes through Drizzle's
  parameterised query builder; the SessionDO SQLite uses `prepare`
  with `?` placeholders consistently (`agents/session-do-helpers.ts`).
- **No XSS sinks** in the React tree that I traversed; TanStack Start
  + React 19 + the message renderer only assigns `dangerouslySetInnerHTML`
  inside the markdown component, which is fed through `react-markdown`
  with default sanitisation.
- **No CSRF gap** for cookie-bound endpoints — Better Auth ships
  SameSite=Lax by default, the CORS allowlist in `server.ts:22-35` is
  tight (`capacitor://localhost` + the worker origin), and all
  state-changing routes I checked are POST/PATCH/DELETE.
- **No DO-id forging** — DOs use `idFromName(sessionId)` /
  `idFromName(userId)` whose inputs come from authenticated context or
  server-minted IDs.
- **`session-runner` resume / fork-with-history** correctly serialises
  *only the local SessionDO's* SQLite (each DO is per-session by
  construction), so there is no cross-session history bleed.
- Reaper / `.exit` write-once via `fs.link(tmp, final)` (atomic.ts:33)
  is correctly implemented; no race window I could construct.

---

## Suggested follow-up tasks

Listed in priority order. Each is small enough to land as a `task`-mode
session.

1. **Disable WebView debugging in release builds** — wrap the call in
   `BuildConfig.DEBUG`. (#1)
2. **Verify session ownership on WS upgrade** — `SessionDO.onConnectInner`
   + `SessionCollabDO.onConnect` reject when `x-user-id` ≠ owner. (#3, #10)
3. **Sign the OTA `version.json`** — embed a public key in the APK,
   verify the signature in `mobile-updater.ts` before `set()`. (#2)
4. **Switch UserSettingsDO `/broadcast` to `constantTimeEquals`** for
   bearer comparison. (#4)
5. **Allowlist `/api/mobile/assets/*` keys** — refuse anything not
   matching `^(ota|apk)/[A-Za-z0-9._-]+$`. (#8)
6. **Move runner callback token from argv → env or `.cmd`**. (#6)
7. **Fail-closed gateway**: refuse to start when neither
   `CC_GATEWAY_API_TOKEN` nor an explicit dev opt-out flag is set. (#5)
8. **Tighten apksigner password passing** to `env:` form. (#9)
9. **Bootstrap admin gate**: require a separate
   `BOOTSTRAP_ADMIN_TOKEN`, default to non-admin seeding. (#7)
10. **UUID-validate `sessionId` in gateway handler**. (#11)
11. **Add `*.jks` / `*.keystore` to `apps/mobile/.gitignore`**. (#13)
