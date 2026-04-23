# React Native pivot evaluation — `apps/mobile`

Date: 2026-04-23
Mode: research · Workflow: RE-ffbb-0423
Classification: library/tech evaluation + feasibility study
Status: decision-support doc, not a spec

## TL;DR

The "Capacitor is janky" read is correct. The friction is five
well-characterised pain points (mostly transport/lifecycle) and #70
closes the biggest category without a framework swap.

**Two recalibrations changed the recommendation across successive passes
of this doc — see §9:**

1. **2026 RN ecosystem is further along than I scored it.** Tamagui
   (optimizing compiler, 100% RN parity, single component tree for web +
   native) or Gluestack UI v3 + NativeWind collapse the "19 Radix
   primitives to rewrite" cost to a library swap. Zeego v3 covers the
   entire menu/dropdown/context-menu family with native iOS/Android
   menus behind a unified Radix-shaped API.
2. **This repo's shipping velocity is AI-coding speed, not human-dev
   speed.** 443 commits in 6 days (Apr 17–22). Features of roughly the
   scope of #68 (public/private visibility with full-collab shared
   sessions, touching auth, D1, DO state, UI, Yjs) go research → spec
   → impl → merge in ~1 day. Applying human-dev months to a repo that
   ships in days was the wrong reference frame.

**Revised envelope:** at this repo's cadence, an RN pivot scoped as
Tamagui + Zeego + Maestro-backed AI-eval parity loop + parallel impl-
agents is a **2–3 week wall-clock project**, not 6–10 weeks and
definitely not 3–6 months. That is comparable to #70's 1–2 weeks and
delivers dramatically more — iOS unlock, entire WebView bug class
eliminated, single-codebase web+native via Tamagui's compiler.

**Recommendation (revised):** **ship #70 AND start the RN spike in
parallel.**

- #70 protects the shipping Android app during the pivot — 1 week.
- In parallel, a **3-day de-risking spike** on the actually-hard
  constraints: `better-auth-react-native` adapter, op-sqlite vs
  expo-sqlite under our workload, `@xyflow/react` → Skia port or
  feature-gate, `react-jsx-parser` RN interpreter or scope-out, Rive
  RN SDK port. If the spike lands clean → commit to the full pivot in
  the following ~2 weeks. If a blocker emerges → fall back to #70 +
  Option C (RN shell + WebView).
- **Option C loses most of its appeal** under this recalibration —
  Tamagui's one-codebase property already gives us the "native feel
  with shared UI code" that C was approximating, without the WebView
  bridge tax.
- **Option D (iterative) is also less attractive** at AI-velocity —
  the per-iteration setup cost dominates when each screen takes
  hours, so a batched full migration is cheaper than drip-feed.

