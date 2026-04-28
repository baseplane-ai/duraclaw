---
initiative: tamagui-orchestrator-web
type: project
issue_type: feature
status: approved
priority: high
github_issue: 125
created: 2026-04-28
updated: 2026-04-28
phases:
  - id: p0
    name: "Spike — Path A (Tamagui on Vite) vs Path B (OneStack) — 2 days"
    tasks:
      - "Path A spike branch: install @tamagui/vite-plugin@2.0.0-rc.41 + @tamagui/core into apps/orchestrator/package.json. Build minimal tamagui.config.ts with current 24 color tokens (OKLch values from styles/theme.css:75-120) + radius tokens"
      - "Path A: insert Tamagui Vite plugin into apps/orchestrator/vite.config.ts plugin chain after cloudflare(), before react(). Verify pnpm dev + pnpm build complete with one hello-world Tamagui Stack/Text component rendered on /"
      - "Path A: verify Worker bundle (dist/<worker>) contains zero @tamagui/* bytes via `grep -r tamagui dist/<worker> | wc -l` + bundle-analyzer spot check"
      - "Path A: verify Tailwind cascade by toggling theme on / route — current Tailwind classes still apply alongside the Tamagui hello-world; document any reset-cascade conflict observed"
      - "Path A: capture verdict — green (clean install, no Worker leak, no Tailwind conflict, dev server stable) / yellow (works but with friction) / red (open issue from #2401/#3406/#3302/#3582 reproduces or Vite 8 incompat)"
      - "Path B spike branch: scaffold fresh OneStack app via `npx one create` in /tmp; deploy hello-world to a throwaway CF Worker per onestack.dev/docs (cloudflare adapter); confirm Tamagui v2-RC works under One"
      - "Path B: port apps/orchestrator/src/routes/_authenticated/sessions/index.tsx (or smallest authenticated route) to OneStack file conventions; verify One's router supports typed search params + a beforeLoad-equivalent auth guard; document parity gap if any"
      - "Path B: capture verdict on same green/yellow/red rubric"
      - "Decision matrix: A green + B green → Path A (least invasive). A red + B green → Path B (forced pivot). A green + B yellow/red → Path A. A yellow + B green → Path A unless A's friction is load-bearing (judgment call, document). **A red + B red** → spike PR concludes with explicit 'P1 blocked' verdict; do not enter P1a; close GH#125 as 'blocked-pending-upstream' with a follow-up issue tracking the unblocking conditions (e.g., 'reopen when Tamagui v2 ships stable' or 'reopen when Vite 8 support is documented'). Record decision + rationale in spike PR description in all cases"
    test_cases:
      - "Path A: hello-world Tamagui component visible on / in pnpm dev"
      - "Path A: pnpm build emits dist/client + dist/<worker> with Worker bundle Tamagui-free (grep returns 0 matches)"
      - "Path A: pnpm typecheck passes"
      - "Path B: OneStack hello-world deploys to CF Worker, returns 200 with rendered HTML"
      - "Path B: ported route serves with auth guard rejecting unauthenticated requests"
      - "Spike PR description records green/yellow/red verdict per path + chosen path + rationale"
  - id: p1a
    name: "Plumbing — runtime install, theme migration, 13 primitives, CI guard"
    tasks:
      - "[P1a-prerequisite, MUST RUN FIRST] Capture before-screenshots of the 10 smoke flows (manual screen capture, store under planning/research/2026-04-28-gh125-screenshots/before/) on the pre-P1a `main` HEAD — these are the visual baseline VP-1 step 5 and VP-3 step 6 compare against. Without these screenshots captured first, visual-regression detection has no reference point. After-screenshots are captured in /after-p1a/ at P1a close and /after-p1b/ at P1b close"
      - "[P1a-core] Install Tamagui per chosen path (P0 outcome): @tamagui/core + @tamagui/font-inter + @tamagui/lucide-icons (or One's bundled set if Path B). Pin to 2.0.0-rc.41"
      - "[P1a-core] Build tamagui.config.ts at apps/orchestrator/src/tamagui.config.ts: tokens from styles/theme.css (24 colors converted from OKLch to hex/rgb, 4 radii, 2 fonts), light + dark themes from :root + .dark CSS-var values, media queries from existing useIsMobile breakpoint (max-width: 767px)"
      - "[P1a-core] Wrap app root in apps/orchestrator/src/routes/__root.tsx with TamaguiProvider — render alongside existing ThemeProvider context (do not remove yet)"
      - "[P1a-core] Migrate apps/orchestrator/src/context/theme-provider.tsx: replace .dark class manipulation with Tamagui's <Theme name='dark'>; preserve cookie persistence (vite-ui-theme); replace window.matchMedia listener with Tamagui's useMedia('dark'). Keep useTheme() hook signature for downstream consumers"
      - "[P1a-critical-path] Migrate 4 highest-usage primitives FIRST so the migration pattern is validated against real consumers before fanning out: components/ui/{button,card,input,label}.tsx (combined ~50+ import sites). Land these as a single PR-equivalent and run smoke before continuing"
      - "[P1a-fanout] Migrate the 4 next-tier primitives in parallel via impl-agents: components/ui/{badge,separator,avatar,tabs}.tsx (combined ~25+ import sites)"
      - "[P1a-deferrable] Migrate the 5 lowest-usage primitives last; if P1a runs long, these may slip into a P1a-extended PR before P1b starts: components/ui/{textarea,table,alert,skeleton,collapsible}.tsx (combined <10 import sites)"
      - "[P1a-cleanup] After all 13 primitives land: remove @radix-ui/react-{label,separator,avatar,collapsible,tabs} from package.json"
      - "[P1a-core] Add CI guard: scripts/check-worker-tamagui-leak.sh that greps `from ['\\\"]@tamagui` in apps/orchestrator/src/server*.ts and exits 1 on match. Wire into apps/orchestrator/package.json's `typecheck` script as a sibling step"
      - "[P1a-core] Update apps/orchestrator/vitest.config.ts to include the Tamagui plugin (Path A) or One's vitest preset (Path B) so component tests would not fail on Tamagui imports — defensive even though P1 adds no tests"
      - "[P1a-cleanup] Capture after-screenshots into /after-p1a/ for human comparison against /before/. Subjective regression detection only — no automated diff (per Non-Goals)"
      - "[P1a-core] Verify smoke list: 10 manual flows in §Verification Plan still work — login, session list, open session, send message, theme toggle (settings + header), kanban view, file viewer, settings save, sign out, dark/light/system tri-state"
      - "[P1a-blocked-path] Stop condition: if migrating the 4 critical-path primitives (button, card, input, label) reveals pattern-level Tamagui friction — `className` escape hatch fails to compose with `styled()` variants, variant type inference breaks across the cn() boundary, or theme tokens fail to resolve in styled() context — STOP fanout. Do NOT migrate the remaining 9 primitives. Document the pattern-level blocker in a new GH issue 'GH#125 follow-up: P1a pattern-level Tamagui friction' with reproduction; post a comment on GH#125; pause the phase. P1b cannot start until pattern is unblocked or strategy revised. **Revert strategy if pattern-blocker is hit:** `git revert` ONLY the per-primitive migration commits (typically named `feat(orchestrator): migrate <primitive> to Tamagui`). KEEP the foundational commits intact: tamagui.config.ts creation, TamaguiProvider wrap in __root.tsx, theme-provider.tsx migration, vitest.config.ts update, scripts/check-worker-tamagui-leak.sh + package.json typecheck wiring. Result: TamaguiProvider remains mounted (theme via Tamagui), 0 primitives migrated, original Radix wrappers restored, CI guard active. Tagging convention: prefix all primitive-migration commits with `feat(orchestrator/ui): migrate ... to Tamagui` so the revert grep pattern is unambiguous"
    test_cases:
      - "pnpm build passes with Tamagui runtime + 13 migrated primitives"
      - "pnpm typecheck passes including new Worker-leak guard"
      - "Theme toggle persists via cookie across reload (light → dark → light cycle)"
      - "System pref change ('prefers-color-scheme: dark') flips theme without reload when set to 'system'"
      - "All 10 smoke flows pass via dogfood checklist (no visual regression)"
      - "Worker-leak guard fails CI when a deliberate `import { Stack } from '@tamagui/core'` is added to src/server.ts (then revert)"
  - id: p1b
    name: "Compiler + sidebar + gate measurement"
    tasks:
      - "Enable Tamagui compiler: Path A → enable extract:true on @tamagui/vite-plugin; Path B → enable One's compiler config per onestack.dev/docs/guides-tamagui. Rebuild + verify atomic CSS extraction in dist/client (grep for hashed tamagui- class prefixes)"
      - "Add baseline measurement run: branch off main pre-Tamagui-compiler, run Lighthouse on /sessions and /projects (3-run median), capture render-count baseline via React DevTools Profiler on session-switch + 10-keystroke-typing scenarios. Commit baseline JSON to planning/research/2026-04-28-gh125-baseline-perf.json"
      - "Wire <Profiler> instrumentation in 4 files (gated to NODE_ENV=development to avoid prod overhead): apps/orchestrator/src/routes/__root.tsx (root render), apps/orchestrator/src/features/agent-orch/AgentDetailView.tsx (session-switch), apps/orchestrator/src/components/layout/sidebar.tsx (cascade), apps/orchestrator/src/features/agent-orch/ChatThread.tsx (virtualization)"
      - "Migrate apps/orchestrator/src/components/ui/sidebar.tsx (705 LOC, 23 subcomponents) to Tamagui. Convert CSS-var arbitrary calc patterns (`w-(--sidebar-width)`, `h-[calc(var(--sidebar-width-icon)+(--spacing(4)))]`) to Tamagui token spacing. Preserve all 23 exported subcomponent shapes (Sidebar, SidebarProvider, SidebarTrigger, SidebarContent, etc.) so consumers don't need to change imports"
      - "Tailwind partial teardown post-sidebar — orchestrator-owned content removed, ai-elements scope retained: from apps/orchestrator/src/styles.css remove the @theme block (theme tokens now in tamagui.config.ts), @custom-variant dark line (Tamagui owns dark mode now), and the 4 @apply usages (lines 29/34/37/77 — rewrite line 77's faded-bottom as a scoped CSS class in escape-hatch.css). Keep `@import 'tailwindcss'` AND `@source '../../packages/ai-elements/src'` AND `@source inline()` safelist — these process ai-elements' Tailwind classes which the orchestrator still consumes. Keep tailwindcss + @tailwindcss/vite + tailwind-merge in apps/orchestrator/package.json (their only remaining job is processing ai-elements). Remove tw-animate-css only if `grep -r 'animate-' apps/orchestrator/src` returns no hits"
      - "Run gate measurement: post-compiler, post-sidebar build deployed to a preview CF Worker. Capture same metrics as baseline. Compute deltas. Write planning/research/2026-04-28-gh125-gate-results.md with the 4 metrics (session-switch render <300ms, keystroke cascade <10 ticks, Lighthouse +10 minimum, react-offscreen-patch decision)"
      - "Decision: gate-pass — proceed to P1c. Gate-fail — stop, file follow-up issue, do not deploy beyond preview Worker"
    test_cases:
      - "Compiler-on build emits hashed atomic-CSS class names in dist/client/*.css (grep for `_tamagui-` or `_t_` prefix)"
      - "Worker bundle still Tamagui-free (CI guard from P1a holds)"
      - "Baseline + post run JSON files exist in planning/research/ with raw numbers"
      - "Session-switch render time <300ms on heavy session (300+ messages) — measured via Profiler on AgentDetailView.tsx"
      - "Re-render cascade <10 ticks across 10-keystroke composer typing — measured on ChatThread/StatusBar/sidebar combined"
      - "Lighthouse delta on /sessions ≥+10 points (median of 3 runs); +15 stretch celebrated, not required"
      - "Tailwind partial teardown verified: orchestrator-owned content gone (no @theme block, no @custom-variant dark, no @apply usages); ai-elements scope retained (@import 'tailwindcss', @source directive, tailwindcss + @tailwindcss/vite + tailwind-merge still in package.json); ai-elements markdown rendering in chat surfaces visually unchanged from before/ screenshots; pnpm build still passes; 10-flow smoke still passes"
      - "Sidebar migration: collapse/expand, keyboard nav (Tab/Enter/Esc), responsive collapse at <768px all functional"
  - id: p1c
    name: "Deploy — web-first, delayed OTA, post-gate offscreen-patch decision"
    tasks:
      - "Merge P1b to main → pipeline auto-deploys to web (apps/orchestrator/dist/* via wrangler). Capacitor app continues serving the previous bundle from Capgo channel"
      - "Run signed-build smoke on Android WebView (build-android.sh + sign-android.sh + sideload) WITH react-offscreen-patch.ts still in place — confirm no new pathology introduced by Tamagui's atomic CSS in WebView"
      - "Dogfood window: 3 days minimum on web before manual OTA push to Capacitor channel. During this window, monitor wrangler tail + sentry/equiv (if any) for client errors specific to Tamagui rendering paths"
      - "react-offscreen-patch.ts decision: branch off main, delete the patch + its conditional import in apps/orchestrator/src/main.tsx. Build + sideload signed APK. Run the original repro from #40 (background app, return, navigate). If pathology returns → revert delete + leave patch indefinitely. If clean → land delete to main"
      - "Manual OTA push: after dogfood window passes cleanly, run `pnpm --filter @duraclaw/orchestrator build` + `bash scripts/build-mobile-ota-bundle.sh` per .claude/rules/deployment.md to push the Tamagui bundle to Capgo. Existing Capacitor installs receive on next launch"
    test_cases:
      - "Web deploy live: curl -sI <prod-url> returns 200 with current Tamagui-built bundle"
      - "Capgo channel still serving pre-Tamagui bundle to existing Capacitor installs (verify via Capgo dashboard or device-side check)"
      - "Signed APK with react-offscreen-patch retained smokes through 10 flows on Android WebView without regressing any of #40, #49, #69"
      - "Patch-removal experiment: signed APK without patch reproduces or doesn't reproduce #40's repro — outcome documented in commit message of the keep/remove decision"
      - "After OTA push, an existing Capacitor install picks up the new bundle on next foreground; smokes through 10 flows"
