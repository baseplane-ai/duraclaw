# Tab State Management — Why It's Still A Mess (Post-#7 Review)

**Date:** 2026-04-18
**Type:** Feasibility + forensic code review
**Scope:** All tab-creation, tab-deletion, and tab↔session-metadata code paths after PR #9 (D1 migration) and the three subsequent follow-up fixes (`603c866`, `538a06b`, `4df474a`).
**Prior art read:** `2026-04-16-state-management-audit.md`, `2026-04-17-issue-5-session-tab-state-root-cause.md`, `2026-04-18-duplicate-tabs-post-d1-migration.md`.

---

## 0. TL;DR

The D1 migration's p5 refactor (`2364334`) **structurally solved half the original problem** (tab rows no longer embed session metadata — the `useLiveQuery` LEFT JOIN against `agentSessionsCollection` fixes the "unknown project badge" class of bug). But the three subsequent hot-fix commits (`603c866` → `538a06b` → `4df474a`) have produced an architecture that is **internally contradictory** and leaves at least **seven distinct failure modes live**, including one regression that silently breaks a shipped feature ("New tab for project").

The root cause is the same one flagged in `2026-04-17-issue-5-session-tab-state-root-cause.md` §2: **optimistic inserts into a collection whose authoritative identity is server-side create a race whenever the server can refuse, mutate, or re-key the client's proposed row**. The D1 migration made this worse, not better: TanStack QueryCollection gives optimistic writes, but there's no rollback protocol when the server dedups. We lost `UserSettingsDO`'s in-memory "merge by clientId" logic and replaced it with three inconsistent layers of client+server dedup that together block the feature they were supposed to enable.

The recommendation at the bottom (§6) is: **stop patching this layer. Implement the zustand store from issue-5 research** — it's the only design where all of these races are structurally impossible.

---

## 1. Timeline of fixes (what's been tried)

| Commit | Claim | What it actually did |
|---|---|---|
| `2364334` (p5, Apr 18 06:36) | Tabs no longer embed project/title; use `useLiveQuery` join | Correct. Removed `project`/`title` from tab rows; tab-bar renders skeletons while join hydrates. |
| `603c866` (Apr 18 13:15) | "Fix duplicate tabs after D1 migration" | Server now honors client-supplied `id` on POST. Extracted `ensureTabForSession`. |
| `538a06b` (Apr 18 14:04) | "Prevent duplicate tabs via server-side sessionId dedup" | POST dedups by `(userId, sessionId)` — if tab exists, returns it with `200`. GET self-heals by deleting duplicates. |
| `4df474a` (Apr 18 14:05) | "Remove aggressive GET dedup that breaks multi-tab" | Reverts GET dedup. Justification: "multiple tabs per session is intentional (swipe-to-cycle)." **But POST dedup is kept, silently making that impossible.** |

The three fixes arrived within one hour; the last one contradicts the second. Something was not thought through.

---

## 2. Architecture snapshot (current, post-`4df474a`)

Write path for a new tab:

```
AgentOrchPage / nav-sessions / notification-drawer
   └── ensureTabForSession(sessionId)      [lib/tab-utils.ts:33]
        ├── userTabsCollection.toArray.find(sessionId)   ← client dedup #1
        ├── if missing: userTabsCollection.insert({id,...}) with nanoid
        │    └── onInsert (user-tabs-collection.ts:39)
        │         └── POST /api/user-settings/tabs  body={id, sessionId, position, ...}
        │              ├── dedup by (userId, sessionId) ← server dedup #2
        │              │    └── if exists: return 200 {tab: existing}  [no notifyInvalidation]
        │              └── else: INSERT into D1 with body.id, return 201 {tab: created}
        │                   └── notifyInvalidation('user_tabs')
        └── setActiveTabId(id)  ← localStorage
```

Read path:

```
TabBar
 └── useLiveQuery(tab LEFT JOIN session, orderBy position)
      ├── userTabsCollection (QueryCollection, OPFS-cached, refetch on invalidate)
      └── agentSessionsCollection (QueryCollection, OPFS-cached, 30s refetch)
```

Invalidation path:

```
D1 write → notifyInvalidation → UserSettingsDO.fetch('/notify')
    → PartyServer fanout → client onMessage → collection.utils.refetch()
```

