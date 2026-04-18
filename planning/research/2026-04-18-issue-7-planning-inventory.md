---
date: 2026-04-18
topic: Issue #7 — Planning-phase codebase inventory for D1 + event-bus migration
type: feature inventory
status: complete
github_issue: 7
supersedes: null
supplements: planning/research/2026-04-17-issue-7-tanstack-db-loading-gate.md
---

# Planning Inventory: Surface Area for the D1 + UserSettingsDO-as-Event-Bus Migration

Companion to `2026-04-17-issue-7-tanstack-db-loading-gate.md`. That doc arrived at the architecture (D1 source of truth + TanStack DB collections with OPFS + joins + UserSettingsDO repurposed as a WebSocket fanout). This doc maps **every file, line, and symbol** the migration will touch so the spec can name each concretely.

All findings from five parallel deep-dives (Explore agents) on 2026-04-18. File paths are relative to `/data/projects/duraclaw-dev1` unless stated.

## 0. Headline discoveries from the inventory pass

Four things emerged that the prior research didn't flag and the spec must account for:

1. **UserSettingsDO is built on the Cloudflare Agents SDK, not a plain DurableObject.** `apps/orchestrator/src/agents/user-settings-do.ts:1` uses `class UserSettingsDO extends Agent<Env, UserSettingsState>` with `@callable` RPC decorators and the client uses `useAgent()` with `onStateUpdate`. Repurposing it as a pure WS fanout means stripping the `Agent` state-sync layer (not a `this.storage.put` deletion). The fanout can stay on the Agents SDK's connection primitives or drop back to `DurableObject` with manual WS handling — spec decision.
2. **`user_preferences` is duplicated between `ProjectRegistry` DO and D1.** Migration `0003_user_preferences.sql` creates `user_preferences (user_id, key, value)` in D1. `ProjectRegistry` SQLite also has `user_preferences (user_id, permission_mode, model, max_budget, thinking_mode, effort, updated_at)` (v6 migration). Two different schemas, same name. Writes land in the DO version (`PUT /api/preferences` → `registry.setUserPreferences`); the D1 table appears unused. The migration needs to unify these and pick a shape.
3. **Drizzle is a dependency but not a schema generator.** `drizzle-kit` is installed but there's no `drizzle.config.ts`. Migrations are hand-written SQL in `apps/orchestrator/migrations/NNNN_*.sql`. Drizzle is used as a runtime ORM only inside Better Auth (`src/lib/auth.ts:19`); all other D1 access uses raw `env.AUTH_DB.prepare(...).bind(...)`. The spec should pick a lane: adopt drizzle-kit for real, or stay on hand-written SQL + raw prepare.
4. **`entry-client.tsx:7` already does `dbReady.then(...)` but non-blocking** — it's a fire-and-forget for `evictOldMessages`, not an await before `RouterProvider` mounts. The OPFS race fix is a one-line change (convert to `await dbReady` in an async wrapper) but will serialize React mount behind OPFS open (~5-30 ms). Spec decision: await, or restructure collections to consume the `dbReady` promise directly and not peek at the stale `persistence` export.

## 1. UserSettingsDO — current surface area

**File:** `apps/orchestrator/src/agents/user-settings-do.ts` (357 lines)
**Class:** `UserSettingsDO extends Agent<Env, UserSettingsState>`
**Migrations:** `apps/orchestrator/src/agents/user-settings-do-migrations.ts` (single v1)
**Binding:** via Agents SDK; check `wrangler.toml` for class declaration.

### 1.1 Persisted tables (DO SQLite, v1 migration)

| Table | Columns | Notes |
|---|---|---|
| `tabs` | `id` PK, `project`, `session_id`, `title`, `position`, `created_at`, `updated_at` | Per-user tab records with stable ordering |
| `tab_state` | `key`, `value` | KV; only `activeTabId` used today |
| `drafts` | `tab_id` PK, `text`, `updated_at` | Per-tab draft text, separate from tabs table |

### 1.2 HTTP endpoints (in `onRequest`)

