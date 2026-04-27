/**
 * Per-file orchestration for the docs-runner (B7-B11).
 *
 * One `FilePipeline` per tracked .md path. Owns:
 *   - the local Y.Doc + Awareness for this file
 *   - the YjsTransport that frames sync/awareness over a `DialBackDocClient`
 *   - the dial-back WS to the matching `RepoDocumentDO`
 *   - the disk-write side: pulls watcher `change/add/unlink` events from
 *     `main.ts` and forwards them as Y.Doc updates / DO tombstones
 *
 * Lifecycle:
 *   start() → derive entityId, open dial-back, sync 1/2, reconcile, settle
 *   onLocalChange() / onLocalAdd() — disk → Y.Doc (filtered by hash gate, B8)
 *   onLocalUnlink() — POST /tombstone to the DO (B10)
 *   stop() — best-effort tear-down, idempotent
 *
 * TODO(P3a verification): integration tests live in the verification scripts
 * because exercising the whole pipeline requires a real `RepoDocumentDO`.
 * Unit-level mocking would simply re-state the implementation.
 */

import fs from 'node:fs/promises'
import path from 'node:path'
import type { ServerBlockNoteEditor } from '@blocknote/server-util'
import { BufferedChannel, DialBackDocClient } from '@duraclaw/shared-transport'
import { deriveEntityId } from '@duraclaw/shared-types'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as Y from 'yjs'
import { markdownToYDoc } from './blocknote-bridge.js'
import { type HashStore, hashOfNormalisedMarkdown } from './content-hash.js'
import { reconcileOnAttach } from './reconcile.js'
import type { SuppressedWriter } from './writer.js'
import { YjsTransport } from './yjs-protocol.js'

export type FilePipelineState = 'starting' | 'syncing' | 'disconnected' | 'tombstoned' | 'error'

export interface FilePipelineOptions {
  rootPath: string
  relPath: string
  projectId: string
  /** e.g. `wss://dura.example/api/collab/repo-document` (no trailing slash). */
  callbackBase: string
  bearer: string
  hashStore: HashStore
  writer: SuppressedWriter
  editor: ServerBlockNoteEditor
  /** Called on terminal close (4401/4410/4412/exhaustion). */
  onTerminate: (reason: string) => void
  /** Reports per-file health state up to main.ts for the /health snapshot. */
  onStateChange: (state: FilePipelineState) => void
}

/**
 * Convert the wss/ws callback base into the matching https/http base for
 * REST calls (e.g. /tombstone). Leaves a non-ws scheme untouched.
 */
function toHttpBase(callbackBase: string): string {
  if (callbackBase.startsWith('wss://')) return `https://${callbackBase.slice(6)}`
  if (callbackBase.startsWith('ws://')) return `http://${callbackBase.slice(5)}`
  return callbackBase
}

export class FilePipeline {
  private readonly opts: FilePipelineOptions
  private readonly ydoc: Y.Doc
  private readonly awareness: awarenessProtocol.Awareness
  private readonly channel: BufferedChannel
  private transport: YjsTransport | null = null
  private dialBack: DialBackDocClient | null = null
  private entityId: string | null = null
  private currentState: FilePipelineState = 'starting'
  private started = false
  private stopped = false
  private syncStep1Sent = false

  constructor(opts: FilePipelineOptions) {
    this.opts = opts
    this.ydoc = new Y.Doc()
    this.awareness = new awarenessProtocol.Awareness(this.ydoc)
    // `DialBackDocClient` bypasses BufferedChannel for binary frames, but the
    // parent `DialBackClient` still requires a channel reference for its
    // attach/detach lifecycle hooks. A scratch channel satisfies that.
    this.channel = new BufferedChannel({ logger: console })
  }

  state(): FilePipelineState {
    return this.currentState
  }

  private setState(next: FilePipelineState): void {
    if (this.currentState === next) return
    this.currentState = next
    this.opts.onStateChange(next)
  }

