---
initiative: gh132-p3-followups
type: project
issue_type: feature
status: approved
priority: high
github_issue: 157
created: 2026-05-01
updated: 2026-05-01
approved_by: dev@baseplane.ai
approved_at: 2026-05-01
predecessors:
  - "GH#125 / PR #127 — P1 Tamagui adoption (merged 2026-04-28)"
  - "GH#131 — P2 RNW universalization (closed 2026-04-29)"
  - "GH#132 / PR #153 — P3 Expo SDK 55 native target (merged 2026-05-01)"
parent_spec: "planning/specs/132-p3-rn-native-target.md"
parent_evidence: "planning/evidence/vp-132-p3-rn-native-target.md"
research:
  - "planning/research/2026-05-01-gh157-p3-followups-bundle.md"
inherits_deferred_vps:
  - "VP-3 (sign-in round-trip + token persist)"
  - "VP-4 (WS bearer)"
  - "VP-5 (SQLite persistence)"
  - "VP-7 (push tap routing)"
  - "VP-9 (kanban DnD)"
phases:
  - id: p1
    name: "Foundations — op-sqlite fix + auth dispatcher (combined, was P1+P2)"
    tasks:
      - "(implements B1) Patch apps/orchestrator/src/db/persistence-op-sqlite.ts:25 — change `opSqlite.open({ name: 'duraclaw.db' })` to `opSqlite.open({ location: 'duraclaw.db' })` to match @op-engineering/op-sqlite@15.2.12 JSI surface"
      - "(implements B2) Create apps/orchestrator/src/lib/auth-client.ts dispatcher: re-exports auth-client-expo on isExpoNative(), better-auth-capacitor/client on isNative() (Capacitor), throws on web (not used)"
      - "(implements B2) Update apps/orchestrator/src/lib/platform.ts:163 — re-order so isExpoNative() Expo branch (lines 137-157) runs before the Capacitor branch; verify both branches exist and dispatch correctly"
      - "(implements B2) Update apps/orchestrator/src/hooks/use-user-stream.ts:103 — change two-way `if (isNative()) { ... }` to three-way `if (isExpoNative()) { import auth-client-expo } else if (isNative()) { import better-auth-capacitor/client } else {}` for the WS `_authToken` query param"
      - "(implements B2) Update apps/orchestrator/src/entry-client.tsx:21,29 comments — replace 'Patch window.fetch on Capacitor…' with 'Patch globalThis.fetch on native (Capacitor or Expo)…'"
      - "(implements B2) Update apps/orchestrator/src/lib/auth.ts:73 server-side `betterAuth({ plugins })` — add `expo()` plugin alongside `capacitor()` so server is dual-tolerant during the transition (capacitor() removed in P4). Import: `import { expo } from '@better-auth/expo'`"
      - "(implements B1, B2) Verify: `pnpm typecheck && pnpm test && pnpm build` all pass on the combined branch before manual smoke"
    test_cases:
      - id: p1-1
        description: "Build the signed Expo APK from apps/mobile-expo/ and sideload to test device — logcat shows successful `[duraclaw-db]` op-sqlite init, NO 'TypeError: undefined is not a function'. Re-runs parent VP-5 cold-start gate."
        type: smoke
      - id: p1-2
        description: "On the same APK: sign in with email+password → land on authenticated route. Force-stop app (`adb shell am force-stop com.baseplane.duraclaw`) and reopen — still authenticated, no re-sign-in. Re-runs parent VP-3."
        type: smoke
      - id: p1-3
        description: "Send 5+ messages in a session, force-stop app, reopen — messages render from op-sqlite cache (no flash-to-empty), then live updates resume. Re-runs parent VP-5 (SQLite persistence)."
        type: smoke
      - id: p1-4
        description: "Open WS to /api/sessions/:id stream — server log shows successful auth via _authToken query param hoisted to bearer header (apps/orchestrator/src/server.ts:101-106). Re-runs parent VP-4."
        type: smoke
      - id: p1-5
        description: "Web build (`pnpm dev` in apps/orchestrator) signs in via the Capacitor branch unchanged — no regression on browser-side auth"
        type: smoke
  - id: p2
    name: "Native screens — 9 functional + 4 deferred-stub + cross-cutting infra"
    tasks:
      - "(implements B3) Create apps/orchestrator/src/lib/toast.ts thin wrapper — exports `toast.success(msg)`, `toast.error(msg)`, `toast.info(msg)`. Web path imports sonner; native path calls `Alert.alert(title, msg)`. Replace direct `import { toast } from 'sonner'` in routes/login.tsx + routes/_authenticated/board.tsx with the wrapper. Lands FIRST in the PR (foundation for all screen ports)"
      - "(implements B3) Create apps/orchestrator/src/hooks/use-route-params.ts — generic `useRouteParams<T>()` wrapping React Navigation's `useRoute()`, returns typed params mirroring TanStack `useParams<T>()` signature. ~30 LOC. Native-only. Lands FIRST in the PR (foundation for all screen ports)"
      - "(implements B3) Create apps/orchestrator/src/features/auth/LoginScreen.tsx — extract login form + authClient call from routes/login.tsx (123 LOC). Pure shared. Both routes/login.tsx and native/screens.tsx LoginScreen import from features/auth/. Tier-A."
      - "(implements B3) Create apps/orchestrator/src/features/layout/MaintenanceScreen.tsx — extract from routes/maintenance.tsx (19 LOC). Pure shared. Tier-A."
      - "(implements B3) Create apps/orchestrator/src/features/sessions/SessionDetailRedirect.tsx — extract redirect logic from routes/_authenticated/session.$id.tsx (20 LOC). Native uses `useRouteParams<{id: string}>()` then redirects via React Navigation; web uses TanStack redirect. Tier-A."
      - "(implements B3) Create apps/orchestrator/src/features/admin/AdminCodexModelsScreen.tsx + AdminGeminiModelsScreen.tsx — unwrap CodexModelsPanel + GeminiModelsPanel from their respective admin.* routes; light wrapper + admin-gate. Delegation pattern. Tier-A."
      - "(implements B3) Create apps/orchestrator/src/features/projects/ProjectsScreen.tsx + use-projects-list.ts — extract `useProjectsList()` hook (useLiveQuery + useAuthSession + visibility filter) from routes/_authenticated/projects.tsx (96 LOC). View split via single-file `Platform.OS === 'web' ? <Grid> : <FlatList>` dispatch inside ProjectsScreen.tsx (matches existing KanbanBoard.tsx pattern; no `.web.tsx`/`.native.tsx` split — Vite config does NOT have platform extensions wired). Tier-B."
      - "(implements B3) Create apps/orchestrator/src/features/arcs/ArcDetailScreen.tsx + use-arc-detail.ts — extract `useArcDetail(arcId)` hook (useLiveQuery + editable title + session list + arc tree state) from routes/_authenticated/arc.$arcId.tsx (415 LOC). View split via single-file Platform.OS dispatch inside ArcDetailScreen.tsx (no `.web.tsx`/`.native.tsx`). Both platforms consume the same hook; the screen reads `params` as PROPS passed by the route wrapper (TanStack route on web reads `useParams()`, native screen wrapper in `native/screens.tsx` reads `useRouteParams()`). Tier-B."
      - "(implements B3) Create apps/orchestrator/src/features/admin/AdminUsersScreen.tsx + use-admin-users.ts — extract `useAdminUsers()` hook (fetch users, derive state) from routes/_authenticated/admin.users.tsx (389 LOC). Native renders read-only FlatList + banner '⚠ Use web for editing' — no Create/Set Password/Delete dialogs on native. Tier-B."
      - "(implements B3) Create apps/orchestrator/src/features/settings/AccountSection.tsx + DefaultsSection.tsx + use-settings-defaults.ts — extract Account section (sign-out, current identity display) and Defaults section (model preference, permission preference) from routes/_authenticated/settings.tsx (~150 LOC of 1058). Admin sections (Projects/Identities/System) NOT extracted in this phase — see deferred-stub task below. Tier-C."
      - "(implements B3) Create apps/orchestrator/src/features/board/BoardScreenContainer.tsx — thin container that hosts KanbanBoard on web, KanbanBoardNative on native (current placeholder). DnD integration is P3. Tier-C."
      - "(implements B3) Wire native/screens.tsx — replace each placeholder Stub component with the real import from features/<x>/. 14 stub→real swaps (9 functional + 5 unchanged: Home, ProjectDocs, Deploys, SettingsTest test-file marker, plus deferred Settings admin which stays in Settings stub list)"
      - "(implements B3, deferred-stub) HomeScreen — keep stub; banner: 'Dashboard pending — see GH#NNN follow-up'. WHY DEFERRED: AgentOrchPage 600+ LOC hidden complexity (tab sync, session collection, spawn agent UI, peer follow, deep-link hydration). Native UX needs redesign, not direct port. File follow-up issue before phase close."
      - "(implements B3, deferred-stub) ProjectDocsScreen — keep stub; banner: 'Docs editor available on web only — see GH#NNN follow-up'. WHY DEFERRED: DocsEditor couples Y.Doc awareness signals + jsx-preview (web-only) + file tree state. No native docs runner. File follow-up issue before phase close."
      - "(implements B3, deferred-stub) DeploysScreen — keep stub; banner: 'Deploys available on web only — see GH#NNN follow-up'. WHY DEFERRED: Custom 1s polling loop, 7-section layout, localStorage state, no synced collection. Admin-only; non-core to mobile workflow. File follow-up issue before phase close."
      - "(implements B3, deferred-stub) Settings admin sections (Projects visibility, Identities CRUD, System) — Settings screen extracts only Account + Defaults; admin sections render a banner 'Use web for admin settings — see GH#NNN follow-up' inside SettingsScreen below the Defaults section. WHY DEFERRED: form-heavy CRUD (~900 LOC of 1058) is a UX cliff on mobile. File follow-up issue before phase close."
      - "(implements B3) File 4 GitHub follow-up issues for the deferred screens (Home/AgentOrchPage, ProjectDocs, Deploys, Settings admin sections). Reference each in the deferred-stub banner copy. Captured as a P3 close-task before merging the PR."
      - "(implements B3) Verify Biome ban: `pnpm lint` confirms apps/orchestrator/src/** does not import any of the web-only banned libs (xyflow, jsx-parser, Rive, media-chrome, cmdk, embla, use-stick-to-bottom). Native fallbacks live in packages/ai-elements/** (already allowed by current rule)."
      - "(implements B3) Verify: `pnpm typecheck && pnpm test && pnpm build` all pass on the P3 branch"
    test_cases:
      - id: p2-1
        description: "On signed Expo APK: navigate Login → Home (stub, banner visible) → Board → Projects → Deploys (stub) → Settings → AdminCodexModels → AdminGeminiModels → AdminUsers → ProjectsDocs (stub) — all 14 routes navigable, no crash, deferred-stub banners reference filed follow-up issue numbers"
        type: smoke
      - id: p2-2
        description: "Login flow on native: enter test credentials, submit, land on authenticated route. Toast on bad credentials renders via Alert.alert (verify by entering wrong password)"
        type: smoke
      - id: p2-3
        description: "Projects screen on native: list renders project cards from useLiveQuery, visibility filter works (toggle to show shared projects)"
        type: smoke
      - id: p2-4
        description: "ArcDetail on native: navigate to /arc/<id>, useArcDetail returns data, editable title PATCH works on blur (verify server log shows PATCH /api/arcs/<id>)"
        type: smoke
      - id: p2-5
        description: "AdminUsers on native (admin user only): list renders, banner '⚠ Use web for editing' visible, no Create/Set Password/Delete buttons"
        type: smoke
      - id: p2-6
        description: "Settings on native: Account section shows current identity + sign-out button (sign-out works → returns to Login). Defaults section: change model preference, persist across app restart. Admin sections show 'Use web' banner."
        type: smoke
      - id: p2-7
        description: "Web regression: `pnpm dev` in apps/orchestrator → all 14 routes still render in browser. Kanban drag works (web @dnd-kit unchanged). Settings admin sections still functional on web."
        type: smoke
      - id: p2-8
        description: "Re-run parent VP-3, VP-4, VP-7: with real screens in place, sign-in round-trip works (VP-3), WS bearer flows token correctly (VP-4), cold-start tap on FCM push routes to correct session (VP-7)"
        type: integration
  - id: p3
    name: "Kanban DnD via react-native-reanimated-dnd"
    tasks:
      - "(implements B4) Verify react-native-reanimated-dnd@2.0.0 is installed (apps/mobile-expo/package.json — should be added if not present). Reanimated 4.3.0 + Gesture Handler 2.31.1 are already in apps/mobile-expo/package.json"
      - "(implements B4) Update apps/orchestrator/src/features/kanban/KanbanBoardNative.tsx (currently 87 LOC read-only placeholder) — replace with real implementation using <GestureHandlerRootView> + <DropProvider> + <Droppable> per column + <Draggable> per card. Reuse AdvanceConfirmModal, advance-arc.ts, checkPrecondition(), deriveColumn(), COLUMN_ORDER, adjacency rule (single-step forward only) from existing web kanban. Target: 180-220 LOC."
      - "(implements B4) Wire <GestureHandlerRootView> at root — verify it's mounted in apps/orchestrator/src/entry-rn.tsx around <NavigationContainer> (add if missing — required by Gesture Handler 2)"
      - "(implements B4) Add Platform.OS feature gate inside KanbanBoardNative — try the DnD tree; if any required prop/method is undefined at module load, fall back to the read-only placeholder rendering. Gate is permissive: if reanimated-dnd misbehaves on Android, dogfood ships with read-only banner reading 'Drag pending — see GH#NNN follow-up'"
      - "(implements B4) Update apps/orchestrator/src/features/board/BoardScreenContainer.tsx (from P3) — confirm it dispatches Platform.OS to KanbanBoard (web, @dnd-kit) vs KanbanBoardNative (native, reanimated-dnd or fallback)"
      - "(implements B4) If fallback path triggers: file GitHub follow-up issue 'GH#NNN: react-native-reanimated-dnd nested-scroll fix on Android'. Banner copy in fallback path references the issue number."
      - "(implements B4) Verify: `pnpm typecheck && pnpm test && pnpm build` all pass on the P4 branch"
    test_cases:
      - id: p3-1
        description: "On signed Expo APK: navigate to Board, drag a card from 'research' column to 'planning' column → AdvanceConfirmModal appears showing current/next mode → tap Advance → modal closes, POST /api/arcs/<id>/sessions fires (verify in server log), card position updates via arcsCollection broadcast. Re-runs parent VP-9."
        type: smoke
      - id: p3-2
        description: "Drag card to non-adjacent column (skip a step) → drag cancels silently, no modal. Adjacency rule preserved on native."
        type: smoke
      - id: p3-3
        description: "If reanimated-dnd misbehaves: BoardScreen falls back to read-only placeholder with banner referencing the filed follow-up issue. App does not crash. (Test by intentionally breaking the DnD wiring locally to verify fallback engages.)"
        type: smoke
      - id: p3-4
        description: "Web regression: Kanban drag still works in browser via @dnd-kit, modal flow unchanged"
        type: smoke
  - id: p4
    name: "Capacitor cleanup — delete apps/mobile/ + scripts + routes + R2 + .npmrc + metro stubs + pipeline coordination"
    tasks:
      - "(implements B5, process gate) Open `baseplane-infra` PR FIRST to drop the `bash scripts/build-mobile-ota-bundle.sh` line from the deploy pipeline. Confirm PR is reviewed/approved before merging the duraclaw cleanup PR. WITHOUT this, the next deploy after cleanup fails with 'file not found'."
      - "(implements B5) `git rm -r apps/mobile/` — delete the Capacitor Android shell directory tree (~8,500 LOC, ~200 files: Gradle configs, Java/Kotlin, capacitor.config.ts, build/sign scripts, google-services.json)"
      - "(implements B5) `git rm scripts/build-mobile-ota-bundle.sh` — delete the Capgo OTA bundle pipeline script (66 LOC)"
      - "(implements B5) Delete Capacitor routes from apps/orchestrator/src/api/index.ts: `POST /api/mobile/updates/manifest` (lines 1091-1121), `GET /api/mobile/apk/latest` (lines 1128-1148), `GET /api/mobile/assets/*` (lines 1155-1170 — only used by Capacitor since Expo uses /api/mobile/eas/assets/*). KEEP the EAS routes (`/api/mobile/eas/manifest` lines 1198-1252, `/api/mobile/eas/assets/*` lines 1254-1267) — they're the Expo path"
      - "(implements B5) KEEP `MOBILE_ASSETS` R2 binding in apps/orchestrator/wrangler.toml (lines 120-133) — Expo still uses this bucket under the `ota/expo/` namespace. Update inline comments to remove references to the legacy `ota/bundle-*.zip` namespace."
      - "(implements B5) Remove Capacitor stubs from apps/mobile-expo/metro.config.js — delete the CAPACITOR_STUBS Set + resolver mapping (lines 43-64). Now safe because P1's auth dispatcher means `better-auth-capacitor` is no longer imported anywhere on the Expo bundle path."
      - "(implements B5) `git rm apps/mobile-expo/native-stubs/empty.js` — only consumed by metro stubs above"
      - "(implements B5) Remove three lines from `.npmrc` (lines 65-67): `public-hoist-pattern[]=better-auth-capacitor`, `public-hoist-pattern[]=@capacitor/*`, `public-hoist-pattern[]=@capgo/*`"
      - "(implements B5) Remove server-side `capacitor()` plugin from apps/orchestrator/src/lib/auth.ts:73 betterAuth() config — keep `expo()` (added in P1) + `bearer()`. Drop the `import { capacitor } from 'better-auth-capacitor'` at line 4."
      - "(implements B5) Remove `better-auth-capacitor` from apps/orchestrator/package.json dependencies. Run `pnpm install` to refresh the lockfile."
      - "(implements B5) Add scripts/r2-cleanup-capacitor-keys.sh — one-shot wrangler script that deletes legacy R2 keys: `ota/bundle-*.zip`, `ota/version.json`, `apk/version.json`, `apk/duraclaw-*.apk`. Per-key delete loop (wrangler has no `--prefix` bulk delete). Committed to repo as the cleanup audit trail; run once during PR rollout."
      - "(implements B5) Run `pnpm install && pnpm typecheck && pnpm test && pnpm build` to verify nothing broke. Check `pnpm --filter @duraclaw/mobile-expo build` succeeds without metro resolver errors."
      - "(implements B5) Manual smoke on Expo APK after deploy: sign in, send a message, kanban drag (or fallback) — confirm baseline still works post-cleanup."
      - "(implements B5) Update `.claude/rules/deployment.md` — remove the Capacitor channel section (lines 13-17 + the dual-OTA explanatory prose), keep Expo channel as the sole mobile OTA channel. ALSO remove any reference to `pnpm verify:expo-prebuild` (script doesn't exist in codebase per spec-review resolution)."
      - "(implements B5) Note in PR body: planning/specs/26-capacitor-android-mobile-shell.md is intentionally KEPT (status: sunset) for historical context."
    test_cases:
      - id: p4-1
        description: "After PR merge + deploy: `curl -i https://duraclaw.baseplane.ai/api/mobile/updates/manifest` returns 404 (route deleted). `curl -i https://duraclaw.baseplane.ai/api/mobile/eas/manifest?platform=android&runtime-version=...` returns the Expo manifest as before."
        type: smoke
      - id: p4-2
        description: "Infra deploy pipeline runs successfully after cleanup PR merges. No 'file not found' on `bash scripts/build-mobile-ota-bundle.sh`. The baseplane-infra PR was merged before this duraclaw PR — confirmed via git log on infra repo."
        type: smoke
      - id: p4-3
        description: "Manual smoke on signed Expo APK after deploy: cold-start works, sign-in works (server `expo()` plugin only, no `capacitor()`), send a message, navigate all 14 routes (deferred-stub screens still show banners), kanban drag (or fallback) works"
        type: smoke
      - id: p4-4
        description: "Run `bash scripts/r2-cleanup-capacitor-keys.sh` (committed in this PR) — deletes legacy R2 keys; output shows N keys deleted, no errors. Verify via `wrangler r2 object list duraclaw-mobile --prefix ota/bundle-` returns empty."
        type: smoke
      - id: p4-5
        description: "Web regression: web build still works (`pnpm dev` in apps/orchestrator). Sign-in works on web (Better Auth bearer + expo() plugin tolerates web cookies, capacitor() removal doesn't break browser flow)."
        type: smoke
      - id: p4-6
        description: "Repository surface check: `rg 'better-auth-capacitor|@capacitor/|@capgo/' --type ts --type json` returns zero hits (or only inside planning/specs/26-capacitor-android-mobile-shell.md historical doc)."
        type: smoke
