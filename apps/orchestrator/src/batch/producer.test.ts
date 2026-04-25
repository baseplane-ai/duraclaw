import { describe, expect, it } from 'vitest'
import type { BatchJobMessage, Env } from '../lib/types'
import { BatchLaneDisabledError, BatchLaneValidationError, submitBatchJob } from './producer'

interface FakeQueue {
  sent: BatchJobMessage[]
  send(msg: BatchJobMessage): Promise<void>
}

function fakeQueue(): FakeQueue {
  const sent: BatchJobMessage[] = []
  return {
    sent,
    async send(msg) {
      sent.push(msg)
    },
  }
}

function fakeD1(): D1Database {
  // The producer only calls `db.insert(batchJobs).values(...)` via
  // drizzle. We give drizzle a no-op D1Database stub by intercepting
  // `.prepare()` → `.bind()` → `.run()`.
  const stub: Partial<D1Database> = {
    prepare(_sql: string) {
      const stmt: Partial<D1PreparedStatement> = {
        bind: () => stmt as D1PreparedStatement,
        run: async () =>
          ({
            results: [],
            success: true,
            meta: {} as D1Meta,
          }) as D1Result,
      }
      return stmt as D1PreparedStatement
    },
  }
  return stub as D1Database
}

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    AUTH_DB: fakeD1(),
    BETTER_AUTH_SECRET: 'x',
    SESSION_AGENT: {} as DurableObjectNamespace,
    USER_SETTINGS: {} as DurableObjectNamespace,
    SESSION_COLLAB: {} as DurableObjectNamespace,
    ASSETS: { fetch: async () => new Response() } as unknown as Fetcher,
    ...overrides,
  } as Env
}

describe('submitBatchJob', () => {
  it('throws BatchLaneDisabledError when BATCH_LANE_ENABLED !== "1"', async () => {
    const queue = fakeQueue()
    const env = makeEnv({ BATCH_JOBS: queue as unknown as Queue<BatchJobMessage> })
    await expect(
      submitBatchJob({ env }, { consumer: 'autoresearch', requestPayload: {} }),
    ).rejects.toBeInstanceOf(BatchLaneDisabledError)
    expect(queue.sent).toHaveLength(0)
  })

  it('throws BatchLaneDisabledError when BATCH_JOBS is unbound', async () => {
    const env = makeEnv({ BATCH_LANE_ENABLED: '1' })
    await expect(
      submitBatchJob({ env }, { consumer: 'autoresearch', requestPayload: {} }),
    ).rejects.toBeInstanceOf(BatchLaneDisabledError)
  })

  it('rejects empty `consumer`', async () => {
    const queue = fakeQueue()
    const env = makeEnv({
      BATCH_LANE_ENABLED: '1',
      BATCH_JOBS: queue as unknown as Queue<BatchJobMessage>,
    })
    await expect(
      submitBatchJob({ env }, { consumer: '   ', requestPayload: {} }),
    ).rejects.toBeInstanceOf(BatchLaneValidationError)
    expect(queue.sent).toHaveLength(0)
  })

  it('rejects null requestPayload', async () => {
    const queue = fakeQueue()
    const env = makeEnv({
      BATCH_LANE_ENABLED: '1',
      BATCH_JOBS: queue as unknown as Queue<BatchJobMessage>,
    })
    await expect(
      submitBatchJob(
        { env },
        // @ts-expect-error — exercising the runtime guard
        { consumer: 'summary', requestPayload: null },
      ),
    ).rejects.toBeInstanceOf(BatchLaneValidationError)
  })

  it('inserts a row + enqueues exactly one queue message on success', async () => {
    const queue = fakeQueue()
    const env = makeEnv({
      BATCH_LANE_ENABLED: '1',
      BATCH_JOBS: queue as unknown as Queue<BatchJobMessage>,
    })
    const out = await submitBatchJob(
      {
        env,
        now: () => 1_700_000_000_000,
        newId: () => 'fixed-id',
      },
      {
        consumer: 'autoresearch',
        sessionId: 'sess-1',
        requestPayload: { model: 'claude-sonnet-4-6', messages: [] },
      },
    )
    expect(out).toEqual({ id: 'fixed-id', status: 'queued' })
    expect(queue.sent).toHaveLength(1)
    expect(queue.sent[0]).toMatchObject({
      id: 'fixed-id',
      consumer: 'autoresearch',
      sessionId: 'sess-1',
    })
    // requestPayload is serialised on its way through.
    expect(JSON.parse(queue.sent[0]!.requestPayload)).toEqual({
      model: 'claude-sonnet-4-6',
      messages: [],
    })
  })
})
