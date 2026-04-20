import type { SyncedCollectionOp } from '@duraclaw/shared-types'

/**
 * Split a large ops array into sub-arrays whose JSON-serialised size
 * stays under maxBytes. Each sub-array becomes a separate
 * `synced-collection-delta` frame so the DO's 256 KiB `/broadcast` cap
 * (safety margin 200 KiB) is never exceeded.
 *
 * A single op that alone exceeds maxBytes is kept in its own chunk —
 * the caller decides whether to log / drop. The size accounting
 * approximates `JSON.stringify([...])` output: 2 bytes for the enclosing
 * `[]` plus `JSON.stringify(op).length + 1` per op (trailing comma
 * overcounts by one for the last op but never undercounts).
 */
export function chunkOps<TRow>(
  ops: Array<SyncedCollectionOp<TRow>>,
  maxBytes = 200 * 1024,
): Array<Array<SyncedCollectionOp<TRow>>> {
  const chunks: Array<Array<SyncedCollectionOp<TRow>>> = []
  let current: Array<SyncedCollectionOp<TRow>> = []
  let currentSize = 2 // "[]"
  for (const op of ops) {
    const opSize = JSON.stringify(op).length + 1 // + ","
    if (currentSize + opSize > maxBytes && current.length > 0) {
      chunks.push(current)
      current = []
      currentSize = 2
    }
    current.push(op)
    currentSize += opSize
  }
  if (current.length > 0) chunks.push(current)
  return chunks
}
