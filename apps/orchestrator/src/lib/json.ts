/**
 * Parse a JSON-stringified field from a D1-mirrored column, returning null
 * on `null` input or parse failure. Used by sessionsCollection selectors
 * for contextUsageJson / kataStateJson / worktreeInfoJson — avoids
 * throwing on corrupt / legacy data (the client self-heals on the next
 * broadcast).
 */
export function parseJsonField<T>(json: string | null | undefined): T | null {
  if (json == null) return null
  try {
    return JSON.parse(json) as T
  } catch {
    return null
  }
}