Three sources of truth for "which tab is active": `localStorage['duraclaw-active-tab']`, `AgentOrchContent.selectedSessionId` (React useState), and URL `?session=X`. These are only aligned at mount by the `useState` initializer (lines 50-72 of AgentOrchPage).

---

## 3. Live failure modes

### F1 — "New tab for project" is silently broken (regression, 100% repro)

**Flow:** Right-click any tab → "New tab for project" → `handleNewTabForProject(project)` sets `quickPromptHint = {project, newTab: true}` and navigates to `/`. User types a prompt, submits. `QuickPromptInput.handleSubmit` passes `newTab: true` up to `handleSpawn`. `handleSpawn` creates a session via `POST /api/sessions`, then calls `ensureTabForSession(sessionId)`.

**What goes wrong:** `ensureTabForSession` always finds the just-created session's sessionId absent (brand-new), inserts a tab, POSTs it. Server accepts — great, you got a tab. But it's for a BRAND-NEW session id — there's no existing tab to conflict with. The user wanted a second tab pointing at the *same existing session* as the one they right-clicked. **That never happens.** The right-click menu might as well be "New session."

Worse: even if the user's intent is "open the same session in a second tab" (`Cmd-click`-style), that path is gated at `lib/tab-utils.ts:35` — `ensureTabForSession` returns the existing tab. You can never have two tabs with the same `sessionId`.

And worse still: if the user submits from the QuickPromptInput with the "Open in new tab" checkbox ticked, `handleSpawn` (AgentOrchPage.tsx:107) **ignores `config.newTab` entirely** — it's never read, never branched on. The feature is dead code.

**Fix:** Decide. Either multi-tab-per-session is supported (→ remove POST dedup, remove client dedup, implement "New tab for project" as explicit duplicate) or it isn't (→ remove the menu item, remove the checkbox, remove `swipeProps`'s presumption that two tabs can share a session). Today both answers ship at once.

### F2 — Phantom optimistic row on dedup hit (critical, ~100% repro on any race)

`userTabsCollection.insert({id: 'abc12345', sessionId: 'S'})` writes an optimistic row **locally** (TanStack QueryCollection semantics). The onInsert handler fires `POST /api/user-settings/tabs` with the same body. If the server dedup path (api/index.ts:342-351) hits, the server returns `{tab: existing}` with `existing.id = 'xyz98765'` (a *different* id) and status `200`.

The client-side contract is: **the server returned an OK. The optimistic write stuck.** The QueryCollection has no rollback path because the HTTP call succeeded. The local row `abc12345` remains.

And because the server *didn't* insert, there's no `notifyInvalidation` fire (line 366 is in the insert branch). The client never receives an invalidation signal → never refetches → never learns that `abc12345` doesn't exist on the server.

**Net effect:** every time two code paths race to `ensureTabForSession` on the same sessionId (e.g. `useState` init at line 56 runs while the user clicks a sidebar item that also fires `ensureTabForSession`), you get a phantom row. On the next full refetch (30s refetch interval on `agentSessionsCollection`, OR when PartyKit fires for unrelated reasons, OR on reload), the phantom disappears. For up to 30 seconds, the user sees a duplicate tab.

**This is exactly the V1 bug from `2026-04-18-duplicate-tabs-post-d1-migration.md`, claimed fixed by `603c866`. It wasn't. `603c866` only fixed the case where NO existing tab matches — in that case the server honors the client id. The RACE case (existing tab with a different id) is untouched.**

### F3 — Double-fire of `useState` initializer writes to global state (correctness, React-rules violation)

`AgentOrchPage.tsx:50-72`:

```ts
const [selectedSessionId, setSelectedSessionId] = useState<string | null>(() => {
  if (searchSessionId) {
    ensureTabForSession(searchSessionId)   // ← mutates global collection
    return searchSessionId
  }
  // ...
  setActiveTabId(fallback.id)              // ← mutates global localStorage
  return fallback.sessionId ?? null
})
```

`useState` initializers are explicitly allowed to run more than once by React (StrictMode, concurrent rendering, the "bailed out render" path). Every run calls `userTabsCollection.insert(...)` *and* `setActiveTabId(...)`. The second insert finds the first row via client dedup (line 35) and returns — so we dodge *that* bullet — but we leave the set of ways to produce phantom rows (F2) doubled for every cold-mount.

