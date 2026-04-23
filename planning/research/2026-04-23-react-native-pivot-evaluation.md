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

**Recommendation (final, superseding earlier passes — see §10):**
reframe the project as **universalizing the orchestrator web app
first, with native as the last step**, not a mobile pivot with web
side-effects. Four independently-shippable phases, each ~3–6 days at
repo velocity:

- **P1** — Tamagui adoption in orchestrator (web only). Measures the
  hypothesis that part of "janky" is actually web-perf + whole-tree
  re-render from hook-based themes/media. No mobile risk. Likely
  kills some of the work in the `react-offscreen-patch.ts`,
  chat-thread virtualization patches, and session-switch triple-
  render fixes we've been shipping all week.
- **P2** — universalize via **react-native-web**. The orchestrator
  web build keeps shipping unchanged (RNW → DOM is transparent).
  Component tree becomes universal. Dual-shipping disappears before
  a native build exists.
- **P3** — add native target (Expo SDK 54, iOS + Android). Capacitor
  seams swap out: auth → `better-auth-react-native`, SQLite →
  op-sqlite, push → `@react-native-firebase/messaging`, OTA → EAS
  Update, lifecycle → AppState/NetInfo. WS uses RN native WebSocket.
- **P4** — Maestro + AI-codegen parity eval harness, iOS App Store
  submission.

**Total: ~2–3 weeks wall clock at repo velocity.** Intermediate value
at each phase — no big-bang landing.

**Option C (RN shell + WebView) is fully demoted** — Tamagui + RNW
give the one-codebase universal property that C was approximating,
without the WebView bridge tax.

**#70 is now optional.** In the §10 frame, P1 + P2 don't touch the
shipping Capacitor Android app, and P3 replaces it with an RN app
that has native sockets from day one. Only keep #70 on the board as
Plan B if P1 or P2 blocks.