---

# GH#157 — GH#132 P3 Follow-ups Bundle

> GitHub Issue: [#157](https://github.com/baseplane-ai/duraclaw/issues/157)
> Parent spec: [`planning/specs/132-p3-rn-native-target.md`](132-p3-rn-native-target.md)
> Parent verification: [`planning/evidence/vp-132-p3-rn-native-target.md`](../evidence/vp-132-p3-rn-native-target.md)
> Research: [`planning/research/2026-05-01-gh157-p3-followups-bundle.md`](../research/2026-05-01-gh157-p3-followups-bundle.md)

## Overview

GH#157 consolidates five follow-up items from PR #153 (GH#132 P3 — Expo SDK
55 native target, merged 2026-05-01). The Expo APK boots cold-start to the
React Navigation root with no fatal exception, but five items remain: a
one-line op-sqlite parameter fix that blocks SQLite persistence (VP-5);
an auth-dispatcher migration that blocks the sign-in round-trip (VP-3);
extraction of nine TanStack route components into RN-compatible shared
modules (which unblocks VP-3 through VP-9 device-side); a kanban DnD
integration on `react-native-reanimated-dnd` (VP-9); and a
post-validation Capacitor cleanup (delete `apps/mobile/`, the legacy
OTA pipeline, the R2 keys, the metro stubs, and the `.npmrc` hoist
patterns). The dogfood gate from the issue body is **dropped** — the
sole dogfood user has confirmed Capacitor is not in use, so cleanup
proceeds as soon as the prior phases are validated.

