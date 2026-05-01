---
date: 2026-05-01
topic: GH#157 P3 follow-ups bundle — feasibility & phasing for spec
type: feature
status: complete
github_issue: 157
parent_issue: 132
parent_spec: planning/specs/132-p3-rn-native-target.md
parent_evidence: planning/evidence/vp-132-p3-rn-native-target.md
items_researched: 6
---

# Research: GH#157 P3 follow-ups bundle

## Context

GH#157 is the consolidated follow-up tracker for PR #153 (GH#132 P3 — Expo SDK
55 native target). The PR landed cold-start to React Navigation root with no
fatal exception, but five items were either deferred in the PR body (#1
native screen extraction, #2 op-sqlite fix, #5 kanban DnD) or surfaced
during VP-2..VP-12 verification (#3 auth migration follow-through, #4
Capacitor cleanup).

This research feeds the spec writer (P2) for a single coordinated spec
covering all five sub-tasks as phases. Scope locked in P0: full GH#157
bundle, not separate per-sub-task specs.

## Scope

Six items deep-dived (one Explore agent each, item 0 first sequentially
to establish parent context, items 1-5 in parallel with equal weight on
codebase + web research):

- Item 0: Parent context (spec 132-p3, evidence file, PR #153, scaffolding
  inherited)
- Item 1: Native screen extraction (the heavy item)
- Item 2: op-sqlite JSI shape mismatch (VP-5 blocker)
- Item 3: better-auth call-site migration (VP-3 blocker)
- Item 4: react-native-reanimated-dnd kanban (VP-9, blocked on item 1)
- Item 5: Capacitor cleanup (destructive, gated on dogfood)

## Findings

### Item 0 — Parent context

**Spec 132-P3 shape:** 11 behaviors (B1-B11) across 5 phases (P3.0-P3.5).
All phases shipped per evidence file; 5 of 12 VPs deferred to #157
because native screen stubs block authenticated-path verification.

**§6 route mapping (from `apps/orchestrator/src/native/navigation.tsx:9-24`):**
14 stub screens total — 2 in AuthStack (Login, Maintenance), 5 in BottomTabs
(Home, Board, Projects, Deploys, Settings), nested HomeStack (SessionDetail,
ArcDetail), ProjectsStack (Docs), SettingsStack (AdminUsers,
AdminCodexModels, AdminGeminiModels, SettingsTest). Linking config wired:
scheme `duraclaw://`, prefixes `duraclaw://` + `https://duraclaw.baseplane.ai`.

**VP status:** PASS — VP-1, VP-2, VP-11, VP-12. PARTIAL — VP-6, VP-10. INFRA-GAP
(code PASS) — VP-8. **DEFERRED to #157 — VP-3, VP-4, VP-5, VP-7, VP-9.**

**Scaffolding inherited:** `apps/orchestrator/src/native/screens.tsx` (14
stubs with placeholder text), `apps/orchestrator/src/native/navigation.tsx`
(complete React Navigation tree), `apps/mobile-expo/metro.config.js` (10
Capacitor module stubs via `native-stubs/empty.js` Proxy),
`apps/orchestrator/src/lib/auth-client-expo.ts` (production-ready shim),
`packages/op-sqlite-tanstack-persistence/` (broken — see item 2),
`apps/orchestrator/src/api/index.ts` (EAS routes scaffolded; Capacitor
routes still active).

**Dogfood gate measurement: [uncertain in source]** — not specified in spec
or rules. Codified by item 5 below as a two-part gate.

### Item 1 — Native screen extraction

**Per-route inventory (LOC + risk + recommended pattern):**

| Route | LOC | Pattern | Tier | Notes |
|-------|-----|---------|------|-------|
| Login | 123 | Pure shared | A | `sonner` toast → wrapper |
| Maintenance | 19 | Pure shared | A | static |
| SessionDetail | 20 | Pure shared | A | redirect logic |
| AdminCodexModels | 41 | Delegation | A | unwrap CodexModelsPanel |
| AdminGeminiModels | 41 | Delegation | A | unwrap GeminiModelsPanel |
| Projects | 96 | Logic shared, view split | B | `useProjectsList` hook + grid → FlatList |
| ArcDetail | 415 | Logic shared, view split | B | `useArcDetail`, editable title, session timeline |
| AdminUsers | 389 | Logic shared, view split | B | 3 dialogs; CRUD; table → FlatList |
| Settings (Account+Defaults) | ~150 of 1058 | Extract sections | C | partial — admin sections deferred |
| Board | 10 (KanbanBoardNative ~87) | Native rewrite (partial) | C | container only; DnD = item 4 |
| Home | 600+ hidden | Defer | — | AgentOrchPage too complex |
| ProjectDocs | 306 | Defer | — | Y.Doc + jsx-preview |
| Deploys | 500 | Defer | — | custom polling, 7 sections |
| Settings admin sections | ~900 of 1058 | Defer | — | Projects/Identities/System CRUD |
| SettingsTest | n/a | n/a | — | test file |

**Total Phase 1 (Tiers A+B+C in this spec):** ~1,580 LOC, 6–6.5 dev days, 9
screens fully ported.

**Cross-cutting infra needed:**
- Toast wrapper (`sonner` is web-only; multiple routes use `toast()`).
  Candidates: `react-native-toast-message`, custom Animated modal, thin
  `Alert.alert` abstraction. **Not yet picked.**
- `useRouteParams<T>()` hook (~30 LOC) wrapping `useRoute()` to mirror
  TanStack `useParams` signature.
- Biome ban on web-only deps in `apps/orchestrator/src/**` (xyflow,
  jsx-parser, Rive, media-chrome, cmdk, embla, use-stick-to-bottom).
- Auth gate, deep-link, secure store, lifecycle: **already done in P3.2**.

**Pattern catalog:**
- **Pure shared** (Login, Maintenance, SessionDetail) — extract to
  `features/<x>/`, both platforms import directly. Only viable when no
  platform-specific primitives.
- **Logic shared, view split** (Projects, ArcDetail, AdminUsers, Settings
  partial) — extract `useFooScreen()` hook, then `Foo.web.tsx` +
  `Foo.native.tsx` consume it.
- **Delegation** (AdminCodexModels, AdminGeminiModels) — unwrap from
  TanStack route, light wrapper.
- **Native rewrite** (Board container, deferred Home/ProjectDocs/Deploys)
  — too much web-only state; hand-write native screen using shared types.

**Defer rationale (4 screens):**
- **Home (AgentOrchPage)**: 600+ LOC hidden complexity — tab sync, session
  collection, spawn agent UI, peer follow, deep-link hydration, plus
  AgentDetailView, SpawnAgentForm, QuickPromptInput components.
- **ProjectDocs (DocsEditor)**: Y.Doc awareness signals + jsx-preview +
  file tree state. No native docs runner exists.
- **Deploys**: custom 1s polling loop, 7-section layout, localStorage
  state, no synced collection. Admin-only; non-core.
- **Settings admin sections**: form-heavy CRUD (Projects visibility,
  Identities, System) — file separate sub-issues (recommended GH#158-161).

### Item 2 — op-sqlite JSI fix

**Root cause (one line):** `apps/orchestrator/src/db/persistence-op-sqlite.ts:25`

```ts
// Wrong:  opSqlite.open({ name: 'duraclaw.db' })
// Right:  opSqlite.open({ location: 'duraclaw.db' })
```

op-sqlite@15.2.12's `open()` expects `{ location?: string, encryptionKey?: string, ... }`,
not `{ name: string }`. The native lib loads correctly (libop-sqlite.so visible
in SoLoader output), so the JSI install is fine — the parameter shape is
the only mismatch. Adapter's `execute()`, transaction handling, and row-
format normalization (lines 68-71 already handle both old `_array` and new
plain `[]` shapes) are all correct.

**Verification (VP-5):** rebuild Expo APK, logcat shows successful `[duraclaw-db]` init,
sign in, send a message, force-stop, reopen, message persists. Branch/rewind
coherence test optional if branch API not yet exposed on native.

**Estimate:** 10–15 minutes including verification. Diff: 1 line.

**Fall-back if op-sqlite stays broken (not expected):** swap to `expo-sqlite`
(~200 LOC new adapter). Not recommended unless the parameter fix doesn't take.

### Item 3 — better-auth call-site migration

**Server-side `auth.ts:4` does NOT need to change** — `import { capacitor } from
'better-auth-capacitor'` is the Worker-side plugin used in `betterAuth()` config
to trust `capacitor://` origins; `bearer()` plugin (also in config) handles
incoming bearer headers from Expo too. Server is dual-tolerant.

**Client-side migration scope:** 3 call sites + 1 comment update.

| File:line | Current | Migration |
|-----------|---------|-----------|
| `lib/platform.ts:163` | Capacitor branch in `installNativeFetchInterceptor()` | Already has Expo branch (lines 137–157); just ensure Expo check runs first |
| `hooks/use-user-stream.ts:103` | `if (isNative()) { import('better-auth-capacitor/client') }` | Three-way: `isExpoNative()` → expo, else `isNative()` → capacitor, else web |
| `entry-client.tsx:21,29` | Capacitor-only comment | Update to mention both platforms |
| `lib/auth-client-expo.ts` | Production-ready shim | No change needed |

**Recommended dispatch pattern (Option C from research):** Create
`lib/auth-client.ts` dispatcher that imports `auth-client-expo` on Expo and
`better-auth-capacitor` on Capacitor. Mirrors `platform.ts`'s existing
`isExpoNative()` branching pattern. Avoids per-call-site boilerplate.

**Metro stubs stay in place** during this phase — removed in item 5
(Capacitor cleanup) once dispatch is verified dead-code-eliminating.

**Verification (VP-3):** sideload Expo APK, sign in, confirm token in
`expo-secure-store` (`adb shell cat /data/data/com.baseplane.duraclaw/shared_prefs/better-auth.xml`),
force-stop, reopen, confirm still authenticated, confirm WS upgrade
includes `_authToken` query param.

**Estimate:** 2–3 hours including testing.

### Item 4 — react-native-reanimated-dnd kanban

**Current architecture:** Web kanban (`apps/orchestrator/src/features/kanban/`)
is already cleanly factored — `KanbanBoard.tsx` (top-level + DndContext),
`KanbanColumn.tsx` (useDroppable), `KanbanCard.tsx` (useDraggable + Start-next
button), `KanbanLane.tsx` (lane grouping), `AdvanceConfirmModal.tsx` (123 LOC
modal — reusable as-is), `advance-arc.ts` (99 LOC shared helper).

**Native placeholder:** `KanbanBoardNative.tsx` (87 LOC) is a read-only
ScrollView grouped by lane. Replace this with the real implementation.

**Lib:** `react-native-reanimated-dnd@2.0.0` — built on Reanimated 4
(already in `apps/mobile-expo`) + Gesture Handler 2 (already in
`apps/mobile-expo`).

**API mapping:**

| @dnd-kit | react-native-reanimated-dnd |
|----------|------------------------------|
| `<DndContext sensors onDragEnd>` | `<GestureHandlerRootView>` + `<DropProvider>` |
| `useDroppable({id})` | `<Droppable droppableId onDrop>` |
| `useDraggable({id, data})` | `<Draggable data>` |
| `DragEndEvent { active, over }` | `onDrop(data)` receives data directly |

**Reuse:** `AdvanceConfirmModal`, `advance-arc.ts`, `checkPrecondition()`,
`deriveColumn()`, COLUMN_ORDER, adjacency rule — **100% reused on native**.
Only the drag mechanism is platform-specific.

**Estimate:** 180–220 LOC, 1–2 days. **Risk:** nested-scroll touch
coordination on Android (horizontal column scroll inside vertical board
scroll plus drag gesture). Recommended fallback: ship with Platform check
that falls back to read-only KanbanBoardNative if drag breaks.

**Scope clarification:** B7 spec text says "drag-between-columns + reorder-
within-column", but **the current web kanban does NOT do reorder-within-
column** (single-step forward only via adjacency rule). Recommend native
parity with web: drag-between-columns only. Reorder-within-column → file
separate follow-up if dogfood feedback requests it.

**Dependency on item 1:** Needs BoardScreen (the `/board` route component
that hosts KanbanBoardNative) — already exists in stub form. Item 1's
Tier-C delivers the real BoardScreen container; item 4 swaps the placeholder
inside it for the real DnD board.

### Item 5 — Capacitor cleanup

**Deletion inventory (verified paths):**

| Path | Size | Notes |
|------|------|-------|
| `apps/mobile/` directory tree | ~8,500 LOC | Capacitor Android shell (Gradle, Java/Kotlin, capacitor.config.ts, build scripts, google-services.json) |
| `scripts/build-mobile-ota-bundle.sh` | 66 LOC | Capgo OTA pipeline (zips dist, emits version.json) |
| `apps/orchestrator/src/api/index.ts` Capacitor routes | ~50 LOC | `POST /api/mobile/updates/manifest` (1091-1121), `GET /api/mobile/apk/latest` (1128-1148), `GET /api/mobile/assets/*` (1155-1170 — generic but only used by Capacitor now since Expo uses `/api/mobile/eas/assets/*`) |
| `apps/orchestrator/wrangler.toml` `MOBILE_ASSETS` lines 120-133 | ~6 lines | R2 binding (KEEP — Expo still uses this bucket under `ota/expo/` namespace) |
| `apps/mobile-expo/metro.config.js` lines 43-64 | ~22 lines | `CAPACITOR_STUBS` set + resolver mapping |
| `apps/mobile-expo/native-stubs/empty.js` | 23 LOC | Proxy stub (only consumed by metro stubs) |
| `.npmrc` lines 65-67 | 3 lines | `@capacitor/*`, `better-auth-capacitor`, `@capgo/*` hoist patterns |
| `planning/specs/26-capacitor-android-mobile-shell.md` | ~1,200 LOC | KEEP (sunset, historical) |

**Grand total deletion:** ~10,000 LOC + 100+ MB R2 keys (`ota/bundle-*.zip`,
`ota/version.json`, `apk/version.json`, `apk/duraclaw-*.apk`).

**No overlap with Expo:** Expo R2 keys live under `ota/expo/...`, distinct
namespace. Wrangler does **not** have `r2 object delete --prefix`; cleanup
needs per-key delete loop or Cloudflare Dashboard bulk-delete.

**Pipeline coupling (CRITICAL):** Infra pipeline (in `baseplane-infra`
external repo, NOT `.github/workflows/`) calls
`bash scripts/build-mobile-ota-bundle.sh` per `.claude/rules/deployment.md`.
**If the script is deleted without coordinating the pipeline edit, every
deploy fails with "file not found."** Pipeline edit must land
simultaneously or immediately after the cleanup PR.

**Dogfood gate codification (recommended):** Two-part gate.
- (a) **Manual**: dogfood user (b3nfreed@gmail.com) confirms in PR comment
  "Expo APK is daily driver, Capacitor APK not used in 7+ days."
- (b) **Metrics**: Cloudflare Analytics / logpush query on
  `/api/mobile/updates/manifest` + `/api/mobile/apk/latest` shows zero hits
  over the 7-day window. If logpush isn't configured, accept (a) alone.

**Risk if gate skipped:** old Capacitor APK on user device tries
`/api/mobile/updates/manifest` after route deletion → 404 → potential crash
loop. Mitigation: gate is the control. Optional belt-and-suspenders: keep
routes returning 410 Gone with a user-facing "please upgrade" message for
1-2 weeks before full deletion.

**Sequencing dependency:** Items 1, 2, 3, 5 must be deployed and
validated, then 7+ day dogfood window, then this lands.

## Comparison

| # | Effort | Risk | Independent | Wall-clock |
|---|--------|------|-------------|------------|
| op-sqlite fix | 1 line, 15 min | Trivial | ✓ | T+0 |
| auth migration | ~30 LOC + dispatcher, 2-3 hr | Low | ✓ | T+0 |
| native screens (Phase 1) | ~1,580 LOC, 6-6.5 days | High (per-screen) | ✓ | T+0..T+6 days |
| kanban DnD | ~200 LOC, 1-2 days | Medium (Android scroll) | ✗ (after Board container) | T+6..T+8 days |
| dogfood gate | passive | n/a | ✗ (after all above) | T+8..T+15 days |
| Capacitor cleanup | ~10K LOC delete + pipeline + R2, 1 day | Medium (destructive) | ✗ (after gate) | T+15+ |

**Total wall-clock:** ~3 weeks calendar time including dogfood window.
**Total dev-effort:** ~9-10 days excluding dogfood.

## Recommendations

### Spec phasing (preview)

| Phase | Scope | Dependencies | Effort | Risk |
|-------|-------|--------------|--------|------|
| P1 | op-sqlite `location` fix → VP-5 PASS | none (parallel-able with P2) | 15 min | Trivial |
| P2 | better-auth dispatcher + 3 call-site migration → VP-3 PASS | none (parallel-able with P1) | 2-3 hr | Low |
| P3a | Native screens Tier-A + cross-cutting infra (toast wrapper, useRouteParams) | P2 (auth must work to navigate authenticated routes) | 2 days | Low |
| P3b | Native screens Tier-B (Projects, ArcDetail, AdminUsers) | P3a | 2 days | Medium |
| P3c | Native screens Tier-C (Settings Account/Defaults, Board container) | P3b | 2-2.5 days | Medium-High |
| P4 | Kanban DnD via reanimated-dnd → VP-9 PASS | P3c (BoardScreen container) | 1-2 days | Medium (fallback ready) |
| P5 | Use-and-fix dogfood window | P1, P2, P3, P4 deployed | 7+ days | Process gate |
| P6 | Capacitor cleanup (code + pipeline + R2) | P5 dogfood gate (two-part) | 1 day code + infra coord | Medium (destructive) |

### Open questions for interview phase

1. Internal phasing of #1 — drop the 4 deferred screens entirely from this
   spec (file separate follow-up issues), or include as deferred-stub
   phases in the same spec?
2. Pipeline coordination for #4 — does this spec own the `baseplane-infra`
   pipeline edit, or is that a process-gate task captured separately?
3. #5 kanban scope — drag-between-columns only (matches web parity), or
   include reorder-within-column (B7 text mentions both, web doesn't)?
4. Toast wrapper pick — `react-native-toast-message` vs custom Animated
   modal vs thin `Alert.alert` abstraction?
5. `useRouteParams` hook location — `apps/orchestrator/src/hooks/` or new
   tiny shared package?
6. Dogfood gate threshold — is 7 days right given dogfood is one user?
7. R2 cleanup timing — at PR merge, or after a separate verification window?

## Open Questions

(Carried forward to interview — see "Open questions for interview phase"
above. None remain after interview locks the answers.)

## Next Steps

1. Run kata-interview (P1) — lock the 7 open questions above.
2. Run kata-spec-writing (P2) — produce
   `planning/specs/157-gh132-p3-followups.md` with B-IDs, P-phases, VP, and
   acceptance criteria. Cite this research doc.
3. Run kata-spec-review (P3) — external reviewer + fix loop.
4. Close P4 — push spec to main.

## Sources

- `planning/specs/132-p3-rn-native-target.md` (parent spec, full read)
- `planning/evidence/vp-132-p3-rn-native-target.md` (parent verification, full read)
- `planning/specs/26-capacitor-android-mobile-shell.md` (sunset spec, sunset_date 2026-04-30)
- `apps/orchestrator/src/native/{screens,navigation}.tsx` (scaffolding)
- `apps/orchestrator/src/db/{persistence-op-sqlite,persistence-capacitor,db-instance}.ts` (item 2)
- `packages/op-sqlite-tanstack-persistence/` (item 2)
- `apps/orchestrator/src/lib/{auth,auth-client-expo,platform}.ts`,
  `apps/orchestrator/src/hooks/use-user-stream.ts`,
  `apps/orchestrator/src/entry-client.tsx` (item 3)
- `apps/orchestrator/src/features/kanban/` (item 4)
- `apps/mobile/`, `scripts/build-mobile-ota-bundle.sh`,
  `apps/orchestrator/src/api/index.ts` Capacitor routes,
  `apps/mobile-expo/metro.config.js`, `.npmrc`, `.claude/rules/deployment.md` (item 5)
- PR #153 body (gh pr view 153 --json body)
- op-sqlite upstream: https://github.com/OP-Engineering/op-sqlite, npm @op-engineering/op-sqlite@15.2.12
- @better-auth/expo upstream: https://better-auth.com/docs/integrations/expo
- react-native-reanimated-dnd upstream: https://react-native-reanimated-dnd.netlify.app/, github entropyconquers/react-native-reanimated-dnd
