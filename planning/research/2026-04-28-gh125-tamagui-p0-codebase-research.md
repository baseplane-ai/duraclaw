---
date: 2026-04-28
topic: P1 Tamagui adoption in apps/orchestrator (web only) — P0 codebase research
type: feature
status: complete
github_issue: 125
items_researched: 7
parent_research: planning/research/2026-04-23-react-native-pivot-evaluation.md
---

# P0 research — Tamagui adoption in `apps/orchestrator` (web only)

GH#125. Phase 0 of the planning workflow for the first chunk of the RN pivot
recommended in §10.7 of the 2026-04-23 RN pivot evaluation.

## Context

The 2026-04-23 doc recommended a 4-phase universalization (P1 Tamagui web →
P2 react-native-web → P3 Expo native → P4 Maestro eval). This research
covers **P1 only** — Tamagui adoption inside the existing CF Workers + Vite
8 web build, with **no RNW, no Expo, no native target.** Its hypothesis
(§10.3 of parent doc): a non-trivial fraction of the perf patches we've
been shipping all month are CSS-in-JS hook-driven re-render thrash that
Tamagui's optimizing compiler eliminates.

Seven parallel Explore agents investigated the migration surface, the
hypothesis, and the external (Tamagui April 2026) state.

## TL;DR

Three findings reshape the spec materially. Only one of them is in the
parent doc.

1. **The hypothesis holds for ~3 of the 5 perf patches we've been
   shipping, not all 5.** §4 below: 1 *probable* (#55/#56 session-switch
   triple-render — canonical CSS-in-JS whole-tree re-render), 2 *plausible*
   (`react-offscreen-patch.ts`, #54 virtualization storms), 2
   *unsupported* (mount-jitter cache 3095762, visibility-gate aefe016 —
   pure DOM measure/reflow timing, not styling). The spec's success
   criteria should not promise "all five patches go away." It should
   measure the #55/#56 pattern specifically.

2. **The Tamagui *compiler* — which delivers the perf wins — has
   integration risk on our exact stack** (Vite 8 + CF Workers + React 19),
   but Tamagui's *runtime* doesn't. That splits P1 into two sub-phases
   the parent doc didn't anticipate: P1a (runtime-only adoption, no
   perf claim, low risk, lays plumbing) and P1b (compiler on, measure
   the §10.5 gate). External research is **YELLOW LIGHT** — v2.0.0
   still RC, vite-plugin has open bugs (Windows paths, config
   discovery, ESM/CJS mismatch), Vite 8 untested in release notes,
   zero documented Cloudflare Workers SSR path. Recommend a 1-day
   spike before P1a to confirm the compiler installs cleanly.

3. **Sidebar is 705 LOC in one file with 23 subcomponents** — 28% of
   the entire `components/ui/` layer. It's not a primitive. It needs
   its own migration sub-phase or has to be explicitly excluded from
   P1's scope.

The 17 Radix families (parent doc said 19) split cleanly: 5 migrate in
P1, 9 defer to P3+Zeego, 3 keep forever. Theme system is a clean
migration. Tailwind 4 footprint is 269 LOC of CSS plus 89 occurrences
of complex `data-[*]`/`[&_*]` selectors that need codemod or hand-port.

## Scope

7 deep-dive items, each fielded by one Explore agent. All in-repo
except #7 (external Tamagui state).

| # | Item | Source | Output |
|---|---|---|---|
| 1 | UI primitive inventory | `apps/orchestrator/src/components/ui/` | Per-file table, migration class A/B/C/D, top-5 usage |
| 2 | Theme + dark-mode system | `theme-provider.tsx`, `theme.css`, `styles.css` | Architecture + Tamagui mapping table |
| 3 | Tailwind 4.2.2 footprint | `styles.css`, `theme.css`, `vite.config.ts` | Tokens, custom utilities, hard incompatibilities |
| 4 | Perf-pain validation | `react-offscreen-patch.ts`, #54/#55/#56 commits, mount-jitter | Per-patch verdict + spec gate metrics |
| 5 | Radix usage map | `package.json`, all `components/ui/*` | 17-family migrate/keep/defer-zeego split |
| 6 | Vite + bundler integration | `vite.config.ts`, `vitest.config.ts`, `wrangler.toml` | Plugin insertion point + blockers |
| 7 | Tamagui April 2026 (external) | Tamagui docs, GitHub issues, npm | TL;DR YELLOW + showstoppers |

