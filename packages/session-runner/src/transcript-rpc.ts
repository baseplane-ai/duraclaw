/**
 * GH#119 P1.2: TranscriptRpc — runner-side request/response multiplexer
 * over the dial-back WS.
 *
 * Piggybacks on the same connection used for `GatewayEvent` /
 * `GatewayCommand` traffic; correlates concurrent calls via `rpc_id`
 * (UUID v4). Each `call()` registers a pending entry, ships a
 * `{type:'transcript-rpc', method, params, rpc_id, session_id}` frame
 * via the injected `send` function, and resolves / rejects when the DO
 * sends back a `transcript-rpc-response` (delivered into
 * `handleResponse`) or the per-call timeout fires.
 *
 * **Retry contract** — this RPC class itself does NOT retry. The Claude
 * Agent SDK's `SessionStore.append()` is documented as best-effort with
 * 3 attempts + short backoff (sdk.d.ts L3552: "Rejection is retried
 * (3 attempts total) with short backoff; timeouts (60s) are not retried
 * since the in-flight call may still land"). The runner-side adapter
 * surfaces a single rejection per `call()` and lets the SDK drive
 * retry. On WS disconnect, the dial-back client invokes `cancelAll`
 * which rejects every pending call promptly with a meaningful reason —
 * the SDK's append-retry then fires fresh `call()`s once the WS
 * reconnects.
 *
 * **Wire shape** — the DO's `handleTranscriptRpc` reads `event.session_id`
 * to route the response. The constructor takes `sessionId` and stamps it
 * into every outgoing frame so callers don't have to thread it through.
 */

import type { TranscriptRpcRequestEvent } from '@duraclaw/shared-types'

/** Public contract — keeps the SessionStore adapter decoupled from the wire. */
export interface TranscriptRpc {
  /**
   * Send an RPC and await the response. Throws on timeout or WS error.
   *
   * `opts.timeoutMs` overrides the constructor default for this single call —
   * used by `loadTranscript` so the RPC's per-call window matches the SDK's
   * `loadTimeoutMs` (120s) and a slow load on a cold-start DO doesn't fail
   * at the RPC layer with budget still remaining at the SDK layer.
   */
  call<T>(
    method: TranscriptRpcMethod,
    params: Record<string, unknown>,
    opts?: { timeoutMs?: number },
  ): Promise<T>
}

export type TranscriptRpcMethod = TranscriptRpcRequestEvent['method']

/**
 * Frame send signature — accepts an event object. We use the object form
 * (rather than a pre-stringified string) so the BufferedChannel can stamp
 * the monotonic `seq` field internally, matching every other event the
 * runner emits and keeping gap-detection consistent on the DO side.
 */
export type TranscriptRpcSend = (frame: Record<string, unknown>) => void

interface PendingEntry {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
  method: TranscriptRpcMethod
}

const DEFAULT_TIMEOUT_MS = 30_000

interface WsTranscriptRpcOptions {
  /** Per-call timeout in ms. Defaults to 30 000. */
  timeoutMs?: number
  /** Injected for tests so they don't drift to wall-clock. */
  clock?: () => number
  /** Injected for tests; defaults to globalThis.setTimeout. */
  setTimer?: typeof setTimeout
  /** Injected for tests; defaults to globalThis.clearTimeout. */
  clearTimer?: typeof clearTimeout
}

export class WsTranscriptRpc implements TranscriptRpc {
  private readonly pending = new Map<string, PendingEntry>()
  private readonly timeoutMs: number
  private readonly setTimer: typeof setTimeout
  private readonly clearTimer: typeof clearTimeout

  constructor(
    private readonly sessionId: string,
    private readonly send: TranscriptRpcSend,
    opts: WsTranscriptRpcOptions = {},
  ) {
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
    this.setTimer = opts.setTimer ?? setTimeout
    this.clearTimer = opts.clearTimer ?? clearTimeout
  }

  call<T>(
    method: TranscriptRpcMethod,
    params: Record<string, unknown>,
    opts?: { timeoutMs?: number },
  ): Promise<T> {
    const rpcId = crypto.randomUUID()
    const timeoutMs = opts?.timeoutMs ?? this.timeoutMs
    return new Promise<T>((resolve, reject) => {
      const timer = this.setTimer(() => {
        const entry = this.pending.get(rpcId)
        if (!entry) return
        this.pending.delete(rpcId)
        reject(new Error(`TranscriptRpc timeout: ${method} after ${timeoutMs}ms`))
      }, timeoutMs)
      this.pending.set(rpcId, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer,
        method,
      })
      try {
        this.send({
          type: 'transcript-rpc',
          session_id: this.sessionId,
          rpc_id: rpcId,
          method,
          params,
        })
      } catch (err) {
        // Synchronous send failure — clear and reject immediately.
        const entry = this.pending.get(rpcId)
        if (entry) {
          this.clearTimer(entry.timer)
          this.pending.delete(rpcId)
        }
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  /**
   * Called by the WS message handler when a `transcript-rpc-response`
   * arrives. Drops silently if `rpcId` is not pending — defensive against
   * late responses arriving after `cancelAll` (e.g. a WS close raced with
   * the reply).
   */
  handleResponse(rpcId: string, result: unknown, error: string | null): void {
    const entry = this.pending.get(rpcId)
    if (!entry) return
    this.pending.delete(rpcId)
    this.clearTimer(entry.timer)
    if (error) {
      entry.reject(new Error(`TranscriptRpc error: ${error}`))
    } else {
      entry.resolve(result)
    }
  }

  /**
   * Cancel every pending call. Invoked from the dial-back client's
   * `onTerminate` and `onClose` paths so the SDK observes a prompt
   * rejection rather than waiting on the 30s timeout.
   */
  cancelAll(reason: string): void {
    for (const [, entry] of this.pending) {
      this.clearTimer(entry.timer)
      entry.reject(new Error(`TranscriptRpc cancelled: ${reason}`))
    }
    this.pending.clear()
  }

  /** Test helper — current pending-call count. */
  get pendingCount(): number {
    return this.pending.size
  }
}