## Feature Behaviors

### B1: op-sqlite `location` parameter fix unblocks SQLite persistence

**Core:**
- **ID:** op-sqlite-location-fix
- **Trigger:** Expo APK cold-start initializes `apps/orchestrator/src/db/persistence-op-sqlite.ts`
- **Expected:** `opSqlite.open({ location: 'duraclaw.db' })` succeeds and returns a working DB handle; logcat shows `[duraclaw-db]` init success, NOT `TypeError: undefined is not a function`. SQLite persistence + branch/rewind coherence work as designed by parent B3.
- **Verify:** Install signed Expo APK, run `adb logcat ReactNativeJS:V '*:S'` during cold-start, confirm zero "undefined is not a function" lines under the `[duraclaw-db]` tag. Then exercise persistence: send 5+ messages in a session, force-stop app, reopen, messages render from cache (no flash-to-empty).
- **Source:** apps/orchestrator/src/db/persistence-op-sqlite.ts:25 (one-line change: `name` → `location`)
- **Re-runs parent VP:** VP-5 (SQLite persistence)

#### UI Layer
N/A — this is a non-visual storage-layer fix. UI side effect: messages persist across cold-start instead of disappearing.

#### API Layer
N/A — purely client-side init.

#### Data Layer
No schema change. The fix is the parameter shape passed to `@op-engineering/op-sqlite@15.2.12`'s synchronous `open()`. The native lib (`libop-sqlite.so`) loads correctly per parent verification; only the JSI method-call shape was wrong. The adapter's `execute()`, transaction handling, and row-format normalization (lines 68-71 already handle both old `_array` and new plain `[]` shapes) are correct.

---

### B2: auth dispatcher routes Better Auth calls per platform

**Core:**
- **ID:** better-auth-expo-dispatcher
- **Trigger:** Any client-side path that needs the Better Auth bearer token — `installNativeFetchInterceptor()` in `platform.ts`, the WS `_authToken` query param in `use-user-stream.ts`, or any future call site
- **Expected:** On Expo native (`isExpoNative()`), token reads come from `expo-secure-store` via `auth-client-expo.ts`. On Capacitor (`isNative()` && !isExpoNative()), token reads come from `@capacitor/preferences` via `better-auth-capacitor/client`. On web, no token interception (cookie-based session). Server-side `betterAuth({ plugins: [admin(), bearer(), capacitor(), expo()] })` is dual-tolerant during the transition; `capacitor()` is removed in P4 cleanup.
- **Verify:** Sign in on signed Expo APK with email+password → land on authenticated route. Force-stop app, reopen → still authenticated. Server log shows successful auth via `_authToken` query param hoisted to bearer header on WS upgrades. Web build (in browser) signs in via the unchanged Capacitor branch.
- **Source:**
  - apps/orchestrator/src/lib/auth-client.ts (NEW — dispatcher)
  - apps/orchestrator/src/lib/platform.ts:163 (re-order)
  - apps/orchestrator/src/hooks/use-user-stream.ts:103 (three-way branch)
  - apps/orchestrator/src/entry-client.tsx:21,29 (comment update)
  - apps/orchestrator/src/lib/auth.ts:73 (server-side `expo()` plugin add)
