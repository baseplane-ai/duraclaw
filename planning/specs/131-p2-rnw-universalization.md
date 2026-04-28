---
initiative: rn-pivot-p2-rnw
type: project
issue_type: feature
status: approved
priority: high
github_issue: 131
created: 2026-04-28
updated: 2026-04-28
predecessors:
  - "GH#125 / PR #127 — P1 Tamagui adoption (merged 2026-04-28)"
blocked_by:
  - "GH#130 — P1c post-merge verification (gates IMPLEMENTATION only, not spec)"
phases:
  - id: pA
    name: "Vite + RNW config — install lite RNW, alias, ssr.noExternal, optimizeDeps"
    tasks:
      - "Install @tamagui/react-native-web-lite at exact version 2.0.0-rc.41 (matching @tamagui/core pin) into apps/orchestrator/package.json dependencies"
      - "Extend apps/orchestrator/vite.config.ts resolve.alias (lines 40-43) to add 'react-native': '@tamagui/react-native-web-lite' — must be set BEFORE the existing tamaguiPlugin() so the compiler sees the correct target"
      - "Add new ssr block to apps/orchestrator/vite.config.ts: ssr: { noExternal: ['react-native-web', 'react-native', '@tamagui/react-native-web-lite'] } — load-bearing, prevents RNW polyfills from leaking into the CF Worker bundle"
      - "Add new optimizeDeps block to apps/orchestrator/vite.config.ts: optimizeDeps: { exclude: ['react-native-web', 'react-native', '@tamagui/react-native-web-lite'] } — respects the RNW browser field, prevents Vite pre-bundling collapse"
      - "Verify pnpm dev still launches and renders the existing post-PR-127 hello-world Tamagui surfaces (login, sessions, settings)"
      - "Verify pnpm build emits dist/client + dist/<worker>; document Worker bundle size delta and client bundle size delta in PR description (NOT a hard gate per D1 — CI guard in pB is the real protection)"
    test_cases:
      - id: pA-1
        description: "pnpm typecheck passes including new vite.config.ts changes"
        type: smoke
      - id: pA-2
        description: "pnpm build emits both bundles cleanly; PR description includes 'Worker delta: +X KB' and 'Client delta: +Y KB' lines"
        type: smoke
      - id: pA-3
        description: "All 10 P1 smoke flows from spec 125 §Verification Plan still pass post-RNW alias swap (no visual regression)"
        type: smoke
  - id: pB
    name: "CI guard extension — block react-native[-web] imports in Worker"
    tasks:
      - "Modify scripts/check-worker-tamagui-leak.sh:11 — replace existing single-pattern grep with: LEAKS=$(grep -rE \"from ['\\\"](@tamagui|react-native-web|react-native)\" $TARGET_GLOB 2>/dev/null || true)"
      - "Update the file's leading comment to document P1a (GH#125) + P2 (GH#131) history and the three banned module families with rationale"
      - "Verify guard fails when a deliberate test import 'import { View } from \"react-native\"' is added to apps/orchestrator/src/server.ts — then revert the test import"
      - "Verify guard fails when a deliberate test import 'import { View } from \"react-native-web\"' is added to apps/orchestrator/src/server.ts — then revert"
      - "Verify guard still fails on @tamagui imports (preserves PR #127 behavior)"
    test_cases:
      - id: pB-1
        description: "pnpm typecheck (which invokes the guard via apps/orchestrator/package.json:10) exits 0 on clean main"
        type: smoke
      - id: pB-2
        description: "Guard exits 1 on each of the three banned module families when injected into server.ts (revert after each)"
        type: smoke
  - id: pC
    name: "Tamagui×RNW CSS smoke check — VP only, no impl"
    tasks:
      - "No code changes. Phase exists to codify the post-deploy verification step that lives in §Verification Plan VP-5"
      - "Spec the exact grep command + minimum acceptance threshold so the verification is deterministic"
    test_cases:
      - id: pC-1
        description: "VP-5 evidence (PR comment with grep output) is present and shows ≥1 hashed atomic class per category before merge"
        type: smoke
  - id: pD
    name: "Web-only lib decisions + Biome defensive rule"
    tasks:
      - "Lint tool is Biome (verified: biome.json at workspace root, no ESLint configs anywhere; lint script at package.json:8 calls scripts/precommit.sh --lint-only)"
      - "Add a new Biome override block to /data/projects/duraclaw-dev6/biome.json (after the existing two overrides at lines 41-91) targeting includes: ['apps/orchestrator/src/**'] with linter.rules.style.noRestrictedImports configured at level 'error' with paths for: @xyflow/react, react-jsx-parser, @rive-app/react-webgl2, media-chrome — each with message 'Banned in apps/orchestrator/src/** until P3 lands feature gates / replacements (GH#131 / GH#132). packages/ai-elements/** remains free to export.'"
      - "Rule scope: orchestrator-only — packages/ai-elements/** remains free to export them (cross-package boundary intact). Achieved by override `includes` pattern matching ONLY apps/orchestrator/src/**"
      - "Document per-lib P3 disposition in §Out of Scope / Known P3 Blockers section in the spec body (see B7 for canonical list)"
      - "Verify lint fails when a test file 'apps/orchestrator/src/_test-lint.ts' adds 'import {} from \"@xyflow/react\"' — then delete the test file"
    test_cases:
      - id: pD-1
        description: "pnpm lint (workspace root, runs Biome check) fails on test imports of any of the 4 banned libs in apps/orchestrator/src/**"
        type: smoke
      - id: pD-2
        description: "pnpm lint passes on packages/ai-elements/** which legitimately uses these libs"
        type: smoke
  - id: pE
    name: "Metro/Expo smoke bundle — hard CI gate, no shipped artifact"
    tasks:
      - "Install minimum Expo subset at exact pinned versions: expo, metro, @expo/metro-runtime. Do NOT install device-runtime packages (expo-modules-core, expo-asset, expo-dev-client, etc.)"
      - "Create apps/orchestrator/app.json with minimal Expo manifest pointing main to './src/entry-rn.tsx' so Metro discovers the entry. Template: {\"expo\": {\"name\": \"duraclaw-orchestrator\", \"slug\": \"duraclaw-orchestrator\", \"main\": \"./src/entry-rn.tsx\", \"platforms\": [\"web\"]}}. ~10 LOC. Required by `npx expo export` invocation in scripts/check-metro-bundle.sh"
      - "Create apps/orchestrator/metro.config.js with pnpm-monorepo recipe: watchFolders: [path.resolve(__dirname, '../../node_modules')], resolver: { unstable_enablePackageExports: true, unstable_enableSymlinks: true }, transformer: minimal (rely on Expo defaults). Target ~80 LOC"
      - "Create apps/orchestrator/src/entry-rn.tsx (5-10 LOC) — branched RNW entry point. Imports the same router/app shell as entry-client.tsx but swaps ReactDOM.createRoot for AppRegistry.registerComponent + AppRegistry.runApplication"
      - "Create scripts/check-metro-bundle.sh: runs `metro build --platform web --entry apps/orchestrator/src/entry-rn.tsx --out /tmp/metro-smoke-bundle.js` (or the equivalent Expo CLI invocation), exits 0 on bundle emission, exits 1 on any resolver/transform error"
      - "Wire scripts/check-metro-bundle.sh into the orchestrator's typecheck script (or a new pnpm verify:metro target invoked from the same CI step). Hard gate per D3 — failure blocks PR merge"
      - "Verify smoke test passes against current orchestrator source (baseline)"
      - "Verify smoke test FAILS when entry-rn.tsx is given a deliberate broken import; then revert"
    test_cases:
      - id: pE-1
        description: "scripts/check-metro-bundle.sh exits 0 on clean main"
        type: smoke
      - id: pE-2
        description: "metro build emits a bundle file at the expected path containing the orchestrator route tree (grep for a known route export confirms presence)"
        type: smoke
      - id: pE-3
        description: "Smoke test exits 1 when given a broken entry import (negative-path test, then revert)"
        type: smoke
