import path from 'node:path'

/**
 * Defence-in-depth check that `relPath` resolves to a location strictly
 * inside `rootPath`. `relPath` ORIGINATES safely from local file discovery
 * in `main.ts`, but it can ALSO arrive over the wire from Yjs doc state
 * pushed by a remote peer. A malicious or compromised peer could inject
 * `relPath = "../../etc/passwd"` — this guard rejects that before any
 * filesystem read or write happens.
 *
 * Returns the validated absolute path on success. Throws on rejection.
 *
 * NOTE: We do NOT call `realpath`. Symlinks pointing out of the worktree
 * are a separate threat model; this check is purely about lexical path
 * traversal.
 */
export function assertWithinRoot(rootPath: string, relPath: string): string {
  if (typeof relPath !== 'string' || relPath.length === 0) {
    throw new Error('empty relPath')
  }
  const root = path.resolve(rootPath)
  const abs = path.resolve(rootPath, relPath)
  if (abs !== root && !abs.startsWith(`${root}${path.sep}`)) {
    throw new Error(`path escapes worktree root: relPath=${relPath}`)
  }
  return abs
}