| Method | Path | Line | Behavior |
|---|---|---|---|
| GET | `/tabs` | 57 | list all tabs |
| POST | `/tabs` | 62 | multi-purpose: `reorder`, `addNew`, `switch`, or inline create |
| PATCH | `/tabs/:id` | 106 | update sessionId, title, or draft |
| DELETE | `/tabs/:id` | 123 | remove tab |

### 1.3 `@callable` RPC methods

`addTab` (201), `addNewTab` (238), `switchTabSession` (249), `removeTab` (260), `setActiveTab` (283), `updateTabTitle` (294), `reorderTabs` (303), `saveDraft` (325), `getDraft` (352).

### 1.4 WS surface

- Server upgrade: `server.ts:17-31` forwards `/api/user-settings/ws` → DO after Better Auth check.
- Agents SDK `onConnect` (45) sends full `UserSettingsState` snapshot on connect; state mutations broadcast automatically via `setState`.

### 1.5 HTTP consumers in Worker routes

All in `apps/orchestrator/src/api/index.ts`:
- Helper `getUserSettingsDO(env, userId)` at 35-38.
- GET proxy 257-261, POST 263-274, PATCH 276-288, DELETE 290-295 — all pass through to DO.

### 1.6 Client consumers

| File | Lines | Role |
|---|---|---|
| `src/hooks/use-user-settings.tsx` | 468 total | Context provider + imperative API. Wraps `useLiveQuery(tabsCollection)` + `useAgent` WS + 3 localStorage caches |
| `src/db/tabs-collection.ts` | 85 | TanStack DB collection, HTTP-backed with WS refetch |
| `src/stores/tabs.ts` | — | Legacy zustand store, imported but dead code |

### 1.7 Pre-flagged issues

From `2026-04-16-state-management-audit.md`: SSR crash risk (no `typeof window` guard), hydration races, no sync authoritative source at first render.

From `2026-04-17-issue-5-session-tab-state-root-cause.md`: embedded tab metadata (`project`, `title`) plus async-only authoritative source causes the placeholder problem.

## 2. D1 + Drizzle patterns

### 2.1 Binding + schema

- Binding: `AUTH_DB` in `wrangler.toml:45-46`, database `duraclaw-auth`, id `c5b4d822-9bc6-467f-9ad6-7ee779b82e0c`.
- Schema mirror files: `src/db/schema.ts` + `src/lib/auth-schema.ts` (duplicate; Drizzle schemas for Better Auth).
- Current tables: `users`, `sessions` (auth session, not chat session), `accounts`, `verifications`, `push_subscriptions`, `user_preferences (user_id, key, value)` — KV style.

### 2.2 Migration tooling

- `drizzle-kit ^0.31.10` in devDependencies but no `drizzle.config.ts` exists.
- Migrations are hand-written SQL files: `apps/orchestrator/migrations/0001_auth_tables.sql` through `0005_seed_admin.sql`.
- Applied via wrangler D1 CLI, no `pnpm run migrate` script.

### 2.3 Per-request DB access

Drizzle client built inside `createAuth(env)`:
```ts
// src/lib/auth.ts:19
const db = drizzle(env.AUTH_DB, { schema })
```
Called from `api/index.ts:236`, `auth-routes.ts:8`, `auth-session.ts:15`.

Everything else (e.g. `src/api/index.ts:297-310` user-preferences GET) uses raw prepared statements:
```ts
await c.env.AUTH_DB.prepare(
  'SELECT key, value FROM user_preferences WHERE user_id = ?'
).bind(userId).all<{ key: string; value: string }>()
```

### 2.4 Auth pattern for D1-backed endpoints

- `src/api/auth-session.ts:11-31` → `getRequestSession(env, request)` resolves Better Auth session and returns `{ userId, role, session, user }`.
- `src/api/auth-middleware.ts:5-13` wraps `/api/*` routes, calls the helper, `c.set('userId', session.userId)` for downstream handlers.
- New user-scoped endpoints follow: `const userId = c.get('userId')`.

### 2.5 Reference pattern for a new TanStack DB collection → D1 endpoint

`sessionsCollection` is the reference:
- Endpoint: `GET /api/sessions` at `src/api/index.ts:542-544` — actually reads from `SESSION_REGISTRY` DO today (not D1), but the shape is what new collections will copy.
- Response: `{ sessions: SessionSummary[] }`.
- Client collection: `src/db/sessions-collection.ts:21-34` with `queryFn: fetch('/api/sessions')`, `refetchInterval: 30_000`, `staleTime: 15_000`.

