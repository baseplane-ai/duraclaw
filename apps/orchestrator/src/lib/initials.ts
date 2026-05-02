/**
 * Derive a 1–2 character initials string for an attribution badge.
 *
 * GH#68 B14 — used by the chat renderer to label user-role messages
 * with the sender's initials in shared (multi-human) sessions. Source
 * order is `senderName` → `senderId` → `'?'`.
 *
 * Rules:
 *   - Strip leading/trailing whitespace; collapse internal whitespace.
 *   - Split on spaces, take the first letter of the first 1–2 tokens.
 *   - Uppercase the result.
 *   - Single-token names (e.g. "ben") → first two letters ("BE") so the
 *     badge has consistent visual weight.
 *   - Email-shaped input falls back to the local-part.
 *   - Non-letter characters are skipped over when picking initials so
 *     "@codevibesmatter" → "CO" rather than "@C".
 *   - Empty/falsy input → '?' (caller decides whether to render the
 *     badge at all when no attribution exists).
 */
export function deriveInitials(input: string | null | undefined): string {
  if (!input) return '?'
  let source = input.trim()
  if (source.length === 0) return '?'

  // Email → local part. Keeps "ben@baseplane.ai" → "BE", not "B@".
  const atIdx = source.indexOf('@')
  if (atIdx > 0) source = source.slice(0, atIdx)

  // Collapse internal whitespace and split.
  const tokens = source
    .split(/\s+/)
    .map((t) => t.replace(/[^A-Za-z]/g, ''))
    .filter((t) => t.length > 0)

  if (tokens.length === 0) {
    // No letter characters at all (e.g. "1234"); fall back to first 2
    // chars of the raw trimmed input uppercased.
    return source.slice(0, 2).toUpperCase() || '?'
  }

  if (tokens.length === 1) {
    // Single token → first two letters for visual weight.
    return tokens[0].slice(0, 2).toUpperCase()
  }

  return (tokens[0][0] + tokens[1][0]).toUpperCase()
}
