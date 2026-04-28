# GH#125 P0 spike — Path A results

Date: 2026-04-28
Branch: feature/125-tamagui-orchestrator
Tamagui version: 2.0.0-rc.41
Vite version: ^8.0.3 (resolved 8.0.8)
React version: ^19.2.4

## Path A — Tamagui on Vite (existing orchestrator)

### Verdict

**YELLOW** — `pnpm build` and `pnpm typecheck` succeed end-to-end, the Worker bundle stays Tamagui-free, and the Tamagui plugin reports `1 found · 1 opt · 1 flat` on the spike component during the client build. One spec-template snippet had to be corrected to ship: `@tamagui/core@2.0.0-rc.41` does NOT export `Stack` (only `View`, `Text`, `TamaguiProvider`, `createTamagui`, plus re-exports from `@tamagui/web`), so the hello-world component uses `View` instead. Plus a noisy peer-dep warning on `vite@8.0.8` because the plugin pins `vite@*8.0.3` (literal, malformed). Neither issue is a blocker — proceed to P1a — but the spec template referencing `Stack` directly from `@tamagui/core` needs an update before P1a authoring (`Stack` lives in `tamagui/`-the-meta-package, not `@tamagui/core`).

### Test cases (per spec frontmatter §p0.test_cases)

| # | Test | Result | Evidence |
|---|------|--------|----------|
| 1 | Hello-world Tamagui component renders on / in pnpm dev | NOT TESTED (manual step) | n/a — agent cannot start dev server per spike instructions |
| 2 | `pnpm build` emits dist/client + dist/<worker> with Worker bundle Tamagui-free | PASS | `grep -rl tamagui apps/orchestrator/dist/duraclaw_orchestrator/` → empty; `grep -c tamagui dist/duraclaw_orchestrator/index.js` → 0; client-side `dist/client/assets/index-BYjw0Oyh.js` → 3 occurrences |
| 3 | `pnpm typecheck` passes | PASS | `tsc --noEmit` exit 0, no diagnostics |
| 4 | Tailwind cascade preserved | NOT TESTED (manual step) | n/a — requires running browser; deferred to VP-1 step 5 in spec |

### Install observations

`pnpm install` completed in 14.9s, +161 packages added. No outright failures. Notable peer-dep warnings (verbatim, only Tamagui-relevant ones reproduced):

```
apps/orchestrator
├─┬ @tamagui/vite-plugin 2.0.0-rc.41
│ └── ✕ unmet peer vite@*8.0.3: found 8.0.8
```

The plugin's `peerDependencies.vite` is the literal string `*8.0.3` (a malformed semver range — almost certainly a typo for `*` or `^8.0.3`). pnpm flags it but does not refuse to install. The build runs fine on `vite@8.0.8` regardless. **Action item for P1a:** flag this upstream (likely in the `tamagui/tamagui` repo); mention in spec hints so the next agent doesn't get spooked by the warning.

No React-19-specific peer warnings on the three Tamagui packages — they accept React 19 cleanly via `react: ">=18"` style ranges.

A pre-existing, unrelated trap: the agent shell had `NODE_ENV=production` exported; pnpm honored it and skipped devDeps on the first install pass. The Tamagui Vite plugin (a devDependency) wasn't linked, so `pnpm build` errored with `vite: not found`. Resolution was `unset NODE_ENV && pnpm install`. **This is not a Tamagui issue** — it's an environment quirk worth flagging to the parent agent so the next P1a session doesn't waste cycles on it.

### Build observations

`pnpm build` exits 0. Two phases:

1. **Worker bundle phase** (`duraclaw_orchestrator` env): completed in 3.22s. Tamagui plugin printed `➡ [tamagui] built config, components, prompt (129ms)` once — config loaded, ready, did not inject into Worker bundle.
2. **Client bundle phase**: 6225 modules transformed, 6.79s. Plugin printed `🐥 [tamagui]  web tamagui-hello · 1 found · 1 opt · 1 flat 29ms`. Translation: 1 component file (`tamagui-hello.tsx`), 1 component optimized, 1 hierarchy flattening applied even with `extract: false`. Encouraging — runtime mode still does some compile-time work.

Standard `(!) Some chunks are larger than 500 kB` warning fired on `index-BYjw0Oyh.js` (2347 KiB) — pre-existing, not Tamagui-introduced. Tamagui contribution to client bundle size: `grep -c tamagui` returns only 3 hits in the main client bundle, suggesting tree-shaking worked.

Initial build attempt failed with:

```
[MISSING_EXPORT] Error: "Stack" is not exported by
  ".../node_modules/@tamagui/core/dist/esm/index.mjs"
   src/components/tamagui-hello.tsx:3:10
```

Root cause: the spec hello-world template imports `Stack` from `@tamagui/core`, but `@tamagui/core@2.0.0-rc.41`'s ESM index only exports `View, Text, TamaguiProvider, createTamagui, LayoutMeasurementController, registerLayoutNode, setOnLayoutStrategy` (plus `* from '@tamagui/web'`). `Stack` is a meta-export from the `tamagui` umbrella package, not `@tamagui/core`. Fix: switched the hello-world to `View` (semantically equivalent for spike purposes — `Stack` is a YStack/XStack-style alias on the meta package).