For the new D1-backed path, Worker endpoints will swap the `SESSION_REGISTRY` call for direct D1 prepare — everything client-side stays identical.

## 3. TanStack DB collection wiring

### 3.1 Collection inventory

| File | Collection | Type | Persisted | Seeded from localStorage |
|---|---|---|---|---|
| `src/db/sessions-collection.ts` | `'sessions'` (L22) | `queryCollectionOptions` | wraps with `persistedCollectionOptions` L38-42 (race-broken) | `SESSIONS_CACHE_KEY='duraclaw-sessions'` L60; `seedFromCache()` L62-81 at module load |
| `src/db/tabs-collection.ts` | `'tabs'` (L27) | `queryCollectionOptions` | wraps L71-75 (race-broken) | `TABS_CACHE_KEY='agent-tabs'` in `use-user-settings.tsx:108`; `seedFromCache` L110-134 |
| `src/db/messages-collection.ts` | `'messages'` (L27) | `localOnlyCollectionOptions` | wraps L31-35 (race-broken) | None |

### 3.2 OPFS race — exact stale-read sites

`src/db/db-instance.ts`:
- L18: `let persistence: Persistence | null = null` (exported null at module load)
- L42-45: `export const dbReady = initPersistence().then((p) => { persistence = p; return p })`
- L47: `export { persistence }` (bound to the `let`, still null for importers that read synchronously)

Stale reads:
- `sessions-collection.ts:38, 71` — `if (persistence)` evaluates `null` at module init
- `tabs-collection.ts:71` — same
- `messages-collection.ts:31` — same

### 3.3 Entry point

`src/entry-client.tsx`:
- L2 imports `dbReady`
- L7: `dbReady.then(() => evictOldMessages()).catch(() => {})` — non-blocking
- L21-25: `RouterProvider` mounts immediately, before `dbReady` settles

Root route: `src/routes/__root.tsx` (TanStack Router, `<Outlet />` at L44).

### 3.4 Consumer hooks

- `use-sessions-collection.ts:32-164` — `useLiveQuery(sessionsCollection)`, returns `{sessions, isLoading, createSession, updateSession, archiveSession, refresh}`, persists to cache on every data change (L57-61).
- `use-messages-collection.ts:11-36` — `useLiveQuery(q => q.from({messages: messagesCollection}))`.
- No `use-tabs-collection.ts` — tabs accessed via `useUserSettings()`.

### 3.5 localStorage helpers

`src/db/sessions-collection.ts`:
- `seedFromCache()` L62-81 — imports; calls `utils.writeBatch(writeInsert)` when not already present
- `persistSessionsToCache(sessions)` L84-91 — called from `use-sessions-collection.ts:59`
- `lookupSessionInCache(sessionId)` L98-112 — **sync read** returning `{project, title?}`; the `AgentOrchPage.tsx:50` first-render dependency

`src/hooks/use-user-settings.tsx`:
- `seedFromCache()` L110-134
- `persistToCache()` L136-143 — stores `{tabs, activeTabId}` JSON

### 3.6 Mutation patterns

Reference — `use-sessions-collection.ts:65-100` (createSession):
```ts
const tx = createTransaction({ mutationFn: async () => { fetch(...) } })
tx.mutate(() => collection.insert(optimistic))
await tx.isPersisted.promise
```

`tabs-collection.ts` instead uses collection-level handlers (no `createTransaction` wrapping):
- `onInsert` L40-48 → POST `/api/user-settings/tabs`
- `onUpdate` L51-59 → PATCH `/api/user-settings/tabs/:id`
- `onDelete` L62-66 → DELETE

New D1-backed collections can use either pattern. `createTransaction` is better for multi-step mutations.

## 4. AgentOrchPage — the delete-and-replace surface

### 4.1 `TabItem` shape

`src/db/tabs-collection.ts:17-24`:
```ts
export interface TabItem {
  id: string
  project: string
  sessionId: string
  title: string
  draft?: string   // per-tab draft text, inlined
}
```

