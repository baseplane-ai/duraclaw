import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts', 'src/main.ts'],
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  banner: (ctx) => {
    if (ctx.format === 'esm') {
      // Only prepend shebang to the executable entrypoint, not the library entry.
      return {}
    }
    return {}
  },
  esbuildOptions(options, _ctx) {
    // tsup emits one file per entry in esm; we only want the shebang on main.js
    // (which doesn't exist yet — added in WU-D). esbuild's `banner` option
    // applies globally, so we instead post-process via `onSuccess` below.
    options.logLevel = options.logLevel ?? 'info'
  },
  onSuccess: async () => {
    // Prepend #!/usr/bin/env bun to dist/main.js so it's directly executable.
    // No-op until WU-D adds src/main.ts to the entry list.
    const { existsSync } = await import('node:fs')
    const mainPath = 'dist/main.js'
    if (!existsSync(mainPath)) return
    const { readFile, writeFile, chmod } = await import('node:fs/promises')
    const content = await readFile(mainPath, 'utf8')
    const shebang = '#!/usr/bin/env bun\n'
    if (!content.startsWith('#!')) {
      await writeFile(mainPath, shebang + content)
    }
    await chmod(mainPath, 0o755)
  },
})
