import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // `src/index.test.ts` is bun-runtime-specific (imports from
    // `bun:test`) and is executed by `bun test`, not vitest. Exclude it
    // here so `pnpm test` doesn't try to load it.
    exclude: ['**/node_modules/**', '**/dist/**', 'src/index.test.ts'],
  },
})