## Findings

### 1. UI primitive inventory — `components/ui/` (2,489 LOC, 28 files)

Validates parent doc's 2,489 LOC figure exactly.

**Migration class distribution:**

| Class | Count | LOC | Examples |
|---|---|---|---|
| A — pure styling (direct Tamagui swap) | 13 | ~589 | button, badge, card, separator, input, label, switch, tabs, etc. |
| B — Radix-portal-based | 8 | ~882 | dialog, alert-dialog, dropdown-menu, select, popover, tooltip, sheet |
| C — complex composite (bespoke port) | 2 | ~864 | **sidebar 705**, command 159 |
| D — trivial/external passthrough | 3 | ~91 | input-otp, sonner, command-cmdk |

**Top 5 highest-usage primitives:**

1. `button.tsx` — 25+ import sites
2. `card.tsx` — 9+
3. `dropdown-menu.tsx` — 8+
4. `sidebar.tsx` — 8+
5. `dialog.tsx` — 7+

**Internal cross-dependencies that constrain migration order:**

- `sidebar.tsx` imports 8 other primitives — must migrate after all of them
- `command.tsx` imports `dialog.tsx` — dialog before command
- `alert-dialog.tsx` imports `button.tsx` — button before alert-dialog
- `sheet.tsx` reuses `@radix-ui/react-dialog` directly — share fate with dialog

**Notable:** `sheet.tsx` (128 LOC) shares the `@radix-ui/react-dialog`
package with `dialog.tsx` — they are the same Radix primitive with
different presentation. Migrate together.

### 2. Theme + dark-mode system — clean migration

- **Shape:** Context-based React `ThemeProvider`
  (`apps/orchestrator/src/context/theme-provider.tsx:1-107`) with
  cookie persistence (`vite-ui-theme`, 1-year TTL), class-based dark
  mode (`.dark` on `<html>`).
- **CSS variable count:** 31 in `:root`, 23 overrides in `.dark`,
  30+ Tailwind aliases in `@theme inline` block. OKLch color space
  throughout (`apps/orchestrator/src/styles/theme.css:1-120`).
- **Media query usage in JS:** 3 sites — 2 in `theme-provider.tsx`
  for system pref, 1 in `hooks/use-mobile.tsx` (`useSyncExternalStore`
  + `matchMedia('(max-width: 767px)')`).
- **Re-render risk:** ThemeProvider's context value is properly
  memoized; no whole-tree re-render risk from theme. `useIsMobile`
  has a minor allocate-per-render `mql` pattern but isn't load-bearing.

**Mapping to Tamagui:**

| Current | Tamagui |
|---|---|
| `useTheme()` context | `useTheme()` hook |
| `vite-ui-theme` cookie | Tamagui theme store + cookie shim |
| `window.matchMedia()` listener | `useMedia('dark')` |
| `.dark` class on `<html>` | `<Theme name="dark">` wrapper |
| `--background`, `--foreground`, ... (54 vars) | `$background`, `$foreground` tokens |
| `dark:` Tailwind utilities | Native styled props |

**Migration class:** **clean** — straight tokenization, no per-feature
themes, no dynamic theming.

### 3. Tailwind 4.2.2 footprint — 269 CSS LOC + 89 inline complex selectors

- **Tokens (`@theme` block, `theme.css:75-120`):** 24 colors + 4 radii
  + 2 fonts. All map cleanly to Tamagui tokens.
- **Custom utilities (`styles.css`):** 3 — `container` (trivial),
  `no-scrollbar` (escape-hatch), **`faded-bottom` (lines 76-78,
  hard — pseudo-element gradient with `@apply` composition)**.