- **Re-runs parent VP:** VP-3 (sign-in round-trip), VP-4 (WS bearer)

#### UI Layer
No new UI. Existing Login form path unchanged; toast on auth failure goes through the new toast wrapper (B3 cross-cutting infra).

#### API Layer
Server-side: `betterAuth({ plugins })` in `auth.ts` adds `expo()` alongside `capacitor()`. Both are active during P1-P4. The `bearer()` plugin (already present) handles the actual `Authorization: Bearer <token>` header for both flavors. The `_authToken` → bearer hoist on WS upgrades at `apps/orchestrator/src/server.ts:101-106` is unchanged.

#### Data Layer
Token storage backend on Expo: `expo-secure-store` (Android: encrypted SharedPreferences; iOS: Keychain). Storage key: `better-auth.session_token` (parity convention with Capacitor). No DB or D1 schema change.

---

### B3: native screens — 9 functional + 4 deferred-stub + cross-cutting infra

**Core:**
- **ID:** native-screens-tier-abc
- **Trigger:** User navigates to any of the 14 React Navigation routes wired in `apps/orchestrator/src/native/navigation.tsx`
- **Expected:**
  - 9 functional screens render real shared components from `apps/orchestrator/src/features/<x>/`: Login, Maintenance, SessionDetail (redirect), AdminCodexModels, AdminGeminiModels, Projects, ArcDetail, AdminUsers (read-only), Settings (Account + Defaults sections only).
  - 4 deferred-stub screens render the stub with a banner explaining why deferred and pointing at a filed GitHub follow-up issue: Home (AgentOrchPage complexity), ProjectDocs (Y.Doc + jsx-preview), Deploys (custom polling UI), Settings admin sections (form-heavy CRUD UX cliff on mobile).
  - Cross-cutting infra: `lib/toast.ts` wrapper (sonner on web, `Alert.alert` on native), `hooks/use-route-params.ts` (RN-side useRoute() typed wrapper), Biome ban still passes (no web-only deps imported into `apps/orchestrator/src/**`).
- **Verify:** On signed Expo APK, tap through Login → all 5 BottomTabs (Home, Board, Projects, Deploys, Settings) → all nested stack screens (SessionDetail, ArcDetail, Docs, AdminUsers, AdminCodexModels, AdminGeminiModels). All 14 routes navigable with no crash. Deferred-stub banners show their referenced issue numbers.
- **Source:**
  - apps/orchestrator/src/lib/toast.ts (NEW — cross-cutting)
  - apps/orchestrator/src/hooks/use-route-params.ts (NEW — cross-cutting)
  - apps/orchestrator/src/features/auth/, layout/, sessions/, admin/, projects/, arcs/, settings/, board/ (NEW — 9 functional screen extractions)
  - apps/orchestrator/src/native/screens.tsx (UPDATE — replace 14 stubs with real imports OR deferred-stub banners)
  - apps/orchestrator/src/routes/login.tsx, board.tsx (UPDATE — toast import → wrapper)
- **Re-runs parent VP:** VP-3 + VP-4 + VP-7 unblocked once real screens exist; VP-9 partially unblocked (needs P3 to fully pass)

#### UI Layer
- **Tier A (5 simple, pure-shared or delegation):** Login, Maintenance, SessionDetail (redirect), AdminCodexModels, AdminGeminiModels.
- **Tier B (3 medium, logic shared + view split):** Projects (single-file `Platform.OS === 'web' ? <Grid> : <FlatList>` dispatch), ArcDetail (single-file Platform.OS dispatch consuming `useArcDetail()`), AdminUsers (read-only FlatList + "⚠ Use web for editing" banner on native; no Create/Set Password/Delete dialogs). **Convention:** all view splits use single-file Platform.OS dispatch, NOT `.web.tsx`/`.native.tsx` extensions — Vite config does not have platform extensions wired, and the existing codebase already uses single-file Platform.OS dispatch (see KanbanBoard.tsx). Route params are passed as PROPS from the route wrapper, not read via a hook inside the shared component.
- **Tier C (2 + infra):** Settings Account section (sign-out, current identity display) + Defaults section (model preference, permission preference); admin sections render an in-screen banner "Use web for admin settings — see GH#NNN follow-up." BoardScreenContainer (thin Platform.OS dispatcher to KanbanBoard / KanbanBoardNative; DnD wiring is B4).
- **Toast wrapper:** `~/lib/toast.ts` exports `toast.success(msg)`, `toast.error(msg)`, `toast.info(msg)`. Web routes through sonner; native calls `Alert.alert`. Replaces direct `import { toast } from 'sonner'` in `routes/login.tsx` + `routes/_authenticated/board.tsx`.
- **Deferred-stub banners:** Each rendered as `<View><Text>{stubMessage}</Text><Text>See GH#{issue}</Text></View>` styled consistently. Stubs occupy the full screen viewport so the user understands the screen is intentionally not implemented yet.

#### API Layer
No new endpoints. All 9 functional screens hit existing API endpoints (Better Auth, arcs collection, projects collection, admin user CRUD, settings CRUD) through their existing hooks (`useLiveQuery`, `useAuthSession`, `useArcDetail`, `useProjectsList`, `useAdminUsers`, `useSettingsDefaults`).

#### Data Layer
No schema change. All extractions consume existing TanStack DB collections + endpoints. The toast wrapper and `useRouteParams` hook are pure-client utilities with no persistence.

---

### B4: kanban DnD on native via react-native-reanimated-dnd

**Core:**
- **ID:** kanban-dnd-native
- **Trigger:** User on signed Expo APK navigates to `/board` and drags a card from one column to an adjacent (forward) column
- **Expected:** Drag is recognized by `react-native-reanimated-dnd` Draggable/Droppable primitives. On drop into adjacent column, `AdvanceConfirmModal` appears showing current/next mode. User taps "Advance →" → modal closes, `POST /api/arcs/<id>/sessions` fires with `{mode, prompt, project?}`, server creates the session, `arcsCollection` broadcast updates the UI. Adjacency rule (single-step forward only) is preserved on native — drag to non-adjacent column cancels silently. **Web @dnd-kit kanban remains unchanged.** If `react-native-reanimated-dnd` misbehaves on Android (nested-scroll touch coordination is the known unknown), `KanbanBoardNative.tsx` falls back to the read-only placeholder behind the same route, with a banner referencing the filed follow-up issue.
- **Verify:** Re-runs parent VP-9. Drag works on Pixel-class Android device, modal flow completes, server log confirms session creation, UI updates via broadcast. Fallback path verified by intentionally breaking DnD wiring locally and confirming no crash + banner visible.
- **Source:** apps/orchestrator/src/features/kanban/KanbanBoardNative.tsx (REWRITE — currently 87 LOC read-only placeholder; target 180-220 LOC with DnD + fallback gate)
- **Re-runs parent VP:** VP-9 (kanban DnD)

