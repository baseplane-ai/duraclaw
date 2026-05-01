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
      // react-native-worklets/plugin must come last per RN-Reanimated 4 docs.
      'react-native-worklets/plugin',
    ],
  }
}