**Fix:** move the side-effect out of render. Run it once in a `useEffect` with `[]` deps; accept that render must tolerate `selectedSessionId === null` for one frame; or move the whole concern into a module-scope init block (which is the shape the issue-5 zustand design proposes).

### F4 — `selectedSessionId` drifts from `userTabsCollection` (correctness)

`selectedSessionId` is a React `useState`, initialized once. Nothing re-syncs it with the collection after mount. If the active tab is deleted (on this device: `Cmd-W`, or on another device: PartyKit invalidates, `refetch` drops the row), `selectedSessionId` still points at it. `AgentDetailWithSpawn` keeps rendering the deleted session. The `key={selectedSessionId}` forces unmount only if the id CHANGES — deletion doesn't change it.

The tab-bar's `handleClose` (tab-bar.tsx:177-198) only handles the close-locally case. It doesn't observe the external-delete case. The `useLiveQuery` inside TabBar re-renders the bar correctly (the tab disappears), but the main view is stale.

**Fix:** `selectedSessionId` should be a *derived* value (selector on collection + active-tab-id), not a mirror. The issue-5 zustand design expresses this as `activeSessionId = tabs.find(t => t.id === activeTabId)?.sessionId`.

### F5 — `activeTabId` in localStorage can point to a deleted tab forever

`setActiveTabId` is called from many places; **nothing watches for the referenced tab disappearing**. After a cross-device delete, localStorage says `duraclaw-active-tab = 'abc12345'`, the collection doesn't have `abc12345`, `getActiveTabId()` returns `'abc12345'`, callers `.find(t => t.id === 'abc12345')` return `undefined`, and the only recovery is the cold-mount fallback at `AgentOrchPage.tsx:62-69`.

The result: keyboard shortcut `Cmd+W` (line 210-218) silently no-ops because `userTabsCollection.has(activeId)` is false. The user presses `Cmd+W`, sees nothing happen, presses again, still nothing. The only way out is to click a tab (which fires `setActiveTabId` with a live id).

**Fix:** subscribe to the collection; when the active tab disappears, move the pointer (to next, prev, first, or null). Trivial in the new design, awkward in the current one.

### F6 — Skeleton tabs render for sessions that are permanently gone

