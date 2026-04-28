---
date: 2026-04-28
topic: GH#131 P2 — interview decisions for spec writing
type: interview
status: complete
github_issue: 131
sibling_research: planning/research/2026-04-28-gh131-p2-rnw-universalization.md
---

# Interview: GH#131 P2 — RNW universalization

This doc captures the decisions the user made during the post-research
interview. The spec writer should treat each decision below as **locked**
unless explicitly flagged as a non-blocking suggestion.

## Decisions Summary

### D1 — Bundle-size gates

| Gate | Status | Spec implication |
|------|--------|------------------|
| **Worker bundle delta** | NOT a hard gate | Phase A acceptance: "delta measured and documented in PR description." CI import guard (Phase B) is the real protection. CF supports multi-Worker split if any single Worker ever balloons, so a hard size gate would be over-engineering. |
| **Client bundle delta** | NOT gated | Phase A acceptance: "delta measured and documented in PR description; ~150 KB gzipped expected with `@tamagui/react-native-web-lite`." No failure threshold. Revisit in P3 if mobile-network UX surfaces an issue. |

### D2 — RNW package choice

**Locked: `@tamagui/react-native-web-lite`** (not full `react-native-web`).

- Tamagui's curated subset, ~30-40% smaller than full RNW
- Tamagui v2 supports both transparently
- **Vite alias** in `apps/orchestrator/vite.config.ts` becomes
  `'react-native': '@tamagui/react-native-web-lite'`
- `react-native-web` itself is **not** installed as a separate
  dep — lite is the runtime
- Trade-off accepted: ties P2 to Tamagui's choice of which RN APIs are
  "lite-worthy"; if P3 finds we need an excluded API, we revert to full
  RNW (cheap swap)

