/**
 * Tiny glob -> RegExp helper shared by `Watcher` and the initial-file
 * discovery pass in `main.ts`.
 *
 * Supports `**`, `*`, and `?`. Anchored against a forward-slash path
 * string. We do this in-process rather than depend on picomatch because
 * the surface area we need is tiny and chokidar v4 dropped its own
 * built-in glob matching.
 */

export function globToRegExp(glob: string): RegExp {
  let re = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*') {
      if (glob[i + 1] === '*') {
        // `**` matches any number of path segments (including zero)
        re += '.*'
        i += 1
        // optional trailing `/` after `**/`
        if (glob[i + 1] === '/') i += 1
      } else {
        re += '[^/]*'
      }
    } else if (c === '?') {
      re += '[^/]'
    } else if ('.+^$|(){}[]\\'.includes(c)) {
      re += `\\${c}`
    } else {
      re += c
    }
  }
  return new RegExp(`^${re}$`)
}

export function matchesAny(relPath: string, regexes: RegExp[]): boolean {
  return regexes.some((rx) => rx.test(relPath))
}