Duplicated in `agents/user-settings-do.ts:8-14` as `TabRecord`, and in `stores/tabs.ts:3-8` (dead).

### 4.2 Placeholder creation paths (4 total)

All in `src/features/agent-orch/AgentOrchPage.tsx`:

| Path | Lines | Placeholder |
|---|---|---|
| Initial cold-start from URL `?session=` | 50-53 | `cached.title \|\| cached.project` from `lookupSessionInCache` |
| URL-session restoration w/o local tab | 124-127 | `project='unknown'`, title falls back through prompt preview chain |
| Post-spawn new session | 206-209 | `title = promptText.slice(0, 40) \|\| config.project` |
| Sidebar session select | 223-226 | `project='unknown'`, title fallback chain |

### 4.3 URL↔state effect chain

`AgentOrchPage.tsx`:
- L84-92 — strip `newSessionProject`/`newTab` one-shot search params
- L97-102 — write `?session=` back on restoration
- L105-147 — **main sync effect**, depends on `searchSessionId, selectedSessionId, quickPromptHint, sessions`; writes `setSelectedSessionId`, `setActiveTab`, creates placeholder tab on miss, clears `spawnConfig`

### 4.4 Backfill effect (the one #9 targets for deletion)

`AgentOrchPage.tsx:388-413` (inside `AgentDetailWithSpawn`):
- Triggers on every `agent.state` change (WS-pushed from SessionDO)
- Calls `settings.updateTabTitle(tab.id, title)` L406 — replaces placeholder title
- Calls `settings.updateTabProject(tab.id, agent.state.project)` L409 — replaces `'unknown'`
- Calls `updateSession(sessionId, patch)` L393 — syncs to registry

This entire effect becomes dead code once tab rendering reads from the join.

### 4.5 Tab-bar render

`src/components/tab-bar.tsx`:
- Tab map: L176-200 (reads from `useUserSettings()` L59, filtered `project !== '__draft'`)
- Displayed fields: `tab.project` L382, `tab.title` L384
- Status dot: `currentSession.status` L376-378 via separate sessions lookup

### 4.6 Keyboard shortcuts

`AgentOrchPage.tsx:270-311`:
- Cmd+T (274-281) — add current session as tab; reads `selectedSessionId` + `sessions.find`
- Cmd+W (284-293) — close active tab
- Cmd+1-9 (296-305) — switch to Nth tab via `settings.tabs[idx]`

All synchronous reads — none require async awaits — so they survive the migration unchanged, just pointing at new collections.

### 4.7 Tab mutation call sites (all in `use-user-settings.tsx`)

| Lines | Call |
|---|---|
| 281-286 | `addTab` insert |
| 292-297 | `addNewTab` force-insert |
| 399-405 | `saveDraft` insert (draft sentinel, `project:'__draft'`) |
| 262-264 | `addTab` title merge update |
| 272-275 | `addTab` session replace |
| 303-306 | `switchTabSession` |
| 332-334 | `updateTabTitle` |
| 340-342 | `updateTabProject` |
| 394-396 | `saveDraft` update |
| 321 | `removeTab` delete |

Reorder: L346-355 — POST to DO with `action:'reorder'`, optimistic `setTabOrder` to localStorage.

### 4.8 Draft-sentinel anti-pattern

`saveDraft` stores drafts as "ghost tabs" with `project:'__draft'`, `sessionId:''`, filtered out of the tab bar (`tab-bar.tsx:176`). This is the hack that makes the tab shape serve two purposes. The migration splits it: `user_tabs` and `user_drafts` become separate D1 tables.

## 5. ProjectRegistry DO

**File:** `src/agents/project-registry.ts` (682 lines)
**Class:** `ProjectRegistry extends DurableObject<Env>` (plain DO, not Agents SDK)
**Binding:** `SESSION_REGISTRY` (`wrangler.toml:24-26`)
**Accessed as:** `c.env.SESSION_REGISTRY.idFromName('default')` — singleton at `api/index.ts:31`

### 5.1 Tables

Migrations file: `src/agents/project-registry-migrations.ts` (v1-v12).