---

# GH#125 — P1 Tamagui adoption in `apps/orchestrator` (web only)

## Overview

First chunk of the universalization plan from
`planning/research/2026-04-23-react-native-pivot-evaluation.md` §10.4 /
§10.7. Adopts Tamagui as the styling/primitive layer in the
orchestrator's existing CF Workers + Vite SPA — **no react-native-web,
no Expo, no native target** — to (a) measure whether part of the
"janky" complaint is web-perf and CSS-in-JS hook re-render thrash that
Tamagui's compiler eliminates, and (b) lay the universal-primitive
foundation for the parent doc's later phases without committing to
them yet.

The Capacitor Android app receives the new bundle via OTA after a
dogfood delay; engineering effort to polish Capacitor is explicitly
out of scope — that shell is on a sunset path with the RN P3 phase.

## Feature Behaviors

### B1: 2-day comparative spike picks Path A or Path B

**Core:**
- **ID:** spike-path-decision
- **Trigger:** P0 phase entry
- **Expected:** standalone spike branch demonstrates both Path A
  (Tamagui on existing Vite + cloudflare-vite-plugin) and Path B
  (OneStack as framework), each with green/yellow/red verdict; chosen
  path documented in spike PR description with rationale
- **Verify:** spike PR contains: Path A hello-world Tamagui component
  rendering through `pnpm dev`; Path A `pnpm build` emits Worker
  bundle with zero `@tamagui/*` bytes (grep verified); Path B
  hello-world OneStack app deploys to a throwaway CF Worker; Path B
  ports one orchestrator route with typed search params + auth guard
  parity verified or gap documented
