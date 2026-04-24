/**
 * GH#92 — unit tests for peer-scan.ts (scanPeerMeta).
 *
 * Uses a real tmp directory with crafted *.meta.json files to exercise
 * filter logic: state, model prefix, selfId exclusion, malformed JSON,
 * and missing-dir graceful fallback.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { scanPeerMeta } from './peer-scan.js'

describe('scanPeerMeta', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'peer-scan-test-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('returns empty array for nonexistent directory', async () => {
    const result = await scanPeerMeta('/tmp/does-not-exist-peer-scan-xyz', 'self')
    expect(result).toEqual([])
  })

  it('returns empty array for empty directory', async () => {
    const result = await scanPeerMeta(dir, 'self')
    expect(result).toEqual([])
  })

  it('finds running claude peer, excludes self', async () => {
    // Self — should be excluded
    await writeFile(
      join(dir, 'self.meta.json'),
      JSON.stringify({
        state: 'running',
        model: 'claude-sonnet-4-20250514',
        last_activity_ts: 100,
      }),
    )
    // Peer — should be included
    await writeFile(
      join(dir, 'peer1.meta.json'),
      JSON.stringify({
        state: 'running',
        model: 'claude-sonnet-4-20250514',
        last_activity_ts: 200,
      }),
    )
    const result = await scanPeerMeta(dir, 'self')
    expect(result).toEqual([
      { sessionId: 'peer1', model: 'claude-sonnet-4-20250514', lastActivityTs: 200 },
    ])
  })

  it('excludes non-running peers', async () => {
    await writeFile(
      join(dir, 'completed.meta.json'),
      JSON.stringify({ state: 'completed', model: 'claude-sonnet-4-20250514' }),
    )
    await writeFile(
      join(dir, 'failed.meta.json'),
      JSON.stringify({ state: 'failed', model: 'claude-sonnet-4-20250514' }),
    )
    const result = await scanPeerMeta(dir, 'self')
    expect(result).toEqual([])
  })

  it('excludes non-claude models', async () => {
    await writeFile(
      join(dir, 'gpt-peer.meta.json'),
      JSON.stringify({ state: 'running', model: 'gpt-4' }),
    )
    await writeFile(join(dir, 'no-model.meta.json'), JSON.stringify({ state: 'running' }))
    const result = await scanPeerMeta(dir, 'self')
    expect(result).toEqual([])
  })

  it('skips malformed JSON gracefully', async () => {
    await writeFile(join(dir, 'bad.meta.json'), '{{not json')
    await writeFile(
      join(dir, 'good.meta.json'),
      JSON.stringify({ state: 'running', model: 'claude-haiku', last_activity_ts: 42 }),
    )
    const result = await scanPeerMeta(dir, 'self')
    expect(result).toEqual([{ sessionId: 'good', model: 'claude-haiku', lastActivityTs: 42 }])
  })

  it('handles missing last_activity_ts as null', async () => {
    await writeFile(
      join(dir, 'peer.meta.json'),
      JSON.stringify({ state: 'running', model: 'claude-opus-4-20250514' }),
    )
    const result = await scanPeerMeta(dir, 'self')
    expect(result).toHaveLength(1)
    expect(result[0].lastActivityTs).toBeNull()
  })

  it('ignores non-meta.json files', async () => {
    await writeFile(join(dir, 'peer.pid'), '{"pid":123}')
    await writeFile(join(dir, 'peer.exit'), '{"state":"completed"}')
    await writeFile(join(dir, 'readme.txt'), 'hello')
    const result = await scanPeerMeta(dir, 'self')
    expect(result).toEqual([])
  })
})