- **Custom variants:** 1 — `@custom-variant dark` (line 25). Becomes
  redundant under Tamagui's `<Theme>` system.
- **`@apply` usage:** 4 sites total. 3 simple, 1 complex (line 77 —
  the `faded-bottom` pseudo-element). `@apply` doesn't exist in
  Tamagui; needs hand-port or scoped CSS escape hatch.
- **Hard-incompatibility list:**
  - Pseudo-element compositions (line 77) — keep as scoped CSS
  - `@source inline()` safelist (lines 14-23) — covers `ai-elements`
    package + `is-user`/`is-assistant` role styling. Needs decision:
    refactor `ai-elements` to Tamagui or keep CSS escape hatch.
  - 89 occurrences of `data-[state=*]` / `[&_*]` / `has-[*]` patterns
    across 28 component files. Tamagui's variant + props system
    replaces most; but some (e.g., `**:data-[slot=*]:h-12` in
    `command.tsx:49`) need bespoke wrappers.
  - Sidebar's CSS-var arbitrary calc: `w-(--sidebar-width)`,
    `h-[calc(var(--sidebar-width-icon)+(--spacing(4)))]`
    (`sidebar.tsx:162,214,227`) — convert to Tamagui token spacing.

### 4. Perf-pain validation (CRITICAL — drives the §10.5 gate)

| Patch | Failure mode | Tamagui mapping | Verdict |
|---|---|---|---|
| `react-offscreen-patch.ts:1-51` | React 19 Offscreen scheduler micro-timing on Android WebView | Component flattening contracts the Offscreen subtree | **plausible** |
| #55/#56 session-switch triple-render (commit `46d99de`) | `useLiveQuery` triple-emit (REST → WS snapshot → WS delta) churns Virtuoso `data` identity → 6.4s of re-render waste on heavy session | **Canonical hook-driven whole-tree re-render** — exactly what compiler's `useMedia`/`useTheme` evaluation eliminates | **probable** |
| #54 virtualization + re-render storms (commit `4752f15`) | Architectural re-render thrash from per-tab live-queries, fresh refs, Yjs awareness churn | Compiler shrinks the consumer surface (smaller tree) but doesn't replace the hoist-and-memo work | **plausible** |
| Remount-jitter cache (commit `3095762`) | DOM measure → reflow timing in Virtuoso | Pure layout problem, not styling | **unsupported** |
| Mount-jitter visibility gate (commit `aefe016`) | Same as above — paint settle ordering | Same — layout, not styling | **unsupported** |

**Aggregate:** 1 probable, 2 plausible, 2 unsupported.

**The patch evidence does not support "Tamagui makes all five problems
go away."** It does support "the #55/#56 pattern — hook-driven
multi-emit cascading through prop-identity churn — is exactly the
shape Tamagui's compiler addresses." That's the metric the spec gate
must measure.

**Concrete §10.5 gate metrics (proposed for the spec):**

1. **Session-switch root render time** (React DevTools Profiler).
   Baseline post-#55/#56: ~1000ms on heavy session. **Target post-P1:
   <300ms.**
2. **Re-render cascade per keystroke in composer** (count of
   unrelated-sibling renders on `ChatThread`/`StatusBar`/sidebar).
   Baseline: 20–40 ticks. **Target: <10 ticks.**
3. **Lighthouse delta on `/sessions` and `/projects`.** Tamagui docs
   claim ~15-point recovery from "compiler on." **Target: +10
   minimum, +15 stretch.**
4. **`react-offscreen-patch.ts` decision after measurement** —
   *plausible* not *probable*; keep through P1, decide post-gate.

**Profiler instrumentation files** for the spec to wire up:

- `routes/__root.tsx` — root → first paint
- `features/agent-orch/AgentDetailView.tsx` — session-switch deltas
- `components/layout/sidebar.tsx` — unrelated-cascade-on-typing
- `features/agent-orch/ChatThread.tsx` — virtualization render count

