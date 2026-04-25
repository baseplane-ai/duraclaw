import { describe, expect, it } from 'vitest'
import { AnthropicBatchClient, type BatchResultRow } from './anthropic-batch'

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  })
}

function streamResponse(text: string): Response {
  return new Response(text, {
    status: 200,
    headers: { 'content-type': 'application/x-ndjson' },
  })
}

describe('AnthropicBatchClient', () => {
  describe('createBatch', () => {
    it('POSTs to /v1/messages/batches with the api-key + version headers', async () => {
      let capturedReq: Request | undefined
      const fetchStub: typeof fetch = async (input, init) => {
        capturedReq = new Request(input as RequestInfo, init)
        return jsonResponse({
          id: 'batch_123',
          type: 'message_batch',
          processing_status: 'in_progress',
        })
      }
      const client = new AnthropicBatchClient({ apiKey: 'sk-test', fetch: fetchStub })

      const result = await client.createBatch([
        { custom_id: 'a', params: { model: 'claude-sonnet-4-6', messages: [] } },
      ])

      expect(result.id).toBe('batch_123')
      expect(capturedReq?.method).toBe('POST')
      expect(capturedReq?.url).toBe('https://api.anthropic.com/v1/messages/batches')
      expect(capturedReq?.headers.get('x-api-key')).toBe('sk-test')
      expect(capturedReq?.headers.get('anthropic-version')).toBe('2023-06-01')
      const body = (await capturedReq?.json()) as { requests: unknown[] }
      expect(body.requests).toHaveLength(1)
    })

    it('throws on a non-2xx response with the upstream body in the message', async () => {
      const fetchStub: typeof fetch = async () => new Response('rate limited', { status: 429 })
      const client = new AnthropicBatchClient({ apiKey: 'k', fetch: fetchStub })

      await expect(client.createBatch([{ custom_id: 'a', params: {} }])).rejects.toThrow(
        /createBatch failed: 429 rate limited/,
      )
    })

    it('rejects empty request lists at the call site', async () => {
      const client = new AnthropicBatchClient({ apiKey: 'k', fetch })
      await expect(client.createBatch([])).rejects.toThrow(/at least one request/)
    })

    it('honours a custom baseUrl + strips trailing slashes', async () => {
      let url: string | undefined
      const fetchStub: typeof fetch = async (input) => {
        url = (input as Request).url ?? String(input)
        return jsonResponse({
          id: 'batch_x',
          type: 'message_batch',
          processing_status: 'in_progress',
        })
      }
      const client = new AnthropicBatchClient({
        apiKey: 'k',
        baseUrl: 'https://eu.api.anthropic.com//',
        fetch: fetchStub,
      })
      await client.createBatch([{ custom_id: 'a', params: {} }])
      expect(url).toBe('https://eu.api.anthropic.com/v1/messages/batches')
    })
  })

  describe('retrieveBatch', () => {
    it('GETs /v1/messages/batches/:id', async () => {
      let capturedUrl: string | undefined
      const fetchStub: typeof fetch = async (input) => {
        capturedUrl = (input as Request).url ?? String(input)
        return jsonResponse({
          id: 'batch_x',
          type: 'message_batch',
          processing_status: 'ended',
          results_url: 'https://api.anthropic.com/v1/messages/batches/batch_x/results',
        })
      }
      const client = new AnthropicBatchClient({ apiKey: 'k', fetch: fetchStub })

      const status = await client.retrieveBatch('batch_x')

      expect(capturedUrl).toBe('https://api.anthropic.com/v1/messages/batches/batch_x')
      expect(status.processing_status).toBe('ended')
      expect(status.results_url).toContain('/results')
    })
  })

  describe('streamResults', () => {
    it('yields one parsed row per JSONL line', async () => {
      const lines = [
        JSON.stringify({
          custom_id: 'a',
          result: { type: 'succeeded', message: { id: 'msg_a' } },
        }),
        JSON.stringify({
          custom_id: 'b',
          result: { type: 'errored', error: { type: 'overloaded_error', message: 'try later' } },
        }),
        JSON.stringify({
          custom_id: 'c',
          result: { type: 'expired' },
        }),
      ]
      // Trailing line intentionally has no newline — confirms the
      // tail-flush path.
      const body = lines.join('\n')
      const fetchStub: typeof fetch = async () => streamResponse(body)
      const client = new AnthropicBatchClient({ apiKey: 'k', fetch: fetchStub })

      const collected: BatchResultRow[] = []
      for await (const row of client.streamResults('https://example/results')) {
        collected.push(row)
      }
      expect(collected).toHaveLength(3)
      expect(collected[0]?.custom_id).toBe('a')
      expect(collected[1]?.result.type).toBe('errored')
      expect(collected[2]?.result.type).toBe('expired')
    })

    it('skips blank lines without yielding garbage', async () => {
      const body =
        '\n\n' +
        JSON.stringify({
          custom_id: 'only',
          result: { type: 'succeeded', message: {} },
        }) +
        '\n\n\n'
      const fetchStub: typeof fetch = async () => streamResponse(body)
      const client = new AnthropicBatchClient({ apiKey: 'k', fetch: fetchStub })

      const collected: BatchResultRow[] = []
      for await (const row of client.streamResults('https://example/results')) {
        collected.push(row)
      }
      expect(collected).toHaveLength(1)
      expect(collected[0]?.custom_id).toBe('only')
    })
  })
})