Remaining hard constraints (gate P3, not earlier): 
`better-auth-react-native` doesn't exist — we own it.
`expo-sqlite` has documented production bugs (expo#37169) so the
SQLite-adapter choice needs validation under our workload.
`@xyflow/react`, `react-jsx-parser`, Rive WebGL2, media-chrome all
need accepted RN fallbacks (feature-gate or rebuild).

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
- [Tamagui — Why a Compiler](https://tamagui.dev/docs/intro/why-a-compiler)
- [React Native for Web (Nicolas Gallagher, Meta)](https://necolas.github.io/react-native-web/)

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

---

## 10. Addendum — Tamagui compiler + react-native-web reframe

After drafting §9, direct reading of the Tamagui "Why a Compiler" doc
and the react-native-web docs exposed one more wrong mental model that
keeps inflating the cost: I was still thinking "Android Capacitor app"
vs "Android RN app" as two separate platforms. The right 2026 framing
is **one universal React Native application with DOM + iOS + Android
targets**, with Tamagui as the optimizing compiler and react-native-
web as the web target. That collapses the decision to a web app
upgrade that coincidentally unlocks native, rather than a mobile
rewrite that also has a web cost.

### 10.1 react-native-web — what it actually is

From the docs: *"an accessible implementation of React Native's
Components and APIs that is interoperable with React DOM."* Owned by
Nicolas Gallagher (Meta Platforms). Properties:

- `<View>`, `<Text>`, `<Image>`, `<ScrollView>`, `<Pressable>`,
  `Animated`, gestures, keyboard input all compile to standard DOM.
- *"Bundle only what you use"* — tree-shakeable, incremental adoption.
- *"Rely on scoped styles and automatic vendor-prefixing. Support
  RTL layouts."*
- *"React Native for Web powers web support in multi-platform React
  tools like Expo, React Native Elements, React Native Paper, and
  NativeBase"* — it's the de-facto web target for the Expo/RN stack
  in 2026.
- Production: Twitter/X web is the reference implementation
  (Gallagher built it there), plus Flipkart, Major League Soccer,
  Uber's marketing site, Expo docs.

**What this means for us:** the orchestrator doesn't need to be "a
web app + a RN app that share some code." It can be **one RN code
tree that compiles to DOM via RNW for the CF Worker and to native
for iOS/Android.** A single component tree. No bridge between
platforms, no parity diff to maintain.

### 10.2 Tamagui compiler — what problem it actually solves

From "Why a Compiler": the framing isn't *"Radix replacement"* (my
earlier reading). It's a direct response to **universal apps doing
CSS-in-JS with hook-based themes/media queries causing whole-tree
re-renders.** Concrete claims from the doc:

- *"extracts all types of styling syntax into atomic CSS"* — no
  runtime style object generation
- *"partial evaluation and hoisting… removes a high % of inline
  styles"* — build-time constant folding
- *"reduces tree depth, flattening expensive styled components into
  div or View… 30–50% of components typically flatten"* — less
  reconciliation, less DOM
- *"evaluates useMedia and useTheme hooks, turning logical
  expressions into media queries and CSS variables"* — no whole-tree
  re-render on theme toggle / viewport change
- Cited perf: without the compiler, *"medium-complexity pages will
  drop from 100% Lighthouse to half or worse."* With it: ~15+
  Lighthouse points recovered on their own marketing pages.
- On native: *"within 5% of hand-optimizing React Native code."*

### 10.3 Why this matters for problems we already have on web

Looking back at the orchestrator's own pain log through a Tamagui
lens, several existing issues look like textbook compiler wins we
never attributed to CSS-in-JS + hook-re-render cost:

- **`react-offscreen-patch.ts`** (`apps/orchestrator/src/lib/react-offscreen-patch.ts:1-51`) — patches the Android WebView × React 19 Offscreen
  scheduler. Under Tamagui, much of the offending re-render traffic
  disappears because theme/media aren't hook-driven anymore.
  May not eliminate the patch but shrinks its surface.
- **`perf(chat-thread): kill session-switch measurement triple-
  render (#55) (#56)`** (git log 2026-04-22) — triple-render on
  session switch is exactly the "whole-tree re-render" failure
  mode the compiler is designed to eliminate.
- **`perf(orchestrator): virtualize message list + kill re-render
  storms (#54)`** — same category.
- **`fix(chat): hide virtualized list until scrollHeight settles —
  kill mount jitter uniformly`** — mount-time reflow driven by
  cascading style computation; compiler flattening directly targets
  this.
- **`fix(chat): eliminate remount jitter via per-session
  virtualizer measurements cache`** — measurement cache is a
  downstream workaround for style recalc thrash.

None of these prove Tamagui would have prevented them, but the
pattern is consistent enough that adopting it is worth tracking as
**a web-perf play first, universal-native play second.** That is
the exact inverse of how I framed this doc in §1.

### 10.4 Revised path — universalize the web, then target native

Given §10.1 + §10.2 + §10.3, the pivot reshapes into **four
independently-shippable phases**, each with standalone value:

| Phase | Scope | Repo-velocity wall clock | Shippable on its own? |
|---|---|---|---|
| **P1. Tamagui adoption in orchestrator (web only)** | Port `components/ui/` + screens to Tamagui primitives behind a compatibility layer. Themes + media queries migrate. Drop hand-rolled CSS-in-JS. Keep Radix where Tamagui has no equivalent (alert/dialog stay on Radix for now). | **~3–5 days** with parallel impl-agents | ✅ Ships to existing web; measurable Lighthouse + re-render wins. No mobile risk. |
| **P2. Universal refactor via react-native-web** | Swap orchestrator entry to render against `react-native-web`. Add Expo/Metro bundler as alternative target; Vite stays for the CF Worker build. Component tree becomes universal. Drop `react-dom`-only libs (ansi-to-react, react-jsx-parser, media-chrome, Rive WebGL2) or feature-gate. | **~4–6 days** | ✅ Ships to existing web unchanged (RNW → DOM is transparent). Prepares native target without adding one yet. |
| **P3. Native target (Expo, iOS + Android)** | Add RN entry via Expo SDK 54. Swap Capacitor seams: auth → `better-auth-react-native`, SQLite → op-sqlite, push → `@react-native-firebase/messaging`, OTA → EAS Update, lifecycle → AppState/NetInfo. WS uses RN native WebSocket. | **~4–6 days** | ✅ Android parity with signed APK; iOS parity with TestFlight. Capacitor app sunset. |
| **P4. Eval + polish** | Maestro + visual regression harness, AI-codegen parity loop per screen, iOS App Store submission, Play Store upgrade. | **~3–5 days** (mostly parallel) | ✅ Production-ready universal app. |

**Total: ~2–3 weeks wall clock at repo velocity, matching §9.3 —
but now with intermediate value at each phase instead of a single
big-bang landing.** Phase 1 alone likely closes some of the
"janky" complaint because it's a web-perf delta before any native
work. Phase 2 pays for itself by collapsing dual-shipping before
we've even shipped a native build. Phase 3 and 4 are additive.

### 10.5 Gates by phase (decision points, not de-risking theatre)

- **After P1** — did the Lighthouse/re-render deltas hit? If yes,
  continue. If no, stop here; the perf story isn't what was hurting
  and the rest of the pivot is motivated by native-only goals, which
  changes the cost/benefit math.
- **After P2** — does the web build on RNW ship clean? Are the hard-
  incompatible libs (xyflow, jsx-parser, Rive, media-chrome)
  acceptably feature-gated or replaced? If yes, continue. If one of
  them is load-bearing and can't be replaced cheaply, stop at P2
  (universal web) and defer native.
- **After P3** — does `better-auth-react-native` + op-sqlite + push
  + OTA pass dogfood on signed builds? If yes, ship. If not, the
  Capacitor shell stays primary for the remaining unblocked seams.
- **After P4** — standard ship gate (App Store, Play Store, prod
  canary).

### 10.6 What #70 becomes in this frame

In the §9 frame, #70 was "insurance for the Capacitor app during
the pivot." In the §10 frame, #70 is **less essential** because:

- P1 + P2 don't touch the Android Capacitor app at all (web refactor
  only); the shipping build stays on its current Capacitor stack
  unchanged for ~1.5–2 weeks with zero additional risk.
- P3 replaces the Capacitor Android app with an RN Android app that
  has native sockets from day one — the #70 problem just *doesn't
  exist* in that build.

If P1 ships cleanly and we're committed to P3, **#70 becomes
optional** — the Capacitor app keeps its current (imperfect)
transport for ~1 more week, then gets replaced. If P1 or P2 blocks,
then #70 is still the right Plan B.

### 10.7 Recommendation (final)

Supersedes §9.4 recommendation:

1. **Do not start with #70.** Start with **P1 (Tamagui adoption in
   orchestrator web)**. It's independently valuable, carries no
   mobile risk, and measures a hypothesis (is part of "janky" really
   web-perf + whole-tree re-render?) before committing.
