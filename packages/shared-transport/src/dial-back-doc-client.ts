import {
  DialBackClient,
  type DialBackClientOptions,
  type DialBackTerminateReason,
} from './dial-back-client.js'

/**
 * Subset of `DialBackClientOptions` exposed to `DialBackDocClient` callers.
 * `onCommand` is narrowed to `Uint8Array` because the doc transport carries
 * raw y-protocols binary frames (no JSON wrapping). `additionalTerminalCodes`
 * is owned by this class — callers don't override it.
 */
export interface DialBackDocClientOptions
  extends Omit<DialBackClientOptions, 'onCommand' | 'additionalTerminalCodes'> {
  onCommand: (frame: Uint8Array) => void
}

/** Close code emitted by `RepoDocumentDO` when a document is hard-deleted
 * after the tombstone grace period elapses. Terminal — peers must stop
 * reconnecting and surface a `document_deleted` reason to the caller. */
const CLOSE_DOCUMENT_DELETED = 4412

const DOC_TERMINAL_CODES: ReadonlyMap<number, DialBackTerminateReason> = new Map([
  [CLOSE_DOCUMENT_DELETED, 'document_deleted'],
])

/**
 * Binary-frame variant of `DialBackClient` for the docs-runner ↔
 * `RepoDocumentDO` transport.
 *
 * Inherits the full reconnect / backoff / terminate machinery from the
 * parent. The only differences are:
 *   - WebSocket `binaryType` is `'arraybuffer'`.
 *   - Inbound frames are surfaced to `onCommand` as `Uint8Array` (no
 *     `JSON.parse`).
 *   - `send(update)` writes the bytes as a binary WS frame directly,
 *     bypassing the parent's `BufferedChannel` (which is JSON-oriented).
 *     Y-protocols handles its own resync via sync-step-1/2 on reconnect,
 *     so dropping a frame mid-disconnect is safe.
 *   - Close code 4412 maps to terminate reason `'document_deleted'`.
 */
export class DialBackDocClient extends DialBackClient {
  private docOnCommand: (frame: Uint8Array) => void

  constructor(options: DialBackDocClientOptions) {
    const docOnCommand = options.onCommand
    super({
      ...options,
      // Parent's `onCommand` receives `unknown` from the overridden
      // `parseIncoming`; we know it's a Uint8Array because we control both
      // sides.
      onCommand: (cmd: unknown) => docOnCommand(cmd as Uint8Array),
      additionalTerminalCodes: DOC_TERMINAL_CODES,
    })
    this.docOnCommand = docOnCommand
  }

  protected override configureWebSocket(ws: WebSocket): void {
    // Required for inbound frames to arrive as ArrayBuffer (default is
    // 'blob' in browsers, which would force an async `.arrayBuffer()` round
    // trip and break the synchronous `parseIncoming` path).
    ws.binaryType = 'arraybuffer'
  }

  protected override parseIncoming(data: unknown): unknown {
    // Inbound frames are y-protocols binary updates. Wrap the ArrayBuffer
    // in a Uint8Array view (no copy) so y-protocols `decoding.createDecoder`
    // can consume it directly.
    return new Uint8Array(data as ArrayBuffer)
  }

  /**
   * Send a y-protocols update frame as a binary WebSocket message.
   *
   * Bypasses the parent's `BufferedChannel`: that channel JSON-stringifies
   * every event and assumes a `seq` field, neither of which fits raw
   * binary. Y-protocols' sync step 1/2 handshake on reconnect re-syncs any
   * updates dropped while disconnected, so silently no-op'ing on a closed
   * socket is safe.
   *
   * Returns `true` if the frame was handed to the underlying socket, `false`
   * if there was no open socket (caller may use this for diagnostics).
   */
  send(update: Uint8Array): boolean {
    const ws = this.ws
    if (!ws || ws.readyState !== 1) {
      return false
    }
    // The `WebSocket.send` overload accepts ArrayBufferView; pass the
    // Uint8Array directly so it goes out as a single binary frame.
    ws.send(update)
    return true
  }

  // Re-exposed for test introspection / diagnostics; identical to the
  // constructor-supplied callback.
  protected handleFrame(frame: Uint8Array): void {
    this.docOnCommand(frame)
  }
}