- **Source:** new — spike branch off main

#### Build Layer
Path A modifies `apps/orchestrator/vite.config.ts` (insert
`tamaguiPlugin()` between `cloudflare()` and `react()`). Path B
scaffolds a fresh `apps/orchestrator-one/` worktree (do not modify the
shipping orchestrator).

### B2: Tamagui runtime adopted; theme system migrated to `<Theme>` + `useMedia`

**Core:**
- **ID:** runtime-theme-migration
- **Trigger:** P1a phase entry, post-spike decision
- **Expected:** orchestrator builds with Tamagui as the runtime styling
  layer (compiler off in this phase). `<TamaguiProvider>` wraps app
  root. Theme tokens (24 colors + 4 radii + 2 fonts) drive primitive
  rendering. Light/dark/system theme toggle continues to work via
  cookie persistence; `<html>` `.dark` class replaced by Tamagui
  `<Theme name="dark">` wrapper.
- **Verify:** light → dark → system → light cycle on `/settings`
  persists across reload via `vite-ui-theme` cookie; toggling OS
  appearance with theme set to "system" flips colors without page
  reload; Tamagui tokens render correct OKLch-equivalent colors
  (visual diff against pre-migration baseline screenshots).
- **Source:** `apps/orchestrator/src/context/theme-provider.tsx:1-107`,
  `apps/orchestrator/src/styles/theme.css:1-120`,
  `apps/orchestrator/src/routes/__root.tsx:65-79`

#### UI Layer
- `<TamaguiProvider config={tamaguiConfig} defaultTheme={resolvedTheme}>`
  wraps `<Outlet />` in `__root.tsx`
- Theme switch component (`apps/orchestrator/src/components/theme-switch.tsx`)
  signature unchanged externally; calls `setTheme()` from existing
  `useTheme()` hook, which now writes to both Tamagui's theme store
  and the existing cookie