  /** Compute entityId, open dial-back, sync, reconcile. Idempotent. */
  async start(): Promise<void> {
    if (this.started) return
    this.started = true

    this.entityId = await deriveEntityId(this.opts.projectId, this.opts.relPath)

    const transport = new YjsTransport({
      ydoc: this.ydoc,
      awareness: this.awareness,
      // Routed through `dialBack.send` once it's constructed. We capture a
      // closure so the transport can call us synchronously even on the very
      // first `broadcastUpdate` (triggered by the awareness ctor).
      send: (frame) => {
        // Best-effort: drop on the floor if dial-back hasn't connected yet
        // or the WS is closed. Y-protocols' sync 1/2 handshake on reconnect
        // re-syncs anything we miss.
        this.dialBack?.send(frame)
      },
    })
    this.transport = transport

    // URL: <callbackBase>/<entityId>/ws?role=docs-runner
    // DialBackClient appends `&token=...` (URL-encoded) automatically.
    const callbackUrl = `${this.opts.callbackBase}/${this.entityId}/ws?role=docs-runner`
    const dialBack = new DialBackDocClient({
      callbackUrl,
      bearer: this.opts.bearer,
      channel: this.channel,
      onCommand: (frame) => transport.handleIncoming(frame),
      onStateChange: (st) => {
        // Map dial-back lifecycle to our health state. `open` is
        // intentionally NOT wired to 'syncing' here — `syncing` only fires
        // once reconcile has settled.
        if (st === 'open') {
          if (!this.syncStep1Sent) {
            this.syncStep1Sent = true
            transport.sendSyncStep1()
          }
        } else if (st === 'reconnecting' || st === 'connecting') {
          if (this.currentState !== 'tombstoned' && this.currentState !== 'error') {
            this.setState('disconnected')
          }
        }
      },
      onTerminate: (reason) => {
        if (reason === 'document_deleted') {
          this.setState('tombstoned')
        } else {
          this.setState('error')
        }
        this.opts.onTerminate(reason)
      },
    })
    this.dialBack = dialBack
    dialBack.start()

    // Wait for sync step 2, then reconcile, then mark syncing.
    try {
      await transport.synced
    } catch (err) {
      this.setState('error')
      throw err
    }

    await reconcileOnAttach({
      rootPath: this.opts.rootPath,
      relPath: this.opts.relPath,
      ydoc: this.ydoc,
      hashStore: this.opts.hashStore,
      writer: this.opts.writer,
      editor: this.opts.editor,
    })

    this.setState('syncing')
  }

  /**
   * Watcher `change` event: re-read disk, B8-gate against last hash, push
   * through bridge into the Y.Doc (which fans out via YjsTransport).
   *
   * B8 ordering (strict): hash persist BEFORE bridge call, so a crash
   * between `markdownToYDoc` and `hashStore.set` doesn't leave us
   * re-pushing the same content on restart.
   */
  async onLocalChange(): Promise<void> {
    if (this.stopped || this.currentState === 'tombstoned') return
    const absPath = path.resolve(this.opts.rootPath, this.opts.relPath)
    let md: string
    try {
      md = await fs.readFile(absPath, 'utf8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return
      throw err
    }
    const newHash = await hashOfNormalisedMarkdown(md)
    if (newHash === this.opts.hashStore.get(this.opts.relPath)) {
      // B8: no change vs the last committed hash — skip silently.
      return
    }
    // Persist new hash BEFORE the Yjs push (B8 ordering invariant).
    await this.opts.hashStore.set(this.opts.relPath, newHash)
    await markdownToYDoc(md, this.ydoc)
  }

  /** Watcher `add` event for a path that was previously absent. */
  async onLocalAdd(): Promise<void> {
    // The B8 gate handles the "nothing changed" path identically to onLocalChange.
    await this.onLocalChange()
  }

  /**
   * Watcher `unlink` event: POST /tombstone to the matching DO and stop
   * the pipeline. The DO drops the document; the WS terminates with 4412
   * `document_deleted`, which routes us to state `'tombstoned'`.
   */
  async onLocalUnlink(): Promise<void> {
    if (this.stopped || this.currentState === 'tombstoned') return
    if (!this.entityId) return
    const httpBase = toHttpBase(this.opts.callbackBase)
    const url = `${httpBase}/${this.entityId}/tombstone`
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.opts.bearer}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ relPath: this.opts.relPath }),
      })
      if (!res.ok) {
        console.warn(
          `[file-pipeline] tombstone POST failed status=${res.status} entityId=${this.entityId}`,
        )
        // We still set tombstoned locally — the file is gone from disk; the
        // DO will hard-delete on its own grace timer once the WS drops.
      }
    } catch (err) {
      console.warn(
        `[file-pipeline] tombstone POST threw for entityId=${this.entityId}: ${(err as Error).message}`,
      )
    }
    // Drop the local hash so a future `add` of the same path is treated as
    // a fresh seed.
    try {
      await this.opts.hashStore.delete(this.opts.relPath)
    } catch {
      /* best-effort */
    }
    this.setState('tombstoned')
    await this.stop()
  }

  /** Stop transport, dial-back, etc. Idempotent. */
  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    try {
      this.transport?.destroy()
    } catch {
      /* best-effort */
    }
    this.transport = null
    try {
      await this.dialBack?.stop()
    } catch {
      /* best-effort */
    }
    this.dialBack = null
    try {
      this.ydoc.destroy()
    } catch {
      /* best-effort */
    }
  }
}
