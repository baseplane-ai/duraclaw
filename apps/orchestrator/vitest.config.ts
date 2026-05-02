import path from 'node:path'
import { tamaguiPlugin } from '@tamagui/vite-plugin'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vitest/config'

// React 19's production build strips `React.act`, which @testing-library/react
// depends on via `react-dom/test-utils`. Something in our plugin chain (likely
// @cloudflare/vite-plugin) sets NODE_ENV=production, which routes react's
// CJS entry to the production build. Force NODE_ENV=test so we load the dev
// build that actually exports `act`.
process.env.NODE_ENV = 'test'

export default defineConfig({
  plugins: [
    tamaguiPlugin({
      config: './src/tamagui.config.ts',
      components: ['@tamagui/core'],
      // Mirrors vite.config.ts: P0 spike runtime only; P1b flips extract: true.
      extract: false,
    }),
    react(),
  ],
  test: {
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx'],
    setupFiles: ['./src/test-setup.ts'],
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
      // Native-only modules dynamic-imported by `use-push-subscription-native`.
      // The orchestrator dep tree doesn't include the firebase RN package, so
      // vite's import-analysis fails before tests run. Stub it.
      '@react-native-firebase/messaging': path.resolve(
        __dirname,
        'src/__mocks__/react-native-firebase-messaging.ts',
      ),
      '@capacitor/push-notifications': path.resolve(
        __dirname,
        'src/__mocks__/capacitor-push-notifications.ts',
      ),
    },
  },
})
