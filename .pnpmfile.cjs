/**
 * pnpm hooks — strip optional meta-framework peers from better-auth.
 *
 * better-auth lists adapters for every meta-framework it supports as
 * optional peer dependencies (Next, SvelteKit, Solid Start, TanStack
 * Start, etc.). pnpm's auto-install-peers (default: true) materializes
 * any optional peer whose hard transitive deps (react, vite, ...) are
 * already satisfied — which is all of them in this repo.
 *
 * We're a plain Vite SPA + Hono backend. None of those adapters are
 * imported from anywhere in the codebase, but they bloat the lockfile
 * and node_modules and (worse) make the lockfile lie about what stack
 * we're on. Strip them at manifest-read time so pnpm never resolves
 * them in the first place.
 *
 * If you ever switch the orchestrator to one of these meta-frameworks,
 * remove the corresponding entry from the `drop` list and re-run
 * `pnpm install`.
 */
function readPackage(pkg) {
  if (pkg.name === 'better-auth') {
    const drop = [
      '@lynx-js/react',
      '@sveltejs/kit',
      '@tanstack/react-start',
      '@tanstack/solid-start',
      'next',
      'solid-js',
      'svelte',
      'vue',
    ]
    for (const peer of drop) {
      if (pkg.peerDependencies) delete pkg.peerDependencies[peer]
      if (pkg.peerDependenciesMeta) delete pkg.peerDependenciesMeta[peer]
    }
  }
  return pkg
}

module.exports = { hooks: { readPackage } }