- `useIsMobile()` hook (`hooks/use-mobile.tsx`) replaced by
  `useMedia('mobile')` per Tamagui's media-query token

#### Data Layer
None — purely client-side migration. `vite-ui-theme` cookie shape
unchanged.

### B3: 13 primitives migrated to Tamagui (P1a scope)

**Core:**
- **ID:** primitives-migration-p1a
- **Trigger:** P1a phase task per primitive
- **Expected:** the following 13 primitives in
  `apps/orchestrator/src/components/ui/` are rebuilt on Tamagui's
  `styled()` API: 8 pure-styling (button, badge, card, input,
  textarea, table, alert, skeleton) + 5 trivial Radix→Tamagui swaps
  (label, separator, avatar, collapsible, tabs). Public component
  signatures preserved so consumer imports do not change.
- **Verify:** every consumer of each migrated primitive (per import
  count from P0 §1: button 25+, card 9+, etc.) renders without
  compile error and without visual regression in the 10-flow smoke
  list. `package.json` no longer depends on
  `@radix-ui/react-{label,separator,avatar,collapsible,tabs}`.
- **Source:** `apps/orchestrator/src/components/ui/` (28 files);
  primitive-by-primitive

#### UI Layer
Each migrated primitive exports the same names + prop shape as today.
Internal implementation switches from Tailwind class composition (via
`cn()` + `class-variance-authority`) to Tamagui `styled()` with
variant props. The `cn()` import + `className` prop forwarding stays
as an escape hatch for any consumer passing arbitrary class strings.

### B4: Compiler enabled; sidebar migrated; Tailwind partial teardown

**Core:**
- **ID:** compiler-sidebar-tailwind-teardown
- **Trigger:** P1b phase entry, post-P1a-stable
- **Expected:** Tamagui compiler enabled in `vite.config.ts`
  (`extract: true`) or via OneStack config. `apps/orchestrator/src/components/ui/sidebar.tsx`
  (705 LOC, 23 subcomponents) rebuilt on Tamagui — CSS-var arbitrary
  calc patterns (`w-(--sidebar-width)` etc.) converted to Tamagui
  token spacing. **Tailwind partial teardown** — orchestrator-owned
  content (the `@theme` block, `@custom-variant dark`, and 4 `@apply`
  usages) is removed; **but** Tailwind processing **stays** for
  `packages/ai-elements`, which keeps using Tailwind classes per the
  P1 interview decision. `tailwindcss` + `@tailwindcss/vite` +
  `tailwind-merge` remain in `apps/orchestrator/package.json` with
  ai-elements as their sole remaining consumer.
- **Verify:** `pnpm build` emits hashed atomic-CSS class names
  (grep `dist/client/*.css` for `_tamagui-` or `_t_` prefix);
  `styles.css` no longer contains `@theme` or `@custom-variant dark`
  or `@apply`; `tailwindcss` still resolves and processes ai-elements
  classes (confirmed by ai-elements rendering correctly in chat
  message surfaces); sidebar collapse/expand + keyboard nav +
  responsive collapse at <768px all functional; 10-flow smoke
  passes; CI Worker-leak guard from B7 still passes.
- **Source:** `apps/orchestrator/src/components/ui/sidebar.tsx:1-705`,
  `apps/orchestrator/src/styles.css`, `apps/orchestrator/vite.config.ts`

#### Build Layer
- Tamagui compiler emits atomic CSS at build time; no runtime style
  object generation for compiled components
- Vite bundler emits one CSS chunk per route (existing chunking
  preserved)
- Tailwind partial teardown:
  - **Remove** from `styles.css`: the `@theme` block (tokens now in
    `tamagui.config.ts`), the `@custom-variant dark` line (Tamagui
    owns dark mode), and all 4 `@apply` usages (lines 29, 34, 37, 77).
    The `faded-bottom` pseudo-element utility (line 77) becomes a
    scoped CSS class in a new `escape-hatch.css`.
  - **Keep** in `styles.css`: `@import "tailwindcss"`,
    `@source "../../packages/ai-elements/src"`, and the
    `@source inline()` safelist (lines 14–23). These continue to
    process ai-elements' Tailwind classes for the orchestrator's
    consumption.
  - **Keep** in `package.json`: `tailwindcss`, `@tailwindcss/vite`,
    `tailwind-merge`. Their post-P1b job is solely ai-elements
    class extraction.
  - **Future:** if `packages/ai-elements` is ever migrated to its
    own pre-built CSS export (out of scope for P1), the orchestrator
    can drop Tailwind entirely. Spec flags this as a follow-up.
- **ai-elements coexistence model:** ai-elements components ship
  their Tailwind class strings in source; orchestrator's Tailwind
  pipeline (still active, scoped to ai-elements via `@source`)
  resolves them at build time. Cascade order: Tailwind reset and
  utilities load first, Tamagui's atomic CSS layers on top. Verify
  during P1b that no Tailwind utility (e.g., `text-sm`,
  `bg-primary`) leaks visual override into Tamagui-styled
  primitives — the `@source` directive should keep Tailwind output
  scoped only to selectors actually used in ai-elements source.

### B5: Gate measurement (§10.5 success criteria)

**Core:**
- **ID:** perf-gate-measurement
- **Trigger:** P1b end, post-compiler + post-sidebar
- **Expected:** four concrete metrics measured against thresholds.
  Three outcome paths defined below. The thresholds are aspirational
  targets derived from the P0 §4 patch evidence (~1000ms session-switch
  pre-Tamagui, 20–40 ticks per 10 keystrokes); **the actual baseline
  is captured at P1b start**, before the compiler is enabled, and may
  invalidate the thresholds. The gate's three outcome paths handle
  that contingency.
