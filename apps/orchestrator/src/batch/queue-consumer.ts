/**
 * Queue consumer for the batch-analysis lane.
 *
 * Cloudflare Queues delivers up to N messages per invocation. We turn
 * each invocation into ONE Anthropic Message Batches call — the whole
 * point of the lane is to amortise the 50% discount across many
 * requests in a single submission.
 *
 * Per-message lifecycle:
 *   - producer wrote `batch_jobs` row with `status='queued'` and pushed
 *     the queue message
 *   - this consumer flips the row to `status='anthropic_submitted'`,
 *     stamps `anthropic_id` + `submitted_at`, and acks the message
 *   - the cron poller (cron-poller.ts) takes it from there
 *
 * Error handling:
 *   - missing `ANTHROPIC_API_KEY`  → log + retry (don't drop)
 *   - Anthropic 4xx                 → log + ack (poison message; sits
 *                                     in `anthropic_submitted` with
 *                                     `error` populated)
 *   - Anthropic 5xx / network       → throw, queue retries with backoff
 *     into the configured DLQ
 */

import { inArray } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/d1'
import { batchJobs } from '../db/schema'
import type { BatchJobMessage, Env } from '../lib/types'
import { AnthropicBatchClient, type AnthropicBatchRequest } from './anthropic-batch'

export interface QueueConsumerInput {
  env: Env
  /** Whatever cloudflare delivers to the `queue()` Worker handler. */
  batch: MessageBatch<BatchJobMessage>
  /** Override for tests. */
  now?: () => number
  /** Override for tests. */
  client?: AnthropicBatchClient
}

export async function handleBatchQueue(input: QueueConsumerInput): Promise<void> {
  const { env, batch, now = Date.now } = input
  if (batch.messages.length === 0) return

  if (!env.ANTHROPIC_API_KEY) {
    console.error('[batch-lane] ANTHROPIC_API_KEY missing — retrying entire batch')
    for (const m of batch.messages) m.retry()
    return
  }

  const client = input.client ?? new AnthropicBatchClient({ apiKey: env.ANTHROPIC_API_KEY })
  const db = drizzle(env.AUTH_DB)

  // Build the Anthropic request from each message's stored payload.
  const requests: AnthropicBatchRequest[] = []
  const ids: string[] = []
  for (const m of batch.messages) {
    let params: Record<string, unknown>
    try {
      params = JSON.parse(m.body.requestPayload)
    } catch (err) {
      console.error(
        `[batch-lane] message ${m.body.id} has unparseable request_payload — acking + marking failed`,
        err,
      )
      // Don't retry: the payload is corrupt and won't get better.
      await markFailed(db, m.body.id, `unparseable request_payload: ${String(err)}`, now())
      m.ack()
      continue
    }
    requests.push({ custom_id: m.body.id, params })
    ids.push(m.body.id)
  }

  if (requests.length === 0) return

  let created: Awaited<ReturnType<typeof client.createBatch>>
  try {
    created = await client.createBatch(requests)
  } catch (err) {
    // Network / 5xx — let the queue retry the whole batch.
    console.error('[batch-lane] createBatch threw, retrying:', err)
    for (const m of batch.messages) m.retry()
    return
  }

  // Persist anthropic_id + flip status. One UPDATE per submitted batch
  // (D1 can't issue per-row UPDATEs cheaply via drizzle yet).
  const submittedAt = now()
  await db
    .update(batchJobs)
    .set({
      status: 'anthropic_submitted',
      anthropicId: created.id,
      submittedAt,
    })
    .where(inArray(batchJobs.id, ids))

  for (const m of batch.messages) m.ack()
}

async function markFailed(
  db: ReturnType<typeof drizzle>,
  id: string,
  error: string,
  ts: number,
): Promise<void> {
  await db
    .update(batchJobs)
    .set({ status: 'failed', error, completedAt: ts })
    .where(inArray(batchJobs.id, [id]))
}
