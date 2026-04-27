import { unlink as fsUnlink, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { atomicOverwrite } from './atomic.js'

/**
 * Write-back loop suppression (B9).
 *
 * When the runner writes a file because of an inbound remote Yjs update, the
 * subsequent chokidar `change`/`unlink` event MUST be swallowed — otherwise
 * the runner re-pushes its own write back to the DO and loops.
 *
 * `SuppressedWriter` records the absolute path in a private map BEFORE the fs
 * call; chokidar's wrapper consults `isSuppressed(absPath)` and short-circuits
 * if the entry is fresh. Suppressions are *single-shot* — each entry swallows
 * exactly one event, then is removed. This avoids accidentally swallowing a
 * legitimate user edit that lands within the TTL window.
 */

export const SUPPRESS_TTL_MS = 2000

export class SuppressedWriter {
  private readonly rootPath: string
  private readonly suppressedPaths: Map<string, number> = new Map()

  constructor(rootPath: string) {
    this.rootPath = rootPath
  }

  /**
   * Atomic write of `contents` to `relPath` (relative to `rootPath`). Suppress
   * entry is recorded BEFORE the write so that there is no window in which
   * chokidar could observe the change without the suppress marker present.
   */
  async write(relPath: string, contents: string): Promise<void> {
    const absPath = resolve(this.rootPath, relPath)
    // Record suppression BEFORE the fs visible change (B9 invariant).
    this.suppressedPaths.set(absPath, Date.now())
    await mkdir(dirname(absPath), { recursive: true })
    await atomicOverwrite(absPath, contents)
  }

  /**
   * Delete `relPath` (relative to `rootPath`) and record a suppress entry so
   * the resulting chokidar `unlink` event doesn't fire B10's tombstone.
   */
  async unlink(relPath: string): Promise<void> {
    const absPath = resolve(this.rootPath, relPath)
    this.suppressedPaths.set(absPath, Date.now())
    try {
      await fsUnlink(absPath)
    } catch (err) {
      // If the file is already gone, the suppress entry will simply expire.
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'ENOENT') throw err
    }
  }

  /**
   * Returns true if `absPath` has a suppress entry less than `SUPPRESS_TTL_MS`
   * old. Single-shot — the entry is removed on consumption (whether a hit or
   * an expiry) so it can swallow exactly one event.
   */
  isSuppressed(absPath: string): boolean {
    const ts = this.suppressedPaths.get(absPath)
    if (ts === undefined) return false
    this.suppressedPaths.delete(absPath)
    return Date.now() - ts < SUPPRESS_TTL_MS
  }

  /** @internal — exposed for diagnostics. */
  get pendingSuppressionCount(): number {
    return this.suppressedPaths.size
  }
}