#### UI Layer
- `<GestureHandlerRootView>` wraps the entry-rn.tsx tree (around `<NavigationContainer>`). Verify mounted; add if missing.
- `<DropProvider>` wraps the BoardScreen content.
- Each kanban column is a `<Droppable droppableId="drop:<lane>:<col>" onDrop={...}>`.
- Each card is a `<Draggable data={{arcId}}>`.
- Reuse `AdvanceConfirmModal`, `advance-arc.ts`, `checkPrecondition()`, `deriveColumn()`, COLUMN_ORDER constant, adjacency rule from existing `apps/orchestrator/src/features/kanban/`.
- **Reorder-within-column is NOT in scope** (web doesn't do it either; this is web parity).
- Fallback: if DnD wiring throws at module load OR if the runtime drag gesture doesn't recognize, render the existing read-only `KanbanBoardNative` placeholder with a banner.

#### API Layer
No new endpoints. Drag triggers the same `POST /api/arcs/<id>/sessions` that web uses via `advance-arc.ts`.

#### Data Layer
No schema change. `arcsCollection` (TanStack DB live query) is the source of truth for both platforms.

---

### B5: Capacitor cleanup — delete sunset surface area

**Core:**
- **ID:** capacitor-sunset-cleanup
- **Trigger:** B1, B2, B3, B4 are validated on the deployed Expo APK (PR merged + auto-deploy + manual device smoke confirms each phase's deliverable works). The dogfood user confirms Capacitor is not in use (already confirmed at spec time — no formal gate).
- **Expected:** Repository surface area for Capacitor is zero. `apps/mobile/` directory deleted. `scripts/build-mobile-ota-bundle.sh` deleted. Three Capacitor routes (`POST /api/mobile/updates/manifest`, `GET /api/mobile/apk/latest`, `GET /api/mobile/assets/*`) deleted from `apps/orchestrator/src/api/index.ts`. Metro stubs in `apps/mobile-expo/metro.config.js` removed (safe because B2's dispatcher means `better-auth-capacitor` is no longer imported on the Expo bundle path). `.npmrc` hoist patterns for `@capacitor/*`, `better-auth-capacitor`, `@capgo/*` removed. Server-side `capacitor()` plugin dropped from `auth.ts` betterAuth config (only `bearer()` + `expo()` remain). Legacy R2 keys (`ota/bundle-*.zip`, `ota/version.json`, `apk/version.json`, `apk/duraclaw-*.apk`) deleted via committed wrangler script. **Cross-repo coordination required:** the `baseplane-infra` deploy pipeline must drop the `bash scripts/build-mobile-ota-bundle.sh` line BEFORE this duraclaw cleanup PR merges, or the next deploy fails with "file not found." Spec captures this as an explicit process gate (user owns the cross-repo PR).
- **Verify:** After cleanup PR merges + deploys: `curl -i https://duraclaw.baseplane.ai/api/mobile/updates/manifest` returns 404; `/api/mobile/eas/manifest` (Expo) returns the manifest as before. Infra deploy pipeline runs successfully (no "file not found"). Manual smoke on Expo APK confirms baseline still works post-cleanup. `rg 'better-auth-capacitor|@capacitor/|@capgo/' --type ts --type json` returns zero hits (excluding sunset-status historical spec). `MOBILE_ASSETS` R2 binding KEPT (Expo uses it under `ota/expo/` namespace).
- **Source:**
  - DELETE: apps/mobile/, scripts/build-mobile-ota-bundle.sh, apps/orchestrator/src/api/index.ts:1091-1170 (3 routes), apps/mobile-expo/metro.config.js:43-64 (stubs), apps/mobile-expo/native-stubs/empty.js, .npmrc:65-67 (3 hoist lines)
  - UPDATE: apps/orchestrator/src/lib/auth.ts:4,73 (drop capacitor import + plugin), apps/orchestrator/package.json (drop better-auth-capacitor dep), apps/orchestrator/wrangler.toml:120-133 comments (remove legacy namespace refs), .claude/rules/deployment.md (drop Capacitor channel section)
  - NEW: scripts/r2-cleanup-capacitor-keys.sh (one-shot R2 key delete loop)
  - KEEP: planning/specs/26-capacitor-android-mobile-shell.md (status: sunset, historical), MOBILE_ASSETS R2 binding (Expo uses it)
- **Re-runs parent VP:** None — this is post-validation cleanup, not a VP gate.

#### UI Layer
No UI change. Mobile users see no functional difference (they're already on Expo APK; the deleted Capacitor surface had no live consumers per the dogfood confirmation).

#### API Layer
Three Worker routes deleted: `POST /api/mobile/updates/manifest`, `GET /api/mobile/apk/latest`, `GET /api/mobile/assets/*`. EAS routes (`/api/mobile/eas/manifest`, `/api/mobile/eas/assets/*`) unchanged. Server-side `betterAuth({ plugins })` drops `capacitor()`, keeps `bearer()` + `expo()`.

#### Data Layer
No DB schema change. R2 cleanup of legacy `ota/bundle-*.zip` + `ota/version.json` + `apk/version.json` + `apk/duraclaw-*.apk` keys via committed `scripts/r2-cleanup-capacitor-keys.sh`. Per-key delete loop because wrangler has no `--prefix` bulk-delete. `MOBILE_ASSETS` R2 bucket binding stays (Expo namespace `ota/expo/` is unaffected).

---

## Non-Goals

Explicitly out of scope for this spec:

- **Native ports of Home (AgentOrchPage), ProjectDocs (DocsEditor), Deploys, and Settings admin sections** — captured as deferred-stub phases inside this spec with documented "why deferred" rationale and filed follow-up issues; full native ports are out of this spec's scope.
- **Reorder-within-column on the kanban** (B7 spec text mentions it, but the current web kanban doesn't do it either; native parity matches web — single-step-forward via adjacency rule only). File a separate follow-up if dogfood requests it.
- **Real RN toast library** (e.g. `react-native-toast-message`) — Phase 1 ships the `Alert.alert` wrapper for `lib/toast.ts`. Real toasts are a future UX upgrade.
- **Dogfood window before Capacitor cleanup** — the sole dogfood user confirms Capacitor is not in use. P4 runs as soon as P1/P2/P3 are validated; no 7-day or N-day gate.
- **`@better-auth/expo` server-side migration to drop `capacitor()` immediately** — server keeps `capacitor()` alongside `expo()` during P1-P3; `capacitor()` drops in P4 cleanup (after the prior phases are validated and nothing depends on it).
- **Replacing `expo-sqlite` for op-sqlite** — B1 is a one-line parameter fix; the existing `op-sqlite-tanstack-persistence/` package stays.
- **Cross-repo atomic PRs** — the `baseplane-infra` pipeline edit is a separate PR coordinated as a process gate, not committed in this spec's PRs.

## Open Questions

- [x] **Resolved:** `pnpm verify:expo-prebuild` referenced in `.claude/rules/deployment.md` but the script doesn't exist in codebase. Decision: P4 cleanup phase removes the reference from `deployment.md` (one of the doc-touch tasks). Per-phase test gates are typecheck + test + build only.
- [ ] If `react-native-reanimated-dnd` doesn't work cleanly on Android in P3, the fallback to read-only is shipped behind a banner. Whether to retry the integration in a follow-up vs. accept the read-only state long-term is a product call after the fallback ships.

## Implementation Phases

See YAML frontmatter `phases:` above. Phase summary:

| Phase | Scope | PR | Sequencing |
|-------|-------|----|----| 
| P1 | op-sqlite location fix + auth dispatcher (B1+B2 combined; original phasing called these P1+P2 separately) | PR 1 | first |
| P2 | Native screens — 9 functional + 4 deferred-stub + cross-cutting infra (B3) | PR 2 | after P1 |
| P3 | Kanban DnD via reanimated-dnd (B4, with read-only fallback) | PR 3 | after P2 (BoardScreen container in place) |
| P4 | Capacitor cleanup (B5) — code, R2 keys, .npmrc, metro stubs, server plugin, pipeline coord | PR 4 | after P1/P2/P3 validated |

**Branch strategy:** Single feature branch name `feat/gh157-followups` is reused across all 4 PRs SEQUENTIALLY (not stacked). Workflow per PR: (1) check out `feat/gh157-followups` from latest `main`, (2) implement the phase, (3) push and open PR, (4) merge to main, (5) delete and recreate the branch from updated main for the next phase. This matches CLAUDE.md's "one PR per branch" convention — the branch NAME is reused to signal the bundle, but each PR has a fresh branch from main with only that phase's commits. **Not stacked PRs** (which would couple PR diffs and complicate review); each PR is independently reviewable and revertable.

**P1 wraps both B1 and B2** — they're parallel-able conceptually but combined into one PR per the agreed strategy. The combined PR is small: B1 is one line, B2 is ~40 LOC dispatcher + 4 file edits + 1 server-side import.

**P2 internal sequencing inside the single PR:** infra (toast wrapper + useRouteParams hook) lands first as foundation, then 9 screens in any order, then deferred-stub banners + filed follow-up issues, then full PR test/build/typecheck pass + manual device smoke. **P2 is the largest phase by far** (~1,580 LOC, ~15 new files, ~5 modified files, 4 GH follow-up issues filed). May span 2-3 implementation sessions; the implementation skill should checkpoint progress task-by-task within the phase rather than waiting for a single end-of-phase verification.

**Phase numbering note:** Phases contiguously numbered P1-P4. The original drafting numbered them P1, P3, P4, P5 to track which parent-spec sub-tasks they corresponded to; renumbered during spec review to remove the confusing gap. YAML `phases:` array uses `id: p1, p2, p3, p4`.

## Verification Strategy

### Test Infrastructure

vitest is project-wide (`pnpm test` runs all suites). No new test config needed for any phase. Bun bundles for VPS components are validated via `pnpm build` per `.claude/rules/deployment.md`.

### Build Verification

Per-phase test gates: `pnpm typecheck`, `pnpm test`, `pnpm build` must all pass before merging the phase PR. (`pnpm verify:expo-prebuild` is referenced in deployment.md but not confirmed present — see Open Questions; do not gate on it until the script's existence is verified.)

### Definition of "validated"

A phase is **validated** when:
1. Phase PR is merged to `main`
2. The auto-deploy pipeline (per `.claude/rules/deployment.md`) deploys the change to production
3. Manual device smoke on the signed Expo APK confirms the phase's deliverable works (e.g. P1: SQLite persists; P2: sign-in works; P3: 14 screens navigate, 9 are functional; P4: drag-between-columns works on Board OR fallback banner is shown)

P4 cleanup runs only after P1/P2/P3 are all validated by this definition.

## Verification Plan

Concrete, executable steps to verify the spec works against a deployed Expo APK + the production Worker.

### VP1: B1 — op-sqlite SQLite persistence (re-runs parent VP-5)

Steps:

1. Build the signed Expo APK: `pnpm --filter @duraclaw/mobile-expo build:android`
   Expected: APK at `apps/mobile-expo/android/app/build/outputs/apk/release/app-release.apk`.
2. Sideload to dev device: `adb install -r apps/mobile-expo/android/app/build/outputs/apk/release/app-release.apk`
   Expected: install success, no error.
3. Start logcat filter for the DB tag: `adb logcat ReactNativeJS:V '*:S' | grep '\[duraclaw-db\]'`
4. Cold-start the app on the device (tap icon)
   Expected: logcat shows `[duraclaw-db] op-sqlite init success` (or equivalent) — NO `TypeError: undefined is not a function`.
5. Sign in with test credentials (e.g. test@baseplane.ai), navigate to a session, send 5+ messages.
   Expected: messages render in the chat list.
6. Force-stop the app: `adb shell am force-stop com.baseplane.duraclaw`
7. Reopen the app from the device launcher.
   Expected: messages render from the local op-sqlite cache (no flash-to-empty), then live updates resume on WS reconnect.

### VP2: B2 — auth dispatcher routes correctly (re-runs parent VP-3 + VP-4)

Steps:

1. On the signed Expo APK from VP1, open the Login screen, enter `test@baseplane.ai` / valid password, tap Sign In.
   Expected: redirect to authenticated route (`/`), no error toast.
2. Verify token in expo-secure-store. **Preferred:** programmatic check — temporarily add a dev-mode log line in `auth-client-expo.ts` (e.g. `console.log('[auth] token present:', !!token)`) and tail logcat after sign-in. (Remove the log before merge.) **Fallback (Android only):** `adb shell run-as com.baseplane.duraclaw ls /data/data/com.baseplane.duraclaw/shared_prefs/` should list a file containing `better-auth` in its name. Note: `expo-secure-store` on Android uses EncryptedSharedPreferences, so the value is not readable via `cat` — only existence and key presence can be confirmed from the shell. Step 3 below is the real round-trip gate.
   Expected: log line shows `token present: true` after sign-in (or shared_prefs file exists for the package).
3. Force-stop the app: `adb shell am force-stop com.baseplane.duraclaw`. Reopen from launcher.
   Expected: skips Login, lands on authenticated route. Session persisted.
4. With Worker logs tailing (`wrangler tail --format=pretty`), navigate to a session in the app — this triggers a WS upgrade to `/api/sessions/:id/stream`.
   Expected: server log shows successful auth via `_authToken` query param hoisted to bearer header (apps/orchestrator/src/server.ts:101-106).
5. Web regression: open browser to https://duraclaw.baseplane.ai, sign in.
   Expected: cookie-based session works, no Capacitor-path side effects.

### VP3: B3 — all 14 routes navigable; 9 functional + 4 deferred-stub

Steps:

1. On signed Expo APK, sign in.
2. Navigate Login → Home (BottomTabs root).
   Expected: Home renders the deferred-stub banner: `Dashboard pending — see GH#NNN follow-up` (NNN = filed Home follow-up issue).
3. Tap Board tab.
   Expected: BoardScreen renders. KanbanBoardNative shows either real DnD (if P4 already shipped) or the read-only placeholder.
4. Tap Projects tab.
   Expected: Projects screen renders the project list (FlatList on native). Visibility filter toggle works.
5. Navigate to a project → tap into Docs.
   Expected: ProjectDocs renders the deferred-stub banner: `Docs editor available on web only — see GH#NNN`.
6. Tap Deploys tab.
   Expected: Deploys screen renders the deferred-stub banner.
7. Tap Settings tab.
   Expected: Settings screen renders Account section (sign-out, identity display) + Defaults section (model preference, permission preference) + admin-sections banner.
8. Change a default (e.g. model preference). Force-stop, reopen.
   Expected: changed default persists.
9. Tap sign-out in Settings.
   Expected: returns to Login screen.
10. Sign in as admin user, navigate to Settings → tap Admin Codex Models / Admin Gemini Models / Admin Users.
    Expected: AdminCodexModels and AdminGeminiModels render their panels. AdminUsers renders read-only FlatList of users with banner `⚠ Use web for editing`. No Create/Set Password/Delete buttons visible.
11. Navigate to an arc detail: `/arc/<id>` (deep-link or tap from Board).
    Expected: ArcDetail renders title, session list, arc tree. Tap title to edit, blur to save.
    Expected: Worker log shows `PATCH /api/arcs/<id>` with new title.
12. Web regression: open browser, navigate every route.
    Expected: all routes still render in browser. Kanban drag works. Settings admin sections still functional.

### VP4: B4 — kanban DnD on native (re-runs parent VP-9)

Steps:

1. On signed Expo APK, sign in, navigate to Board.
2. Identify a card in the 'research' column. Long-press to begin drag, drag to the 'planning' column, release.
   Expected: AdvanceConfirmModal appears, shows "Advance '<title>' from research to planning?", with worktree label and project picker (if applicable).
3. Tap "Advance →".
   Expected: modal closes. Server log shows `POST /api/arcs/<id>/sessions` with `{mode: 'planning', prompt: <kata-enter prompt>, project?: <picked>}`. arcsCollection broadcast updates UI; card position may shift to reflect new derived column.
4. Drag a card from 'research' to 'verify' (skip planning + implementation — non-adjacent).
   Expected: drag cancels silently, no modal, no API call. Adjacency rule preserved.
5. Web regression: open browser to /board, drag a card.
   Expected: web @dnd-kit drag works unchanged, modal appears, advanceArc fires.
6. Fallback path test (only if reanimated-dnd misbehaves on this device): intentionally break DnD wiring locally (e.g. comment out `<DropProvider>`), rebuild APK, navigate to Board.
   Expected: BoardScreen renders read-only KanbanBoardNative placeholder with banner `Drag pending — see GH#NNN`. No crash.

### VP5: B5 — Capacitor cleanup applied; deploy + smoke

Steps:

1. Confirm `baseplane-infra` PR has been merged dropping the `bash scripts/build-mobile-ota-bundle.sh` line. Verify in infra repo's git log.
2. Merge the duraclaw cleanup PR. Auto-deploy pipeline runs.
   Expected: pipeline succeeds, no "file not found" error.
3. Run the R2 cleanup script: `bash scripts/r2-cleanup-capacitor-keys.sh`
   Expected: output lists N keys deleted (`ota/bundle-*.zip`, `ota/version.json`, `apk/version.json`, `apk/duraclaw-*.apk`). No error.
4. Verify R2 cleanup: `wrangler r2 object list duraclaw-mobile --prefix ota/bundle-`
   Expected: empty result.
5. `curl -i https://duraclaw.baseplane.ai/api/mobile/updates/manifest`
   Expected: 404.
6. `curl -i 'https://duraclaw.baseplane.ai/api/mobile/eas/manifest?platform=android&runtime-version=<rv>'`
   Expected: 200 with Expo manifest body (or 404 if manifest doesn't exist for that runtime version — both are valid; 5xx is the failure).
7. On signed Expo APK, sign in (server `expo()` plugin only, no `capacitor()`), send a message, navigate all 14 routes, drag a kanban card.
   Expected: baseline still works post-cleanup.
8. Repository surface check: `rg 'better-auth-capacitor|@capacitor/|@capgo/' --type ts --type json`
   Expected: zero hits (or only inside `planning/specs/26-capacitor-android-mobile-shell.md` historical doc).
9. `pnpm install && pnpm typecheck && pnpm test && pnpm build`
   Expected: all pass.
10. Web regression: open browser, sign in, navigate all routes.
    Expected: web build still works; sign-in via Better Auth bearer + `expo()` plugin tolerates browser cookies; capacitor() removal doesn't affect web flow.

## Implementation Hints

### Dependencies

No new npm installs for P1, P2 (everything needed is already in the workspace per parent spec P3.0 risks all GREEN/YELLOW). For P3, verify `react-native-reanimated-dnd@2.0.0` is in `apps/mobile-expo/package.json`; if not, `pnpm --filter @duraclaw/mobile-expo add react-native-reanimated-dnd`. For P4, no installs — only deletions.

### Key Imports

| Module | Import | Used For |
|--------|--------|----------|
| `@op-engineering/op-sqlite` | `open` (synchronous, takes `{ location?: string }`) | B1 — fix the parameter shape |
| `@better-auth/expo` | `expo()` (server-side plugin), `expoClient()` (client-side plugin via auth-client-expo.ts) | B2 — server config + client dispatcher |
| `expo-secure-store` | `getItemAsync`, `setItemAsync` (already wrapped in auth-client-expo.ts) | B2 — token storage |
| `react-native` | `Platform`, `Alert`, `FlatList`, `View`, `Text`, `ScrollView`, `TextInput` | B3 — primitives for view splits |
| `@react-navigation/native` | `useRoute`, `useNavigation`, `Linking` | B3 — useRouteParams hook + deep-link |
| `react-native-reanimated-dnd` | `DropProvider`, `Draggable`, `Droppable` | B4 — kanban DnD primitives |
| `react-native-gesture-handler` | `GestureHandlerRootView` | B4 — required wrapper for reanimated-dnd |
| `sonner` | `toast` (web only — wrapped by lib/toast.ts) | B3 — toast on web |

### Code Patterns

**B1 — op-sqlite parameter fix (one line):**
```ts
// apps/orchestrator/src/db/persistence-op-sqlite.ts:25
- const database = opSqlite.open({ name: 'duraclaw.db' })
+ const database = opSqlite.open({ location: 'duraclaw.db' })
```

**B2 — auth-client.ts dispatcher (NEW):**
```ts
// apps/orchestrator/src/lib/auth-client.ts
import { isExpoNative, isNative } from './platform'

// Dynamic imports gated by Platform check. Both Vite (web) and Metro
// (native) statically resolve dynamic imports — they don't need them
// to be conditional at the bundler level; the conditionality is at
// runtime. The `/* @vite-ignore */` comment suppresses Vite's analyze
// warning when the path is a relative file (it's not load-bearing for
// resolution). For Metro, the better-auth-capacitor import is replaced
// at bundle time by the metro.config.js stub (until P4 cleanup), so
// Metro never tries to resolve the real package. After P4 cleanup
// removes the stub, the dispatcher's runtime guard `isNative() &&
// !isExpoNative()` is the only thing that prevents the import from
// firing on Expo — the import literal is parsed but not executed.
export async function getAuthToken(): Promise<string | null> {
  if (isExpoNative()) {
    const { getExpoAuthToken } = await import(/* @vite-ignore */ './auth-client-expo')
    return getExpoAuthToken()
  }
  if (isNative()) {
    // Capacitor branch — only reachable when isNative() is true AND
    // isExpoNative() is false. After P4 cleanup, this branch is dead
    // code in practice (no more Capacitor client) but the module still
    // dispatches correctly if the Capacitor APK is sideloaded.
    const { getCapacitorAuthToken } = await import('better-auth-capacitor/client')
    return getCapacitorAuthToken({ storagePrefix: 'better-auth' })
  }
  return null  // web — cookie-based session, no token interception
}
```

**B2 — server-side dual-plugin (transition state):**
```ts
// apps/orchestrator/src/lib/auth.ts
import { capacitor } from 'better-auth-capacitor'  // REMOVED in P4
import { expo } from '@better-auth/expo'           // ADDED in P1

export const auth = (env: Env) => betterAuth({
  // ...
  plugins: [admin(), bearer(), capacitor(), expo()],  // capacitor() removed in P4
})
```

**B3 — toast wrapper (no top-level await; works in both Vite and Metro):**
```ts
// apps/orchestrator/src/lib/toast.ts
import { Platform, Alert } from 'react-native'

type ToastApi = {
  success: (msg: string) => void
  error: (msg: string) => void
  info: (msg: string) => void
}

// Synchronous platform dispatch. Metro tree-shakes the web branch on
// native (Platform.OS is statically known after babel-preset-expo
// transform); Vite tree-shakes the native branch on web. No top-level
// await — Metro historically does NOT support TLA, and TLA in a module
// shared with the Worker bundle would also break Cloudflare's Worker
// loader. The cost is loading sonner eagerly on web, which is fine
// (it's already in the web bundle).
let webSonnerToast: ToastApi | null = null
if (Platform.OS === 'web') {
  // require() lets Metro skip parsing on native; Vite handles it as a
  // synchronous import on web.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  webSonnerToast = require('sonner').toast as ToastApi
}

export const toast: ToastApi = {
  success: (msg) =>
    Platform.OS === 'web' ? webSonnerToast?.success(msg) : Alert.alert('Success', msg),
  error: (msg) =>
    Platform.OS === 'web' ? webSonnerToast?.error(msg) : Alert.alert('Error', msg),
  info: (msg) =>
    Platform.OS === 'web' ? webSonnerToast?.info(msg) : Alert.alert('', msg),
}
```

**B3 — useRouteParams hook:**
```ts
// apps/orchestrator/src/hooks/use-route-params.ts
import { useRoute } from '@react-navigation/native'

export function useRouteParams<T extends Record<string, unknown>>(): T {
  const route = useRoute()
  return (route.params ?? {}) as T
}
```

**B3 — view split convention (Projects example, single-file Platform.OS dispatch):**

Vite config does NOT have `.web.tsx` / `.native.tsx` extensions wired (verified at spec-write time in `apps/orchestrator/vite.config.ts`). The convention is a single shared file with `Platform.OS === 'web'` dispatch — matches the existing `KanbanBoard.tsx` pattern (`Platform.OS !== 'web' && require('./KanbanBoardNative')`).

```ts
// apps/orchestrator/src/features/projects/ProjectsScreen.tsx
import { Platform } from 'react-native'
import { FlatList } from 'react-native'
import { useProjectsList } from './use-projects-list'
import { ProjectCard } from './ProjectCard'
import { ProjectCardNative } from './ProjectCardNative'

export function ProjectsScreen() {
  const { projects } = useProjectsList()
  if (Platform.OS === 'web') {
    return (
      <div className="grid">
        {projects.map((p) => (
          <ProjectCard key={p.id} {...p} />
        ))}
      </div>
    )
  }
  return (
    <FlatList
      data={projects}
      renderItem={({ item }) => <ProjectCardNative {...item} />}
      keyExtractor={(p) => p.id}
    />
  )
}
```

**Route params convention:** Shared screen components take `params` as PROPS, not via a hook. The TanStack route wrapper on web reads `useParams()` and passes them in; the native screen wrapper in `native/screens.tsx` reads `useRouteParams()` and passes them in. This sidesteps the platform-specific hook problem.

```tsx
// apps/orchestrator/src/features/arcs/ArcDetailScreen.tsx — shared
export function ArcDetailScreen({ arcId }: { arcId: string }) {
  const { arc, sessions } = useArcDetail(arcId)
  // ... shared rendering ...
}

// apps/orchestrator/src/routes/_authenticated/arc.$arcId.tsx — web wrapper
import { useParams } from '@tanstack/react-router'
export const Route = createFileRoute('/_authenticated/arc/$arcId')({
  component: () => {
    const { arcId } = useParams({ from: '/_authenticated/arc/$arcId' })
    return <ArcDetailScreen arcId={arcId} />
  },
})

// apps/orchestrator/src/native/screens.tsx — native wrapper
import { useRouteParams } from '~/hooks/use-route-params'
export function ArcDetailScreenNative() {
  const { arcId } = useRouteParams<{ arcId: string }>()
  return <ArcDetailScreen arcId={arcId} />
}
```

**B4 — kanban DnD on native (sketch, ~30 LOC):**

Note: `Droppable.onDrop` receives the dragged item's `data` payload. The DROP-TARGET column is captured via the closure (the `col` variable in the outer `.map()`); the SOURCE column is encoded in `Draggable.data` and read inside `handleDrop`. The adjacency check then compares `fromCol` (from data) vs `toCol` (from the Droppable's closure).

```tsx
// apps/orchestrator/src/features/kanban/KanbanBoardNative.tsx
import { DropProvider, Draggable, Droppable } from 'react-native-reanimated-dnd'
import { GestureHandlerRootView } from 'react-native-gesture-handler'
// ... reuse: useLiveQuery, advanceArc, AdvanceConfirmModal, checkPrecondition,
//           COLUMN_ORDER, deriveColumn, adjacency rule

function handleDrop(data: { arcId: string; fromCol: string }, toCol: string) {
  if (data.fromCol === toCol) return  // no-op (no within-column reorder)
  const fromIdx = COLUMN_ORDER.indexOf(data.fromCol)
  const toIdx = COLUMN_ORDER.indexOf(toCol)
  if (toIdx !== fromIdx + 1) return  // adjacency rule: single-step forward only
  // ... call checkPrecondition(arc), open AdvanceConfirmModal, etc.
}

return (
  <GestureHandlerRootView style={{ flex: 1 }}>
    <DropProvider>
      <ScrollView>
        {LANES.map((lane) => (
          <ScrollView horizontal key={lane}>
            {COLUMN_ORDER.map((col) => (
              <Droppable
                key={`${lane}:${col}`}
                droppableId={`drop:${lane}:${col}`}
                onDrop={(data: { arcId: string; fromCol: string }) =>
                  handleDrop(data, col)
                }
              >
                {arcsByLaneAndCol[lane][col].map((arc) => (
                  <Draggable key={arc.id} data={{ arcId: arc.id, fromCol: col }}>
                    <Card arc={arc} />
                  </Draggable>
                ))}
              </Droppable>
            ))}
          </ScrollView>
        ))}
      </ScrollView>
      <AdvanceConfirmModal {...modalProps} />
    </DropProvider>
  </GestureHandlerRootView>
)
```

**B5 — R2 cleanup script (NEW):**
```bash
#!/usr/bin/env bash
# scripts/r2-cleanup-capacitor-keys.sh
set -euo pipefail
BUCKET=duraclaw-mobile

# Per-key delete loop (wrangler has no --prefix bulk delete)
for key in $(wrangler r2 object list "$BUCKET" --prefix 'ota/bundle-' | awk '{print $1}'); do
  echo "Deleting $key"
  wrangler r2 object delete "$BUCKET/$key" --remote
done

for key in 'ota/version.json' 'apk/version.json'; do
  if wrangler r2 object get "$BUCKET/$key" --remote >/dev/null 2>&1; then
    echo "Deleting $key"
    wrangler r2 object delete "$BUCKET/$key" --remote
  fi
done

for key in $(wrangler r2 object list "$BUCKET" --prefix 'apk/duraclaw-' | awk '{print $1}'); do
  echo "Deleting $key"
  wrangler r2 object delete "$BUCKET/$key" --remote
done

echo "Capacitor R2 cleanup complete."
```

### Gotchas

- **op-sqlite `open()` is synchronous in v15.2.12** — do not `await` it. Adapter at line 25 already calls it sync; the parameter fix is the only change.
- **Server-side `expo()` plugin coexisting with `capacitor()`** — both must be in the betterAuth `plugins` array during P1-P3. Removing `capacitor()` early breaks the (already-deployed) Capacitor APK; keeping `expo()` after P4 is required for native sign-in.
- **`lib/toast.ts` uses synchronous `require('sonner')` gated by `Platform.OS === 'web'`** — NOT top-level await. Metro historically does not support TLA (and TLA in a Worker-shared module would also break Cloudflare's Worker loader). The `if (Platform.OS === 'web') { webSonnerToast = require('sonner').toast }` pattern is parsed by Metro but skipped at runtime on native (Platform.OS is statically known after babel-preset-expo transform). See the B3 toast wrapper code pattern for the exact shape.
- **`auth-client.ts` dispatcher dynamic imports** — Both Vite (web) and Metro (native) statically resolve dynamic imports. The `/* @vite-ignore */` comment on the relative path is to suppress Vite's analyze warning, not load-bearing for resolution. Metro's resolver handles `import('better-auth-capacitor/client')` via the metro.config.js stub during P1-P3 (until P4 cleanup removes the stub). After cleanup, the `isNative() && !isExpoNative()` runtime guard is the only thing preventing the import from firing on Expo.
- **No `.web.tsx` / `.native.tsx` extension splits** — Vite config does not have platform extensions wired (verified in `apps/orchestrator/vite.config.ts`). All view splits use single-file `Platform.OS === 'web'` dispatch. Matches existing `KanbanBoard.tsx` pattern.
- **Route params passed as PROPS, not read via hook in shared component** — TanStack `useParams()` is web-only; React Navigation `useRoute()` (wrapped by `useRouteParams`) is native-only. Shared screen components take `params` as props; route wrappers read from their respective router and pass them in. See B3 view split convention code pattern.
- **`<GestureHandlerRootView>` placement (B4)** — must wrap the entire app at `entry-rn.tsx` around `<NavigationContainer>`, NOT inside the BoardScreen. Required by Gesture Handler 2 to install at root; if missing, drag gestures don't recognize.
- **Metro stub removal sequencing (P4)** — only safe AFTER P1's auth dispatcher is deployed AND no other Capacitor imports remain. If you delete the stub before the dispatcher, the Expo bundle fails to resolve `better-auth-capacitor` at runtime even though no code calls it (Metro doesn't tree-shake aggressively enough).
- **Cross-repo coordination for P4** — the `baseplane-infra` pipeline edit is a separate PR. Open it FIRST, get it merged, THEN merge the duraclaw cleanup PR. Reverse order = broken deploy.
- **`scripts/r2-cleanup-capacitor-keys.sh` is a one-shot** — commit it for audit trail, run it once, leave it in repo as documentation. Idempotent (wrangler delete on missing key is a no-op).
- **`pnpm verify:expo-prebuild` does NOT exist in codebase** — referenced only in `.claude/rules/deployment.md`. P4 cleanup removes the stale reference. Per-phase test gates are typecheck + test + build only. (See Open Questions: this was resolved during spec review.)
- **Branch strategy: name reused, NOT stacked PRs** — single `feat/gh157-followups` branch name reused across 4 sequential PRs. Each PR is a fresh branch from latest `main` with only that phase's commits — independently reviewable and revertable. NOT stacked (which would couple PR diffs and complicate review). Document the workflow in PR 1's body.
- **Deferred-stub banners must reference filed issue numbers** — banners like `Dashboard pending — see GH#NNN` only work if NNN is an actual issue. File the 4 follow-ups (Home, ProjectDocs, Deploys, Settings admin) BEFORE writing the banner copy in P2.

### Reference Docs

- [op-sqlite GitHub](https://github.com/OP-Engineering/op-sqlite) — confirms `open({ location })` parameter shape
- [op-sqlite API docs](https://op-engineering.github.io/op-sqlite/docs/api/) — full JSI surface
- [@better-auth/expo](https://better-auth.com/docs/integrations/expo) — Expo plugin client + server setup
- [Better Auth Bearer plugin](https://better-auth.com/docs/plugins/bearer) — token-header injection (already in server config)
- [react-native-reanimated-dnd](https://react-native-reanimated-dnd.netlify.app/) — DropProvider/Draggable/Droppable API
- [react-native-reanimated-dnd GitHub](https://github.com/entropyconquers/react-native-reanimated-dnd) — examples + Android compatibility notes
- [React Navigation useRoute](https://reactnavigation.org/docs/use-route/) — useRouteParams hook reference
- [Cloudflare R2 Wrangler commands](https://developers.cloudflare.com/r2/api/wrangler/) — confirms no `--prefix` bulk delete; per-key loop required
- [Expo Updates manifest protocol](https://docs.expo.dev/technical-specs/expo-updates-1/) — confirms `/api/mobile/eas/manifest` route shape (kept in P4)

---