`sessions` (30 columns): `id, user_id, project, status, model, created_at, updated_at, duration_ms, total_cost_usd, num_turns, prompt, summary, archived, title, tag, origin, agent, message_count, sdk_session_id, kata_mode, kata_issue, kata_phase, last_activity` + index `idx_sessions_sdk_id`.

`user_preferences` (7 columns): `user_id, permission_mode, model, max_budget, thinking_mode, effort, updated_at`. **Conflicts with D1's `user_preferences` (user_id, key, value)** — see §0.2.

### 5.2 Write methods (10) + dead code

In use (4): `registerSession`, `replaceSessionForResume`, `updateSession`, `setUserPreferences`, `syncDiscoveredSessions` (also called from `alarm()`).

Apparently dead (5): `updateSessionStatus`, `removeSession`, `updateSessionResult`, `archiveSession`, `backfillLastActivity` (debug-only).

### 5.3 Read methods (9) — caller map

| Method | Caller route |
|---|---|
| `getSession` | ownership checks via `getOwnedSession` `api/index.ts:90-91` |
| `listSessions` | `GET /api/sessions` (542) |
| `listActiveSessions` | `GET /api/sessions/active` (548) |
| `listSessionsByProject` | `GET /api/projects` (528) |
| `listSessionsPaginated` | `GET /api/sessions/history` (561) |
| `searchSessions` | `GET /api/sessions/search` (555) |
| `findSessionBySdkId` | `POST /api/sessions` resume path (654) |
| `getUserPreferences` | `GET /api/preferences` (332) |

All funnel through the singleton; no caching.

### 5.4 Known pain points

- Singleton bottleneck (audit line 81) — estimated breaking point ~50 req/s.
- Fuzzy-match race in `syncDiscoveredSessions` L560-599 (60s `created_at` window) — causes duplicates if alarm runs late; v10 and v12 migrations reset bad `last_activity` backfills.
- Two-phase inconsistency: fire-and-forget updates with only `console.error` on failure.

### 5.5 What migrates, what goes away

- **Sessions table → D1** (`chat_sessions`, rename to avoid conflict with Better Auth `sessions`). 30 columns carry over; trim dead code first to avoid porting unused fields.
- **user_preferences → D1** (must reconcile schema with existing D1 KV-style table).
- **Discovery alarm → scheduled Worker cron** (Cloudflare native, no DO required).
- **Whole DO → deleted.** No coordination primitives remain.

## 6. Consolidated change inventory (for the spec)

### 6.1 Files to **delete**

- `src/agents/project-registry.ts` (682 lines)
- `src/agents/project-registry-migrations.ts`
- `src/stores/tabs.ts` (dead zustand store)
- `src/agents/user-settings-do-migrations.ts` (tables migrate to D1; DO keeps no storage)

### 6.2 Files to **substantially rewrite**

- `src/agents/user-settings-do.ts` — from 357 lines of Agent+RPC+storage down to ~40 lines of WS fanout
- `src/db/tabs-collection.ts` — point at new D1 endpoints, drop draft-sentinel pattern
- `src/hooks/use-user-settings.tsx` — drop localStorage caches (OPFS does the job); drop `getDraft`/`saveDraft` imperative path in favor of a `useDraftsCollection` hook
- `src/features/agent-orch/AgentOrchPage.tsx` — delete effects L84-147, delete backfill L388-413, replace placeholder creation paths with join-query reads
- `src/components/tab-bar.tsx` — read from `useLiveQuery` join instead of `useUserSettings`
- `src/api/index.ts` — replace every `SESSION_REGISTRY.*` call with Drizzle/raw D1 queries; replace `/api/user-settings/tabs*` proxies with D1-backed endpoints

### 6.3 Files to **create**

- `migrations/0006_chat_sessions.sql` (session index in D1)
- `migrations/0007_user_tabs.sql`
- `migrations/0008_user_drafts.sql`
- `migrations/0009_user_preferences_v2.sql` (reconcile the two existing shapes)
- `src/db/user-tabs-collection.ts`
- `src/db/user-drafts-collection.ts`
- `src/db/chat-sessions-collection.ts` (rename of current `sessions-collection.ts` or replaces it)
- `src/hooks/use-drafts-collection.ts`
- `src/hooks/use-invalidation-channel.ts` (WS subscribe + refetch on `{invalidate, collection, keys}`)
- Worker endpoints: new `/api/tabs`, `/api/drafts`, `/api/chat-sessions` (paths TBD in spec)

