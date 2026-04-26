import { eq } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import * as schema from '~/db/schema'
import type { SessionDOContext } from './types'

/**
 * Spec #101 Stage 6: extracted body of `SessionDO.getFeatureFlagEnabled`.
 *
 * Reads a global feature flag from D1, cached in-DO for 5 minutes via
 * `ctx.do.featureFlagCache`. Fail-open: on any D1 read failure (network
 * error, missing table during a deploy window), returns `defaultValue` —
 * callers decide whether the flag should default on or off.
 */
export async function getFeatureFlagEnabledImpl(
  ctx: SessionDOContext,
  flagId: string,
  defaultValue: boolean,
): Promise<boolean> {
  const now = Date.now()
  const cached = ctx.do.featureFlagCache.get(flagId)
  if (cached && cached.expiresAt > now) return cached.enabled
  try {
    const db = drizzle(ctx.env.AUTH_DB, { schema })
    const row = await db
      .select({ enabled: schema.featureFlags.enabled })
      .from(schema.featureFlags)
      .where(eq(schema.featureFlags.id, flagId))
      .limit(1)
    const enabled = row[0] ? !!row[0].enabled : defaultValue
    ctx.do.featureFlagCache.set(flagId, { enabled, expiresAt: now + 300_000 })
    return enabled
  } catch (err) {
    console.warn(
      `[SessionDO:${ctx.ctx.id}] getFeatureFlagEnabled(${flagId}) D1 read failed, defaulting to ${defaultValue}:`,
      err,
    )
    return defaultValue
  }
}
