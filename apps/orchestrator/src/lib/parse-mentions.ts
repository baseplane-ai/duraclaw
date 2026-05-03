/**
 * GH#152 P1.5 (WU-A / B13) — server-side @-mention parser.
 *
 * Extracts `@token` candidates from a comment / chat body and resolves
 * them against the arc's membership (`arc_members ⋈ users`). Returns
 * both the resolved user ids (in token-encounter order, deduped) and
 * the unresolved tokens (for telemetry / future "did you mean?"
 * surfacing). Intended to be called by `addCommentImpl` and
 * `addChatImpl` before persisting the row, so the resolved id list
 * can be JSON-serialized into the row's `mentions` column and a row
 * per resolved id can be inserted into `arc_mentions` (WU-B).
 *
 * Decisions:
 *  - Lookbehind `(?<![\w@])` keeps email addresses (`a@example.com`)
 *    from triggering on the `@example` segment.
 *  - Token charset `[a-zA-Z0-9._-]{2,32}` rejects single-char tokens
 *    and unbounded runs; multibyte usernames are out of scope by
 *    design (rare in practice + would complicate the lookahead).
 *  - Reserved tokens (`everyone`, `here`, `channel`, `all`) are
 *    stripped — the spec calls out @everyone / @here; the others are
 *    defensive against Slack-style muscle memory.
 *  - Resolution is case-insensitive against both `users.email` (the
 *    canonical lowercased form) and `users.name` (case-insensitive
 *    for usability).
 *  - Code fences (``` and ~~~) are skipped; single-backtick spans are
 *    NOT — the spec doesn't require that level of precision and the
 *    fence-only check is meaningfully simpler.
 */

import { and, eq, inArray, or, sql } from 'drizzle-orm'
import type { DrizzleD1Database } from 'drizzle-orm/d1'
import type * as schema from '~/db/schema'
import { arcMembers, users } from '~/db/schema'

export interface ParsedMentions {
  /** User ids resolved against arc members. Stable order: per first appearance in body. */
  resolvedUserIds: string[]
  /** Tokens that appeared but didn't resolve to a member. Useful for telemetry. */
  unresolvedTokens: string[]
}

const MENTION_RE = /(?<![\w@])@([a-zA-Z0-9._-]{2,32})/g
const RESERVED = new Set(['everyone', 'here', 'channel', 'all'])

export async function parseMentions(
  db: DrizzleD1Database<typeof schema>,
  arcId: string,
  body: string,
): Promise<ParsedMentions> {
  // 1. Extract candidate tokens, skipping ones inside code fences and
  //    de-duping by lowered form (the resolver is case-insensitive).
  const candidates: string[] = []
  const seen = new Set<string>()
  for (const match of body.matchAll(MENTION_RE)) {
    const token = match[1]
    if (!token) continue
    const lower = token.toLowerCase()
    if (RESERVED.has(lower)) continue
    if (isInsideCodeFence(body, match.index ?? 0)) continue
    if (seen.has(lower)) continue
    seen.add(lower)
    candidates.push(token)
  }
  if (candidates.length === 0) {
    return { resolvedUserIds: [], unresolvedTokens: [] }
  }

  // 2. Resolve via JOIN against arc_members ⋈ users. Match by lowered
  //    email OR lowered name. The DB de-dupes by user id implicitly
  //    (a user has at most one membership row per arc).
  const lowered = candidates.map((c) => c.toLowerCase())
  const rows = await db
    .select({ id: users.id, email: users.email, name: users.name })
    .from(users)
    .innerJoin(arcMembers, eq(arcMembers.userId, users.id))
    .where(
      and(
        eq(arcMembers.arcId, arcId),
        or(
          inArray(sql`lower(${users.email})`, lowered),
          inArray(sql`lower(${users.name})`, lowered),
        ),
      ),
    )

  // 3. Build result. Preserve token-encounter order; collect unresolved.
  const userByLower = new Map<string, string>()
  for (const r of rows) {
    if (r.email) userByLower.set(r.email.toLowerCase(), r.id)
    if (r.name) userByLower.set(r.name.toLowerCase(), r.id)
  }
  const resolvedSet = new Set<string>()
  const resolvedUserIds: string[] = []
  const unresolvedTokens: string[] = []
  for (const token of candidates) {
    const id = userByLower.get(token.toLowerCase())
    if (id) {
      if (!resolvedSet.has(id)) {
        resolvedSet.add(id)
        resolvedUserIds.push(id)
      }
    } else {
      unresolvedTokens.push(token)
    }
  }
  return { resolvedUserIds, unresolvedTokens }
}

/**
 * Walk the body up to `index` and count fence delimiters. Even count =
 * outside a fenced block; odd = inside. Both ``` and ~~~ count.
 *
 * Single backtick spans (`code`) are NOT skipped — only fenced blocks.
 */
function isInsideCodeFence(body: string, index: number): boolean {
  const before = body.slice(0, index)
  let count = 0
  for (const m of before.matchAll(/^(```|~~~)/gm)) {
    void m
    count += 1
  }
  return count % 2 === 1
}