### 5. Radix usage map — 17 functional families (not 19)

Parent doc said 19; actual count in `package.json` is 16 packages
+ 1 wrapped context (`direction`) = **17 functional families**.

**5 migrate in P1 (low-risk, high-leverage):**

| Family | Why migrate |
|---|---|
| `label` | High usage, trivial wrapper, Tamagui has `Label` |
| `separator` | Decorative-only, Tamagui has `Separator` |
| `avatar` | Stateless, clean Tamagui equivalent |
| `collapsible` | Low usage, no portal, clean Tamagui equivalent |
| `tabs` | High usage, no portal, clean Tamagui equivalent |

**9 defer to P3 + Zeego (all portal-based, mobile-native UX matters):**

`dialog`, `alert-dialog`, `dropdown-menu`, `popover`, `select`,
`switch`, `tooltip`, `radio-group`, `checkbox`. All use Radix portals
(fixed positioning, overlay stacking, keyboard interception). Zeego v3
provides native iOS/Android variants on mobile + Radix on web through
a unified API. Migrating these to Tamagui in P1 would be
**re-migrated again in P3** — pure waste.

**3 keep forever:**

| Family | Why keep |
|---|---|
| `slot` | `asChild` polymorphism — Tamagui has it built-in but Radix Slot is a 2-LOC dep with no equivalent |
| `direction` | RTL context provider — Tamagui has no native equivalent |
| `scroll-area` | Web ScrollArea differs fundamentally from RN `ScrollView`; defer to P3 |

**Direct-import sites bypassing wrappers:** only 2 — `config-drawer.tsx`
imports `radio-group` directly, `button.tsx`/`badge.tsx` use `Slot`
directly. Both are intentional.

### 6. Vite + bundler integration — ready with 2 blockers

- **Vite 8.0.3** ✓
- **`jsx: react-jsx`** in `tsconfig.json:8` ✓ (Tamagui requires this)
- **Path aliases** ✓ (`~/` → `./src/`)
- **Clean client/worker boundary** ✓ (`server.ts` is the Worker;
  Tamagui must not leak in)
- **Plugin chain** (`vite.config.ts:41-68`):
  ```
  reactRefreshPreamble → agents → VitePWA → buildHashPlugin
   → cloudflare → react → tailwindcss
  ```
  **Tamagui plugin insertion point: after `cloudflare()`, before
  `react()`** — Tamagui must transform JSX before React plugin's Fast
  Refresh runs.

**Blockers:**

1. **No `@tamagui/vite-plugin` Vite 8 confirmation** in any release
   notes or GitHub issues. Most install docs cite Vite 6. *Assumption
   to verify in spike:* the plugin works on Vite 8 unchanged. Alt path
   is the Babel plugin.
2. **Vitest config has no Tamagui transform.** Component tests will
   fail on first import. Either add `@tamagui/vite-plugin` to
   `vitest.config.ts`, or use the Babel plugin path.

**Worker-leak risk:** `src/server.ts` must never import from
`@tamagui/*`. The spec should add a CI guard (a `import-cost` rule or
a simple grep in `pnpm typecheck`).

**Biome:** no rules that fight Tamagui's JSX shape. ✓

### 7. Tamagui April 2026 — YELLOW LIGHT

**Stability:**

- **v1.144.3** (Jan 2026) — current stable. Recommend.
- **v2.0.0-rc.41** (Apr 15 2026) — still RC. Defer.
- React 19 supported (v1.100+), with open issues (#3582
  TamaguiProvider destructuring under React 19 contexts).

**Vite plugin issues (open on GitHub):**

- **#3302** — Windows path resolution fails (Linux/macOS unaffected;
  CI on Linux is fine)