### Worker bundle inspection

```
$ grep -rl "tamagui" apps/orchestrator/dist/duraclaw_orchestrator/
(empty)

$ grep -c "tamagui" apps/orchestrator/dist/duraclaw_orchestrator/index.js
0

$ ls apps/orchestrator/dist/duraclaw_orchestrator/
.dev.vars  .vite  assets/  index.js (2.7 MB)  manifest.webmanifest
registerSW.js  wrangler.json
```

**Worker bundle is Tamagui-free.** No `@tamagui/*` imports, no `tamagui` strings, no leak. Confirms `tamaguiPlugin()` correctly scopes its output to the client environment under `@cloudflare/vite-plugin`'s multi-environment build. P1a's Worker-leak CI guard will hold.

### Client bundle inspection

```
$ grep -l "tamagui" apps/orchestrator/dist/client/assets/*.js
apps/orchestrator/dist/client/assets/index-BYjw0Oyh.js

$ grep -c "tamagui" apps/orchestrator/dist/client/assets/index-BYjw0Oyh.js
3
```

Tamagui runtime is in the client bundle but at a low byte-count — the 3 hits are likely `data-component`-style attribute tags on rendered View / Text plus the plugin's component-tree marker. `extract: false` keeps the bulk of the API as runtime-resolved imports, which is what the spec wants for P1a (compiler flips on in P1b).

### Known issues encountered

- **Spec template error (NOT upstream):** spec hint snippet imports `Stack` from `@tamagui/core`. Real export surface is `View / Text / TamaguiProvider / createTamagui` only. Documented above; spec authors should either (a) update the hello-world snippet to use `View`, or (b) instruct P1a to install the `tamagui` umbrella package alongside `@tamagui/core` if they want `Stack`/`YStack`/`XStack`. Recommend (a) — keep the package count minimal.
- **Plugin peer-dep typo (mild upstream):** `@tamagui/vite-plugin@2.0.0-rc.41` declares `peerDependencies.vite: "*8.0.3"`. Almost certainly a tamagui-side typo; doesn't block install or build. No filed issue yet — recommend filing a one-line upstream PR after P1a stabilizes.
- **No reproduction of #3582 (`TamaguiProvider` destructuring on React 19):** the build completed and the spike component passed plugin processing. Runtime confirmation requires the manual dev-server step (test case 1, NOT TESTED).
- **No reproduction of #3406 / #3302 (vite-plugin ESM/CJS issues):** plugin loaded and ran its config-builder phase cleanly under Vite 8 + Rolldown.
- **No reproduction of #2401 (compiler instability) — not relevant; we're running `extract: false`.**

### Files changed

- `apps/orchestrator/package.json` — added `@tamagui/core@2.0.0-rc.41`, `@tamagui/font-inter@2.0.0-rc.41` to `dependencies`; `@tamagui/vite-plugin@2.0.0-rc.41` to `devDependencies`
- `apps/orchestrator/src/tamagui.config.ts` — new (placeholder hex tokens, light + dark themes, `createInterFont()`-driven font, `mobile: maxWidth 767` media)
- `apps/orchestrator/vite.config.ts` — inserted `tamaguiPlugin({...})` between `cloudflare()` and `react()`; `extract: false`
- `apps/orchestrator/src/routes/__root.tsx` — wrapped both render branches in `<TamaguiProvider config={tamaguiConfig} defaultTheme="light">`; rendered `<TamaguiHello />` once inside the main branch's `NowProvider`. ThemeProvider untouched (per P0 constraints).
- `apps/orchestrator/src/components/tamagui-hello.tsx` — new; uses `View` + `Text` from `@tamagui/core` (NOT `Stack`, which doesn't exist on that package). Token refs `$primary`, `$primaryForeground`, `$3`, `$2` resolve against `tamaguiConfig`.

## Path B — OneStack (deferred)

**Status: NOT EXECUTED** — Path B requires `npx one create` interactive scaffolding + a throwaway CF Worker deploy with Cloudflare account credentials, neither of which is suitable for an agent session. Path B verdict will be captured by a human follow-up before P1a entry, OR (per spec decision matrix) skipped if Path A is green.

## Decision

Path A is **YELLOW**, not green — but the friction (Stack-vs-View export name, plugin peer-dep typo, `NODE_ENV=production` shell quirk) is metadata-and-imports level, not architectural. The build succeeds, typecheck succeeds, the Worker bundle stays clean, and Tamagui's plugin reports normal optimization activity. Per the spec's decision matrix ("A green/yellow + B green/yellow/red → Path A unless A's friction is load-bearing"): **proceed with Path A**. None of the friction is load-bearing — each item is a one-line fix in P1a's authoring. Path B's interactive scaffolding cost is not justified.

Recommended P1a entry checklist:
1. Update the spec's hello-world hint snippet to use `View` from `@tamagui/core` (not `Stack`).
2. P1a's primitive migrations should import `Stack` (if needed) from the `tamagui` umbrella package, not `@tamagui/core`.
3. File a one-line upstream PR on the plugin's `peerDependencies.vite` (`"*8.0.3"` → `">=8.0.3"` or `"*"`).
4. Add a note to `.claude/rules/orchestrator.md` (or wherever) that `pnpm install` for this workspace requires `NODE_ENV` unset.
