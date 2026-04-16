import path from 'node:path'
import { defineConfig } from 'vitest/config'

// React 19's production build strips `React.act`, which @testing-library/react
// depends on via `react-dom/test-utils`. Something in our plugin chain (likely
// @cloudflare/vite-plugin) sets NODE_ENV=production, which routes react's
// CJS entry to the production build. Force NODE_ENV=test so we load the dev
// build that actually exports `act`.
process.env.NODE_ENV = 'test'

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    env: {
      NODE_ENV: 'test',
    },
  },
  resolve: {
    alias: {
      '~': path.resolve(__dirname, 'src'),
      'virtual:pwa-register/react': path.resolve(
        __dirname,
        'src/__mocks__/virtual-pwa-register-react.ts',
      ),
    },
  },
})