2. **If P1 lands clean, proceed to P2 (universalize via
   react-native-web).** The Capacitor app still ships unchanged
   through this phase.
3. **If P2 lands clean, gate P3 on a 2-day spike** covering just the
   three things no library fixes: `better-auth-react-native`,
   op-sqlite vs expo-sqlite under our workload, and
   xyflow/jsx-parser/Rive/media-chrome fallbacks.
4. **If the P3 spike passes, ship P3 + P4** and retire Capacitor.
5. **Skip #70** unless P1 or P2 blocks. The sockets it fixes will be
   replaced wholesale by native WebSocket in RN anyway.

This keeps the "ship #70 first" optionality if anything ahead
blocks, but re-centers the project around a **web-first incremental
universalization** that happens to unlock native as its last step,
rather than a mobile pivot that drags along a web cost.

---

## 11. Addendum — Expo Router swap evaluation (spoiler: don't)

The suggested "swap TanStack for Expo Router" is worth surfacing
because Expo Router is much more legitimate in 2026 than most docs
admit — but the swap is wrong for *this specific repo's* shape.

### 11.1 Correcting a wrong premise in prior sections

**We are not on TanStack Start.** Prior sections of this doc
implicitly assumed we were. Actual stack (verified in
`apps/orchestrator/src/server.ts`, `vite.config.ts`, `api/index.ts`,
`package.json`):