The LEFT JOIN in TabBar renders a skeleton when `session` is undefined. `agentSessionsCollection` filters archived sessions out (it doesn't, actually — SessionRecord has `archived: boolean`, but the UI filters via `sessionsByProject` computations, not at the collection level — confirmed by grep). But `agentSessionsCollection.queryFn` fetches `/api/sessions` — what's that endpoint's filter?

If a session was deleted from D1 (not just archived), the `/api/sessions` response won't include it, but the tab still exists in `userTabsCollection` pointing at that sessionId. **The tab bar renders the skeleton shimmer forever.** No recovery UI, no "this session was deleted, close tab?" affordance, no auto-close.

**Fix:** tab-side FK enforcement or a reaper that deletes tabs whose sessionId isn't in `agent_sessions`. Today this is a guaranteed dead tab after any session delete.

### F7 — OPFS-seeded first render vs server truth divergence (cold-load UX)

On cold load, `userTabsCollection` hydrates synchronously from OPFS via `dbReady` top-level-await. The `queryFn` fires in parallel to fetch D1 truth. For a 200-500ms window, `.toArray` returns OPFS rows, some of which may no longer exist on the server (tab deleted on another device).

`AgentOrchPage`'s init path reads those stale rows and may set `selectedSessionId` to a stale tab's sessionId. Once the refetch completes and the stale row is removed, F4 kicks in — `selectedSessionId` points at nothing. User lands on the empty-state composer after the page "seems" to have loaded the right session.

**Fix:** in the issue-5 design, cold-load cache is the same store as live state; reconciliation is a single `patchSessionMeta` merge with `updatedAt`. Today it's two separate collections with separate caches and no merge protocol.

---

## 4. Why the three hot-fix commits can't close this

Each commit addressed one vector in isolation. The vectors interact.

| Commit | Fixed | Broken |
|---|---|---|
| `603c866` | POST honors client id → no duplicate on fresh insert | Didn't touch server dedup behavior on repeat insert. |
| `538a06b` | Server dedups by `(userId, sessionId)` on POST | Prevents the "New tab for project" feature. Introduces phantom-row bug on race (F2). |
| `4df474a` | Removed GET self-heal that was deleting intentional duplicates | But POST still blocks intentional duplicates from being created. Now the system is strictly worse: you can't create dupes (POST dedups) AND you can't clean up dupes that slip in (GET no longer dedups). |

The three together ship a state where "multi-tab per session is intentional" is claimed in the commit message of `4df474a` while the code in `538a06b` guarantees it's structurally impossible. Take your pick — whichever intent you honor, you have bugs.

---

## 5. Alternative framings (why "just pick one")

Two coherent shipping choices:

### Choice A — "One tab per session, ever"

- Keep POST dedup (`538a06b`).
- Delete the "New tab for project" menu item.
- Delete the `newTab` param from `QuickPromptInput.onSubmit`.
- Delete the `initialNewTab` prop + the checkbox rendering.
- Delete `handleNewTabForProject` from AgentOrchPage.
- Update `use-swipe-tabs` docs to say "cycles through tabs (each a different session)" rather than implying swipe-to-cycle within a session.
- **Pros:** Simplest mental model; eliminates three of the seven failure modes.
- **Cons:** Loses a feature that's been in the UI since the p5 refactor.

### Choice B — "Tabs are opaque; multi-tab-per-session allowed"

- Remove POST `(userId, sessionId)` dedup (revert `538a06b`).
- Remove client `ensureTabForSession` dedup (`lib/tab-utils.ts:35-39`).
- Make `handleSpawn` honor `config.newTab` — skip the find-existing path when true.
- Reintroduce a **surgical** dedup for the *accidental* duplicate case: client tracks a `Set<sessionId>` of "tabs created this tick" and refuses a second insert within the same React tick. One-line guard, solves the double-`useState`-init problem without blocking intentional duplicates.
- **Pros:** Restores the shipped feature; matches the `4df474a` commit message.
- **Cons:** Re-opens the `17244bf` bug class unless client ID honoring is bulletproof. (It is, per `603c866` — so this is low risk.)

Either is fine. Shipping both (today's state) is not.

---

## 6. Recommendation: stop patching this; do issue-5

Every failure mode in §3 is a symptom of the same root cause documented in `2026-04-17-issue-5-session-tab-state-root-cause.md` §2:

> Tabs embed cached session metadata but the system has no synchronous, authoritative source for that metadata at first render — so tab creation has to guess, then backfill, and the guess/backfill pair races with every other async loader.

The D1 migration fixed the "embed metadata" half (via join) but replaced `UserSettingsDO`'s in-memory coordinator with an HTTP/PartyKit/OPFS tri-layer that has **more** asynchrony, not less:

| Source | Latency | Authoritative for |
|---|---|---|
| OPFS cache (userTabsCollection) | sync (~5ms) | Last-known tabs |
| OPFS cache (agentSessionsCollection) | sync | Last-known session metadata |
| `queryFn` fetch (userTabs) | ~50-200ms | D1 truth |
| `queryFn` fetch (agentSessions) | ~50-200ms | D1 truth |
| PartyKit WS invalidation | ~50ms post-handshake, 0 afterwards | Refresh signal |
| SessionDO WS state | ~100ms handshake + per-event | Live status |
| `localStorage['duraclaw-active-tab']` | sync | Active selection |
| `selectedSessionId` useState | sync (mount-only) | Active selection (mirror) |
| URL `?session=X` | sync | Active selection (hint) |

Nine sources that each claim partial authority. The issue-5 zustand design collapses this to three (URL hint, single store, write-through to server) and makes every observed race structurally impossible via the precedence rules in §4.5 of that doc.

**Concrete next step for a planning-mode session:**

1. Read `2026-04-17-issue-5-session-tab-state-root-cause.md` in full (especially §4, §5, §8).
2. Scope the 5-file implementation (§8 of that doc) as GH#5 implementation work.
3. Plan the migration from `userTabsCollection` (TanStack QueryCollection) to the zustand slice — keep the D1 HTTP endpoints, swap the client-side collection consumer for a store action.
4. Delete `ensureTabForSession`, the client dedup in `lib/tab-utils.ts`, the `(userId, sessionId)` POST dedup in `api/index.ts`, the `quickPromptHint` state machinery, and the `useState`-initializer side effects.
5. Decide A vs B (§5) — whichever is chosen, the new store expresses it in a single place.

Expected diff size, per issue-5 §8: **+~220 / −~400 LOC**. The three hot-fix commits totalled `+195 / −110`. We've spent the LOC, we just spent it on patches.

---

## 7. If we don't do issue-5 yet — minimum bandaids

Priority-ordered by harm-per-minute:

1. **F1 (broken feature):** Pick choice A or B from §5. Ship the three-line deletion (A) or the four-line undeletion (B). Two hours of work.
2. **F4 (stale selectedSessionId):** Replace the useState with a derived selector: `useSelectedSessionId()` reads `userTabsCollection.toArray.find(t => t.id === useActiveTab())?.sessionId ?? searchSessionId`. One hook, ~20 lines. Fixes F4 + F5 together.
3. **F3 (double-fire side effect):** Move the `ensureTabForSession(searchSessionId)` call from the `useState` init into a `useEffect` with `[searchSessionId]` deps. Gate behind a `useRef` flag to avoid re-firing on every URL change. ~10 lines.
4. **F2 (phantom optimistic row):** Change `onInsert` in `user-tabs-collection.ts` to read the server response, compare returned `tab.id` against `m.modified.id`, and if they differ, perform a `collection.delete([m.modified.id])` in a microtask (after the transaction settles). TanStack QueryCollection's mutation protocol allows this via the return value. ~15 lines.
5. **F6 (orphan skeleton tabs):** Add a sweep on `agentSessionsCollection` refetch: find tabs whose `sessionId` isn't in the sessions list, soft-prompt the user, or auto-close after N seconds of skeleton. ~30 lines.
6. **F7 (stale OPFS on cold):** Bump `userTabsCollection` `schemaVersion` to 2; accept one-time cache loss on next release. Re-evaluate once invalidation delivery is proven reliable.

These are bandaids. They will pay off if the next breaking change is >2 weeks away. If it isn't, go straight to §6.

---

## 8. Verification plan (if any of §7 ships)

Reuse the six race scenarios in `2026-04-16-state-management-audit.md` §10, plus:

| # | Scenario | Expected |
|---|---|---|
| 1 | Cold-mount with `?session=X` where X is in OPFS but not D1 (deleted elsewhere) | Skeleton tab for <200ms, then auto-close with toast; selectedSessionId → null. |
| 2 | Two concurrent `ensureTabForSession('S')` calls in the same tick | Exactly one tab for S; no phantom optimistic row. |
| 3 | Right-click tab → "New tab for project" → submit prompt | Exactly one new session, with a tab distinct from the right-clicked tab. (Only valid under Choice B.) |
| 4 | `Cmd+W` after cross-device delete of active tab | No-op warning, or auto-advance to next tab. Today: silent no-op. |
| 5 | Archive a session on device A; device B's tab for it | Should survive (archive ≠ delete) and render correctly. |
| 6 | Logout → login as different user | No stale `duraclaw-active-tab` leakage into second user's tab bar. (Untested today — `localStorage` persists across users.) |
| 7 | QuickPromptInput "Open in new tab" checkbox behavior | Honored (Choice B) or removed from UI (Choice A). |

---

## 9. Bottom line

The commit message of `4df474a` — *"remove aggressive GET tab dedup that breaks multi-tab"* — is **half right**. The GET dedup was aggressive. But the POST dedup is **equally aggressive** and is still in tree. The result is the worst of both worlds: accidental duplicates that slip past the POST racecheck (F2) are never cleaned up (GET no longer dedups), AND intentional duplicates can't be created (POST dedups). Multi-tab is both broken and un-repairable.

Three hot-fix commits in one hour shipped a system that is internally inconsistent. The next attempt should not be "fix number four." It should be the structural refactor that `2026-04-17-issue-5-session-tab-state-root-cause.md` has been waiting on since yesterday.
