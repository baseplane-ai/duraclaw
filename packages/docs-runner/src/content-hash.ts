import { createHash } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { atomicOverwrite } from './atomic.js'
import { normalisedMarkdown } from './blocknote-bridge.js'

/**
 * Content-hash gate primitives (B8 + spike result N1).
 *
 * Hashes are computed over the *normalised* (BlockNote-round-tripped) form
 * of markdown so that disk-side and DO-side comparisons are apples-to-apples
 * — see `normalisedMarkdown()` and the spike result amendment N1 at
 * planning/research/2026-04-27-gh27-p0-spike-result.md L97-115.
 *
 * Persistence lives at `{docsWorktreePath}/.duraclaw-docs/hashes.json`.
 */

const HASH_DIR = '.duraclaw-docs'
const HASH_FILE = 'hashes.json'

/**
 * Returns the lowercase hex sha256 digest of `input`.
 */
export function sha256Hex(input: string | Uint8Array): string {
  const hash = createHash('sha256')
  hash.update(input)
  return hash.digest('hex')
}

/**
 * Hash the canonical (BlockNote-normalised) form of a markdown body.
 * Both runner-side and DO-side comparisons must hash the normalised form
 * to avoid spurious "changed" verdicts after a remote round-trip (N1).
 */
export async function hashOfNormalisedMarkdown(md: string): Promise<string> {
  const normalised = await normalisedMarkdown(md)
  return sha256Hex(normalised)
}

/**
 * Persistent map of `relPath -> hexHash`, backed by a single JSON file
 * inside the docs worktree.
 *
 * **Ordering invariant (B8):** the persist (`set` / `delete`) MUST complete
 * BEFORE the caller pushes the corresponding update to the DO. Otherwise a
 * crash between push and persist will re-push the same content on restart.
 * Enforcement is the caller's responsibility — `set` and `delete` simply
 * await the atomic write before resolving.
 */
export class HashStore {
  private readonly docsWorktreePath: string
  private readonly filePath: string
  private map: Map<string, string> = new Map()
  private loaded = false

  constructor(docsWorktreePath: string) {
    this.docsWorktreePath = docsWorktreePath
    this.filePath = join(docsWorktreePath, HASH_DIR, HASH_FILE)
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, 'utf8')
      const parsed = JSON.parse(raw) as unknown
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        this.map = new Map(
          Object.entries(parsed as Record<string, unknown>).filter(
            (entry): entry is [string, string] => typeof entry[1] === 'string',
          ),
        )
      } else {
        console.warn(`[docs-runner] HashStore: ${this.filePath} is not an object; starting empty`)
        this.map = new Map()
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT') {
        // First run — no hash file yet. This is not an error.
        this.map = new Map()
      } else if (err instanceof SyntaxError) {
        console.warn(
          `[docs-runner] HashStore: failed to parse ${this.filePath}; starting empty: ${err.message}`,
        )
        this.map = new Map()
      } else {
        throw err
      }
    }
    this.loaded = true
  }

  get(relPath: string): string | undefined {
    return this.map.get(relPath)
  }

  async set(relPath: string, hash: string): Promise<void> {
    this.map.set(relPath, hash)
    await this.persist()
  }

  async delete(relPath: string): Promise<void> {
    this.map.delete(relPath)
    await this.persist()
  }

  entries(): Iterable<[string, string]> {
    return this.map.entries()
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true })
    const obj: Record<string, string> = {}
    // Stable key order for deterministic on-disk output.
    for (const key of [...this.map.keys()].sort()) {
      const value = this.map.get(key)
      if (value !== undefined) obj[key] = value
    }
    await atomicOverwrite(this.filePath, `${JSON.stringify(obj, null, 2)}\n`)
  }

  /** @internal — exposed for diagnostics; reflects whether `load()` ran. */
  get isLoaded(): boolean {
    return this.loaded
  }

  /** @internal — exposed for diagnostics. */
  get path(): string {
    return this.filePath
  }

  /** @internal — exposed for diagnostics. */
  get worktreePath(): string {
    return this.docsWorktreePath
  }
}
