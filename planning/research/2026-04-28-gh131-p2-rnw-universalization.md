---
date: 2026-04-28
topic: GH#131 P2 — universalize orchestrator via react-native-web
type: feasibility
status: complete
github_issue: 131
items_researched: 5
predecessor_pr: 127
parent_research: planning/research/2026-04-23-react-native-pivot-evaluation.md
---

# Research: GH#131 P2 — RNW universalization

## Context

Phase 2 of the RN pivot. P1 (Tamagui adoption, GH#125) merged via PR #127.
P2 swaps the orchestrator's primitive renderer from web-only DOM
(`<div>`/`<span>`) to **react-native-web** primitives (`<View>`/`<Text>`).
The web build keeps shipping unchanged (RNW translates to DOM); after P2
the same component code is *capable* of running native, unlocking P3
(Expo SDK 54) without forcing it.

This research feeds the P2 spec. It exists because three areas needed
verification before spec writing:

1. Does Tamagui v2's RNW adapter work cleanly under our Vite 8 + CF
   plugin stack, or are there gotchas?
2. Are the four "hard-incompatible" libs called out in the parent
   research actually load-bearing today, or can we defer their
   feature-gate decisions?
3. Does the existing PR #127 CI guard cover RNW imports into the CF
   Worker bundle, or does it need extension?

Plus two scoping confirmations:

4. Should Expo/Metro install in P2 (per GH#131 issue body) or defer to
   P3 (per deep-dive agent recommendation)?
5. Does TanStack Router survive P2 unchanged, per parent §11.5?

## Scope

5 items deep-dived in parallel via Explore agents. User confirmed scope
before deep-dive (Capacitor `apps/mobile` excluded from P2 research; lib
research limited to "light" decision-criteria depth + 1-2 candidates per
lib).

| # | Item | Outcome |
|---|------|---------|
| 1 | Tamagui v2 + RNW under Vite 8 + CF plugin | ✅ Tractable with three guardrails |
| 2 | Web-only lib inventory (xyflow / react-jsx-parser / Rive / media-chrome) | ✅ Surprise — none currently imported by orchestrator |
| 3 | Vite alias + CF Worker CI guard extension | ✅ One-line vite alias + one-regex guard change |
| 4 | Expo/Metro alt bundler scoping | ✅ User decision: install in P2 as smoke-bundle proof |
| 5 | TanStack Router stays | ✅ Confirmed — zero changes needed |

Sources searched: `apps/orchestrator/**`, `packages/ai-elements/**`,
`scripts/`, `wrangler.toml`, `.github/workflows/`, parent research §10.4
+ §10.5 + §11.4 + §11.5, predecessor spec
`planning/specs/125-p1-tamagui-orchestrator-web.md`, PR #127 diff,
Tamagui v2 + RNW + Vite docs, GitHub issues at the
Tamagui/RNW/Vite-8 intersection.

## Findings

### 1. Tamagui v2 RNW adapter under Vite 8 + CF plugin

**Status: tractable, NOT free — three guardrails are load-bearing.**

Tamagui v2-rc.41 has built-in RNW awareness via the
`@tamagui/react-native-web-lite` ESM adapter. The compiler detects the
web target via the `react-native` → `react-native-web` Vite alias and
emits atomic CSS for primitives (View/Text/Pressable). No additional
plugin needed; the existing `@tamagui/vite-plugin` at
`apps/orchestrator/vite.config.ts:100-108` is sufficient.

**Current orchestrator state (post-PR #127, commit `b6447cf`):**
- `vite.config.ts` lines 40-43: `resolve.alias` only contains `~ →
  ./src` — no `react-native` alias yet
- `package.json:63-64,110`: Tamagui v2-rc.41 (core, vite-plugin,
  font-inter); `vite@8.0.3`
- `tamagui.config.ts`: 24 light/dark color tokens, 4 radius tokens,
  mobile breakpoint at 767px
- Plugin order: `cloudflare()` → `tamaguiPlugin()` → `react()` →
  `tailwindcss()` (correct per spec §B4)
- `react-native@0.85.2` is already in `node_modules` as a Tamagui peer,
  but **never imported** by `src/server.ts` — Worker bundle is clean
- `react-native-web` is **not** installed yet

**Required vite.config.ts deltas:**

```typescript
resolve: {
  alias: {
    '~': path.resolve(__dirname, './src'),
    'react-native': 'react-native-web',  // NEW — enables Tamagui RNW adapter
  },
},
ssr: {
  noExternal: ['react-native-web', 'react-native'],  // NEW — load-bearing
},
optimizeDeps: {
  exclude: ['react-native-web', 'react-native'],  // NEW — respects RNW browser field
},
```

**Risks (ranked):**

| Risk | Level | Mitigation |
|------|-------|-----------|
| RNW polyfills (~500 KB) leak into CF Worker bundle | HIGH | `ssr.noExternal` + extended CI guard + bundle-size assertion |
| Tamagui compiler × RNW atomic-CSS extraction interference | MEDIUM | Manual post-merge VP smoke check on `dist/client/assets/*.css` |
| RNW transitive deps tree-shake poorly into client bundle (~100-150 KB gzipped) | MEDIUM | Optional: switch to `@tamagui/react-native-web-lite` if size becomes a gate |
| Vite environment resolution misconfigured (Worker treated as web) | LOW | Verify `wrangler.toml:2` main entry untouched + Worker build smoke test |
| Shared-lib leak (e.g. `packages/ai-elements`, `shared-types` import RNW transitively) | MEDIUM | Pre-merge audit; CI guard catches direct imports |

**[uncertain]** Tamagui compiler × RNW atomic-CSS interaction is not
documented in the wild. Tamagui's recipes assume Metro for native + Vite
for web in isolation; "Vite + RNW + Tamagui" is a less-traveled path.
Mitigation = manual VP smoke check (decision Q3).

**Sources:** `apps/orchestrator/vite.config.ts:1-112`,
`apps/orchestrator/package.json:63-119`,
`apps/orchestrator/src/tamagui.config.ts`,
`apps/orchestrator/wrangler.toml:2,28`, [Tamagui Vite
guide](https://tamagui.dev/docs/guides/vite), [react-native-web +
Vite](https://dev.to/dannyhw/react-native-web-with-vite-1jg5).

---

### 2. Web-only libs — surprise inventory result

**Status: NONE of the four "hard-incompatible" libs are currently
imported by the orchestrator.**

All four live in `packages/ai-elements/` (a shared component library)
but the orchestrator's actual ai-elements consumers (ChatThread,
MessageInput, AwaitingBubble, QuickPromptInput) don't pull them. They
are exported, dormant.

| Lib | ai-elements file | Orchestrator usage | Decision (P2 spec) |
|-----|------------------|--------------------|--------------------|
| `@xyflow/react` | `canvas.tsx`, `node.tsx`, `edge.tsx`, `panel.tsx`, `controls.tsx`, `toolbar.tsx` | 0 call sites | **Feature-gate web-only** (Platform.OS check); list-view fallback on native (~1 day if/when adopted). Skia port deferred. |
| `react-jsx-parser` | `jsx-preview.tsx` (242 LOC, streaming JSX runtime) | 0 call sites | **Feature-gate web-only** (only option — no RN equivalent, RN has no `eval`); markdown/code-block fallback on native. |
| `@rive-app/react-webgl2` | `persona.tsx` (277 LOC, animated avatars w/ state machines) | 0 call sites | **Replace with `@rive-app/react-native`** (~1-2 weeks port at adoption time); falls back to static image until ported. |
| `media-chrome` | `audio-player.tsx` (186 LOC, custom-elements wrapper) | 0 call sites | **Replace with platform-conditional wrapper** (HTML5 `<audio>` on web + `react-native-video` on native). |

**Per user direction** (decision Q2, "decide replace-vs-feature-gate
per lib in P2 spec"), the P2 spec will codify these decisions even
though the libs are dormant — this front-loads the work for P3 spec
writing.

**Defensive nudge** (NOT in user-selected option but worth flagging in
P2 spec): consider adding a lint rule blocking new orchestrator imports
of these four packages until P3 spec lands their feature gates. Cost:
~1 hour. Prevents accidental adoption between P2 and P3.

**[uncertain]** xyflow Skia port maturity — no reference
implementations found in 2026; if workflow visualization becomes native
v1 scope, this needs a P3 spike.

**[uncertain]** Rive RN SDK production stability with rapid state
machine input changes (listening→thinking→speaking transitions) — needs
P3 device validation.

**Sources:** `packages/ai-elements/src/components/canvas.tsx`,
`node.tsx`, `edge.tsx`, `jsx-preview.tsx`, `persona.tsx`,
`audio-player.tsx`. Parent research
`planning/research/2026-04-23-react-native-pivot-evaluation.md` §3.2
matrix.

---

### 3. Vite alias + CF Worker CI guard extension

**Status: trivial — one Vite alias line, one regex change.**

**Worker entry (already protected):** `apps/orchestrator/src/server.ts`
(269 LOC) per `wrangler.toml:2`. Imports Drizzle, PartyServer, DO
classes, API app, auth, DB schema only. Zero `@tamagui` / `react-native`
/ `react-native-web` bytes in current build artifact
`apps/orchestrator/dist/duraclaw_orchestrator/index.js` (verified by
grep).

**Current guard:** `scripts/check-worker-tamagui-leak.sh:11`

```bash
LEAKS=$(grep -rE "from ['\"]@tamagui" $TARGET_GLOB 2>/dev/null || true)
```

Wired into `apps/orchestrator/package.json:10` as part of `pnpm
typecheck` (runs in CI + local pre-commit).

**Required change for P2** (one-regex extension):

```bash
# Before
LEAKS=$(grep -rE "from ['\"]@tamagui" $TARGET_GLOB 2>/dev/null || true)
# After (P2)
LEAKS=$(grep -rE "from ['\"](@tamagui|react-native-web|react-native)" $TARGET_GLOB 2>/dev/null || true)
```

Update the file's leading comment from "P1a guard" to "P1a + P2 guard"
documenting the three banned module families and rationale (RNW is a
client-only runtime; bundling into CF Worker bloats cold-start).

**No conditional Vite alias logic needed for P2.** The Cloudflare Vite
plugin auto-detects the Worker entry via `wrangler.toml:main`, and the
source-level guard catches direct `react-native[-web]` imports in
`server*.ts` regardless of alias resolution. If a future phase
introduces a separate SSR build target distinct from the Worker, this
re-evaluates.

**[uncertain]** Whether `@tamagui/react-native-web-lite` needs a
separate ban entry. Probably not — it's a Tamagui internal already
caught by `@tamagui` prefix.

**Sources:** `scripts/check-worker-tamagui-leak.sh:1-18`,
`apps/orchestrator/package.json:10`,
`apps/orchestrator/wrangler.toml:2,28`,
`apps/orchestrator/src/server.ts:1-15`.

---

### 4. Expo/Metro as alternative bundler — user decision: install in P2

**Status: deep-dive agent recommended deferring to P3; user override
keeps Metro in P2 as a smoke-bundle proof.**

Rationale for keeping in P2 (per user): the GH#131 issue body explicitly
lists Metro install as P2 scope, and shipping a "metro can bundle the
same source" smoke test now closes the §10.5 gate question ("does
RNW-on-Vite ship clean and is the native target *capable*?") with
evidence rather than promise. P3 (GH#132) then activates the bundle for
real native builds.

**Minimum P2 Metro scope** (~1-1.5 days incremental):

1. **`apps/orchestrator/metro.config.js`** (~80 LOC) — pnpm-monorepo
   recipe with:
   ```js
   resolver: {
     unstable_enablePackageExports: true,
   },
   watchFolders: [path.resolve(__dirname, '../../node_modules')],
   ```

2. **`apps/orchestrator/src/entry-rn.tsx`** (5-10 LOC) — RNW entry
   branched from `entry-client.tsx`, swaps `ReactDOM.createRoot` →
   `AppRegistry.registerComponent` + `AppRegistry.runApplication`.

3. **CI smoke test** — new script
   `scripts/check-metro-bundle.sh`: runs `metro build --platform web` (or
   the equivalent Expo CLI), exits 0 if bundle emits, fails on resolver
   error or RNW import miss. Wired into `pnpm typecheck` or a separate
   `pnpm verify:metro` pulled in by the CI workflow.

4. **`package.json` deps**: `expo`, `@expo/metro-runtime`, `metro` (pin
   versions to GH#132 P3 target, Expo SDK 54).

**No shipped artifact.** The Metro web bundle is built in CI for
verification only; production web continues shipping the Vite bundle.
Metro becomes user-facing only in P3 (native).

**Cohabitation with Vite is clean:**
- Vite owns `apps/orchestrator/src/entry-client.tsx` → CF Worker client
- Metro owns `apps/orchestrator/src/entry-rn.tsx` → RNW (P2 smoke) +
  iOS/Android (P3)
- `apps/mobile` (Capacitor) untouched, ships pre-Tamagui bundle until
  manual OTA per GH#130

**[uncertain]** Metro × pnpm hoisting fragility — `watchFolders` +
`enablePackageExports` recipe is documented but version-sensitive;
pinning Metro to a known-good version is required, otherwise
intermittent resolver failures.

**[uncertain]** Whether Expo SDK 54 install pulls in iOS/Android
toolchain bits we don't want yet. Mitigation: install only the metro
subset (`expo`, `@expo/metro-runtime`, `metro`) and avoid the
device-runtime packages until P3.

**Sources:** GH#131 issue body, GH#132 P3 issue body, parent research
§10.4, `apps/orchestrator/package.json`, `pnpm-workspace.yaml`,
[Expo SDK 54 metro
recipe](https://docs.expo.dev/guides/monorepos/), [Metro pnpm
issues](https://github.com/facebook/metro/issues).

---

### 5. TanStack Router stays — verified clean

**Status: confirmed. Zero changes for P2.**

The codebase is already P3-ready for the router layer:

- **Router setup**: `apps/orchestrator/src/router.tsx` (505 bytes,
  `createRouter()` singleton) + auto-generated
  `routeTree.gen.ts`. Root route at `routes/__root.tsx` with `<Outlet />`.
- **8 routes** total — all use `createFileRoute()` with TanStack
  Router's file-based convention.
- **Zero `<Link>` usage** (grep across `apps/orchestrator/src/`) — all
  navigation is 100% programmatic via `useNavigate()` hook (e.g.
  `nav-sessions.tsx:262,371`).
- **Zero `<a href>` tags** (grep result: 0).
- **DOM API touches** (acceptable):
  - `entry-client.tsx:45` — `document.getElementById('root')` (mount
    point, RNW transparent)
  - `auth-redirect.ts:14` — `window.location.href` for auth expiry
    (hard reload, RNW-compatible per parent research §10.1)
- **`<Outlet />` usage** clean: nested in
  ThemeProvider→TamaguiProvider→NowProvider chain. No DOM-specific
  event handlers on routing components. AuthenticatedLayout's
  `<Outlet />` has fallback via `children ?? <Outlet />`.

**Parent research §11.5 verdict holds exactly:**

> P2 (RNW universal rendering on web): TanStack Router stays. RNW is a
> primitive-library swap, not a router swap.

**P3 path is already mapped** (parent §11.4):
- Default option (A): TanStack web + React Navigation native (two
  trees, screens shared)
- Optional (B): full Expo Router migration (1-2 days mechanical
  rewrite of `createFileRoute()` → Expo file conventions)

**No defensive nudges needed in P2.** The codebase is already
future-proof for both options.

**[uncertain]** `window.location.href` for auth expiry under RNW: not
yet tested post-PR #127. Impact is low — auth expiry is a hard-failure
case; both web and native prefer a full reload anyway. Add to VP as a
manual smoke check.

**Sources:** `apps/orchestrator/src/router.tsx`,
`apps/orchestrator/src/routes/__root.tsx`,
`apps/orchestrator/src/routes/_authenticated/route.tsx`,
`apps/orchestrator/src/entry-client.tsx:45`,
`apps/orchestrator/src/lib/auth-redirect.ts:14`, parent research
§3.2 + §11.4 + §11.5.

## Comparison

Not applicable — this was a feasibility/integration study, not a
library-vs-library evaluation.

## Recommendations (for P2 spec writing)

The P2 spec should be structured as **5 phases** mapping to the items
above:

### Phase A — Vite + RNW config

- Add `react-native-web` to `apps/orchestrator/package.json`
  dependencies
- Add 3 vite.config.ts blocks: `resolve.alias` extension, new `ssr`
  block, new `optimizeDeps` block
- Optional: switch to `@tamagui/react-native-web-lite` if final bundle
  size is a gate
- **Acceptance**: `pnpm build` emits clean Worker + client bundles;
  client bundle size delta documented; Worker bundle delta < 1 KB

### Phase B — CI guard extension

- One-regex change in `scripts/check-worker-tamagui-leak.sh:11` to
  catch `react-native` and `react-native-web` imports
- Update file header comment to document P1a + P2 history
- **Acceptance**: deliberate test import to `server.ts` triggers guard
  failure; revert restores green

### Phase C — Tamagui×RNW CSS smoke check (Verification Plan, not implementation)

- Per user decision Q3: post-merge VP step inspects
  `dist/client/assets/*.css` for hashed atomic classes (`_alignItems-*`,
  `_dsp-flex`, etc.)
- **Acceptance**: atomic CSS present + no visual regression on existing
  Tamagui-converted screens

### Phase D — Web-only lib decisions documented

- P2 spec codifies replace-vs-feature-gate per lib (per user decision
  Q2):
  - xyflow: feature-gate web-only
  - react-jsx-parser: feature-gate web-only
  - Rive: replace with `@rive-app/react-native` (P3 work)
  - media-chrome: replace with platform-conditional wrapper (P3 work)
- Optional defensive nudge: add eslint rule blocking new orchestrator
  imports of these four packages until P3 spec lands the gates
- **Acceptance**: P2 spec section enumerates per-lib decision; no code
  changes required (libs are dormant in orchestrator)

### Phase E — Metro/Expo smoke bundle

- Install minimal Expo subset: `expo`, `@expo/metro-runtime`, `metro`
  (no device runtime)
- Create `apps/orchestrator/metro.config.js` (~80 LOC)
- Create `apps/orchestrator/src/entry-rn.tsx` (5-10 LOC, RNW
  AppRegistry entry)
- Create `scripts/check-metro-bundle.sh` smoke test, wire into
  `pnpm typecheck` or new `pnpm verify:metro`
- **Acceptance**: CI step `metro build --platform web` exits 0; bundle
  emits to a verified path; no shipped artifact

### Plus — TanStack Router

- **No spec phase needed.** Confirm in spec preamble that router layer
  is unchanged. Add VP smoke check on auth-expiry hard-reload path.

## Open Questions

- **CSS extraction post-merge**: need real evidence on the Tamagui ×
  RNW × Vite atomic-CSS interaction. VP smoke check will surface this.
  If extraction breaks, fallback to runtime mode (`extract: false`)
  costs perf; replan needed.

- **Worker bundle-size gate threshold**: parent research suggests "<30%
  Worker growth post-RNW-add" — P2 spec needs a concrete kilobyte
  threshold (e.g. < 5 KB delta) since current Worker bundle is ~2.7 MB.

- **Expo SDK 54 metro-only install footprint**: requires verification
  that `expo + metro + @expo/metro-runtime` alone doesn't drag
  Xcode/Android Studio integration into devDependencies. P3 will exercise
  the full SDK.

## Next Steps

1. **Hand off to P1 (interview phase)** — surface the open questions
   above to user for any final scoping calls before spec writing.

2. **P2 spec writing** — follow the 5-phase structure above. Spec
   template at `planning/spec-templates/feature.md`.

3. **Coordinate with GH#130 (P1c verification)** — P2 implementation
   should not start until P1c dogfood window closes cleanly. Spec
   writing for P2 can proceed in parallel with P1c.

4. **Future: P3 spec (GH#132)** — will inherit the four lib decisions
   from this P2 spec and activate the Metro bundle for native targets.