- **Verify:** `planning/research/2026-04-28-gh125-gate-results.md`
  exists with raw numbers, baseline values, post values, deltas, and
  one of three outcome annotations per metric:
  - **Pass** — post-Tamagui meets the absolute threshold (e.g.,
    session-switch <300ms post-compiler) → proceed to P1c
  - **Fail-on-delta** — post-Tamagui shows <40% improvement over
    baseline regardless of absolute number (Tamagui's claimed
    30–50% wins didn't materialize) → stop, file follow-up issue,
    do not proceed to P1c
  - **Hypothesis-invalid** — pre-Tamagui baseline already meets the
    threshold (e.g., session-switch already <300ms before any
    Tamagui work) → §10.5 of parent research applies: stop here,
    the perf story isn't what was hurting. Spec-required artifacts:
    (1) write `planning/research/2026-04-28-gh125-hypothesis-invalid.md`
    documenting the baseline + which threshold was already met +
    candidate alternative root causes for the original "janky"
    complaint (mobile WebView × React 19, network/transport,
    something else); (2) open a new GH issue titled "GH#125
    follow-up: P1 hypothesis invalid — alternative root-cause
    investigation" linking the baseline JSON; (3) post a comment on
    GH#125 with a TL;DR + link to the artifacts. The spec does NOT
    auto-proceed to P1c — the user decides via the new issue
    whether to ship the architecturally-better but not measurably-
    faster code, or abandon. **Default is do not proceed.**
- **Metrics + thresholds (aspirational, may revise post-baseline):**
  - Session-switch root render: <300ms absolute, OR ≥40% delta vs baseline
  - Re-render cascade per 10-keystroke burst: <10 ticks absolute, OR ≥50% delta vs baseline
  - Lighthouse delta on `/sessions` and `/projects`: +10 points minimum, +15 stretch
  - `react-offscreen-patch.ts` decision: deferred to B6 in P1c (post-gate)
- **Source:** `planning/research/2026-04-28-gh125-baseline-perf.json` (created in P1b),
  `planning/research/2026-04-28-gh125-gate-results.md` (created in P1b)

### B6: `react-offscreen-patch.ts` evidence-based decision

**Core:**
- **ID:** offscreen-patch-decision
- **Trigger:** P1c, post-gate-pass
- **Expected:** signed APK built without
  `apps/orchestrator/src/lib/react-offscreen-patch.ts` is sideloaded
  and runs the original #40 repro (background app, return, navigate
  through routes). If the pathology (white-screen, route-not-visible)
  returns → patch is restored and kept indefinitely. If clean → patch
  is deleted from main.
- **Verify:** commit removing or restoring the patch references the
  APK smoke result; if removed, follow-up commit deletes the
  conditional import from `apps/orchestrator/src/main.tsx`.
- **Source:** `apps/orchestrator/src/lib/react-offscreen-patch.ts:1-51`,
  `apps/orchestrator/src/main.tsx` (import site)

### B7: CI guard against `@tamagui/*` leaking into Worker bundle

**Core:**
- **ID:** worker-leak-ci-guard
- **Trigger:** every push to main
- **Expected:** `pnpm typecheck` invokes a sibling shell step that
  greps for `from ['"]@tamagui` in `apps/orchestrator/src/server*.ts`
  and exits 1 on any match. The `pnpm ship` and CI pipelines run
  `pnpm typecheck`, so the guard runs on every push.
- **Verify:** deliberately add a stray `import { Stack } from '@tamagui/core'`
  to `apps/orchestrator/src/server.ts`, run `pnpm typecheck`, observe
  exit 1 with a message identifying the offending import. Revert.
- **Source:** new file `scripts/check-worker-tamagui-leak.sh`,
  `apps/orchestrator/package.json` `typecheck` script

### B8: Web-first deploy with delayed OTA push to Capacitor

**Core:**
- **ID:** web-first-deploy
- **Trigger:** P1c phase entry, post-gate-pass
- **Expected:** P1b merge to main triggers infra-pipeline web deploy
  (per `.claude/rules/deployment.md`). Capacitor app continues
  serving the pre-Tamagui bundle from Capgo. Manual re-trigger of
  the OTA build script (`scripts/build-mobile-ota-bundle.sh`)
  pushes the new bundle to Capgo only after a 3-day minimum dogfood
  window with no Tamagui-related client errors.
- **Verify:** after P1b merge, `curl -sI <prod-url>` returns 200 with
  the new bundle hash (`VITE_APP_VERSION` short hash visible in
  asset names); Capgo dashboard / device-side check shows the
  pre-Tamagui bundle is still active; after manual OTA push,
  existing Capacitor install picks up new bundle on next foreground.
- **Source:** `.claude/rules/deployment.md`, `scripts/build-mobile-ota-bundle.sh`,
  `apps/mobile/capacitor.config.ts`

#### Deployment Layer
- Web: standard pipeline-driven deploy on push to main per
  `.claude/rules/deployment.md` (no pipeline change). The orchestrator
  Worker rebuilds + deploys; existing Capgo OTA bundle pointer is
  unaffected because the pipeline only updates Capgo when
  `scripts/build-mobile-ota-bundle.sh` runs.
- Capacitor OTA: explicitly deferred — `build-mobile-ota-bundle.sh`
  is **not** invoked during the P1b merge or any subsequent push for
  the duration of the dogfood window (3 days minimum). After
  dogfood, a separate, manually-triggered run of that script (locally
  or via a one-shot pipeline trigger if available) pushes the new
  bundle. **No commit-message tokens or pipeline modifications are
  required** — the existing infra-pipeline contract already only
  pushes OTA when explicitly invoked, per `.claude/rules/deployment.md`.
- Rollback: if post-OTA-push a regression surfaces, `git revert`
  the offending commits on `main`, push, and re-run
  `build-mobile-ota-bundle.sh` to push the reverted bundle to Capgo.
  Recovery time ~10 min.

## Non-Goals

Pulled directly from P1 interview's explicit scope exclusions:

- **react-native-web universalization** (parent doc P2 — separate
  issue when P1 ships)
- **Expo / native target / iOS / Android RN app** (parent doc P3)
- **Maestro + AI-codegen eval harness** (parent doc P4)
- **#70 native WebSocket Capacitor plugin** (parked per parent §10.6)
- **`packages/ai-elements` migration** — stays Tailwind-styled,
  coexists via cascade order
