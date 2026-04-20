import type { SyncedCollectionOp } from '@duraclaw/shared-types'
import { describe, expect, it } from 'vitest'
import { chunkOps } from './chunk-frame'

interface Row {
  name: string
  payload?: string
}

describe('chunkOps', () => {
  it('returns empty array for empty input', () => {
    expect(chunkOps<Row>([])).toEqual([])
  })

  it('returns a single chunk when all ops fit under maxBytes', () => {
    const ops: Array<SyncedCollectionOp<Row>> = [
      { type: 'insert', value: { name: 'a' } },
      { type: 'update', value: { name: 'b' } },
      { type: 'delete', key: 'c' },
    ]
    const chunks = chunkOps(ops, 200 * 1024)
    expect(chunks).toHaveLength(1)
    expect(chunks[0]).toEqual(ops)
  })

  it('splits ops across multiple chunks when size exceeds maxBytes', () => {
    // Each op ~100 bytes; cap at 250 → two ops per chunk, 3 chunks for 6 ops.
    const bigPayload = 'x'.repeat(80)
    const ops: Array<SyncedCollectionOp<Row>> = Array.from({ length: 6 }, (_, i) => ({
      type: 'insert',
      value: { name: `p${i}`, payload: bigPayload },
    }))
    const chunks = chunkOps(ops, 250)
    expect(chunks.length).toBeGreaterThan(1)
    // No chunk exceeds the cap (approx: sum of per-op JSON lengths + overhead).
    for (const chunk of chunks) {
      const asFrame = JSON.stringify(chunk)
      expect(asFrame.length).toBeLessThanOrEqual(300)
    }
    // All ops preserved and in order.
    expect(chunks.flat()).toEqual(ops)
  })

  it('keeps a single oversized op in its own chunk', () => {
    const huge = 'x'.repeat(1000)
    const ops: Array<SyncedCollectionOp<Row>> = [
      { type: 'insert', value: { name: 'a' } },
      { type: 'insert', value: { name: 'huge', payload: huge } },
      { type: 'insert', value: { name: 'b' } },
    ]
    const chunks = chunkOps(ops, 100)
    // Each op too big for 100-byte cap → each in its own chunk.
    expect(chunks).toHaveLength(3)
    expect(chunks[0]).toEqual([ops[0]])
    expect(chunks[1]).toEqual([ops[1]])
    expect(chunks[2]).toEqual([ops[2]])
  })

  it('respects the boundary at exactly maxBytes', () => {
    // Craft an op whose JSON form is a known length (+1 for trailing comma).
    const op: SyncedCollectionOp<Row> = { type: 'delete', key: 'aa' }
    const opSize = JSON.stringify(op).length + 1
    // maxBytes == 2 (brackets) + 2*opSize → exactly fits 2 ops, not 3.
    const max = 2 + opSize * 2
    const ops = [op, op, op]
    const chunks = chunkOps(ops, max)
    expect(chunks).toHaveLength(2)
    expect(chunks[0]).toHaveLength(2)
    expect(chunks[1]).toHaveLength(1)
  })
})
