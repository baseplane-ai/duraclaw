# Research: Duplicate Tabs After D1 Migration Merge

**Date:** 2026-04-18
**Context:** PR #9 (`feature/7-d1-partykit-migration`) merged as `4a942be` — 71 files, +5333/−4365. Replaced `ProjectRegistry` + `UserSettingsDO` with D1 tables + TanStack QueryCollections (OPFS-cached). Post-merge, users see duplicate tabs.

---

## Background

Before the migration, commit `17244bf` (Apr 17) fixed a duplicate-tabs bug: the client generated one tab ID, the `UserSettingsDO` generated a different ID on the server, both survived WS sync → duplicates. The fix passed `clientId` through to the DO.

The D1 migration **deleted `UserSettingsDO` entirely** and replaced tab storage with the `user_tabs` D1 table + `userTabsCollection` (TanStack QueryCollection). The old fix no longer applies — and the new architecture has **its own variant of the same bug class**.

---

## Duplication Vectors Identified

### V1: Server ignores client-generated ID (Critical — 100% repro)

**Root cause:** The client generates `id` via `crypto.randomUUID().slice(0, 8)` and inserts optimistically into `userTabsCollection`. The `onInsert` handler (user-tabs-collection.ts:39-47) POSTs to `/api/user-settings/tabs`. But the **server ignores the client ID** and generates its own `crypto.randomUUID()` (api/index.ts:339). When PartyKit invalidation fires and the collection refetches from D1, the server's row comes back with a *different ID*. The optimistic row and the server row coexist → **duplicate tab**.

**Files:**
- `apps/orchestrator/src/db/user-tabs-collection.ts` — `onInsert` sends `m.modified` (includes client `id`)
- `apps/orchestrator/src/api/index.ts:318-354` — `POST /api/user-settings/tabs` ignores body `id`, generates new one at line 339

**This is the exact same class of bug as `17244bf`, reborn in the D1 layer.**

### V2: Race condition in copy-pasted insert-or-find logic (Moderate)

The `ensureTabForSession()` helper exists in `AgentOrchPage.tsx:52-69`, but two other call sites **inline identical logic** without reusing the helper:

1. `nav-sessions.tsx:280-308` — sidebar session click
2. `notification-drawer.tsx:55-75` — notification click

All three read `.toArray` synchronously. If the collection hasn't refetched yet after a prior insert (the `onInsert` POST is async, PartyKit invalidation hasn't arrived), the `find()` misses the just-inserted row and inserts a **second tab for the same session**.

### V3: `newTab` path always inserts without dedup (Minor)

In `AgentOrchPage.tsx:174-183`, when `config.newTab` is true (from "New tab for project" context menu), a raw `insert()` fires with no sessionId-dedup check. Double-clicking quickly produces duplicates.

---

## What's NOT Causing Duplicates

- **Tab-bar rendering** — the `useLiveQuery` join (tab-bar.tsx:71-78) correctly renders whatever's in the collection. Duplication is in the **write path**.
- **Drag-reorder** — uses `/reorder` endpoint + refetch, no insert.
- **OPFS persistence** — cache layer only; D1 is source of truth. Stale OPFS clears on refetch.

---

## Severity Matrix

| Vector | Likelihood | Impact | Repro |
|--------|-----------|--------|-------|
| V1: Server ignores client ID | Every insert (100%) | Ghost duplicate of every tab | Insert any tab, wait for invalidation refetch |
| V2: Race in inlined logic | Moderate (fast clicks) | Duplicate tab for same session | Click session in sidebar while prior insert is in-flight |
| V3: newTab always-insert | Low (intentional) | Extra tab for same session | Double-click "New tab for project" |

---

## Recommended Fixes

### Fix V1 (Critical)

Make `POST /api/user-settings/tabs` accept and use the client-provided `id` from the request body. Fall back to `crypto.randomUUID()` only if `id` is missing.

```diff
// api/index.ts ~ line 339
-    const id = crypto.randomUUID()
+    const id = (typeof body.id === 'string' && body.id.length > 0) ? body.id : crypto.randomUUID()
```

Also update the `onInsert` handler body shape if needed — currently `m.modified` already includes the client `id`, so the POST body already sends it; the server just needs to read it.

### Fix V2 (Moderate)

Extract `ensureTabForSession` into a shared utility (`~/lib/tab-utils.ts`) and replace the 2 inlined copies. Single source of truth = single place to add future dedup guards.

### Fix V3 (Minor)

Add a sessionId uniqueness check on the `newTab` path, or accept it as intentional behavior (some users may want two tabs pointing at the same session).

---

## Files Reference

| File | Role |
|------|------|
| `src/db/user-tabs-collection.ts` | D1-backed collection, OPFS cache, CRUD handlers |
| `src/api/index.ts:307-444` | Tab CRUD API endpoints |
| `src/features/agent-orch/AgentOrchPage.tsx` | Main page, `ensureTabForSession`, spawn/select flows |
| `src/components/layout/nav-sessions.tsx:280-308` | Inlined insert-or-find (sidebar) |
| `src/components/notification-drawer.tsx:55-75` | Inlined insert-or-find (notifications) |
| `src/components/tab-bar.tsx` | Tab rendering (read path — not a cause) |
| `src/hooks/use-active-tab.ts` | localStorage active-tab tracking |