- **9 deferred Radix portal families** — `dialog`, `alert-dialog`,
  `dropdown-menu`, `popover`, `select`, `switch`, `tooltip`,
  `radio-group`, `checkbox` stay on Radix until P3 + Zeego
- **3 keep-forever Radix families** — `slot`, `direction`,
  `scroll-area` stay on Radix indefinitely
- **`command.tsx`** (cmdk-based command palette) — low usage,
  defer with the deferred Radix portal cohort
- **Visual regression / Playwright / Vitest component tests** — no
  test net added; manual smoke checklist owns regression detection
- **APK smoke testing as a P1 gate prerequisite** — Capacitor on
  sunset path; web-first dogfood is the gate
- **Feature flagging or rollback infrastructure** — reactive
  git-revert is the rollback path
- **Migration of arbitrary `data-[state=*]` selectors in non-migrated
  primitives** — these stay until their owning primitive migrates
- **OneStack adoption decision** is gated to the spike — not
  pre-committed by this spec

## Verification Plan

Executable steps. A fresh agent with no context should be able to run
each verbatim.

### VP-0 — Spike outcome documented (gates P1a entry)

1. `gh pr view <spike-pr-number>` — PR description must contain a
   "Decision" section with one of: "Path A (Tamagui on Vite)" or
   "Path B (OneStack)" plus rationale referencing green/yellow/red
   verdicts on both paths.
2. Confirm the PR body references the four spike test cases from
   the P0 frontmatter as PASS or FAIL on both paths.

### VP-1 — Tamagui runtime + 13 primitives (after P1a)

1. `cd apps/orchestrator && pnpm install && pnpm typecheck` — exit 0,
   no errors.
2. `pnpm build` — exit 0; `dist/client/` exists; `dist/<worker>/` exists.
3. `grep -r "from ['\"]@tamagui" apps/orchestrator/src/server*.ts || echo OK` — prints `OK`.
4. `pnpm dev` — open `http://localhost:43xxx/` (per worktree port);
   navigate to `/settings`; toggle theme through light → dark →
   system → light. Confirm:
   - Each toggle persists across browser reload (`vite-ui-theme`
     cookie value updates)
   - With theme = "system", changing OS appearance flips orchestrator
     colors without reload
5. Run the 10-flow smoke list manually. **Compare visually against `planning/research/2026-04-28-gh125-screenshots/before/` baseline** captured pre-P1a; pass criterion is "no human-visible regression" (subjective; per Non-Goals, no automated diff tooling). Capture after-screenshots into `/after/` for the spec-review record:
   1. Sign in via Better Auth flow (Google / GitHub)
   2. Sessions list renders, sessions visible
   3. Click a session → AgentDetailView renders with chat history
   4. Send a message → assistant turn streams in
   5. Theme toggle in settings → persists across reload
   6. Theme toggle in header → same
   7. Open file viewer on a file
   8. Switch projects via project selector
   9. Open kanban view, drag a card column-to-column
   10. Sign out → returns to sign-in screen
6. `! grep -E "@radix-ui/react-(label|separator|avatar|collapsible|tabs)" apps/orchestrator/package.json` — prints nothing (deps removed).

### VP-2 — Worker-leak CI guard (B7)

1. Add a stray import to `apps/orchestrator/src/server.ts`:
   `import { Stack } from '@tamagui/core'` (top of file, do not use it).
2. `pnpm --filter @duraclaw/orchestrator typecheck` — must exit 1
   with a message identifying the leak.
3. Revert the stray import.
4. `pnpm --filter @duraclaw/orchestrator typecheck` — exit 0.

### VP-3 — Compiler + sidebar + Tailwind partial teardown (after P1b)

1. `pnpm build` — exit 0.
2. `grep -E "_tamagui-|_t_" apps/orchestrator/dist/client/*.css | head -5` — prints non-empty (compiler emitted hashed atomic CSS).
3. **Tailwind partial teardown — orchestrator-owned content removed:**
   - `! grep -E "^\s*@theme\b" apps/orchestrator/src/styles.css apps/orchestrator/src/styles/theme.css 2>/dev/null` — prints nothing (no `@theme` block remains)
   - `! grep -E "^\s*@custom-variant\s+dark\b" apps/orchestrator/src/styles.css 2>/dev/null` — prints nothing (Tamagui owns dark mode now)
   - `! grep -E "^\s*@apply\b" apps/orchestrator/src/styles.css apps/orchestrator/src/styles/*.css 2>/dev/null` — prints nothing (the 4 `@apply` usages are removed; `faded-bottom` lives in `escape-hatch.css` as a regular CSS class)
4. **Tailwind retained for ai-elements processing — must NOT be removed:**
   - `grep "tailwindcss" apps/orchestrator/package.json` — prints non-empty (deps still present)
   - `grep "@import 'tailwindcss'" apps/orchestrator/src/styles.css` — prints non-empty (entry still imports Tailwind for ai-elements scope)
   - `grep "@source" apps/orchestrator/src/styles.css` — prints non-empty (ai-elements source scope retained)
   - Open `/sessions`, send a chat message, observe ai-elements-rendered markdown (code block, inline code, headings) — visually compare against `before/` screenshot; cascade is intact, ai-elements styling not regressed
5. `pnpm dev`, navigate to any session, open + close sidebar via the
   collapse trigger; verify:
   - Sidebar slides closed/open
   - Keyboard: Tab into sidebar, Enter on a session, Escape closes any
     open submenu
   - Resize browser to <768px width: sidebar auto-collapses to mobile
     drawer mode
6. Re-run the 10-flow smoke from VP-1; all 10 still pass. Visual comparison against `before/` screenshots — sidebar should look fundamentally similar (collapse behavior, spacing, contents) even though the underlying primitives changed. Capture P1b after-screenshots into `planning/research/2026-04-28-gh125-screenshots/after-p1b/`.

### VP-4 — Gate measurement (B5)