Hard constraints that remain regardless of velocity and still gate the
decision: `better-auth-react-native` doesn't exist — we own that and
its auth-flow testing. `expo-sqlite` has documented production bugs
(expo#37169). The Expo-Go-vs-production WebSocket mismatch is a known
foot-gun. All three must pass the de-risking spike before committing.

---

## 1. Framing

The ask is to pivot `apps/mobile` from Capacitor (WebView + JS bridge) to
React Native (native views + JS runtime) for "real native feel." Before
answering *how*, this doc answers two prior questions:

1. **What does "janky" concretely mean in this codebase?** — so we know
   which of RN's strengths are actually load-bearing.
2. **What is the sunk cost of Capacitor and the sunk LOC of the shared
   web bundle?** — so we know the true rewrite bill.

The shared web bundle (`apps/orchestrator`) is the real subject. The
mobile shell today is a 1-file Capacitor config wrapping it. Any pivot
cost is dominated by how much of that bundle survives the move.

---

## 2. What hurts today (evidence-based pain inventory)

Five distinct pain categories, ordered by how much they actually bite:

### 2.1 Transport / lifecycle (SEVERE — #40, #49, #69, #70, silent-closures)

- **JS timer throttling under Doze / App Standby** — PartySocket's
  heartbeat stalls; server times out; WebView doesn't learn until
  `visibilitychange`. (issue #70 body)
- **No link-layer network-change signal** — Wi-Fi↔LTE handoff eats
  frames; `navigator.onLine` is a lagging indicator vs. Android's
  `ConnectivityManager.NetworkCallback`. (issue #70)
- **Sockets die on WebView reload** — any OTA swap or crash recovery
  drops live state. (issue #70)
- **Session socket perma-reconnect loop after background cycle** — user-
  stream and collab recover, session doesn't (issue #49).
- **WebView JS freezes while backgrounded** — streaming deltas halt
  instantly when app backgrounds (issue #40).
- **Silent session closures** — CF Workers idle-TCP kill at ~70s with no
  app-level heartbeat; recovery clears `active_callback_token`; runner
  exits on next 4401 (`planning/research/2026-04-22-silent-session-closures-post-ttl.md`).

**Status:** Spec #70 (approved) fixes the first three by hosting sockets
in an Android bound Service with OkHttp and plumbing network callbacks
back to `connection-manager`. It also restores protocol-level keepalive.
This is a Capacitor plugin, not a framework swap. Expected to close
#40, #49, #69, and silent-closures in one landing.

**RN would fix these for free** because it runs sockets in the JS
runtime's native thread, not a WebView. But so does #70.

### 2.2 React concurrent-scheduler × WebView interaction (patch in place)

- `apps/orchestrator/src/lib/react-offscreen-patch.ts:1-51` monkey-
  patches `CSSStyleDeclaration.setProperty` to drop
  `display: none !important`. React 19's Offscreen scheduler gets
  `baseLanes` stuck on Android WebView, leaving routes invisible despite
  TanStack Router reporting success. The patch works but is a red flag
  that WebView's event loop is slightly out of sync with React 19's
  concurrent assumptions.

**RN implication:** RN has its own React reconciler integration (Fabric).
The same bug may or may not reappear. Not free; not worse.

### 2.3 OTA cache coherence (patch in place)

- `apps/orchestrator/src/lib/mobile-updater.ts` has to call
  `CapacitorUpdater.next()` + `.reload()` explicitly after `.set()`
  because the WebView doesn't reliably pick up the new bundle. Worked
  around.

**RN implication:** CodePush / Expo EAS Update have their own coherence
story; it's different, not necessarily better.

### 2.4 SQLite connection lifecycle (patch in place)

- `persistence-capacitor.ts:16-29` checks `isConnection()` →
  `retrieveConnection()` → else `createConnection()` to handle hot-
  reload leaks. Minor.

**RN implication:** `expo-sqlite` has documented production bugs with
suspense/navigation (GitHub expo#37169). Not a slam-dunk win.

### 2.5 Platform integration (no current pain)

No open bugs mention status bar, safe area, keyboard avoidance,
haptics, splash, or native transitions. Capacitor has plugins for all
of these; the repo hasn't pulled them because the UI hasn't needed them.
If the "janky" complaint is secretly about missing chrome polish, that's
addressable in Capacitor without pivoting.

---

## 3. The surface to replace (what a full RN pivot actually costs)

### 3.1 UI layer (`apps/orchestrator`)

- **~15,500 LOC** across 16 route files (1,779 LOC), 32 screen-level
  components, 2,489 LOC of shadcn-style UI primitives in `components/ui/`,
  and 11,111 LOC across `lib/` and `hooks/`.
- **Styling:** Tailwind CSS 4.2.2 via `@tailwindcss/vite`. Web-only. RN
  equivalent is Nativewind, which ports ~80% of Tailwind but not layout
  edge cases (grid, subgrid, container queries). Expect per-screen
  rework.
- **Radix UI: 19 families** (AlertDialog, Avatar, Checkbox, Collapsible,
  Dialog, Dropdown, Label, Popover, RadioGroup, ScrollArea, Select,
  Separator, Slot, Switch, Tabs, Tooltip, Direction, Accordion,
  HoverCard). All portal-based; none have RN equivalents. Every
  modal/popover/dropdown/tooltip becomes a hand-rolled RN Modal +
  animation + gesture, or a port to `@gorhom/bottom-sheet` +
  `react-native-menu`.

### 3.2 Library compatibility matrix

| Library | RN path | Cost |
|---|---|---|
| `yjs`, `y-partyserver/provider` | ✅ portable | none |
| `partysocket` | ✅ RN has native WS | none |
| `@tanstack/db`, `@tanstack/query` | ✅ portable | none |
| `@tanstack/react-router` | ✅ portable (not Start) | router outlets need RN navigation shim |
| `@tanstack/browser-db-sqlite-persistence` | ❌ web-only | write RN SQLite adapter (~200 LOC) |
| `react-markdown`, `shiki`, `streamdown`, `mermaid` | ✅ portable | need RN renderers (`react-native-markdown-display`) |
| `lucide-react` | ✅ `lucide-react-native` exists | swap |
| `better-auth` cookies | ⚠️ needs RN adapter | `better-auth-react-native` does not exist first-party |
| **`@dnd-kit/*`** (kanban) | ❌ web-only | rewrite kanban on Gesture Handler + Reanimated (~800 LOC) |
| **`@xyflow/react`** (graphs) | ❌ web-only | wait for `@xyflow/native` or rebuild on Skia |
| **`media-chrome`**, **`@rive-app/react-webgl2`** | ❌ web-only | Rive has a separate RN SDK with different API |
| **`ansi-to-react`**, **`react-jsx-parser`** | ❌ web-only | custom implementations |
| **`cmdk`** (command palette) | ❌ web-only | rewrite on RN Modal |
| `embla-carousel-react`, `use-stick-to-bottom`, `sonner`, `react-top-loading-bar` | ⚠️ alternatives exist | swap each (1-2 days each) |
| `react-dom` (entry), TanStack Start (if adopted later) | ❌ incompatible | RN entry is AppRegistry |

Rough split: **~60% portable** (data, realtime, business logic),
**~25% needs alternative** (UI primitives, small libs), **~15% no viable
path** (WebGL2, runtime JSX parsing, ANSI rendering, xyflow, Rive web).

### 3.3 Capacitor-side seams (what goes away vs. re-written in RN)

From the surface inventory: **9 native plugins, 13 runtime seams, ~25
`isNative()` decision points in 12 files.** Every seam has an RN-native
equivalent:

- `@capacitor-community/sqlite` → `op-sqlite` (JSI, fastest) or
  `expo-sqlite/next` (simplest; has known prod bugs)
- `@capacitor/push-notifications` → `@react-native-firebase/messaging`
- `@capacitor/app` + `@capacitor/network` → `AppState` + `@react-native-community/netinfo`
- `better-auth-capacitor` → new `better-auth-react-native` adapter (must write)
- `@capgo/capacitor-updater` → Expo EAS Update or `react-native-code-push` (Microsoft has deprecated, community fork is current)
- `@capacitor/preferences` → `react-native-mmkv` (faster than AsyncStorage)

None of these are blockers; they're all line-items in a budget.

### 3.4 Effort estimate

The Explore agent's "2–3 weeks senior" estimate is **shell bootstrap
only** — RN project, Android build, plugin swaps, auth adapter, SQLite
adapter, WS adapter. That's real work but tractable.

The UI rewrite is where the time goes: **3–6 months of focused senior
effort** to get to parity with today's feature set, assuming:

- Kanban rebuilt on Gesture Handler + Reanimated (2-3 weeks)
- Command palette + dialogs + dropdowns + tooltips rebuilt on RN primitives (3-4 weeks)
- Markdown/code rendering chain rebuilt on RN text + Skia for syntax highlighting (2-3 weeks)
- Diagram viewing (mermaid/xyflow) either scoped out or rebuilt on Skia (2-4 weeks)
- Rive/media-chrome either scoped out or ported to Rive RN SDK (1-2 weeks)
- Tailwind → Nativewind per-screen audit (3-4 weeks)
- Auth adapter + session token plumbing (1 week)
- Parity QA + two app stores (2-3 weeks)

And this assumes we keep the web build alive in parallel — otherwise
every orchestrator feature ships twice during the transition.

---

## 4. Option matrix

### Option A — Stay on Capacitor, ship #70 (and maybe Foreground Service for #40)

- **Fixes:** transport (Doze, LTE handoff, WebView reload, keepalive),
  silent closures, #40, #49, #69.
- **Doesn't fix:** React Offscreen scheduler interaction (already
  patched), OTA cache coherence (already patched), the general "feels
  like a webpage" feel if that's what the user means.
- **Cost:** ~500 LOC Kotlin + JS shim, spec is already written and
  approved. 1-2 weeks.
- **Risk:** low. Additive. Reversible.

### Option B — Full React Native rewrite (Expo SDK)

- **Fixes:** every transport/lifecycle pain for free. True native
  chrome, gestures, keyboard, transitions, haptics. Platform-idiomatic
  feel.
- **Cost:** 3-6 months senior effort for UI parity; ~15.5k LOC rewrite;
  19 Radix primitives to replace; drop or rebuild Rive, xyflow,
  media-chrome, cmdk, ansi-to-react, react-jsx-parser; Tailwind →
  Nativewind audit; dual-ship orchestrator features during transition.
- **Risk:** high. `expo-sqlite` has production bugs (expo#37169);
  WebSocket prod-vs-Expo-Go mismatch is a known foot-gun. No
  `better-auth-react-native` adapter exists — we'd own that. Every
  component change during rewrite has to happen twice (web + native)
  or the web build stagnates.
- **Upside:** eliminates entire categories of WebView bugs; unlocks
  iOS (today's mobile is Android-only); native push UX; background
  reliability without Service gymnastics.

### Option C — Hybrid: RN shell with WebView interior

- **Shape:** RN owns the window, navigation stack, tab bar, status/safe
  area, push handling, lifecycle, and deep-links. The session and
  kanban views are `react-native-webview` panels loading the existing
  React bundle. Native WS plugin (from Option A) keeps sockets in the
  RN thread; WebView consumes over `postMessage`.
- **Fixes:** feel of chrome (~70% of "real native"), native transitions,
  native push, reliable background transport, iOS unlock path.
- **Doesn't fix:** the UI inside the WebView is still React-in-WebView.
- **Cost:** ~4-6 weeks senior — RN project bootstrap, bridge the
  existing WS/auth plumbing through RN instead of Capacitor, wrap
  routes in RN screens + WebView. No UI rewrite.
- **Risk:** medium. `react-native-webview` has its own quirks; message
  passing between RN and WebView adds one indirection to every native
  bridge call. But: reversible. If the experiment fails, you're back
  to Capacitor with a learning bill.
- **Cf.** this is essentially what Shopify did for their first-gen
  mobile app; Discord did the opposite (went full RN, took ~2 years).

### Option D — Iterative native surfaces (RN app + targeted screens)

- **Shape:** Start a new RN app that shares business logic packages
  (`shared-types`, parts of `@tanstack/db` adapters) but rebuilds only
  the **most-used** surfaces natively — session chat stream, command
  palette, sidebar. Leaves low-traffic/visually-complex surfaces
  (kanban, diagrams, admin) in the WebView via Option-C-style embed.
  Over months, migrate more surfaces natively as value warrants.
- **Cost:** ~2 months to first shippable native session view; grows
  from there.
- **Risk:** medium. Scope discipline required. Dual UI stack forever
  if we stop migrating.

---

## 5. Cross-cutting risks to call out

- **No `better-auth-react-native`** exists. We'd own it. That's a
  nontrivial surface — token lifecycle, refresh, 4401 handling, deep
  link recovery — and we've already hit bugs in its Capacitor sibling.
- **Dual-shipping.** While a rewrite is in flight, every orchestrator
  feature (chains, visibility, voice, admin) ships twice — or the
  native app falls behind and re-invites "janky" via staleness.
- **Expo prod-vs-dev drift.** Documented: WS works in Expo Go, fails in
  production builds (dev.to article) and `expo-sqlite` has suspense
  bugs (expo#37169). These are solved with effort, not free.
- **Android-first constraint today** means the pivot-to-RN carrot
  (iOS unlock) is real, but we'd still need to invest in a signing
  pipeline, App Store compliance, and iOS-specific QA that doesn't
  exist yet.
- **New Architecture (Fabric/TurboModules)** is stable in 2026, which
  removes a historical argument against RN. But library ecosystem lag
  still applies for the long tail (some plugins haven't migrated).

---

## 6. Recommendation

**Ship #70 first.** It is already specced, approved, and addresses the
transport + lifecycle pain that accounts for the majority of open
mobile bugs. Cost is 1-2 weeks; it moves the needle on exactly the
symptoms the pivot is being proposed to solve.

**Then measure.** After #70 lands, run a week of dogfood sessions on
the signed APK with adb logcat capture. Three concrete questions:

1. Do `agent:*` / `user-stream` / `collab:*` survive phone-locked
   sessions? (expected: yes)
2. Does the session-refresh "missed frames" artifact stop reproducing?
   (expected: yes)
3. After fixing transport, does "janky" still describe the app? If yes,
   is the residual about (a) gesture/scroll feel, (b) native chrome
   (status bar, keyboard, transitions), or (c) specific screens
   (kanban, session view)?

**Only then decide:**

- (a) is fixable with CSS + Reanimated-equivalent web libs and maybe
  dropping the react-offscreen patch by pinning React 19.1+.
- (b) is the strongest argument for **Option C (RN shell + WebView)** —
  it buys most of the "feel" upgrade for ~20% of the rewrite cost and
  is reversible.
- (c) is the strongest argument for **Option D (iterative native
  surfaces)** — rewrite the screens that matter, leave the rest.

**Option B (full RN rewrite) should not be the first move.** The cost
is a 3-6 month rewrite of a UI that is actively evolving (voice, chains,
visibility) and a dependency tree that is ~15% incompatible with RN.
That bill is only worth paying if #70 and follow-ups fail to close the
"janky" complaint — and the evidence today says they will.

### Decision rule for the user

If the ask is *"make the mobile app feel native"* → Option C, after #70.

If the ask is *"unlock iOS + native experience + multi-year mobile
investment"* → Option B or D, **after** a 1-month scoped spike to
de-risk `better-auth-react-native`, `op-sqlite` or `expo-sqlite` under
our traffic, and RN build of the 3 highest-value screens.

If the ask is *"stop bugs #40 / #49 / #69"* → Option A. Pivot is not
the right lever.

---

## 7. Open questions to bring to planning

1. What specifically does "real native feel" mean to the user? Transport
   reliability, chrome polish, gesture feel, or all three? Answer
   changes the recommendation.
2. Is iOS in scope on any timeline? If yes, that reshapes ROI — all
   options cost less per-platform when both exist.
3. Are we willing to drop features during a rewrite (Rive animations,
   xyflow diagrams, embedded media) to ship faster? Or is parity
   mandatory?
4. Who owns `better-auth-react-native` if we write it? Upstream it, or
   fork?
5. What's the acceptable freeze window for web orchestrator feature
   work during a rewrite?

---

## 8. Cited evidence

In-repo:

- `apps/mobile/package.json` — 9 Capacitor plugins
- `apps/mobile/capacitor.config.ts` — logging behaviour, Capgo config
- `apps/mobile/scripts/build-android.sh`, `sign-android.sh`
- `apps/orchestrator/src/lib/platform.ts:33-95` — `isNative()`, fetch interceptor, WS host override
- `apps/orchestrator/src/lib/react-offscreen-patch.ts:1-51` — WebView × React 19 scheduler patch
- `apps/orchestrator/src/lib/mobile-updater.ts:13-120` — Capgo + APK flow
- `apps/orchestrator/src/db/db-instance.ts:35-44`, `apps/orchestrator/src/db/persistence-capacitor.ts` — SQLite backend swap
- `apps/orchestrator/src/lib/connection-manager/lifecycle.ts:69-113` — Capacitor App + Network listeners
- `apps/orchestrator/src/hooks/use-push-subscription*.ts` — Web Push vs FCM
- `apps/orchestrator/src/hooks/use-user-stream.ts:100-108`, `features/agent-orch/use-coding-agent.ts:313-334` — WS bearer token plumbing
- `apps/orchestrator/src/lib/auth-client.ts:13-23`, `src/lib/auth.ts` — better-auth capacitor wrapping

Issues / specs:

- #40 — WebView JS freezes while backgrounded
- #49 — session WS perma-reconnect loop after background cycle
- #69 — mobile refresh reveals missed frames (closed by PR #71)
- #70 — native WebSocket Capacitor plugin (approved, not merged)
- `planning/specs/70-native-websocket-capacitor-plugin.md`
- `planning/research/2026-04-22-silent-session-closures-post-ttl.md`
- `planning/research/2026-04-22-native-websocket-capacitor-plugin.md`

External (2026):

- [Capacitor vs React Native (2025)](https://nextnative.dev/blog/capacitor-vs-react-native)
- [Cross-Platform App 2026 — Flutter, React Native, or Capacitor](https://thedebuggersitsolutions.com/blog/cross-platform-app-2026-flutter-react-native-capacitor)
- [React Native vs Expo vs Capacitor 2026 — PkgPulse](https://www.pkgpulse.com/blog/react-native-vs-expo-vs-capacitor-cross-platform-mobile-2026)
- [WebSocket Connection Issue: Works in Expo Go but Fails in Production (DEV)](https://dev.to/lean_evolution_8c35e0b3d4/websocket-connection-issue-works-in-expo-go-but-fails-in-production-28ne)
- [expo/expo#37169 — SQLite works on dev but has suspense/navigation bugs in production](https://github.com/expo/expo/issues/37169)
- [Modern SQLite for React Native apps (Expo blog)](https://expo.dev/blog/modern-sqlite-for-react-native-apps)
- [expo-sqlite (npm)](https://www.npmjs.com/package/expo-sqlite)
- [Tamagui — 100% parity on React Native, optimizing compiler](https://github.com/tamagui/tamagui)
- [Gluestack UI v3 — unstyled primitives + NativeWind](https://gluestack.io/ui/docs/home/performance/benchmarks)
- [Zeego — native menus for React (Native) on Radix primitives](https://zeego.dev/)
- [Maestro — YAML-driven E2E for RN (no native build)](https://maestro.dev/insights/best-react-native-testing-frameworks)
- [Panto AI — React Native automated testing platform 2026](https://www.getpanto.ai/products/react-native-automated-testing)

---

## 9. Addendum (2026-04-23, mid-session) — two corrections that flipped the recommendation

This doc was written in passes. Two reader pushbacks after the first
draft exposed wrong reference frames. Keeping both corrections visible
so the reasoning trail is auditable.

### 9.1 Correction #1 — 2026 RN ecosystem was underscored

**What I got wrong on pass 1:** treated Radix × React Native as a
19-family hand-rewrite. In 2026 three libraries collapse that cost:

- **Tamagui** — optimizing compiler with 100% RN parity; compiles to
  atomic CSS on web + native Views on mobile; single component tree
  covers both platforms. Fully compatible with Fabric/TurboModules.
- **Gluestack UI v3** — unstyled accessible primitives styled via
  NativeWind; optimized for Expo SDK 54 + New Architecture.
- **Zeego v3** — native iOS/Android menus on mobile + pure Radix on
  web, unified API; covers DropdownMenu, ContextMenu, etc. directly.

The big Tamagui implication that I originally missed: **single
codebase eliminates dual-shipping.** Every orchestrator feature
(chains, voice, visibility) ships to web + RN from one component
change. That was ~30% of the original "don't pivot" cost argument.

**AI-eval parity loop** is also now mature: Maestro (YAML E2E, no
native build) + Panto / Autonoma AI test platforms + visual
regression on device-specific snapshots make "write parity spec →
AI-generate RN → eval harness verifies against web baseline"
tractable. Screen rewrites become codegen + eval, not typing.

### 9.2 Correction #2 — wrong velocity reference frame

**What I got wrong on pass 2 (after correction #1):** still quoted
human-dev timelines (6–10 weeks). This repo does not ship at
human-dev speed.

Observed cadence from `git log --since="14 days ago"`:

```
2026-04-17: 118 commits
2026-04-18:  69
2026-04-19:  41
2026-04-20:  69
2026-04-21:  70
2026-04-22:  59  (includes #68 full-collab visibility landing,
                  #69 hibernation fix, #70 spec approved, #58
                  chain StatusBar widget merged, #55 virtualization
                  shipped+reverted+re-approached)
```

**443 commits across 6 days.** Feature landings at roughly daily
cadence for issue-scale work like #68 (auth + D1 schema + DO state +
UI + Yjs). At this velocity, applying human weeks to parallel-
agent-capable work is the wrong unit.

### 9.3 Recalibrated RN pivot envelope at observed velocity

Work inventory, most items parallel-izable via impl-agents:

| Work unit | Human-weeks est. | At repo velocity |
|---|---|---|
| Tamagui/Gluestack decision + primitive migration scaffold | 2 weeks | **0.5–1 day** |
| `better-auth-react-native` adapter (bearer + secure-store wrap) | 1 week | **0.5–1 day** |
| SQLite adapter (op-sqlite or expo-sqlite) + TanStack DB persistence | 1 week | **0.5–1 day** |
| Lifecycle swap (Capacitor App/Network → AppState/NetInfo in connection-manager) | 3 days | **~0.5 day** |
| WS transport (RN has native WebSocket; drop Capacitor native WS layer) | 2 days | **~0.25 day** |
| Push (FCM via `@react-native-firebase/messaging`) | 3 days | **~0.5 day** |
| OTA (Expo EAS Update replacing Capgo + APK fallback) | 3 days | **~0.5 day** |
| Maestro + visual-regression + AI-codegen eval harness | 1 week | **1–2 days** |
| 16 routes × screen migration via codegen + parity eval (parallel agents) | 4 weeks | **2–3 days** |
| Hard-incompatible triage (xyflow → Skia/feature-gate, jsx-parser, Rive RN SDK, media-chrome → react-native-video) | 2 weeks | **2–3 days** |
| iOS signing + App Store admin (human-gated) | 1 week | **1–2 days** (mostly non-code) |
| Bug-hunt + polish on signed Android + iOS builds | 2 weeks | **2–3 days** |

**Wall-clock envelope at this repo's velocity: ~2–3 weeks for
Android parity, +~3–5 days for iOS submission.** Maybe 4 weeks all-in
including dogfood + polish loops.

That is **comparable to shipping #70** in wall-clock terms and
delivers categorically more value:

- entire WebView bug class eliminated (not patched)
- iOS unlocked
- single-codebase web + native via Tamagui's compiler
- no `react-offscreen-patch.ts` equivalent needed
- no bound-Service keepalive gymnastics needed
- new Architecture (Fabric/TurboModules) performance

### 9.4 Revised option ranking

- **A (ship #70 only)** — still the right *immediate* move, 3–7 days.
  Guards the shipping app during the pivot. But by itself, leaves
  iOS locked, the react-offscreen patch in place, and the WebView
  × React 19 scheduler interaction one bug away from reappearing.
- **B (full RN pivot)** — **promoted to primary recommendation.**
  At AI-velocity with Tamagui + Zeego + Maestro-eval, ~2–3 weeks
  wall clock on top of #70 ships the pivot. Gates: the de-risking
  spike in §9.5 must pass.
- **C (RN shell + WebView)** — **demoted.** Tamagui already gives
  the one-codebase-native-feel property that C approximated, so C
  now carries WebView bridge tax without a corresponding upside.
  Only revisit if the spike hits a blocker.
- **D (iterative native surfaces)** — **demoted.** Per-iteration
  scaffold cost dominates at AI-velocity — cheaper to batch the full
  migration than drip-feed screens. Revisit only if iOS timeline
  needs to slip well past the Android cutover.

### 9.5 De-risking spike (run before committing to §9.4 B)

Three concrete risks gate the full pivot. Answer them in a ~3-day
spike before locking the direction:

1. **`better-auth-react-native` adapter shape.** The Capacitor
   sibling (`better-auth-capacitor`) embeds bearer-token replay,
   token storage, and 4401 handling. RN adapter lives on
   `expo-secure-store` + `AsyncStorage`. Write the minimal adapter;
   verify sign-in + WS bearer + 4401 reconnect against the local
   orchestrator. **Go/no-go:** round-trip sign-in + reconnect works
   inside the spike, including after process kill.
2. **SQLite backend choice under our workload.** `expo-sqlite` has
   documented suspense/navigation bugs (expo#37169); `op-sqlite`
   (JSI) is faster but its TanStack DB persistence adapter doesn't
   exist yet. Port `persistence-capacitor.ts` to both; run a 10-min
   session with the branch/rewind flow. **Go/no-go:** at least one
   adapter keeps `messagesCollection` coherent through reconnect
   without data loss.
3. **`@xyflow/react`, `react-jsx-parser`, Rive, media-chrome.**
   xyflow has no mature RN peer — decide Skia port vs feature-gate
   on mobile. react-jsx-parser needs a bespoke RN JSX interpreter or
   scope-out. Rive has an RN SDK with different API — port is
   mechanical. media-chrome rebuilds on `react-native-video`.
   **Go/no-go:** each has an accepted fallback (feature-gate,
   rebuild, or Skia port with bounded cost).

If all three pass: full RN pivot in the next ~2 weeks.
If any blocks: fall back to #70 + Option C hybrid.

### 9.6 What this means for #70

**#70 still ships.** Even if the RN pivot starts immediately, the
Android Capacitor app is the shipping build for ~2–3 more weeks
while RN work lands. #70 keeps it stable during that window. If the
pivot lands clean, #70's Kotlin plugin code is discardable — that's
acceptable given its 1-week cost and the stability it buys during
the transition.
