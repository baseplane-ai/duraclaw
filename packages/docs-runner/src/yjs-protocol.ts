/**
 * y-protocols sync + awareness wire helper for the docs-runner (B7).
 *
 * `RepoDocumentDO` (a y-partyserver) speaks the canonical y-protocols
 * binary framing:
 *
 *   outerFrame := varUint(messageType) payload
 *   messageType 0 = sync sub-protocol — payload is varUint(syncStep) bytes
 *   messageType 1 = awareness sub-protocol — payload is the awareness update
 *
 * `YjsTransport` wires a local `Y.Doc` + `Awareness` pair to a binary
 * `send(frame)` callback (typically `DialBackDocClient.send`) and an
 * inbound `handleIncoming(frame)` entrypoint (called from
 * `DialBackDocClient.onCommand`). It owns nothing about the WS itself —
 * reconnect, backoff, terminate are the dial-back client's job.
 *
 * Echo prevention: every local apply uses `this` as the Y origin, and
 * `broadcastUpdate` filters those out so applying inbound state never
 * round-trips back to the peer.
 */

import * as decoding from 'lib0/decoding'
import * as encoding from 'lib0/encoding'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as syncProtocol from 'y-protocols/sync'
import type * as Y from 'yjs'

export const MESSAGE_SYNC = 0
export const MESSAGE_AWARENESS = 1

export interface YjsRunnerIdentity {
  kind: 'docs-runner'
  host: string
  version: string
  projectId: string
}

export interface YjsTransportOptions {
  ydoc: Y.Doc
  awareness: awarenessProtocol.Awareness
  send: (frame: Uint8Array) => void
  /**
   * Optional richer identity broadcast on awareness as the `user` field.
   * Browsers can render a presence chip showing host/version/projectId.
   * Falls back to `{ kind: 'docs-runner' }` when omitted.
   */
  identity?: YjsRunnerIdentity
}

export class YjsTransport {
  readonly ydoc: Y.Doc
  readonly awareness: awarenessProtocol.Awareness
  /** Resolves once a sync step 2 reply has arrived (initial sync done). */
  readonly synced: Promise<void>

  private readonly sendFrame: (frame: Uint8Array) => void
  private readonly onDocUpdate: (update: Uint8Array, origin: unknown) => void
  private readonly onAwarenessUpdate: () => void
  private resolveSync: (() => void) | null = null
  private destroyed = false

  constructor(opts: YjsTransportOptions) {
    this.ydoc = opts.ydoc
    this.awareness = opts.awareness
    this.sendFrame = opts.send

    this.synced = new Promise<void>((resolve) => {
      this.resolveSync = resolve
    })

    // Identify ourselves to remote peers (browsers can render a presence chip).
    this.awareness.setLocalStateField('user', opts.identity ?? { kind: 'docs-runner' })

    this.onDocUpdate = (update, origin) => this.broadcastUpdate(update, origin)
    this.onAwarenessUpdate = () => this.broadcastAwareness()

    this.ydoc.on('update', this.onDocUpdate)
    this.awareness.on('update', this.onAwarenessUpdate)
  }

  /** Send sync step 1 (state-vector request). Call this on WS open. */
  sendSyncStep1(): void {
    if (this.destroyed) return
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, MESSAGE_SYNC)
    syncProtocol.writeSyncStep1(encoder, this.ydoc)
    this.sendFrame(encoding.toUint8Array(encoder))
  }

  /** Decode + apply an inbound binary frame. */
  handleIncoming(frame: Uint8Array): void {
    if (this.destroyed) return
    const decoder = decoding.createDecoder(frame)
    const messageType = decoding.readVarUint(decoder)
    if (messageType === MESSAGE_SYNC) {
      const encoderReply = encoding.createEncoder()
      encoding.writeVarUint(encoderReply, MESSAGE_SYNC)
      // `this` as the transactionOrigin so our local apply doesn't echo back.
      const syncStep = syncProtocol.readSyncMessage(decoder, encoderReply, this.ydoc, this)
      // syncStep === messageYjsSyncStep2 (1) means the peer just answered our
      // sync step 1 — initial sync is done.
      if (syncStep === syncProtocol.messageYjsSyncStep2 && this.resolveSync) {
        this.resolveSync()
        this.resolveSync = null
      }
      // Reply only if y-protocols actually wrote bytes after the message-type
      // varUint header.
      if (encoding.length(encoderReply) > 1) {
        this.sendFrame(encoding.toUint8Array(encoderReply))
      }
    } else if (messageType === MESSAGE_AWARENESS) {
      const payload = decoding.readVarUint8Array(decoder)
      awarenessProtocol.applyAwarenessUpdate(this.awareness, payload, this)
    }
    // Other messageTypes are ignored — y-partyserver only emits sync /
    // awareness today; future expansions can extend here.
  }

  /** Encode a Y.Doc update as a sync-update frame and send. */
  broadcastUpdate(update: Uint8Array, origin: unknown): void {
    if (this.destroyed) return
    // Echo prevention: skip updates that we ourselves just applied from an
    // inbound frame. `handleIncoming` passes `this` as the origin.
    if (origin === this) return
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, MESSAGE_SYNC)
    syncProtocol.writeUpdate(encoder, update)
    this.sendFrame(encoding.toUint8Array(encoder))
  }

  /** Send our own awareness state to peers. */
  broadcastAwareness(): void {
    if (this.destroyed) return
    const encoder = encoding.createEncoder()
    encoding.writeVarUint(encoder, MESSAGE_AWARENESS)
    encoding.writeVarUint8Array(
      encoder,
      awarenessProtocol.encodeAwarenessUpdate(this.awareness, [this.awareness.clientID]),
    )
    this.sendFrame(encoding.toUint8Array(encoder))
  }

  /** Tear down listeners and clear awareness. Idempotent. */
  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.ydoc.off('update', this.onDocUpdate)
    this.awareness.off('update', this.onAwarenessUpdate)
    // Mark our local state null so peers see us go offline on next awareness
    // update; clear the states map afterwards.
    try {
      awarenessProtocol.removeAwarenessStates(this.awareness, [this.awareness.clientID], this)
    } catch {
      /* awareness instance may already be destroyed by caller */
    }
  }
}
