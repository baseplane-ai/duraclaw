import path from 'node:path'
import { cloudflare } from '@cloudflare/vite-plugin'
import tailwindcss from '@tailwindcss/vite'
import { tamaguiPlugin } from '@tamagui/vite-plugin'
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
      // GH#131 P2: route `react-native` imports through Tamagui's curated
      // RNW subset so the web build keeps shipping unchanged while the
      // same source becomes capable of running native (P3). Must be set
      // BEFORE `tamaguiPlugin()` below so the compiler sees the RNW
      // target and emits atomic CSS for primitives (View/Text/Pressable).
      'react-native': '@tamagui/react-native-web-lite',
    },
  },
  // GH#131 P2: keep RNW polyfills out of the CF Worker bundle. Without
  // ssr.noExternal, Vite shares chunks containing RNW runtime bytes with
  // the Worker, costing ~500 KB and risking eval/global-scope breakage in
  // the Worker. Belt-and-suspenders with the import-leak guard in
  // scripts/check-worker-tamagui-leak.sh (extended in this PR to match
  // these three module families).
  ssr: {
    noExternal: ['react-native-web', 'react-native', '@tamagui/react-native-web-lite'],
  },
  // GH#131 P2: respect RNW's `package.json#browser` field. Without this,
  // Vite pre-bundles the three RNW packages into a single CJS chunk,
  // which collapses the per-platform exports map and defeats the alias
  // above (Tamagui compiler then sees DOM, not RNW).
  optimizeDeps: {
    exclude: ['react-native-web', 'react-native', '@tamagui/react-native-web-lite'],
  },
  build: {
    rollupOptions: {
      // GH#132 P3: native-only modules (Expo SDK 55 dep tree) are
      // dynamic-imported behind `isExpoNative()` guards in the
      // orchestrator source. On the Vite web build that branch never
      // runs, but Rolldown still walks the import graph statically and
      // fails to resolve packages that aren't declared in
      // apps/orchestrator/package.json. Externalising them tells
      // Rolldown to leave the import as a runtime lookup; the dynamic
      // branch never fires on web, so the unresolved external is
      // unreachable. Capacitor counterparts are NOT externalised — they
      // ARE declared in orchestrator/package.json and live-ship on the
      // Capacitor Vite build.
      external: [
        '@better-auth/expo',
        '@better-auth/expo/client',
        '@op-engineering/op-sqlite',
        '@duraclaw/op-sqlite-tanstack-persistence',
        '@react-native-community/netinfo',
        '@react-native-firebase/messaging',
        '@react-native-firebase/app',
        // platform.ts:25 has `require('expo-constants').default` inside an
        // `if (Platform.OS !== 'web')` branch. The comment in platform.ts
        // claims Vite tree-shakes the require on web — that's true under
        // the legacy Rollup pipeline, but Rolldown (Vite 8's default)
        // walks the static import graph BEFORE DCE, so it follows
        // expo-constants → expo → expo-modules-core and trips on
        // expo-modules-core's `export declare class` declaration files
        // (`SharedRef`, `SharedObject`, `EventEmitter`, `NativeModule`)
        // which emit no runtime symbols. Externalising the whole expo
        // chain leaves the require as a runtime lookup; the
        // `Platform.OS === 'web'` early-return guarantees the require is
        // never evaluated on the web build, so the unresolved external
        // is unreachable.
        'expo',
        'expo-constants',
        'expo-modules-core',
        'expo-secure-store',
        'expo-updates',
      ],
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
