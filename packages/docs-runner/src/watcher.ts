import { relative, resolve } from 'node:path'
import { type FSWatcher, watch } from 'chokidar'
import type { SuppressedWriter } from './writer.js'

/**
 * chokidar wrapper for the docs-runner (B8 debounce + B9 self-write filter).
 *
 * Wraps chokidar v4 in a tight surface that:
 *  - applies an `awaitWriteFinish` debounce of `WATCHER_DEBOUNCE_MS` so vim's
 *    swap dance doesn't fire two events for one save (B8).
 *  - consults `writer.isSuppressed(absPath)` BEFORE invoking onChange/onUnlink/
 *    onAdd, swallowing the runner's own writes (B9).
 *  - tracks an `alive` flag that flips false on chokidar's `error` event so
 *    the B14 health endpoint can report `down`.
 */

export const WATCHER_DEBOUNCE_MS = 500

export interface WatcherOptions {
  rootPath: string
  patterns: string[]
  ignored?: string[]
  writer: SuppressedWriter
  onChange: (relPath: string, absPath: string) => void
  onUnlink: (relPath: string, absPath: string) => void
  onAdd: (relPath: string, absPath: string) => void
}

/**
 * Convert a glob pattern (supporting `**`, `*`, and `?`) into a RegExp anchored
 * against a path string. We do this in-process rather than depend on picomatch
 * because the surface area we need is tiny and chokidar v4 dropped its own
 * built-in glob matching.
 */
function globToRegExp(glob: string): RegExp {
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

export class Watcher {
  private readonly opts: WatcherOptions
  private readonly patternRegexes: RegExp[]
  private readonly ignoredRegexes: RegExp[]
  private fsw: FSWatcher | null = null
  private alive = false

  constructor(opts: WatcherOptions) {
    this.opts = opts
    this.patternRegexes = opts.patterns.map(globToRegExp)
    this.ignoredRegexes = (opts.ignored ?? []).map(globToRegExp)
  }

  async start(): Promise<void> {
    if (this.fsw) return
    const root = this.opts.rootPath

    this.fsw = watch(root, {
      ignoreInitial: false,
      awaitWriteFinish: {
        stabilityThreshold: WATCHER_DEBOUNCE_MS,
        pollInterval: 100,
      },
      ignored:
        this.opts.ignored && this.opts.ignored.length > 0
          ? (path: string) => {
              const rel = relative(root, path)
              if (rel === '' || rel.startsWith('..')) return false
              return this.ignoredRegexes.some((rx) => rx.test(rel))
            }
          : undefined,
    })

    this.alive = true

    this.fsw.on('add', (path) => this.dispatch('add', path))
    this.fsw.on('change', (path) => this.dispatch('change', path))
    this.fsw.on('unlink', (path) => this.dispatch('unlink', path))
    this.fsw.on('error', (err) => {
      this.alive = false
      console.error('[docs-runner] watcher error:', err)
    })

    await new Promise<void>((res) => {
      this.fsw?.once('ready', () => res())
    })
  }

  async stop(): Promise<void> {
    if (!this.fsw) return
    const fsw = this.fsw
    this.fsw = null
    this.alive = false
    await fsw.close()
  }

  isAlive(): boolean {
    return this.alive && this.fsw !== null
  }

  private dispatch(kind: 'add' | 'change' | 'unlink', rawPath: string): void {
    const absPath = resolve(rawPath)
    const relPath = relative(this.opts.rootPath, absPath)

    // Out-of-tree (shouldn't happen with chokidar v4, but be defensive).
    if (relPath === '' || relPath.startsWith('..')) return

    // Pattern filter — only files matching at least one pattern are emitted.
    if (!this.patternRegexes.some((rx) => rx.test(relPath))) return

    // B9: short-circuit our own writes/deletions.
    if (this.opts.writer.isSuppressed(absPath)) return

    if (kind === 'add') this.opts.onAdd(relPath, absPath)
    else if (kind === 'change') this.opts.onChange(relPath, absPath)
    else this.opts.onUnlink(relPath, absPath)
  }
}
