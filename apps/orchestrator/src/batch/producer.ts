/**
 * Producer for the batch-analysis lane.
 *
 * `POST /api/batch-jobs` (auth-gated by the existing session middleware)
 * persists a row to D1 and pushes a message onto the BATCH_JOBS queue.
 * The queue consumer (queue-consumer.ts) picks it up next invocation.
 *
 * Request shape:
 *   {
 *     consumer:        string,     // 'autoresearch' | 'summary' | …
 *     sessionId?:      string,     // optional cross-ref to agent_sessions.id
 *     requestPayload:  unknown     // a `messages.create`-shaped body
 *   }
 *
 * Response on success: 202 Accepted, `{ id, status: 'queued' }`.
 *
 * Returns a 503 when:
 *   - `BATCH_LANE_ENABLED` is not set to `'1'`
 *   - the `BATCH_JOBS` queue isn't bound on this Worker
 *
 * Either case lets operators ship the code without immediately wiring
 * the queue + secret.
 */

import { drizzle } from 'drizzle-orm/d1'
import { batchJobs } from '../db/schema'
import type { BatchJobMessage, Env } from '../lib/types'

export interface SubmitBatchJobInput {
  consumer: string
  sessionId?: string | null
  requestPayload: unknown
}

export interface SubmitBatchJobResult {
  status: 'queued'
  id: string
}

export class BatchLaneDisabledError extends Error {
  constructor() {
    super('Batch-analysis lane is disabled (set BATCH_LANE_ENABLED=1 + bind BATCH_JOBS).')
  }
}

export class BatchLaneValidationError extends Error {}

export interface SubmitBatchJobDeps {
  env: Env
  /** Override for tests. */
  now?: () => number
  /** Override for tests. */
  newId?: () => string
}

export async function submitBatchJob(
  deps: SubmitBatchJobDeps,
  input: SubmitBatchJobInput,
): Promise<SubmitBatchJobResult> {
  const { env } = deps
  if (env.BATCH_LANE_ENABLED !== '1' || !env.BATCH_JOBS) {
    throw new BatchLaneDisabledError()
  }

  const consumer = (input.consumer ?? '').trim()
  if (!consumer) {
    throw new BatchLaneValidationError('`consumer` is required and non-empty.')
  }
  if (input.requestPayload == null) {
    throw new BatchLaneValidationError('`requestPayload` is required.')
  }

  const id = deps.newId?.() ?? crypto.randomUUID()
  const now = (deps.now ?? Date.now)()
  const sessionId = input.sessionId ?? null
  const requestPayloadStr = JSON.stringify(input.requestPayload)

  const db = drizzle(env.AUTH_DB)
  await db.insert(batchJobs).values({
    id,
    consumer,
    sessionId,
    status: 'queued',
    requestPayload: requestPayloadStr,
    createdAt: now,
  })

  const msg: BatchJobMessage = {
    id,
    consumer,
    sessionId,
    requestPayload: requestPayloadStr,
  }
  await env.BATCH_JOBS.send(msg)

  return { id, status: 'queued' }
}