1. `cat planning/research/2026-04-28-gh125-baseline-perf.json` — exists,
   contains `sessionSwitchMs`, `keystrokeCascadeTicks`, `lighthouseSessions`,
   `lighthouseProjects` numeric fields.
2. `cat planning/research/2026-04-28-gh125-gate-results.md` — exists,
   contains a table with the four metrics, baseline values, post values,
   delta, and a PASS/FAIL annotation per metric.
3. Read the file: each of the four metric rows must be PASS for P1c
   to enter, with the exception of the offscreen-patch row which
   reads "deferred to B6 in P1c".

### VP-5 — Web-first deploy + delayed OTA (B8)

1. After P1b merge to main, `curl -sI https://<prod-url>/` — 200.
2. `curl -s https://<prod-url>/ | grep -oE "VITE_APP_VERSION[^\"]*"` — short hash matches `git rev-parse --short HEAD` of the merge commit.
3. Capgo dashboard (or `curl` to the OTA pointer URL) — `version.json` still points to the pre-Tamagui bundle hash.
4. After 3 days of dogfood without Tamagui-related client errors,
   manually run `bash scripts/build-mobile-ota-bundle.sh` (or trigger
   the corresponding pipeline step). Capgo dashboard now shows the
   new bundle hash.
5. On a real Android device with the existing Capacitor app installed:
   force-quit, relaunch, observe OTA fetch + reload; smoke through
   3 flows (open session, send message, theme toggle).

### VP-6 — `react-offscreen-patch.ts` decision (B6)

1. Branch `experiment/remove-offscreen-patch` off main.
2. `git rm apps/orchestrator/src/lib/react-offscreen-patch.ts`; remove
   the conditional import from `apps/orchestrator/src/main.tsx`.
3. `pnpm build`; `cd apps/mobile && bash scripts/build-android.sh && bash scripts/sign-android.sh`.
4. Sideload the resulting APK; run #40's repro:
   - Open the app, sign in, open a session
   - Background the app for ~30s
   - Foreground; navigate to `/settings` and back to `/sessions`
5. **Outcome A (clean):** screen renders correctly; route navigation
   visible. Land the patch deletion to main.
6. **Outcome B (pathology returns):** white screen / route invisible.
   Discard the experiment branch; record the test outcome in a
   commit message on main: `docs(orchestrator): retain offscreen-patch — APK smoke reproduced #40`.

## Implementation Hints

### Key Imports

```ts
// Path A (Tamagui on Vite) — apps/orchestrator/vite.config.ts
import { tamaguiPlugin } from '@tamagui/vite-plugin'

// Path A or B — apps/orchestrator/src/tamagui.config.ts
import { createTamagui, createTokens } from '@tamagui/core'
import { themes as defaultThemes, tokens as defaultTokens } from '@tamagui/themes'
import { createInterFont } from '@tamagui/font-inter'

// Per-primitive — Tamagui styled API
import { styled, Stack, Text, Button as TamaguiButton } from '@tamagui/core'

// Theme + media — replaces ThemeProvider context internals
import { Theme, useTheme, useMedia, getMedia } from '@tamagui/core'
```

### Code Patterns

**1. Plugin chain insertion (Path A) — `apps/orchestrator/vite.config.ts`:**

```ts
export default defineConfig({
  plugins: [
    reactRefreshPreamble(),
    agents(),
    VitePWA({ /* unchanged */ }),
    buildHashPlugin(),
    cloudflare({ /* unchanged */ }),
    // ↓ NEW — must run before react()
    tamaguiPlugin({
      config: './src/tamagui.config.ts',
      components: ['@tamagui/core'],
      // P1a: extract: false (runtime-only)
      // P1b: extract: true (compiler on)
      extract: process.env.TAMAGUI_COMPILE === 'true',
    }),
    react(),
    tailwindcss(), // removed in P1b teardown
  ],
})
```

**2. Tamagui config skeleton — `apps/orchestrator/src/tamagui.config.ts`:**

```ts
import { createTamagui, createTokens } from '@tamagui/core'

const colorTokens = {
  // From styles/theme.css :root block — convert OKLch to hex/rgb
  background: '#fafafa',
  foreground: '#0a0a0a',
  // ... 22 more from styles/theme.css:75-120
}

const radiusTokens = { sm: 6, md: 8, lg: 12, xl: 16 }

const tokens = createTokens({
  color: colorTokens,
  radius: radiusTokens,
  // space + size derived
})

const lightTheme = { /* from :root values */ }
const darkTheme = { /* from .dark overrides */ }

export const tamaguiConfig = createTamagui({
  tokens,
  themes: { light: lightTheme, dark: darkTheme },
  media: { mobile: { maxWidth: 767 } },
  defaultFont: 'inter',
  fonts: { inter: { /* @tamagui/font-inter */ } },
})

export type AppConfig = typeof tamaguiConfig
declare module '@tamagui/core' {
  interface TamaguiCustomConfig extends AppConfig {}
}
```

**3. Primitive migration shape — Class A pure styling:**

```ts
// BEFORE — apps/orchestrator/src/components/ui/button.tsx (current)
import { cva, type VariantProps } from 'class-variance-authority'
import { Slot } from '@radix-ui/react-slot'
const buttonVariants = cva('...', { variants: { /* ... */ } })
export function Button({ className, variant, asChild, ...props }) {
  const Comp = asChild ? Slot : 'button'
  return <Comp className={cn(buttonVariants({ variant }), className)} {...props} />
}

// AFTER — Tamagui styled
import { styled, Button as TamaguiButton } from '@tamagui/core'
import { Slot } from '@radix-ui/react-slot' // keep — class D

const StyledButton = styled(TamaguiButton, {
  name: 'Button',
  variants: {
    variant: {
      default: { backgroundColor: '$primary', color: '$primaryForeground' },
      destructive: { backgroundColor: '$destructive', color: '$destructiveForeground' },
      outline: { borderColor: '$border', borderWidth: 1 },
      // ...
    },
    size: { /* ... */ },
  } as const,
  defaultVariants: { variant: 'default', size: 'default' },
})

export function Button({ className, variant, size, asChild, ...props }) {
  const Comp = asChild ? Slot : StyledButton
  // className escape hatch preserved for incremental migration
  return <Comp variant={variant} size={size} className={className} {...props} />
}
```

