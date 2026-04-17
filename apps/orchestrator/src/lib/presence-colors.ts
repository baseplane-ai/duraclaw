/**
 * Deterministic color assignment for collab presence — same user always
 * gets the same color across sessions and peers, so avatars and cursors
 * stay recognisable. Eight picks to keep the palette small enough that
 * colors read as "identities" rather than a continuous spectrum.
 *
 * Exported for reuse by the cursor overlay (B7, P3b).
 */

export const PRESENCE_COLORS = [
  '#ef4444', // red-500
  '#f97316', // orange-500
  '#eab308', // yellow-500
  '#22c55e', // green-500
  '#06b6d4', // cyan-500
  '#3b82f6', // blue-500
  '#a855f7', // purple-500
  '#ec4899', // pink-500
] as const

/**
 * FNV-1a 32-bit hash → one of PRESENCE_COLORS. Pure function, stable
 * across processes. Falling back to index 0 for empty IDs keeps tests
 * happy without special-casing upstream.
 */
export function colorForUserId(userId: string): string {
  if (!userId) return PRESENCE_COLORS[0]
  let hash = 2166136261
  for (let i = 0; i < userId.length; i++) {
    hash ^= userId.charCodeAt(i)
    // 32-bit FNV prime multiply via shifts (keeps int range on V8)
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0
  }
  return PRESENCE_COLORS[hash % PRESENCE_COLORS.length]
}
