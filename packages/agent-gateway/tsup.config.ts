import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index: 'src/server.ts',
  },
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
  shims: true,
})