**4. Theme provider migration:**

```tsx
// apps/orchestrator/src/routes/__root.tsx
import { TamaguiProvider } from '@tamagui/core'
import { tamaguiConfig } from '~/tamagui.config'

function RootComponent() {
  const { resolvedTheme } = useTheme() // existing hook, unchanged signature
  return (
    <TamaguiProvider config={tamaguiConfig} defaultTheme={resolvedTheme}>
      <Theme name={resolvedTheme}>
        <Outlet />
      </Theme>
    </TamaguiProvider>
  )
}
```

**5. Worker-leak guard — `scripts/check-worker-tamagui-leak.sh`:**

```bash
#!/usr/bin/env bash
set -euo pipefail
LEAKS=$(grep -rE "from ['\"]@tamagui" apps/orchestrator/src/server*.ts 2>/dev/null || true)
if [[ -n "$LEAKS" ]]; then
  echo "ERROR: @tamagui import detected in Worker entry — leak would bloat Worker bundle:"
  echo "$LEAKS"
  exit 1
fi
echo "OK: no @tamagui imports in apps/orchestrator/src/server*.ts"
```

Wired into `apps/orchestrator/package.json`:
```json
"scripts": {
  "typecheck": "tsc --noEmit && bash ../../scripts/check-worker-tamagui-leak.sh"
}
```

### Gotchas

- **Tamagui v2-RC + Vite 8** is untested in any release notes found.
  P0 spike must validate this combination explicitly. If `extract:true`
  fails on Vite 8, Path A falls back to runtime-only (no compiler →
  no §10.5 gate firing → P1 doesn't deliver its hypothesis test).
- **Radix Slot** must stay imported from `@radix-ui/react-slot` for
  `asChild` polymorphism in the migrated button/badge — this is one
  of the 3 keep-forever Radix families. Don't remove it.
- **`@tamagui/themes` ships its own default tokens** — we override
  with our own from `theme.css`. Don't mix; pick one source of truth
  per token.
- **Tailwind cascade ordering** during P1a: Tailwind reset must load
  *before* Tamagui's CSS (which is none in runtime mode, but matters
  for P1b compiler output). Confirm via DevTools Elements panel that
  Tamagui-generated styles override Tailwind defaults where intended.
- **`vite-ui-theme` cookie name is load-bearing** — change it and
  every existing user's saved theme resets. Migration must preserve
  the cookie name and value semantics.
- **Vitest config update** is defensive — P1 adds no tests, but if
  any future test imports a Tamagui component, vitest will fail
  without the plugin. Add it now while we're touching `vite.config.ts`.
- **OneStack (Path B) is Beta + bundles its own opinions on
  Tamagui version.** If Path B is chosen, the Tamagui v2-RC pin is
  partly dictated by what One ships, not by us.
- **`packages/ai-elements`** keeps Tailwind. The `@source
  "../../packages/ai-elements/src"` directive **stays in
  `apps/orchestrator/src/styles.css`** — do not move it to a
  sibling file. Per B4 the partial teardown removes orchestrator-
  owned `@theme`/`@custom-variant`/`@apply` content but the
  `@import "tailwindcss"` + `@source` lines remain so ai-elements'
  Tailwind classes continue to resolve. (An earlier draft of this
  spec proposed moving the directive to a sibling `ai-elements.css`;
  decision was reversed during review — keeping it in `styles.css`
  is simpler and matches the "Tailwind processing scoped to
  ai-elements" model.)
- **`react-offscreen-patch.ts` import side-effect** — the file
  patches `CSSStyleDeclaration.prototype.setProperty` at module
  load. It's gated to `import.meta.env.SSR === false &&
  isNative()`. Removing it cleanly requires deleting both the file
  and the conditional import in `main.tsx`.
- **`apps/mobile/capacitor.config.ts`'s `webDir`** literally
  references `../orchestrator/dist/client`. P1 changes nothing in
  that file; OTA pickup is automatic on next Capgo push.
- **`pnpm build` runs in the orchestrator workspace, not root.**
  `pnpm ship` is the production build invocation — but per
  `.claude/rules/deployment.md`, never run it manually; the infra
  pipeline owns deploys.

### Reference Docs

- `planning/research/2026-04-28-gh125-tamagui-p0-codebase-research.md` — P0 codebase research; per-item findings the spec is built from
- `planning/research/2026-04-23-react-native-pivot-evaluation.md` — parent research; §10.4/§10.7 frame for the 4-phase universalization
- [Tamagui — Why a Compiler](https://tamagui.dev/docs/intro/why-a-compiler) — atomic CSS extraction, hoisting, flattening explained; the §10.3 hypothesis comes from this doc
- [Tamagui — Vite Guide](https://tamagui.dev/docs/guides/vite) — plugin install + config, baseline integration shape
- [Tamagui — Themes](https://tamagui.dev/docs/intro/themes) — `<Theme>` component, token shape, dark mode pattern
- [OneStack docs](https://onestack.dev/docs/introduction) — Path B framework option; reference for spike Path B
- [OneStack — Tamagui guide](https://onestack.dev/docs/guides-tamagui) — Tamagui setup under One; spike Path B follows this
- [Tamagui issue #3582 — TamaguiProvider destructuring on React 19](https://github.com/tamagui/tamagui/issues/3582) — known v2-RC issue affecting our React 19 setup
- [Tamagui issue #3406 — vite-plugin Storybook incompat](https://github.com/tamagui/tamagui/issues/3406) — vite-plugin ESM/CJS issues; relevant if spike A hits ESM resolution errors
- `.claude/rules/deployment.md` — infra-pipeline deploy contract; OTA bundle build script reference
- `.claude/rules/worktree-setup.md` — per-worktree port derivation; relevant for local dev/spike on this branch