- **Bundler:** Vite 7 + `@cloudflare/vite-plugin`
- **Router:** `@tanstack/react-router` v1.168.10 — file-based routes
  under `apps/orchestrator/src/routes/`, **SPA-only, no SSR, no
  loaders, no server functions, no `.server.ts` files**
- **API layer:** Hono (`new Hono<ApiAppEnv>()`) with 53 handler
  declarations in `apps/orchestrator/src/api/index.ts` gated by
  `authMiddleware`
- **Worker entry:** **hand-rolled custom `fetch` handler** in
  `apps/orchestrator/src/server.ts:78–220` that:
  1. Routes WS upgrades (`/api/sessions/:id/ws`,
     `/agents/session-agent/:id`, `/api/collab/:id/ws`,
     `/parties/*`) directly to `SESSION_AGENT`, `SESSION_COLLAB`,
     `USER_SETTINGS` DOs via `idFromName()` / `idFromString()`
  2. Dispatches `/api/*` to Hono
  3. Falls back to `env.ASSETS.fetch()` for static
- **DO classes exported** from Worker entry: `SessionDO`,
  `SessionCollabDOv2`, `SessionCollabDO` (legacy), `UserSettingsDO`
- **Auth:** Better Auth mounted at `/api/auth/*`, with `bearer()` +
  `capacitor()` + `admin()` plugins

Implication: the swap question is not *"TanStack Start → Expo
Router"* but *"Vite + TanStack Router + Hono + custom Worker entry
→ Expo Router + expo-server + Metro."* That's a bigger surface area
than the original framing suggested.

### 11.2 What Expo Router + expo-server actually is in 2026

From the Expo docs + Cloudflare framework guide, as of SDK 54:

- **Expo Router** is a file-based router built on React Navigation,
  typed routes, deep-linking, universal web via RNW. Long-standing
  limitation that "server-side rendering currently requires custom
  infrastructure" is now **obsolete** — `expo-server` ships SSR.
- **API Routes** (`app/**/+api.ts`) are server-side route handlers
  using standard Fetch `Request` / `Response`.
