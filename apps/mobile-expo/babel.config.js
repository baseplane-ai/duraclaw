module.exports = (api) => {
  api.cache(true)
  return {
    presets: [
      // unstable_transformImportMeta: orchestrator source uses
      // `import.meta.env.VITE_*` (a Vite idiom). Hermes doesn't support
      // `import.meta` natively; this flag lets babel transpile it to a
      // const that Hermes can run. Required because apps/mobile-expo/index.js
      // imports apps/orchestrator/src/entry-rn.tsx which transitively
      // pulls in lib/platform.ts.
      ['babel-preset-expo', { unstable_transformImportMeta: true }],
    ],
    plugins: [
      // GH#157: hoist top-level await into async IIFE so Hermes (0.14.1
      // pinned by RN 0.83.6 / Expo SDK 55, no native TLA support) can
      // compile the bundle. Nine `apps/orchestrator/src/db/*-collection.ts`
      // modules do `const persistence = await dbReady` at module top
      // level — the Vite web bundle handles this fine, but Hermes
      // chokes with "';' expected" at the bare `await`. The plugin
      // wraps each TLA module in an async IIFE; consumers of the
      // module's named exports work because Babel hoists the export
      // declarations. Must come BEFORE babel-preset-expo's own
      // commonjs transform (which doesn't pass topLevelAwait through).
      ['@babel/plugin-transform-modules-commonjs', { topLevelAwait: true }],
      // react-native-worklets/plugin must come last per RN-Reanimated 4 docs.
      'react-native-worklets/plugin',
    ],
  }
}
