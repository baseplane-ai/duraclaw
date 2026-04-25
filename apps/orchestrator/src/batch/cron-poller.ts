/**
 * Cron poller for the batch-analysis lane.
 *
 * Hooked into the orchestrator's existing 5-minute cron via
 * `src/api/scheduled.ts`. Fans out to the Anthropic Batches API for
 * every job that's currently in flight, transitions completed batches
 * to `completed` / `failed`, and writes per-row results back to D1.
 *
 * Per-batch lifecycle:
 *   - status='anthropic_submitted'   → poll `retrieveBatch`
 *   - processing_status='in_progress' → flip to 'in_progress' (UI hint),
 *                                       try again next tick
 *   - processing_status='ended'       → stream results, write
 *                                       result_payload / error per row,
 *                                       set completed_at
 *
 * Idempotent: safe to call repeatedly. If a batch lands twice we'll
 * just overwrite the same JSON.
 */

import { eq, inArray, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import { batchJobs } from '../db/schema'
import type { Env } from '../lib/types'
import { AnthropicBatchClient, type BatchResultRow } from './anthropic-batch'

export interface CronPollerInput {
  env: Env
  /** Override for tests. */
  now?: () => number
  /** Override for tests. */
  client?: AnthropicBatchClient
}

interface InflightRow {
  id: string
  anthropicId: string | null
  status: string
}

/**
 * Returns the number of D1 rows whose status was advanced this tick,
 * for logging / observability.
 */
export async function pollBatchJobs(input: CronPollerInput): Promise<number> {
  const { env, now = Date.now } = input
  if (!env.ANTHROPIC_API_KEY) {
    // Don't spam the cron log every 5 min — this is an opt-in lane.
    return 0
  }

  const client = input.client ?? new AnthropicBatchClient({ apiKey: env.ANTHROPIC_API_KEY })
  const db = drizzle(env.AUTH_DB)

  const rows = (await db
    .select({
      id: batchJobs.id,
      anthropicId: batchJobs.anthropicId,
      status: batchJobs.status,
    })
    .from(batchJobs)
    .where(inArray(batchJobs.status, ['anthropic_submitted', 'in_progress']))
    .all()) as InflightRow[]

  // Group by anthropicId — one D1 row per request, but typically many
  // requests share an anthropicId from a single queue invocation.
  const byBatch = new Map<string, InflightRow[]>()
  for (const r of rows) {
    if (!r.anthropicId) continue
    const list = byBatch.get(r.anthropicId)
    if (list) list.push(r)
    else byBatch.set(r.anthropicId, [r])
  }

  let advanced = 0
  for (const [batchId, members] of byBatch) {
    let status: Awaited<ReturnType<typeof client.retrieveBatch>>
    try {
      status = await client.retrieveBatch(batchId)
    } catch (err) {
      console.error(`[batch-lane] retrieveBatch ${batchId} failed:`, err)
      continue
    }

    if (status.processing_status === 'in_progress') {
      // Promote freshly-submitted rows so the UI knows they're moving.
      const stillSubmitted = members
        .filter((m) => m.status === 'anthropic_submitted')
        .map((m) => m.id)
      if (stillSubmitted.length > 0) {
        await db
          .update(batchJobs)
          .set({ status: 'in_progress' })
          .where(inArray(batchJobs.id, stillSubmitted))
        advanced += stillSubmitted.length
      }
      continue
    }

    if (status.processing_status === 'ended' && status.results_url) {
      const ts = now()
      try {
        for await (const row of client.streamResults(status.results_url)) {
          await applyResultRow(db, row, ts)
          advanced++
        }
      } catch (err) {
        console.error(`[batch-lane] streamResults ${batchId} failed:`, err)
      }
    }
  }

  return advanced
}

async function applyResultRow(
  db: ReturnType<typeof drizzle>,
  row: BatchResultRow,
  ts: number,
): Promise<void> {
  if (row.result.type === 'succeeded') {
    await db
      .update(batchJobs)
      .set({
        status: 'completed',
        resultPayload: JSON.stringify(row.result.message),
        completedAt: ts,
        error: sql`NULL`,
      })
      .where(eq(batchJobs.id, row.custom_id))
    return
  }

  const error =
    row.result.type === 'errored'
      ? `${row.result.error.type}: ${row.result.error.message}`
      : row.result.type // 'canceled' | 'expired'

  await db
    .update(batchJobs)
    .set({
      status: 'failed',
      error,
      completedAt: ts,
    })
    .where(eq(batchJobs.id, row.custom_id))
}
