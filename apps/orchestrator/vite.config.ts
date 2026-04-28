import path from 'node:path'
import { cloudflare } from '@cloudflare/vite-plugin'
import { tamaguiPlugin } from '@tamagui/vite-plugin'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import agents from 'agents/vite'
import { defineConfig, type PluginOption } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'
import { buildHashPlugin } from './src/vite/build-hash-plugin'

// Fallback injector for @vitejs/plugin-react's Fast Refresh preamble.
// With Vite 8 + @cloudflare/vite-plugin's HTML serving path, the react
// plugin's own transformIndexHtml hook doesn't always fire in dev, which
// causes every hook-using TSX module to crash with `$RefreshSig$ is not
// defined`. This plugin runs `pre` and injects the canonical preamble
// script tag into the served HTML in dev only.
const reactRefreshPreamble = (): PluginOption => ({
  name: 'duraclaw:react-refresh-preamble',
  apply: 'serve',
  transformIndexHtml: {
    order: 'pre',
    handler() {
      return [
        {
          tag: 'script',
          attrs: { type: 'module' },
          children: `import RefreshRuntime from "/@react-refresh"
RefreshRuntime.injectIntoGlobalHook(window)
window.$RefreshReg$ = () => {}
window.$RefreshSig$ = () => (type) => type
window.__vite_plugin_react_preamble_installed__ = true`,
          injectTo: 'head-prepend',
        },
      ]
    },
  },
})

export default defineConfig({
  resolve: {
    alias: {
      '~': path.resolve(__dirname, './src'),
    },
  },
  define: {
    // Stamped into client bundle. Empty defaults so web build uses
    // window.location.origin and isNative() returns false. Mobile build
    // overrides via apps/mobile/.env.production (set in P5).
    'import.meta.env.VITE_API_BASE_URL': JSON.stringify(process.env.VITE_API_BASE_URL ?? ''),
    'import.meta.env.VITE_PLATFORM': JSON.stringify(process.env.VITE_PLATFORM ?? ''),
    'import.meta.env.VITE_WORKER_PUBLIC_URL': JSON.stringify(
      process.env.VITE_WORKER_PUBLIC_URL ?? '',
    ),
  },
  plugins: [
    reactRefreshPreamble(),
    agents(),
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.ts',
      registerType: 'prompt',
      injectManifest: {
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
      },
      manifest: {
        name: 'Duraclaw',
        short_name: 'Duraclaw',
        description: 'Claude Code session orchestrator',
        theme_color: '#09090b',
        background_color: '#09090b',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          {
            src: '/icons/icon-512-maskable.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
        shortcuts: [
          {
            name: 'New Session',
            url: '/?new=1',
            icons: [{ src: '/icons/icon-192.png', sizes: '192x192' }],
          },
          {
            name: 'Dashboard',
            url: '/',
            icons: [{ src: '/icons/icon-192.png', sizes: '192x192' }],
          },
        ],
      },
    }),
    buildHashPlugin(),
    cloudflare(),
    tamaguiPlugin({
      config: './src/tamagui.config.ts',
      components: ['@tamagui/core'],
      // P1b: compiler enabled (atomic-CSS extraction, hoisting, flattening).
      // The compiler emits underscore-prefixed atomic classes (e.g.,
      // `_dsp-flex`, `_alignItems-center`) into dist/client/assets/*.css —
      // verify with `grep -E '\\._[a-zA-Z]' dist/client/assets/*.css`.
      extract: true,
    }),
    react(),
    tailwindcss(),
  ],
})
