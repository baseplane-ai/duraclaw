import { describe, expect, it } from 'vitest'
import * as awarenessProtocol from 'y-protocols/awareness'
import * as Y from 'yjs'
import { YjsTransport } from './yjs-protocol.js'

/**
 * Unit tests use two YjsTransport instances looped through fake `send`
 * callbacks — no real WebSocket. Frames are queued and flushed via a
 * tiny `pump()` helper so we can drive the protocol synchronously.
 */

interface Wired {
  transport: YjsTransport
  ydoc: Y.Doc
  awareness: awarenessProtocol.Awareness
  inbox: Uint8Array[]
}

function makePair(): { a: Wired; b: Wired; pump: () => void } {
  const aDoc = new Y.Doc()
  const bDoc = new Y.Doc()
  const aAwareness = new awarenessProtocol.Awareness(aDoc)
  const bAwareness = new awarenessProtocol.Awareness(bDoc)
  const aOutbox: Uint8Array[] = []
  const bOutbox: Uint8Array[] = []

  const aTransport = new YjsTransport({
    ydoc: aDoc,
    awareness: aAwareness,
    send: (frame) => aOutbox.push(frame),
  })
  const bTransport = new YjsTransport({
    ydoc: bDoc,
    awareness: bAwareness,
    send: (frame) => bOutbox.push(frame),
  })

  const a: Wired = { transport: aTransport, ydoc: aDoc, awareness: aAwareness, inbox: bOutbox }
  const b: Wired = { transport: bTransport, ydoc: bDoc, awareness: bAwareness, inbox: aOutbox }

  // pump drains both outboxes into the partner's handleIncoming, repeating
  // until both are empty (the sync handshake involves a couple of
  // back-and-forth rounds).
  const pump = () => {
    let safety = 0
    while ((aOutbox.length || bOutbox.length) && safety++ < 100) {
      const aFrames = aOutbox.splice(0)
      const bFrames = bOutbox.splice(0)
      for (const frame of aFrames) bTransport.handleIncoming(frame)
      for (const frame of bFrames) aTransport.handleIncoming(frame)
    }
    if (safety >= 100) throw new Error('pump runaway — protocol loop?')
  }

  return { a, b, pump }
}

describe('YjsTransport', () => {
  it('sync step 1 -> step 2 round-trip syncs two empty docs', async () => {
    const { a, b, pump } = makePair()
    a.transport.sendSyncStep1()
    b.transport.sendSyncStep1()
    pump()
    await a.transport.synced
    await b.transport.synced
    // Both empty docs should have identical state vectors after sync.
    const sva = Y.encodeStateVector(a.ydoc)
    const svb = Y.encodeStateVector(b.ydoc)
    expect(sva).toEqual(svb)
  })

  it('propagates a Y.Map insert from A to B after initial sync', async () => {
    const { a, b, pump } = makePair()
    a.transport.sendSyncStep1()
    b.transport.sendSyncStep1()
    pump()
    await a.transport.synced

    const aMap = a.ydoc.getMap<string>('m')
    aMap.set('hello', 'world')
    pump()

    const bMap = b.ydoc.getMap<string>('m')
    expect(bMap.get('hello')).toBe('world')
  })

  it('awareness round-trip surfaces the docs-runner kind on the peer', async () => {
    const { a, b, pump } = makePair()
    // Constructor already set local state field 'user' = { kind: 'docs-runner' }.
    // Force an explicit awareness emit by re-setting the field.
    a.transport.broadcastAwareness()
    pump()
    const peerStates = b.awareness.getStates()
    const aState = peerStates.get(a.awareness.clientID)
    expect(aState).toBeDefined()
    expect((aState as { user?: { kind?: string } }).user?.kind).toBe('docs-runner')
  })

  it('synced Promise resolves only after sync step 2 arrives', async () => {
    const { a, b, pump } = makePair()
    let resolved = false
    void a.transport.synced.then(() => {
      resolved = true
    })
    // No frames pumped yet — synced should still be pending.
    await Promise.resolve()
    expect(resolved).toBe(false)

    a.transport.sendSyncStep1()
    b.transport.sendSyncStep1()
    pump()
    await a.transport.synced
    expect(resolved).toBe(true)
  })

  it('destroy() unsubscribes Y.Doc + awareness listeners', () => {
    const aDoc = new Y.Doc()
    const aAwareness = new awarenessProtocol.Awareness(aDoc)
    const sent: Uint8Array[] = []
    const t = new YjsTransport({
      ydoc: aDoc,
      awareness: aAwareness,
      send: (frame) => sent.push(frame),
    })
    t.destroy()
    const beforeCount = sent.length
    aDoc.transact(() => {
      aDoc.getMap('m').set('post-destroy', 1)
    }, 'someone-else')
    // No outbound frames after destroy.
    expect(sent.length).toBe(beforeCount)
  })

  it('does not re-broadcast updates whose origin is the transport itself', () => {
    const aDoc = new Y.Doc()
    const aAwareness = new awarenessProtocol.Awareness(aDoc)
    const sent: Uint8Array[] = []
    const t = new YjsTransport({
      ydoc: aDoc,
      awareness: aAwareness,
      send: (frame) => sent.push(frame),
    })

    // Apply a transaction with `t` as origin — should NOT trigger broadcast.
    aDoc.transact(() => {
      aDoc.getMap('m').set('x', 1)
    }, t)
    // Awareness ctor set a field which DID broadcast — pop those out.
    const beforeCount = sent.length

    // Now apply with a foreign origin — should broadcast.
    aDoc.transact(() => {
      aDoc.getMap('m').set('y', 2)
    }, 'someone-else')
    expect(sent.length).toBeGreaterThan(beforeCount)
  })
})