---

# P2: Universalize Orchestrator via react-native-web

> GitHub Issue: [#131](https://github.com/baseplane-ai/duraclaw/issues/131)
> Predecessors: GH#125 / PR #127 (P1 Tamagui adoption — merged 2026-04-28)
> Implementation gated on: GH#130 close (P1c post-merge verification)

## Overview

Phase 2 of the React Native pivot. Swap the orchestrator's primitive
renderer from web-only DOM (Tamagui's "core-only" mode emitting raw
`<div>`/`<span>`) to **react-native-web** primitives (`<View>`/`<Text>`)
via `@tamagui/react-native-web-lite`. The web build keeps shipping
unchanged because RNW translates back to DOM transparently. After this
phase, the same component code is *capable* of running native — this
unlocks P3 (Expo SDK 54, GH#132) without forcing it. To make that
capability concrete rather than theoretical, P2 also lands a hard CI
gate that runs `metro build` on the orchestrator source on every PR.

## Non-Changes Confirmed

The research+interview phase verified these are NOT being touched in P2:

- **TanStack Router** — no changes. Codebase already uses 100%
  programmatic `useNavigate()` (zero `<Link>` / `<a href>` usage); router
  layer survives the renderer swap untouched (see B10 below for the
  positive-confirmation behavior).
- **Capacitor `apps/mobile`** — untouched, ships pre-Tamagui bundle
  until manual OTA per GH#130. P3 will replace it with Expo RN.
- **D1 dashboard / D1 schema / DO migrations** — N/A; this is a
  client-rendering and build-pipeline change.
- **Tamagui plugin config** at `apps/orchestrator/vite.config.ts:100-108`
  — no change needed. The plugin auto-detects RNW once the alias is set.

## Feature Behaviors

### B1: vite-rnw-alias

**Core:**
- **ID:** `vite-rnw-alias`
- **Trigger:** Vite resolves any module specifier `react-native` (or
  `react-native/<subpath>`) anywhere in the orchestrator client bundle
- **Expected:** Resolution returns `@tamagui/react-native-web-lite`'s
  module(s); Tamagui compiler sees the web target and emits atomic CSS
  for primitives (View/Text/Pressable)
- **Verify:** After `pnpm build`, grep `dist/client/assets/*.js` for
  `react-native-web-lite` (should appear); grep for raw
  `react-native/Libraries` paths (should NOT appear — that would
  indicate the alias didn't fire)
- **Source:** `apps/orchestrator/vite.config.ts:40-43` (resolve.alias —
  add new line)

#### UI Layer
N/A — build-time configuration. Visible effect: existing post-PR-127
Tamagui surfaces continue rendering with no visual regression.

#### API Layer
N/A.

#### Data Layer
N/A.

---

### B2: rnw-ssr-no-external

**Core:**
- **ID:** `rnw-ssr-no-external`
- **Trigger:** Vite builds the CF Worker bundle (`src/server.ts` entry)
- **Expected:** `react-native-web`, `react-native`, and
  `@tamagui/react-native-web-lite` are listed in `ssr.noExternal` so
  Vite never shares chunks containing RNW polyfills with the Worker
  bundle. CF Worker bundle remains free of any RNW-runtime bytes (~500
  KB savings vs the worst-case shared-chunk leak).
- **Verify:** `pnpm build` then `grep -E
  '(react-native|@tamagui/react-native-web-lite)'
  apps/orchestrator/dist/duraclaw_orchestrator/index.js` returns 0
  matches.
- **Source:** `apps/orchestrator/vite.config.ts` (new `ssr` top-level
  block)

#### UI Layer
N/A.

#### API Layer
N/A.

#### Data Layer
N/A.

---

### B3: rnw-optimize-deps

**Core:**
- **ID:** `rnw-optimize-deps`
- **Trigger:** Vite dev server cold start or production build
  optimization pass
- **Expected:** `optimizeDeps.exclude` lists the three RNW-related
  packages so Vite respects RNW's `package.json#browser` field and does
  not pre-bundle them into a single CJS chunk (which would defeat the
  alias and the noExternal contract)
- **Verify:** `pnpm dev` starts cleanly; opening the orchestrator at
  `localhost:43XXX` (port per worktree) renders without a "RNW failed
  to optimize" Vite warning in the dev server log
- **Source:** `apps/orchestrator/vite.config.ts` (new `optimizeDeps`
  top-level block)

#### UI Layer
N/A.

#### API Layer
N/A.

#### Data Layer
N/A.

---

### B4: ci-guard-extended

**Core:**
- **ID:** `ci-guard-extended`
- **Trigger:** Any PR adds `import ... from 'react-native'`,
  `'react-native-web'`, `'@tamagui/...'`, or `'@tamagui/react-native-web-lite'`
  into `apps/orchestrator/src/server*.ts`
- **Expected:** `pnpm typecheck` (which invokes
  `scripts/check-worker-tamagui-leak.sh` per
  `apps/orchestrator/package.json:10`) fails with a clear error message
  naming the file:line of the leaked import
- **Verify:** Inject a test `import { View } from 'react-native'` into
  `src/server.ts`, run `pnpm typecheck`, confirm exit code 1 with the
  file:line in the error output; revert the test import
- **Source:** `scripts/check-worker-tamagui-leak.sh:11` (regex
  extension)

#### UI Layer
N/A.

#### API Layer
N/A.

#### Data Layer
N/A.

---

### B5: tamagui-rnw-atomic-css

**Core:**
- **ID:** `tamagui-rnw-atomic-css`
- **Trigger:** `pnpm build` runs the Tamagui compiler over orchestrator
  source after the RNW alias is in place
- **Expected:** Tamagui's atomic-CSS extraction continues to emit
  hashed classes (`_alignItems-*`, `_dsp-flex`, `_fd-*`, `_jc-*`) into
  `dist/client/assets/*.css`. Runtime fallback (style generation in JS)
  must NOT be triggered as the steady state — that would defeat the
  perf win from PR #127's compiler enablement (`extract: true`).
- **Verify:** Post-deploy, run `grep -E '_(alignItems|dsp|fd|jc)-'
  dist/client/assets/*.css | head -20` and paste the output as a
  comment on the P2 PR (per D4). At least 1 hashed class per category
  must be present.
- **Source:** N/A — this is an emergent behavior of the existing
  Tamagui plugin config under the new alias, not a code change. Phase
  pC exists to codify the verification step.

#### UI Layer
Emergent: existing Tamagui surfaces render with the same visual fidelity
as post-PR-127. If atomic CSS silently breaks, runtime styles still
apply (correctness preserved) but with a perf cost — surfaced via the
VP-5 evidence requirement.

#### API Layer
N/A.

#### Data Layer
N/A.

---

### B6: orchestrator-rnw-render

**Core:**
- **ID:** `orchestrator-rnw-render`
- **Trigger:** Browser loads any orchestrator route (`/`, `/login`,
  `/board`, `/settings`, etc.) post-P2 deploy
- **Expected:** All Tamagui primitive components render via the RNW
  path (View → div, Text → span/p, Pressable → button/div with role).
  Visual fidelity matches post-PR-127 baseline. Same component source
  is now *capable* of running on native (P3 will exercise this).
- **Verify:** Visual smoke check — re-run the 10 smoke flows from spec
  `125-p1-tamagui-orchestrator-web.md` §Verification Plan (login,
  session list, open session, send message, theme toggle ×2, kanban,
  file viewer, settings save, sign out, dark/light/system tri-state).
  No visual regression. Inspector-tooled spot check: `<View>`
  components in the React DevTools tree should render as div elements
  (RNW translation working).
- **Source:** N/A — emergent from B1+B2+B3.

#### UI Layer
The 10 P1 smoke flows render identically. The presence of RNW under
the hood is invisible to end users; the only observable difference for
developers is a slightly larger client bundle (~150 KB gzipped delta,
documented in PR per D1, not gated).

#### API Layer
N/A.

#### Data Layer
N/A.

---

### B7: web-only-lib-biome-restriction

**Core:**
- **ID:** `web-only-lib-biome-restriction`
- **Trigger:** Any orchestrator source file under
  `apps/orchestrator/src/**` adds an `import` from one of the four
  web-only libs: `@xyflow/react`, `react-jsx-parser`,
  `@rive-app/react-webgl2`, `media-chrome`
- **Expected:** `pnpm lint` (which invokes
  `scripts/precommit.sh --lint-only` → `biome check` per
  `package.json:8` workspace root) fails with a clear
  `lint/style/noRestrictedImports` diagnostic citing the banned package
  and the message: "Banned in apps/orchestrator/src/** until P3 lands
  feature gates / replacements (GH#131 / GH#132). packages/ai-elements/**
  remains free to export."
- **Verify:** Add `apps/orchestrator/src/_test-lint.ts` with `import
  {} from '@xyflow/react'`. Run `pnpm lint` from repo root; confirm
  exit code 1. Delete the test file. Repeat for each of the four
  banned libs.
- **Source:** Workspace-root `biome.json` (currently lines 41-91 carry
  two override blocks; add a third targeting
  `apps/orchestrator/src/**` only). `packages/ai-elements/**` is
  explicitly excluded from the new override's `includes` so it remains
  free to import these libs.

#### UI Layer
N/A — developer-facing lint guardrail.

#### API Layer
N/A.

#### Data Layer
N/A.

---

### B8: web-only-lib-p3-disposition

**Core:**
- **ID:** `web-only-lib-p3-disposition`
- **Trigger:** P3 spec writing reads this spec to inherit lib decisions
- **Expected:** Per-lib P3 disposition is documented in the §Out of
  Scope / Known P3 Blockers section below, so P3 spec writing does not
  re-litigate decisions already made
- **Verify:** §Out of Scope section enumerates xyflow, react-jsx-parser,
  Rive, media-chrome with a one-line disposition each
- **Source:** This file (the spec itself).

#### UI Layer
N/A.

#### API Layer
N/A.

#### Data Layer
N/A.

---

### B9: metro-smoke-bundle

**Core:**
- **ID:** `metro-smoke-bundle`
- **Trigger:** PR opens a build against orchestrator source containing
  the new `entry-rn.tsx` and `metro.config.js`
- **Expected:** CI step `scripts/check-metro-bundle.sh` runs `metro
  build --platform web --entry apps/orchestrator/src/entry-rn.tsx` (or
  the equivalent Expo CLI invocation) and exits 0. Bundle is emitted
  to a verified path; CI does NOT ship the artifact (Vite remains the
  production web bundler). Hard gate per D3 — failure blocks merge.
- **Verify:** Run `bash scripts/check-metro-bundle.sh` locally; expect
  exit 0 and bundle file present at the script's documented output
  path. Inject a deliberate broken import into `entry-rn.tsx`, re-run;
  expect exit 1; revert.
- **Source:** New files: `apps/orchestrator/metro.config.js`,
  `apps/orchestrator/src/entry-rn.tsx`,
  `scripts/check-metro-bundle.sh`.

#### UI Layer
N/A — CI-only behavior.

#### API Layer
N/A.

#### Data Layer
N/A.

---

### B10: tanstack-router-unchanged

**Core:**
- **ID:** `tanstack-router-unchanged`
- **Trigger:** Any orchestrator navigation (login → sessions, sidebar
  click, programmatic `useNavigate({ to: ... })`) post-P2 deploy
- **Expected:** Navigation works identically to pre-P2. No code
  changes to `apps/orchestrator/src/router.tsx`,
  `routes/__root.tsx`, `routes/_authenticated/route.tsx`, or any
  `routes/**/*.tsx`. The codebase's 100% programmatic-navigation
  pattern (zero `<Link>`/`<a href>`) is preserved.
- **Verify:** Smoke check during VP-6: login → land on `/`, click
  Sessions, observe URL update; click Settings, observe; Sign Out,
  observe redirect to `/login`. All transitions identical to post-PR-127
  baseline. (Confirms parent research §11.5 conclusion still holds.)
- **Source:** N/A — positive-confirmation behavior, no code change.

#### UI Layer
Routing behavior unchanged.

#### API Layer
N/A.

#### Data Layer
N/A.

---

## Out of Scope / Known P3 Blockers

These four libraries currently live in `packages/ai-elements/` and are
**not imported by `apps/orchestrator/src/**`** today. P2 codifies their
P3 disposition so the P3 spec can act without re-litigating:

| Lib | ai-elements file(s) | P3 disposition |
|-----|---------------------|---------------|
| `@xyflow/react` | `canvas.tsx`, `node.tsx`, `edge.tsx`, `panel.tsx`, `controls.tsx`, `toolbar.tsx` | **Feature-gate web-only** via `Platform.OS === 'web'` check; list-view fallback on native (~1 day at adoption time). Skia port deferred indefinitely. |
| `react-jsx-parser` | `jsx-preview.tsx` (242 LOC) | **Feature-gate web-only** — only option (no RN equivalent; RN runtime has no `eval`). Native fallback: render JSX as a markdown/code-block. |
| `@rive-app/react-webgl2` | `persona.tsx` (277 LOC) | **Replace with `@rive-app/react-native`** (~1-2 weeks port at adoption time). Until ported, fall back to a static avatar image on native. |
| `media-chrome` | `audio-player.tsx` (186 LOC) | **Replace with platform-conditional wrapper** — HTML5 `<audio>` + custom CSS controls on web; `react-native-video` on native. |

**Defensive posture in P2** (per B7): the Biome
`lint/style/noRestrictedImports` rule prevents accidental adoption of
these libs into `apps/orchestrator/src/**` between P2 ship and P3
spec. `packages/ai-elements/` exports remain free.

## Non-Goals

Explicitly out of scope for P2:

- **Native target build/ship** (P3, GH#132). Metro smoke-bundle is a
  feasibility proof only; no native artifact is shipped.
- **Expo Router migration** (P3.5 optional, parent §11.4 option B).
  TanStack Router stays untouched per B10.
- **Capacitor `apps/mobile` changes**. Capacitor still ships
  pre-Tamagui bundle until manual OTA per GH#130. P3 replaces it with
  Expo RN.
- **Replace any of the 4 web-only libs in this PR**. P2 codifies the
  decisions (B8) and locks down accidental adoption (B7); actual
  replacement work is P3.
- **Visual regression detection automation**. VP-5 is a manual grep
  + PR comment check (per D4). Visual diff screenshots are not
  required for P2; they may be added later if regressions appear.
- **Worker bundle size hard gate**. Per D1, Worker bundle delta is
  documented in PR description but not gated. CI import guard (B4) is
  the real protection. Multi-Worker split is the escape hatch if any
  single Worker ever exceeds size limits.
- **Client bundle size hard gate**. Per D1, ~150 KB gzipped delta is
  expected and documented; not gated.
- **Switch to full `react-native-web`**. P2 commits to
  `@tamagui/react-native-web-lite` (per D2 / B1). If P3 surfaces a
  missing API, revert is cheap (one alias line).
- **Auth-redirect platform handling refactor**. `auth-redirect.ts:14`
  uses `window.location.href` for catastrophic auth-expiry; flagged in
  Risks (#5) as a low-impact untested path under RNW. P3 may revisit
  for native; P2 does not.

## Architectural Bets

Decisions hard to reverse later — the spec calls these out so future
maintainers can find them:

### AB-1: `@tamagui/react-native-web-lite` over full `react-native-web`

P2 standardizes on Tamagui's curated subset (~30-40% smaller). Full
RNW is a less-trafficked but possible fallback. Reversal cost: change
one line in `vite.config.ts` resolve.alias + add `react-native-web`
install + re-measure bundle. ~1 hour to revert. Not catastrophic but
worth flagging if P3 surfaces a missing API in the lite fork.

### AB-2: Hard Metro CI gate from P2

If Metro becomes unmaintainable or Expo SDK 54 has a regression, this
gate could block all P2-and-after PRs. No bake-in escape valve in P2;
if needed, follow-up issue switches to informational-only via env flag.
Decision rationale: smoke-bundle's purpose is to prove the native
target is *capable*; an informational-only gate fails that purpose.

### AB-3: `no-restricted-imports` rule scoped to `apps/orchestrator/src/**`

`packages/ai-elements/` remains free to export the four banned libs
(cross-package boundary intact). If we ever fold ai-elements consumers
back into orchestrator (e.g. inline a component), the lint trips.
Acceptable cost; the alternative (banning at workspace root) would be
strictly worse.

## Risks

Decisions where uncertainty remains. Spec writer surfaced these from
the interview; impl phase should monitor.

### R1: Tamagui × RNW × Vite atomic-CSS extraction interaction (untested in the wild)

Tamagui's recipes assume Metro+native and Vite+web in isolation; the
"Vite + RNW + Tamagui" path is less-traveled. If extraction silently
breaks under the alias, runtime style generation falls back (correctness
preserved, perf cost). **Mitigation**: B5 + VP-5 manual smoke check.
**Replan trigger**: if VP-5 evidence shows extraction broken, P2 cuts
back to runtime-mode (`extract: false`) and opens a follow-up issue
against Tamagui.

### R2: `@tamagui/react-native-web-lite` API completeness

P3 may discover a missing RN API the lite fork doesn't ship. **Mitigation**:
AB-1 reversal path is cheap; document the missing API in a P3 follow-up
issue and swap to full RNW.

### R3: Metro × pnpm hoisting fragility

`watchFolders` + `unstable_enablePackageExports` recipe is documented
but version-sensitive. **Mitigation**: D7 exact-pin policy + spec
references known-good Metro version aligned with Expo SDK 54 install.

### R4: Expo SDK 54 metro-only install footprint unknown

Risk of pulling in iOS/Android toolchain bits via transitive deps.
**Mitigation**: pE task explicitly excludes device-runtime packages;
verify post-install that no Xcode/Android Studio integration leaked
into devDependencies.

### R5: `window.location.href` for auth expiry under RNW (untested post-PR-127)

`apps/orchestrator/src/lib/auth-redirect.ts:14` uses `window.location.href`
for catastrophic session loss. Low impact (auth expiry is hard-failure
case anyway; both web and native prefer reload). **Mitigation**:
VP-7 manual smoke check during P2 verification. Not a blocking gate.

### R6: Metro devDep presence × Vite resolver interaction

Metro ships its own resolver and (transitively) its own
`react-native` package. **Concern**: could Metro in `node_modules`
shadow the Vite alias `'react-native': '@tamagui/react-native-web-lite'`?
**Assessment**: very unlikely — Vite's `resolve.alias` is consulted
before the node resolution algorithm runs, so the alias wins regardless
of what's in `node_modules`. devDep installation does not affect
Vite's runtime resolution behavior. **Mitigation**: VP-2 step 2 grep
of the Worker bundle for `react-native` matches catches any unexpected
leak. If a pE Metro install ever flips a Vite resolution outcome,
VP-2 fails immediately. No additional defensive code required for P2.

## Implementation Phases

See YAML frontmatter `phases:` above. Phases are pA → pB → pC → pD →
pE; each is 1-4 hours of focused work. Phases are largely independent
within a single PR but should be reviewed in order.

**Implementation gate** (per D6): P2 implementation MUST NOT START
until GH#130 (P1c verification) closes cleanly. Spec writing (this
session) is unblocked.

## Verification Strategy

### Test Infrastructure

- Vitest with jsdom — config exists at `apps/orchestrator/vitest.config.ts`
- Tamagui plugin already wired into vitest config per spec 125 (so
  component tests don't fail on Tamagui imports). Verify the alias
  introduced in pA doesn't break vitest resolution; if it does, mirror
  the alias in `vitest.config.ts`.
- New: `scripts/check-metro-bundle.sh` — bash smoke test invoked from
  `pnpm typecheck` (or new `pnpm verify:metro`).

### Build Verification

- Use `pnpm build` (not bare `vite build`) for full Worker + client
  artifact emission.
- Use `pnpm typecheck` for the typecheck + tamagui-leak guard combined
  step (per `apps/orchestrator/package.json:10`).
- Use `pnpm dev` to smoke-test dev server startup post-alias.

## Verification Plan

### VP-1: pnpm typecheck passes (CI guard extension working)

Steps:
1. From repo root: `pnpm --filter @duraclaw/orchestrator typecheck`
   Expected: exit code 0; no leaked Tamagui or RNW imports detected;
   stdout includes a "Worker leak guard: 0 matches" or equivalent
   confirmation line from the updated guard script.
2. Inject test import: edit `apps/orchestrator/src/server.ts`, add
   `import { View } from 'react-native'` at top; re-run command.
   Expected: exit code 1; error output names `server.ts` and the
   `react-native` import; revert the edit.
3. Repeat step 2 with `import { View } from 'react-native-web'`.
   Expected: exit 1; error output names `react-native-web`; revert.
4. Repeat step 2 with `import { Stack } from '@tamagui/core'`.
   Expected: exit 1 (preserves PR #127 behavior); revert.

### VP-2: pnpm build emits clean Worker bundle

Steps:
1. From repo root: `pnpm --filter @duraclaw/orchestrator build`
   Expected: exit 0; emits `apps/orchestrator/dist/client/` and
   `apps/orchestrator/dist/duraclaw_orchestrator/index.js`.
2. `grep -cE '(react-native|@tamagui/react-native-web-lite)'
   apps/orchestrator/dist/duraclaw_orchestrator/index.js`
   Expected: `0`.
3. Capture Worker bundle size: `wc -c
   apps/orchestrator/dist/duraclaw_orchestrator/index.js`. Compare
   against the pre-P2 baseline (~2.7 MB per research). Document the
   delta in the PR description ("Worker delta: +X KB"). NOT a hard
   gate per D1.

### VP-3: pnpm build client bundle delta documented

Steps:
1. After VP-2 completes, list client assets: `ls -la
   apps/orchestrator/dist/client/assets/`. Sum the JS file sizes
   (use `du -bsh apps/orchestrator/dist/client/assets/`).
2. Compare against pre-P2 baseline. Document in PR description
   ("Client delta: +Y KB gzipped"). Expected ~150 KB gzipped delta.
   NOT a hard gate per D1.

### VP-4: Metro smoke bundle exits 0 (HARD GATE per D3)

Steps:
1. From repo root: `bash scripts/check-metro-bundle.sh`
   Expected: exit 0; output dir `/tmp/metro-smoke/` populated with
   `_expo/static/js/web/*.js` bundle file and `index.html`; bundle
   is non-empty.
2. `grep -c 'createRouter' /tmp/metro-smoke/_expo/static/js/web/*.js`
   Expected: ≥1 match (confirms the router source code from
   `apps/orchestrator/src/router.tsx:9` made it into the bundle
   through the pnpm-monorepo resolver).
3. Negative-path: edit `apps/orchestrator/src/entry-rn.tsx` to add a
   broken import (`import {} from '@nonexistent-module/foo'`). Re-run
   the script. Expected: exit 1 with a clear resolver error citing
   `@nonexistent-module/foo`. Revert the edit.

### VP-5: Tamagui×RNW atomic-CSS extraction smoke check (PR comment)

Steps:
1. After VP-2 completes, run:
   `grep -hE '_(alignItems|dsp|fd|jc)-' apps/orchestrator/dist/client/assets/*.css | sort -u | head -20`
   Expected: at least 1 line per category (alignItems, dsp, fd, jc) —
   i.e., at least 4 distinct hashed-class output lines.
2. Paste the output as a comment on the P2 PR (per D4 evidence
   format). Reviewer confirms ≥1 hashed class per category before
   approving the PR.
3. If the grep returns 0 matches (extraction broken — R1 triggered),
   STOP. Open a follow-up issue tagged `tamagui-rnw-extraction-broken`
   and either (a) cut P2 to `extract: false` runtime mode + accept
   perf cost, or (b) replan and pause P2.

### VP-6: Server.ts import smoke test (manual)

Steps:
1. Confirm that the orchestrator's web bundle continues to render the
   10 P1 smoke flows from spec `125-p1-tamagui-orchestrator-web.md`
   §Verification Plan: login, session list, open session, send
   message, theme toggle (settings), theme toggle (header), kanban
   view, file viewer, settings save, sign out, dark/light/system
   tri-state.
2. For each flow: visual fidelity matches post-PR-127 baseline; no
   layout shift, no missing styles, no console errors.
3. In React DevTools, inspect a `<View>` from a Tamagui-converted
   primitive. Expected: it renders as a `<div>` element under the
   hood (RNW translation working).

### VP-7: Auth-expiry hard-reload smoke check (manual, R5 mitigation)

Steps:
1. Open the orchestrator at `localhost:43XXX` (port per worktree),
   log in.
2. Manually invalidate the session cookie via DevTools (delete the
   `better-auth.session_token` cookie) OR wait for the session to
   expire naturally.
3. Trigger any authenticated API call (click "Sessions" tab or
   similar).
4. Expected: `apps/orchestrator/src/lib/auth-redirect.ts:14`'s
   `window.location.href = '/login'` fires; browser hard-reloads to
   `/login`. No console error stating "window is not defined" or
   similar (which would indicate RNW broke the path).
5. NOT a blocking gate — document outcome in PR. If broken, open a
   follow-up issue against R5 for P3.

### VP-8: Biome web-only-lib defensive rule (B7 verification)

Steps:
1. Create `apps/orchestrator/src/_test-lint-xyflow.ts` with content
   `import {} from '@xyflow/react'`. Run `pnpm lint` from repo root.
   Expected: exit 1 with a `lint/style/noRestrictedImports` diagnostic
   citing `@xyflow/react` and the override's message. Delete the test
   file.
2. Repeat for `react-jsx-parser`, `@rive-app/react-webgl2`,
   `media-chrome` — each in its own test file, deleted after.
3. Verify lint still passes on `packages/ai-elements/**` (legitimate
   consumer of these libs): inspect `pnpm lint` output for any false
   positives in `packages/ai-elements/src/components/canvas.tsx` or
   `persona.tsx`. Expected: zero diagnostics from the new override
   on ai-elements files (the override's `includes` scopes to
   `apps/orchestrator/src/**` only).

## Implementation Hints

### Dependencies

```bash
pnpm --filter @duraclaw/orchestrator add @tamagui/react-native-web-lite@2.0.0-rc.41
pnpm --filter @duraclaw/orchestrator add -D expo metro @expo/metro-runtime
# Pin all four to exact versions per D7 — no caret. Metro/Expo SDK 54-aligned versions
# determined at impl time from the current Expo SDK 54 lockfile. Do NOT install
# expo-modules-core, expo-asset, expo-dev-client, or any expo-* device runtime package.
```

### Key Imports

| Module | Import | Used For |
|--------|--------|----------|
| `@tamagui/react-native-web-lite` | (no direct import — Vite alias only) | Resolved by `'react-native': '@tamagui/react-native-web-lite'` alias; Tamagui compiler picks it up |
| `react-native` | `import { AppRegistry } from 'react-native'` (in `entry-rn.tsx` only) | Alias-resolves to lite; provides AppRegistry for the Metro entry |
| `metro` | (no direct import — invoked via CLI in `scripts/check-metro-bundle.sh`) | Metro CLI entrypoint for the smoke build |

### Code Patterns

**vite.config.ts deltas (Phase pA):**

```typescript
// apps/orchestrator/vite.config.ts — extend resolve.alias (lines 40-43)
resolve: {
  alias: {
    '~': path.resolve(__dirname, './src'),
    'react-native': '@tamagui/react-native-web-lite', // GH#131 P2
  },
},
// Add new top-level ssr block
ssr: {
  noExternal: [
    'react-native-web',
    'react-native',
    '@tamagui/react-native-web-lite',
  ],
},
// Add new top-level optimizeDeps block
optimizeDeps: {
  exclude: [
    'react-native-web',
    'react-native',
    '@tamagui/react-native-web-lite',
  ],
},
```

**CI guard regex extension (Phase pB):**

```bash
# scripts/check-worker-tamagui-leak.sh — replace line 11
LEAKS=$(grep -rE "from ['\"](@tamagui|react-native-web|react-native)" $TARGET_GLOB 2>/dev/null || true)
```

**Metro entry (Phase pE):**

The current `apps/orchestrator/src/router.tsx` (verified at lines
1-21) exports `createRouter()` and a memoized `getRouter()`
singleton. The Metro entry uses `getRouter()` to share the same
router instance pattern as `entry-client.tsx`:

```tsx
// apps/orchestrator/src/entry-rn.tsx — NEW FILE, ~10 LOC
import { AppRegistry } from 'react-native'
import { RouterProvider } from '@tanstack/react-router'
import { getRouter } from './router'

function App() {
  return <RouterProvider router={getRouter()} />
}

AppRegistry.registerComponent('Orchestrator', () => App)

if (typeof document !== 'undefined') {
  AppRegistry.runApplication('Orchestrator', { rootTag: document.getElementById('root')! })
}
```

**Metro config (Phase pE):**

```js
// apps/orchestrator/metro.config.js — NEW FILE
const path = require('path')
const { getDefaultConfig } = require('expo/metro-config')

const config = getDefaultConfig(__dirname)

config.watchFolders = [
  path.resolve(__dirname, '../..'),         // monorepo root
  path.resolve(__dirname, '../../node_modules'),
]
config.resolver.unstable_enablePackageExports = true
config.resolver.unstable_enableSymlinks = true
config.resolver.disableHierarchicalLookup = false

module.exports = config
```

**Smoke script (Phase pE):**

```bash
#!/bin/bash
# scripts/check-metro-bundle.sh — NEW FILE
set -euo pipefail
cd "$(dirname "$0")/.."
OUT_DIR=/tmp/metro-smoke
rm -rf "$OUT_DIR"
echo "Running Metro smoke build → $OUT_DIR"
pnpm --filter @duraclaw/orchestrator exec npx expo export \
  --platform web \
  --output-dir "$OUT_DIR" \
  --no-minify \
  || { echo "ERROR: Metro smoke build failed"; exit 1; }
# Expo SDK 54 emits an _expo/static/js/web/*.js bundle file plus an index.html
BUNDLE=$(find "$OUT_DIR/_expo/static/js/web" -name '*.js' | head -n 1)
[ -n "$BUNDLE" ] && [ -s "$BUNDLE" ] || { echo "ERROR: no bundle emitted"; exit 1; }
echo "Metro smoke bundle OK ($(wc -c < "$BUNDLE") bytes at $BUNDLE)"
```

CLI command verified against Expo SDK 54 docs: `npx expo export
--platform web` is the canonical SDK 54+ invocation (replaced
`expo export:embed` from earlier SDKs). The script reads the
metro entry from `apps/orchestrator/src/entry-rn.tsx` via the
project's `app.json` `main` field — pE adds the `app.json` if not
already present (one-time, ~10 LOC). VP-4 evidence path is
`/tmp/metro-smoke/_expo/static/js/web/*.js`.

### Gotchas

- **Alias must come before plugin chain.** Tamagui's vite-plugin reads
  the resolved module map at startup. If `'react-native'` alias is
  missing or set after the plugin, the compiler emits DOM primitives
  (current behavior) instead of RNW primitives. Verify by inspecting
  one component's compiled output in `dist/client/assets/*.js` — should
  reference `react-native-web-lite` paths.
- **`ssr.noExternal` is load-bearing.** Without it, Vite shares chunks
  containing RNW polyfills with the Worker bundle (~500 KB leak).
  Combined with the CI guard (B4), this gives belt-and-suspenders
  protection.
- **`optimizeDeps.exclude` matters in dev mode only.** Pre-bundling
  collapses RNW's per-platform exports into a single CJS module, which
  defeats the alias. Excluding from optimizeDeps lets Vite respect the
  `browser` field at request time.
- **Lint config location: locked to Biome.** Verified at spec-write
  time: `biome.json` at workspace root (lines 41-91 carry two
  existing override blocks); no ESLint configs anywhere in the
  workspace. `pnpm lint` at repo root runs
  `scripts/precommit.sh --lint-only` which invokes `biome check`.
  P2 adds a third override block to `biome.json` targeting
  `apps/orchestrator/src/**` only.
- **`AppRegistry.runApplication` requires a DOM rootTag.** The
  `entry-rn.tsx` snippet above guards on `typeof document !==
  'undefined'` so the Metro web smoke build doesn't crash in SSR-like
  environments. Native (P3) will use a different entry path that skips
  this guard.
- **Metro version pinning.** Per D7, pin the exact Metro version
  Expo SDK 54 ships with. Caret ranges have caused intermittent
  resolver failures in pnpm monorepos (research R3).
- **`packages/ai-elements/` is allowed to import the four web-only
  libs.** The B7 lint rule scopes to `apps/orchestrator/src/**` only —
  do NOT extend to ai-elements or you'll break that package's exports.

### Reference Docs

- [Tamagui Vite guide](https://tamagui.dev/docs/guides/vite) — alias
  setup + plugin order
- [Tamagui Version Two](https://tamagui.dev/blog/version-two) — RNW
  adapter status, lite fork rationale
- [Cloudflare Vite plugin](https://developers.cloudflare.com/workers/vite-plugin/)
  — CF Worker entry detection
- [Expo Metro monorepo guide](https://docs.expo.dev/guides/monorepos/)
  — `watchFolders`, `unstable_enablePackageExports`, pnpm
- [react-native-web with Vite](https://dev.to/dannyhw/react-native-web-with-vite-1jg5)
  — community recipe for the Vite alias
- Predecessor spec
  [`planning/specs/125-p1-tamagui-orchestrator-web.md`](./125-p1-tamagui-orchestrator-web.md)
  — P1 Tamagui adoption baseline (CI guard origin, smoke flow list)
- Parent research
  [`planning/research/2026-04-23-react-native-pivot-evaluation.md`](../research/2026-04-23-react-native-pivot-evaluation.md)
  §10.4 + §10.5 + §11.4 + §11.5 — RN pivot phasing rationale
- Sibling research
  [`planning/research/2026-04-28-gh131-p2-rnw-universalization.md`](../research/2026-04-28-gh131-p2-rnw-universalization.md)
  — P0 deep-dives that fed this spec
- Interview decisions
  [`planning/research/2026-04-28-gh131-p2-rnw-interview.md`](../research/2026-04-28-gh131-p2-rnw-interview.md)
  — D1-D7, L1-L8, B1-B3, R1-R5 traceability