**User clarification surfaced during interview**: user asked "Do we
need RNW?" — answered inline: yes, RNW (or lite) is the core artifact
P2 ships. Today (post-PR #127, RNW NOT installed) Tamagui falls back to
"core-only" mode emitting raw `<div>`/`<span>`. P2's whole point is to
swap to RNW so the same source code runs unchanged on native (P3).
Decision unchanged after clarification.

### D3 — Metro smoke-bundle gate semantics

**Locked: hard CI gate.** `metro build` exit 0 is required for PR
merge.

- Treats Metro-bundle-clean as a P2 deliverable, not a future promise
- Catches resolver/import regressions immediately
- Aligns with the GH#131 issue body's "prove the native target is
  *capable*" framing
- No shipped Metro artifact; Vite continues serving production web

### D4 — Tamagui×RNW atomic-CSS smoke check evidence format

**Locked: PR comment with grep output of hashed atomic classes.**

- Verification Plan step (Phase C, not implementation): post-deploy,
  run a grep like:
  ```bash
  grep -E '_(alignItems|dsp|fd|jc)-' dist/client/assets/*.css | head -20
  ```
- Paste the output as a comment on the P2 PR
- **Acceptance**: at least one hashed atomic class per category present;
  spec should enumerate the exact grep pattern and the minimum class
  count expected (>0 per category)
- Cheap, version-controlled in GH, easy to audit. ~5 min per
  verification.
- Visual diff screenshots NOT required for P2 (deferred — could be
  added to a later VP step if visual regressions appear)

### D5 — Defensive eslint rule for web-only libs

**Locked: INCLUDE in P2.**

- Add `no-restricted-imports` rule to orchestrator's eslint config
  blocking direct imports of the four web-only libs in `apps/orchestrator/`:
  - `@xyflow/react`
  - `react-jsx-parser`
  - `@rive-app/react-webgl2`
  - `media-chrome`
- Rule applies ONLY to `apps/orchestrator/src/**`; `packages/ai-elements/`
  remains free to export them (so cross-package boundary is intact)
- Spec writer should specify the exact eslint config delta in Phase D
- Easily lifted in P3 spec when feature gates land

### D6 — P1c (GH#130) coordination

**Locked: spec writes parallel; impl gates on P1c close.**

- P2 spec writing proceeds NOW (this session, P3 phase)
- P2 implementation issue references P1c close as a precondition
- P1c verification (~few hours of dogfood) likely closes before P2
  spec is reviewed/approved anyway
- Spec writer should add a P2-impl-precondition note in the spec's
  "Blocked by" or "Predecessors" section

### D7 — Dependency version pinning policy

**Locked: pin exact versions (no caret) for all new packages.**

- `@tamagui/react-native-web-lite` — exact pin matching Tamagui core
  version (currently `2.0.0-rc.41`)
- `expo` — exact pin (Expo SDK 54 series)
- `metro` — exact pin (version-fragile in pnpm monorepos per research)
- `@expo/metro-runtime` — exact pin (must align with Metro version)

Rationale:
- Aligns with PR #127's existing exact-pin pattern for `@tamagui/*`
- Metro especially is sensitive to pnpm hoisting; caret could surface
  intermittent resolver failures between dev and CI
- Tamagui is still in rc — must pin

## Locked-from-research decisions (no interview needed)

These came out of the research doc and remain unchanged:

| # | Decision | Source |
|---|----------|--------|
| L1 | 5-phase spec structure: A (Vite+RNW config), B (CI guard), C (CSS smoke check VP), D (lib decisions), E (Metro smoke bundle) | Research §Recommendations |
| L2 | TanStack Router unchanged in P2 — no defensive nudges needed | Research item 5 |
| L3 | xyflow → feature-gate web-only (Platform.OS check + list-view fallback on native) | Research item 2 + decision Q2 |
| L4 | react-jsx-parser → feature-gate web-only (markdown/code-block fallback on native; no RN equivalent) | Research item 2 + decision Q2 |
| L5 | Rive → replace with `@rive-app/react-native` (P3 work, ~1-2 weeks port) | Research item 2 + decision Q2 |
| L6 | media-chrome → replace with platform-conditional wrapper (HTML5 + react-native-video, P3 work) | Research item 2 + decision Q2 |
| L7 | CI guard regex: `from ['"](@tamagui\|react-native-web\|react-native)` in `scripts/check-worker-tamagui-leak.sh` | Research item 3 |
| L8 | Vite config deltas: `resolve.alias` + new `ssr.noExternal` block + new `optimizeDeps.exclude` block | Research item 1 |

## Open Risks

These are decisions where uncertainty remains; the spec writer should
flag them explicitly in the spec's "Risks" section:

1. **Tamagui × RNW × Vite atomic-CSS extraction interaction is untested
   in the wild.** Mitigation = manual VP smoke check per D4. If extraction
   silently breaks, runtime fallback applies (perf cost, not correctness
   cost). Replan needed if observed.

2. **`@tamagui/react-native-web-lite` is a less-trafficked path than
   full RNW.** P3 may discover a missing API (e.g. an obscure
   `react-native` export the lite fork doesn't ship). Mitigation: cheap
   revert to full RNW.

3. **Metro × pnpm hoisting fragility.** `watchFolders` +
   `unstable_enablePackageExports` recipe is documented but
   version-sensitive. Exact pins (D7) reduce risk; spec should reference
   a known-good Metro version from a current Expo SDK 54 install.

4. **Expo SDK 54 metro-only install footprint unknown.** Spec writer
   should explicitly NOT install device-runtime packages (e.g.
   `expo-modules-core`, `expo-asset`, native binaries). Verify post-install
   that no Xcode/Android Studio toolchain integration leaked.

5. **`window.location.href` for auth expiry under RNW (untested
   post-PR #127).** Low-impact (auth expiry is a hard-failure case
   anyway). Add to VP as a manual smoke check; not a blocking gate.

## Architectural Bets (hard to reverse)

Spec must call these out explicitly:

- **B1 — `@tamagui/react-native-web-lite` over full `react-native-web`.**
  Reverting requires changing the Vite alias + adding the full RNW
  install + bundle-size re-measurement. ~1 hour to revert; not
  catastrophic but worth flagging.

- **B2 — Hard Metro CI gate from P2.** If Metro becomes unmaintainable
  or Expo SDK has a regression, the gate could block all P2 PRs. Escape
  valve: temporarily switch to informational-only via env flag, but
  spec should not pre-bake this.

- **B3 — `no-restricted-imports` lint rule scope.** Scope is
  orchestrator-only (`apps/orchestrator/src/**`); ai-elements remains
  free to export the four libs. If we ever fold ai-elements consumers
  back into orchestrator (e.g. inline a component), the lint trips.
  Acceptable cost.

## Codebase Findings (re-emphasized for spec writer)

Key file paths the spec writer needs to reference:

- `apps/orchestrator/vite.config.ts:40-43` — current `resolve.alias`
  (extend here)
- `apps/orchestrator/vite.config.ts:100-108` — Tamagui plugin config
  (no change needed)
- `apps/orchestrator/wrangler.toml:2,28` — Worker entry + asset
  directory (no change needed)
- `apps/orchestrator/package.json:63-119` — current Tamagui pinning
  pattern (mirror for new deps)
- `scripts/check-worker-tamagui-leak.sh:11` — CI guard regex (extend
  here)
- `apps/orchestrator/src/server.ts:1-15` — Worker imports (must stay
  RNW-free)
- `packages/ai-elements/src/components/canvas.tsx`, `node.tsx`,
  `edge.tsx`, `jsx-preview.tsx`, `persona.tsx`, `audio-player.tsx` —
  the four web-only lib usages (all dormant in orchestrator)
- `apps/orchestrator/src/router.tsx` + `routes/__root.tsx` +
  `routes/_authenticated/route.tsx` — TanStack Router setup (no change)
- `apps/orchestrator/src/lib/auth-redirect.ts:14` — `window.location.href`
  call (VP smoke check)

## Spec Writing Inputs — checklist

Spec writer at P2 should produce a doc covering:

- **B-IDs (behaviors)** mapping to each phase A-E plus the lint rule
  (Phase D) and VP-only smoke check (Phase C)
- **Verification Plan steps** for:
  - VP-1: `pnpm typecheck` passes (CI guard extension working)
  - VP-2: `pnpm build` Worker bundle delta documented in PR
  - VP-3: `pnpm build` client bundle delta documented in PR
  - VP-4: `metro build` exits 0 (hard CI gate)
  - VP-5: post-deploy CSS atomic-class grep output posted as PR comment
  - VP-6: `apps/orchestrator/src/server.ts` import smoke (manual): try
    `import { View } from 'react-native'` in server.ts → guard fails;
    revert
  - VP-7: auth-expiry hard-reload smoke check (manual)
- **Out of scope / known P3 blockers** section enumerating the four
  web-only libs and their P3 disposition (per L3-L6)
- **Predecessors / blocked by**: P1c (GH#130) close before P2 impl
  starts (per D6)
- **Architectural bets** section (per B1-B3)
- **Risks** section (per Open Risks 1-5)
