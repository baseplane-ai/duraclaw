/**
 * Thin HTTP client for the Anthropic Message Batches API.
 *
 *   https://docs.anthropic.com/en/api/creating-message-batches
 *
 * Pure functions over `fetch` — no Workers-specific bindings, so this
 * module is exercised in vitest without a wrangler shim.
 */

const ANTHROPIC_BASE = 'https://api.anthropic.com'
const ANTHROPIC_VERSION = '2023-06-01'

export interface AnthropicBatchRequest {
  /** Anthropic-defined identifier returned in the per-result row. We
   *  reuse our D1 row id so a result row maps straight back. */
  custom_id: string
  /** A `POST /v1/messages`-shaped body — model, messages, max_tokens, … */
  params: Record<string, unknown>
}

export interface CreateBatchResponse {
  id: string
  type: 'message_batch'
  processing_status: 'in_progress' | 'canceling' | 'ended'
  request_counts?: {
    processing: number
    succeeded: number
    errored: number
    canceled: number
    expired: number
  }
  ended_at?: string | null
  results_url?: string | null
}

export interface RetrieveBatchResponse extends CreateBatchResponse {}

/**
 * One row from the JSONL stream returned by the batch results URL.
 * The Anthropic API documents `result.type` ∈ {succeeded, errored,
 * canceled, expired}; only the succeeded variant carries the upstream
 * `messages.create` response under `result.message`.
 */
export interface BatchResultRow {
  custom_id: string
  result:
    | {
        type: 'succeeded'
        message: Record<string, unknown>
      }
    | {
        type: 'errored'
        error: { type: string; message: string }
      }
    | {
        type: 'canceled' | 'expired'
      }
}

export interface AnthropicBatchClientOptions {
  apiKey: string
  /** Override the base URL (test stubs, alt regions). */
  baseUrl?: string
  /** Override fetch (Workers globals, test stubs). */
  fetch?: typeof fetch
}

export class AnthropicBatchClient {
  private readonly apiKey: string
  private readonly baseUrl: string
  private readonly fetch: typeof fetch

  constructor(opts: AnthropicBatchClientOptions) {
    this.apiKey = opts.apiKey
    this.baseUrl = (opts.baseUrl ?? ANTHROPIC_BASE).replace(/\/+$/, '')
    this.fetch = opts.fetch ?? fetch
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      'x-api-key': this.apiKey,
      'anthropic-version': ANTHROPIC_VERSION,
      'content-type': 'application/json',
      ...extra,
    }
  }

  /** Submit one batch (1..N requests). Returns the new batch's id. */
  async createBatch(requests: AnthropicBatchRequest[]): Promise<CreateBatchResponse> {
    if (requests.length === 0) {
      throw new TypeError('createBatch: at least one request is required')
    }
    const res = await this.fetch(`${this.baseUrl}/v1/messages/batches`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ requests }),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`Anthropic createBatch failed: ${res.status} ${body}`)
    }
    return (await res.json()) as CreateBatchResponse
  }

  /** Retrieve current batch status. Used by the cron poller. */
  async retrieveBatch(batchId: string): Promise<RetrieveBatchResponse> {
    const res = await this.fetch(`${this.baseUrl}/v1/messages/batches/${batchId}`, {
      method: 'GET',
      headers: this.headers(),
    })
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      throw new Error(`Anthropic retrieveBatch failed: ${res.status} ${body}`)
    }
    return (await res.json()) as RetrieveBatchResponse
  }

  /**
   * Stream the JSONL results of a finished batch. Yields one
   * `BatchResultRow` per line; tolerates blank lines and partial
   * trailing lines (last chunk may not end with `\n`).
   */
  async *streamResults(resultsUrl: string): AsyncGenerator<BatchResultRow> {
    const res = await this.fetch(resultsUrl, {
      method: 'GET',
      headers: this.headers(),
    })
    if (!res.ok || !res.body) {
      const body = await res.text().catch(() => '')
      throw new Error(`Anthropic streamResults failed: ${res.status} ${body}`)
    }
    const decoder = new TextDecoder('utf-8')
    let buffered = ''
    const reader = res.body.getReader()
    for (;;) {
      const { value, done } = await reader.read()
      if (value) {
        buffered += decoder.decode(value, { stream: true })
        let idx = buffered.indexOf('\n')
        while (idx !== -1) {
          const line = buffered.slice(0, idx).trim()
          buffered = buffered.slice(idx + 1)
          if (line) yield JSON.parse(line) as BatchResultRow
          idx = buffered.indexOf('\n')
        }
      }
      if (done) break
    }
    const trailing = buffered.trim()
    if (trailing) yield JSON.parse(trailing) as BatchResultRow
  }
}