### 6.4 Files to **minimally change**

- `src/entry-client.tsx` — fix OPFS race (`await dbReady` or refactor collections to consume the promise)
- `src/db/db-instance.ts` — remove stale `persistence` export; switch to promise-based accessor
- `src/db/sessions-collection.ts`, `src/db/messages-collection.ts`, (any `*-collection.ts`) — replace `if (persistence)` pattern
- `wrangler.toml` — remove `SESSION_REGISTRY` binding; keep `UserSettingsDO` binding; remove migration for `ProjectRegistry` class
- `src/server.ts` — keep WS upgrade path to UserSettingsDO; drop routes that are now D1-direct

## 7. Open questions for the P1 interview

1. **Drizzle strategy:** Adopt `drizzle-kit` with generated migrations + typed schema across all new tables, or continue hand-written SQL + raw `prepare`?
2. **`user_preferences` reconciliation:** The existing D1 KV-style table (`user_id, key, value`) vs. the ProjectRegistry columnar version (`permission_mode, model, max_budget, ...`). Pick one shape, or keep both with clear naming?
3. **UserSettingsDO runtime:** Stay on Cloudflare Agents SDK (`extends Agent`) and use its connection primitives for the fanout, or drop back to plain `DurableObject` with manual WS upgrade?
4. **Migration order — big bang or feature-flag:** Dual-write window (DO + D1) for a release, or cut over per-collection behind a flag?
5. **Session archival & history pagination:** Keep `listSessionsPaginated`'s filtering/sorting knobs as-is in the new D1 endpoint, or simplify?
6. **`sdk_session_id` resume path:** The fuzzy 60s window in `syncDiscoveredSessions` needs a D1 equivalent. Strong-unique index + `ON CONFLICT` upsert with `sdk_session_id` as the key once it's known? Or retain the fuzzy matcher during the transition?
7. **OPFS race fix — await vs. restructure:** Simple `await dbReady` before mount (serializes ~5-30 ms) vs. thread `dbReady` into each collection's options (more files touched, zero serialization).
8. **Invalidation message granularity:** Whole-collection (`{type:'invalidate', collection:'tabs'}`) vs. per-key (`{... keys:['tab-123']}`)? Spec implication: per-key requires adding `refetchKeys` to `queryCollectionOptions` (currently only `refetch` exists).
9. **Draft debounce under D1 + invalidation:** Drafts write per-keystroke (debounced) → D1 → invalidation fans out to other devices. Same-device echo-suppression strategy?
10. **iOS Safari OPFS fallback:** If OPFS is unavailable (older WebKit), the app already falls back to memory-only. Acceptable as-is, or add a warning?

## 8. Sources

- Prior research: `planning/research/2026-04-17-issue-7-tanstack-db-loading-gate.md` (full)
- Audit: `planning/research/2026-04-16-state-management-audit.md`
- Root cause: `planning/research/2026-04-17-issue-5-session-tab-state-root-cause.md`
- Code surveyed (all in `apps/orchestrator/`):
  - `src/agents/user-settings-do.ts`, `src/agents/user-settings-do-migrations.ts`
  - `src/agents/project-registry.ts`, `src/agents/project-registry-migrations.ts`
  - `src/api/index.ts`, `src/api/auth-session.ts`, `src/api/auth-middleware.ts`
  - `src/lib/auth.ts`, `src/lib/auth-schema.ts`
  - `src/db/sessions-collection.ts`, `src/db/tabs-collection.ts`, `src/db/messages-collection.ts`, `src/db/db-instance.ts`, `src/db/schema.ts`
  - `src/hooks/use-sessions-collection.ts`, `src/hooks/use-messages-collection.ts`, `src/hooks/use-user-settings.tsx`
  - `src/features/agent-orch/AgentOrchPage.tsx`
  - `src/components/tab-bar.tsx`
  - `src/entry-client.tsx`, `src/routes/__root.tsx`, `src/server.ts`
  - `wrangler.toml`
  - `migrations/0001_auth_tables.sql` through `0005_seed_admin.sql`
