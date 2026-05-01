import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  // react-native is external because ai-elements is consumed by both
  // the orchestrator's Vite web build (where react-native resolves
  // via react-native-web alias) and its Metro/Expo build (where it
  // resolves to actual RN). Bundling it would force one resolution
  // path and break the other.
  external: ['react', 'react-dom', 'react-native'],
  treeshake: true,
})