- **#2583** — `tamagui.config.ts` discovery fails outside project root
  (we're at root, fine)
- **#3406** — Storybook 8 incompat (we don't use Storybook)
- **#2401** — vite-plugin distributed CJS, ESM consumer mismatch
- **No Vite 8 release notes mention.** Treat as untested.

**Web-only adoption:**

- **Not a documented use case.** Tamagui frames itself cross-platform
  first. Web-only works (just install `@tamagui/core` +
  `@tamagui/react-native-web`, skip the compiler), but we'll be
  charting territory.
- **Bundle adds ~25KB gzipped** for `@tamagui/core` runtime-only.
  Compiler-on saves 30-90% of styling output but adds plugin risk.

**Cloudflare Workers SSR:** zero documentation. Tamagui's SSR support
(`@tamagui/ssr`) is generic, but no case studies of Workers
integration. Our orchestrator is a SPA (Vite client + Hono Worker
API), not SSR-driven, so this is **not a blocker for P1** — but the
spec should explicitly scope it out.

**Tailwind coexistence:** documented as workable, with caveats around
CSS reset cascade order. The spec needs to decide: keep Tailwind
loaded in parallel during P1 (incremental migration), or fully tear
out at P1 close.

**Top 3 production gotchas:**

1. **Switch component broken on web by default** (#2699) — needs
   `p={0}` override. Doesn't matter for P1 since Switch is in the
   "defer to P3+Zeego" bucket.
2. **"No theme and no parent" error in production** (#3230, #3372) —
   theme hydration ordering. Mitigate with explicit
   `TamaguiProvider` placement.
3. **Vite plugin config discovery in monorepos** (#2583) — keep
   `tamagui.config.ts` colocated with `vite.config.ts`. We're
   already monorepo-flat enough.

## Comparison

### Migration cost vs. value per primitive class

| Class | LOC | P1 cost | Value | Recommendation |
|---|---|---|---|---|
| A (pure styling) | ~589 | low | high (frequent imports) | **migrate in P1** |
| B (Radix portal) | ~882 | high (rebuild) | low (already works on web; gets re-migrated in P3) | **defer to P3 + Zeego** |
| C (composite) | ~864 | very high | **sidebar 8+ uses, command 1 use** | **sidebar = own sub-phase; command = defer or kept** |
| D (passthrough) | ~91 | n/a | n/a | **keep as-is** |

### Compiler decision matrix

| Stance | Risk | Perf claim | Spec implication |
|---|---|---|---|
| Compiler-off entire P1 | low | none | §10.5 gate cannot fire (no perf delta to measure) — recommend against |
| Compiler-on entire P1 | high (Vite 8 untested) | full | one big bet; if compiler doesn't install, P1 stalls |
| Split P1a runtime / P1b compiler | low → medium | none → full | clean gate placement — **recommended** |
| Spike compiler before P1a | minimal | n/a | de-risks P1b before committing to it — **recommended** |

## Recommendations

Synthesizing the seven items into spec direction:

1. **Run a 1-day Tamagui-compiler-on-Vite-8-with-CF-Workers spike
   *before* P1a starts.** Output: green/yellow/red on the compiler.
   If green, proceed. If red, P1 falls back to runtime-only
   (acknowledging the §10.5 gate can't fire without the compiler — at
   which point we should question whether P1 is worth doing standalone
   vs. rolling its non-compiler-dependent value into P2).

2. **Split P1 into P1a + P1b:**
   - **P1a — Plumbing.** Install `@tamagui/core` runtime, build
     `tamagui.config.ts` from current 31+23 CSS vars + 24 color
     tokens, migrate the 5 trivial Radix families (label, separator,
     avatar, collapsible, tabs) and the 13 Class-A primitives. Theme
     toggle wired through `<Theme>` + `useMedia`. Tailwind stays in
     parallel. **Ships independently. No perf claim.**
   - **P1b — Compiler + measurement.** Add `@tamagui/vite-plugin` to
     Vite + Vitest. Wire `<Profiler>` instrumentation in the four
     identified files. Run measurement against the §10.5 gate
     (session-switch <300ms, cascade <10 ticks, Lighthouse +10–15).
     Decide on `react-offscreen-patch.ts` removal based on results.

3. **Explicitly scope sidebar (705 LOC) out of P1.** Either:
   - **P1c sub-phase** — bespoke sidebar port post-P1b
   - **defer indefinitely** — keep sidebar on Tailwind through P2+P3
   The interview should pick one.

4. **Explicitly scope the 9 Radix portal families out of P1**, defer
   to P3 + Zeego. They will be re-migrated in P3 anyway; doing them
   in P1 doubles the work.

5. **Pin Tamagui to v1.144.3.** Re-evaluate v2 only after stable
   release.

6. **Tailwind teardown is a P1c question, not a P1a/b question.**
   During P1a + P1b, Tailwind stays loaded; reset-cascade ordering is
   the only coexistence concern.

7. **Adjust the §10.5 gate language** in the spec: drop "all
   patches go away" framing; replace with the four concrete metrics
   in §4 above.

## Open questions (for P1 interview)

1. **Compiler spike: do we run a 1-day Tamagui+Vite8+CF-Workers
   spike before P1a, or skip the spike and discover risk inside
   P1a?** Recommendation: spike. Cost <1 day, eliminates the
   highest-uncertainty failure mode.
2. **P1 split into P1a (runtime/plumbing) + P1b (compiler/gate), or
   one-shot?** Recommendation: split — clean gate placement,
   independently shippable.
3. **Sidebar (705 LOC) in P1, deferred to its own P1c sub-phase, or
   indefinitely on Tailwind?** Recommendation: P1c sub-phase, post-
   P1b. Don't block P1 gate on sidebar correctness.
4. **9 Radix portal families: confirm defer to P3 + Zeego (not
   migrated in P1)?** Recommendation: confirm.
5. **Tailwind during P1: keep loaded in parallel through P1a + P1b,
   tear out only after sidebar/command migrate?** Recommendation:
   parallel through P1; teardown in P1c or later.
6. **`react-offscreen-patch.ts`: keep through P1, decide post-gate?**
   Recommendation: yes — the patch is *plausible* not *probable* in
   §4; we need measurement to decide.
7. **CI guard against Tamagui leaking into Worker bundle
   (`src/server.ts`)?** Recommendation: simple grep in CI or
   `import-cost`-style rule.
8. **Pin Tamagui at v1.144.3?** Recommendation: yes; defer v2 to
   post-stable.
9. **Freeze policy on `apps/orchestrator` UI feature work during
   P1?** Recommendation: no freeze — parallel impl-agents, AI
   velocity. Ratify or override.

## Next steps

P1 (interview) — gather decisions on the 9 open questions, then
proceed to P2 (spec writing) with the answers folded into behaviors
+ phases.

## Sources

In-repo (per-item agent reports):

- `apps/orchestrator/src/components/ui/` (28 files, 2,489 LOC)
- `apps/orchestrator/src/context/theme-provider.tsx:1-107`
- `apps/orchestrator/src/styles/theme.css:1-120`
- `apps/orchestrator/src/styles.css:1-149`
- `apps/orchestrator/src/lib/react-offscreen-patch.ts:1-51`
- `apps/orchestrator/src/hooks/use-mobile.tsx:1-16`
- `apps/orchestrator/vite.config.ts:1-68`
- `apps/orchestrator/vitest.config.ts`
- `apps/orchestrator/wrangler.toml`
- `apps/orchestrator/package.json`
- `apps/orchestrator/tsconfig.json:8`
- Commits: `46d99de` (#55/#56), `4752f15` (#54), `3095762`,
  `aefe016`

External:

- [Tamagui v2 Blog](https://tamagui.dev/blog/version-two)
- [Tamagui Why a Compiler](https://tamagui.dev/docs/intro/why-a-compiler)
- [Tamagui Vite Guide](https://tamagui.dev/docs/guides/vite)
- GitHub Tamagui issues: #3582, #3302, #2583, #3406, #2401, #2699,
  #3230, #3372
- [Tamagui Feb 2026 release notes](https://useaxentix.com/blog/tamagui/tamagui-latest-version-february-2026/)

Parent research: `planning/research/2026-04-23-react-native-pivot-evaluation.md`