- **EAS Hosting** is Expo's managed deploy target. From the
  [worker runtime docs](https://docs.expo.dev/eas/hosting/reference/worker-runtime/):
  *"EAS Hosting runs on Cloudflare Workers, a modern and powerful
  platform for serverless APIs"*, *"small V8 isolates"*, with Node
  compat shims for `fs` (in-memory), `http`/`https` (client-only),
  `Buffer`, `EventEmitter`, `process.env`.
- **Direct CF Workers deploy via Wrangler is supported** (per
  community `expo-adapter-workers`, `expo-workers`, and the
  Cloudflare React Router framework guide pattern — same
  pattern applies).

So Expo Router is a real full-stack-on-Workers framework. That's
not the issue.

### 11.3 Why swapping is wrong for this repo specifically

Four reasons, ranked by weight:

**1. Our Worker entry is load-bearing and doesn't fit Expo's
framework-handler model.** The pattern Cloudflare documents for
React Router / Expo Router on Workers is *"The framework handler
delegates HTTP requests while developers can add Durable Objects
and Workflows as supplementary exports in the same file."* That
works when routes are HTTP-only. Our Worker:
- Has **dedicated WS-upgrade dispatch** that runs *before* any
  HTTP routing — any `Upgrade: websocket` request for
  `/api/sessions/:id/ws`, `/agents/session-agent/:id`, or
  `/parties/*` is routed directly to a DO stub, bypassing
  framework routing entirely
- Uses **different auth paths for WS vs HTTP** (Better Auth
  cookie + Bearer token fallback, with gateway-token override
  for `/api/gateway/*` routes)
- Has **multiple DO binding dispatch patterns** per upgrade path
  (`idFromString(hex64) || idFromName(uuid)` for SessionDO,
  PartyKit's `routePartykitRequest()` for user-settings)

Composing that custom dispatcher with Expo's Worker-entry output
is possible (wrap expo-server's handler as a fall-through after
our WS + DO dispatch) but offers zero architectural benefit and
adds integration risk.

**2. Our SPA architecture doesn't use Expo Router's big wins.** The
Expo Router features that justify the swap — SSR, server
components, loaders, API Routes co-located with UI — are things
we either don't use or already have cleaner solutions for:
- **No SSR today** and we don't want it (authenticated SPA; SSR
  would gate first paint behind auth check)
- **No loaders** — TanStack Query + TanStack DB + WS pushes are
  our data layer, tied to the collection system described in the
  top-level CLAUDE.md
- **Our API layer is 53 Hono routes** — Expo Router's
  `+api.ts` convention doesn't compose with Hono; we'd be
  migrating route definitions for ergonomics, not capability

**3. We'd lose TanStack Router's ergonomics.** The current
`apps/orchestrator/src/routes/` tree uses `createFileRoute()`
with route-level type-safe search params, `beforeLoad` auth
guards, and the route tree is statically analysed for typed
`Link` props. Expo Router's typed routes cover the navigation
cases but not TanStack Router's search-param + loader
typing model. This is a downgrade, not a lateral move.

**4. TanStack React Router already works on RNW.** Router v1 is
platform-agnostic — it needs a React tree, not a DOM.
Per §10.4's P2 phase, once the orchestrator renders via
react-native-web, TanStack Router keeps working. The only
native-specific routing concern is **stack-style navigation with
iOS swipe-back / Android hardware back / gesture transitions** —
that's a presentation-layer concern, handled by wrapping screens
in React Navigation primitives *under* TanStack Router, not by
swapping the router.

### 11.4 What about unified file-based routing?

Legitimate concern. The §10.4 plan leaves us with TanStack Router
on web and (optionally) React Navigation primitives wrapping
screens on native. That's *one route tree* rendered two ways —
not two routers. Expo Router's pitch of "one file tree for both"
sounds cleaner but isn't meaningfully different in practice once
Tamagui + RNW are in place.

### 11.5 When the swap WOULD be right

- **If we were starting from zero.** Expo Router + expo-server +
  EAS Hosting is a defensible default for a new universal app
  in 2026 — less plumbing than Vite + CF plugin + Hono + custom
  Worker entry + React Navigation.
- **If we wanted SSR.** Not today.
- **If we wanted native-first routing conventions (deep links,
  platform-idiomatic stack navigation) and were willing to accept
  the Worker entry rewrite.** Trade-off possible; not clearly
  worth it here given the shipping-velocity-loss during the
  rewrite.

### 11.6 Recommendation — keep TanStack Router + Hono, add RNW + Tamagui on top

Modify §10.4 plan to explicitly preserve the routing + API stack:

| Phase | Changes from §10.4 |
|---|---|
| P1 (Tamagui web) | Unchanged. Tamagui is orthogonal to router. |
| P2 (RNW universal) | **Keep TanStack Router, keep Hono, keep custom Worker entry.** Add RNW as the rendering primitive layer. Vite stays for web; Metro runs in parallel for native. |
| P3 (native target) | Add **React Navigation as a presentation-layer wrapper** on native so screens get stack transitions + swipe-back + hardware back. TanStack Router is still the route tree — React Navigation is just the screen renderer on native. |
| P4 (eval + ship) | Unchanged. |

Net: we keep everything that's already working and load-bearing
(Worker entry, DO dispatch, Hono, TanStack Router, Better Auth
plugins) and layer universal rendering on top. The stack gets
bigger by ~2 libraries (RNW + Tamagui), not smaller by one
(Expo Router replacing TanStack).

**Reserve Expo Router swap as a future refactor option** if/when
we hit a specific pain point it uniquely solves — most likely
deep-link handling or platform-native navigation transitions
that React Navigation alone can't deliver inside the TanStack
Router tree. Not a blocker for the §10 pivot.
