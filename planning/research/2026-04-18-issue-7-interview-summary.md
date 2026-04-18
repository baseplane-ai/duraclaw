---
date: 2026-04-18
topic: Issue #7 — Interview summary & resolved requirements for D1 + PartyKit fanout migration
type: interview summary
status: complete
github_issue: 7
inputs: planning/research/2026-04-17-issue-7-tanstack-db-loading-gate.md, planning/research/2026-04-18-issue-7-planning-inventory.md
---

# Interview Summary — Decisions for the Migration Spec

Every decision locked in during the P1 interview. Every one of these must map to at least one behavior (B-ID) in the spec. Architectural bets are flagged — those are the decisions we can't easily reverse later.

## 1. Scope & rollout

| Decision | Choice | Rationale |
|---|---|---|
| **Spec scope** | Full migration (closes #5, #6, #7 together) | One coherent target architecture; avoids mid-migration drift. Phased implementation internally. |
| **Rollout strategy** | Big bang cutover | Solo-operator Cloudflare Workers app; no dual-write plumbing. One release flips everything. Requires one-shot data migration (below). |
| **Data migration at cutover** | Export script → D1 import | Preserve user continuity (sessions, tabs, prefs). Tabs/drafts stay migrated; drafts then hand off to Yjs. |

### Scope inclusions (in this spec)

- Fix OPFS `persistence=null` race in `db-instance.ts`
- Migrate ProjectRegistry SQLite → D1 `agent_sessions` table
- Migrate UserSettingsDO tabs/prefs → D1 `user_tabs` / `user_preferences`
- Delete ProjectRegistry DO; retire its discovery alarm (move to scheduled Worker cron)
- Repurpose UserSettingsDO as a PartyKit-based WS fanout for cache invalidation
- Rewrite tab-bar around a TanStack DB join query (`user_tabs` ⋈ `agent_sessions`)
- Drop the `project:'__draft'` sentinel pattern (drafts leave this spec via Yjs)
- Close issues #5 and #6 as superseded on merge

### Scope exclusions (deferred)

- Draft persistence — handled by Yjs via PR #4; this spec hands off drafts cleanly but doesn't own them
- Message cache shape changes (`messagesCollection` stays `localOnlyCollectionOptions`, OPFS-persisted)
- Any feature-flag / gradual-rollout infrastructure
- Multi-region / D1 replication strategy
- iOS-Safari-specific OPFS detection UX beyond the existing silent fallback

## 2. Tooling

| Decision | Choice | Implications |
|---|---|---|
| **UserSettingsDO runtime** | **PartyKit library directly** | Replace `@cloudflare/agents`' `Agent<Env,State>` with `PartyServer`. Client hook moves from `useAgent` to `usePartySocket`. Purpose-built for per-room WS fanout; more idiomatic than repurposing the Agents SDK's state layer. Architectural bet — see §6. |
| **D1 schema authority** | Full `drizzle-kit` adoption | Add `drizzle.config.ts`, define all tables (auth + new) in `src/db/schema.ts`, generate migrations via `drizzle-kit generate`. Drizzle ORM for all queries (replaces raw `prepare()` calls in existing routes, in-scope cleanup PR as part of this spec). |

## 3. Data model

| Decision | Choice | Table / shape |
|---|---|---|
| **`agent_sessions` table name** | `agent_sessions` | Avoids collision with Better Auth's `sessions`. Consistent with `agent-gateway` / `agent-orch` naming. Rename is DB-side only; API paths (`/api/sessions/*`) unchanged. |
| **`sdk_session_id` constraint** | Strict UNIQUE, partial index `WHERE sdk_session_id IS NOT NULL`, ON CONFLICT upsert | Discovery sync becomes a single UPSERT. Kills the 60-second fuzzy-match window. |
| **`user_preferences` shape** | Columnar (ProjectRegistry's shape wins) | `user_id, permission_mode, model, max_budget, thinking_mode, effort, updated_at`. Drop the unused KV-style D1 0003 table. |
| **Drafts** | Yjs (PR #4) — no D1 drafts table in this spec | UserSettingsDO's `drafts` table is NOT migrated to D1; it's deleted, and draft persistence becomes a PR #4 responsibility. |

### Final target table set in D1

- **Existing auth**: `users`, `sessions`, `accounts`, `verifications` (Better Auth; untouched except possibly retrofit into `drizzle-kit`)
- **Existing notifications**: `push_subscriptions` (untouched)
- **Replaced**: `user_preferences` — schema changes from D1 0003 (KV) to ProjectRegistry shape (columnar)
- **New**: `agent_sessions` (ex-ProjectRegistry sessions, 30 cols, trim dead fields)
- **New**: `user_tabs` (ex-UserSettingsDO `tabs`)
- **Not created**: `user_drafts` — Yjs owns drafts

## 4. Invalidation protocol (PartyKit channel)

| Decision | Choice | Wire format |
|---|---|---|
| **Granularity** | Collection + optional keys | `{type:'invalidate', collection: 'user_tabs' \| 'agent_sessions' \| 'user_preferences', keys?: string[]}` |
| **Default client behavior** | `collection.utils.refetch()` on every invalidation; `keys` is an optimization hint TanStack DB doesn't natively support today | Keys field future-proofs; initial implementation falls back to whole-collection refetch. |

### Channel lifecycle

- Client opens PartyServer connection on app mount (per-user room keyed by `userId`).
- Worker mutation endpoints POST `/notify` to the DO after D1 commit lands.
- DO broadcasts invalidation to all connected clients for that user (other tabs, other devices).
- Self-origin echo suppression: spec must decide (see §6 open risks).

## 5. Client architecture

| Decision | Choice | Implication |
|---|---|---|
| **OPFS race fix** | `await dbReady` before mount in `entry-client.tsx` | One-line change. Serializes React mount behind OPFS open (5–30 ms). Acceptable trade-off vs. threading the promise into 3+ collection files. |
| **OPFS fallback UX** | Silent memory-only | Matches today's behavior. Console warning only. |
| **Keyboard shortcut sync reads** | Direct `collection.toArray()` / `collection.get()` | No hook needed. Shortcuts at `AgentOrchPage.tsx:270-311` get refactored to read from `userTabsCollection` / `agentSessionsCollection` directly. |
| **Tab-bar render path** | `useLiveQuery` with a join — `user_tabs ⋈ agent_sessions` | Deletes embedded `project` / `title` on tabs. Placeholder creation paths go away; backfill effect at `AgentOrchPage.tsx:388-413` becomes dead code. |

## 6. Architectural bets (hard to reverse)

These are the decisions the spec should call out explicitly because they shape everything downstream:

1. **Big bang cutover with an export script.** No dual-write. If the export script or D1 migration has a bug, rollback means replaying the migration in the opposite direction — which the export script pattern doesn't support out of the box. Mitigation: the export should be idempotent (re-runnable if the deploy fails), and we ship behind a `maintenance mode` page during the cutover window.
2. **PartyKit direct, not Cloudflare Agents SDK.** Commits to PartyKit's API shape for per-user WS fanout. Migrating off PartyKit later (unlikely but possible if the lib becomes unmaintained) means rewriting the DO class + the client hook.
3. **Drafts belong to Yjs (PR #4).** This spec depends on PR #4 shipping the Yjs draft provider. If PR #4 merges later, this spec needs to either (a) wait for it, or (b) ship with drafts temporarily broken, or (c) add a throwaway local-only `user_drafts` table that gets migrated to Yjs later. Open risk.
4. **`drizzle-kit` adopted project-wide.** The existing hand-written SQL migrations (`0001_auth_tables.sql` through `0005_seed_admin.sql`) must be unified with generated migrations. The cleanup is in-scope but touches files outside the strict "new migration" boundary.
5. **Delete `ProjectRegistry` DO entirely.** Discovery alarm moves to a scheduled Worker cron. The singleton's SQLite state is exported and then the DO class + its wrangler binding are removed. Rollback means recreating the DO — but Cloudflare doesn't support "unmigrate" of DO classes without a separate wrangler migration step. Needs careful wrangler migration ordering.

## 7. Open risks flagged during interview

1. **Yjs dependency (PR #4).** This spec needs to know whether drafts in PR #4 land before, with, or after this migration. If PR #4 isn't ready, this spec should add a temporary local-only draft mechanism to avoid breaking the input field — but the simpler answer is to sequence the work so #4 ships first.
2. **Echo suppression on invalidation fanout.** When client A writes to D1 and the DO broadcasts the invalidation, client A receives its own invalidation and will refetch. Bandwidth waste + possible UX flicker. Spec should specify: the client ignores invalidations that match its own pending-write `origin-id`, or the DO sender tags broadcasts and skips the originating WS. Deferred to spec writing but not unresolved.
3. **PartyKit Cloudflare deployment surface.** PartyKit has its own `partykit.json` config that sits alongside `wrangler.toml`. Spec should confirm (during writing) whether PartyKit ships as a sibling worker or integrates as a library inside the existing orchestrator Worker.
4. **Data migration ordering vs. wrangler deploy.** The export-then-deploy sequence requires the export to run against the *current* production DOs, not a stale environment. Spec should define the exact runbook (export → apply migrations → deploy).
5. **Scheduled-cron discovery alarm.** ProjectRegistry's 5-minute discovery alarm is currently a DO `alarm()`. Moving to Cloudflare Workers Cron Triggers changes the execution model (scheduled, not in-DO). Some retry/backoff logic may need reworking.

## 8. Codebase findings (pinned from P0 inventory)

Key files and line references the spec will reference:

- **OPFS race**: `apps/orchestrator/src/db/db-instance.ts:18, 42-47`
- **Collection stale-read**: `sessions-collection.ts:38, 71`, `tabs-collection.ts:71`, `messages-collection.ts:31`
- **Entry point**: `apps/orchestrator/src/entry-client.tsx:7, 21-25`
- **UserSettingsDO**: `apps/orchestrator/src/agents/user-settings-do.ts` (357 lines — shrinks to ~50 for PartyKit fanout)
- **ProjectRegistry**: `apps/orchestrator/src/agents/project-registry.ts` (682 lines — deleted)
- **AgentOrchPage placeholder paths**: `AgentOrchPage.tsx:50-53, 124-127, 206-209, 223-226`
- **URL-sync effect chain**: `AgentOrchPage.tsx:84-92, 97-102, 105-147`
- **Backfill effect (to delete)**: `AgentOrchPage.tsx:388-413`
- **Tab-bar render**: `apps/orchestrator/src/components/tab-bar.tsx:176-200`
- **Keyboard shortcuts**: `AgentOrchPage.tsx:270-311`
- **Tab mutation call sites**: `apps/orchestrator/src/hooks/use-user-settings.tsx:262, 272, 281-286, 292-297, 303-306, 321, 332-334, 340-342, 394-396, 399-405`
- **API routes affected**: `apps/orchestrator/src/api/index.ts:90-91, 257-295, 528-675, 759`
- **Existing D1 bindings**: `wrangler.toml:45-46` (binding `AUTH_DB`, db `duraclaw-auth`)
- **To delete from wrangler.toml**: `SESSION_REGISTRY` binding at L24-26

## 9. Behaviors the spec must cover (pre-draft outline)

Grouped by layer; each becomes one or more B-IDs during spec writing:

### Data layer
- B-DATA-1: `agent_sessions` D1 table (Drizzle schema, migration, UNIQUE partial index on `sdk_session_id`)
- B-DATA-2: `user_tabs` D1 table
- B-DATA-3: `user_preferences` D1 table (columnar)
- B-DATA-4: Drop unused KV-style `user_preferences` D1 table from migration 0003
- B-DATA-5: Export script (dumps ProjectRegistry SQLite + all UserSettingsDO instances → SQL inserts)
- B-DATA-6: Cutover runbook (maintenance mode → export → apply migrations → deploy → lift maintenance)

### API layer
- B-API-1: Rewrite `/api/sessions*` routes to query D1 directly (replace `SESSION_REGISTRY` calls)
- B-API-2: New `/api/user-settings/tabs*` routes backed by D1 + emit invalidation
- B-API-3: `/api/preferences` on D1
- B-API-4: PartyKit `/notify` endpoint on UserSettingsDO
- B-API-5: Scheduled Worker cron replaces `alarm()` discovery

### Client persistence layer
- B-CLIENT-1: Fix OPFS race (`await dbReady` in `entry-client.tsx`)
- B-CLIENT-2: New `userTabsCollection` (TanStack DB, OPFS-persisted, queryCollectionOptions → D1)
- B-CLIENT-3: New `agentSessionsCollection` (renames from `sessionsCollection`, schema bumped)
- B-CLIENT-4: Remove `seedFromCache` / `lookupSessionInCache` localStorage helpers (OPFS covers it)
- B-CLIENT-5: PartyKit client subscription + invalidation handler

### UI layer
- B-UI-1: Tab-bar renders from `useLiveQuery` join (`user_tabs ⋈ agent_sessions`)
- B-UI-2: Delete placeholder-creation paths in `AgentOrchPage`
- B-UI-3: Delete backfill effect `AgentOrchPage.tsx:388-413`
- B-UI-4: Keyboard shortcuts read from collections directly (no `useUserSettings()` hook)
- B-UI-5: Retire `useUserSettings()` context / API surface

### Infrastructure / deletions
- B-INFRA-1: Delete `ProjectRegistry` DO (class + migration file + wrangler binding)
- B-INFRA-2: UserSettingsDO shrinks to PartyKit `PartyServer` (state removed)
- B-INFRA-3: Delete dead `stores/tabs.ts`
- B-INFRA-4: Delete `UserSettingsDO` SQLite migrations file
- B-INFRA-5: Update `wrangler.toml` (remove SESSION_REGISTRY, update UserSettingsDO class if needed)

## 10. Verification plan seed

The spec's VP should include at minimum:
- Cold-load warm-load latency measurements (target: <50 ms to first tab-bar render on warm load with OPFS)
- Multi-tab invalidation end-to-end test (write in tab A, observe refetch in tab B within 100 ms)
- sdk_session_id UPSERT race test (simulate discovery-alarm-late scenario)
- Export-then-import round-trip test (export prod-shaped data, import to clean D1, compare)
- Keyboard shortcut smoke test (Cmd+T/W/1-9 work without `useUserSettings`)
- `drizzle-kit` migration replay test (drop DB, re-apply all generated migrations, confirm schema matches)
