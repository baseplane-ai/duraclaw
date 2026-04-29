import { describe, expect, it } from 'vitest'

// GH#131 P2 — verify the `react-native` → `@tamagui/react-native-web-lite`
// Vite alias also fires under vitest. The spec's Verification Strategy
// section flags this as a load-bearing check: if the alias breaks
// vitest resolution, component tests start failing with "Cannot find
// module 'react-native'" the moment any Tamagui-converted component
// reaches into the RN module graph. This file proves the alias is
// wired across both code paths (vite build + vitest) before that
// breakage is allowed to land silently.

describe('GH#131 RNW alias under vitest', () => {
  it('resolves `react-native` to the Tamagui lite fork', async () => {
    // Dynamic import so a resolution failure surfaces as a rejected
    // promise rather than a load-time crash inside vitest's worker.
    // Under vitest's jsdom env (apps/orchestrator/vitest.config.ts),
    // the Vite alias from `vite.config.ts` is shared, so the same
    // resolution path that ships in the production web bundle is
    // exercised here. If a future change accidentally drops or
    // reorders the alias, this test fails before component tests
    // start cascading "Cannot find module 'react-native'" errors.
    const rn = await import('react-native')
    expect(rn).toBeTruthy()
    expect(rn.View).toBeTruthy()
    expect(rn.Text).toBeTruthy()
    expect(rn.StyleSheet).toBeTruthy()
  })
})
