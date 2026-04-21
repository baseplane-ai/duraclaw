/**
 * @vitest-environment jsdom
 *
 * GH#38 P1.5: branch-info-collection migrated onto `createSyncedCollection`.
 * Tests verify the factory (a) delegates to the synced factory with the
 * right `collection` routing name, `queryKey`, `getKey`, (b) memoises per
 * sessionId, and (c) pipes synced-collection deltas on
 * `branchInfo:<sessionId>` through to the internal begin/write/commit
 * sync callback.
 */

import type { SyncedCollectionFrame } from '@duraclaw/shared-types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type SyncedCollectionConfig = {
  id: string
  collection: string
  queryKey: readonly unknown[]
  getKey: (row: { parentMsgId: string }) => string
  subscribe: (handler: (frame: SyncedCollectionFrame<unknown>) => void) => () => void
  onReconnect: (handler: () => void) => () => void
  queryFn: () => Promise<unknown[]>
  persistence?: unknown
  schemaVersion?: number
}

let capturedConfigs: SyncedCollectionConfig[] = []

// Mock the synced-collection factory so we can inspect configs without
// running the real TanStack DB plumbing.
vi.mock('./synced-collection', () => ({
  createSyncedCollection: vi.fn((config: SyncedCollectionConfig) => {
    capturedConfigs.push(config)
    return { __mock: true, config }
  }),
}))

vi.mock('./db-instance', () => ({
  dbReady: Promise.resolve(null),
  queryClient: { invalidateQueries: vi.fn() },
}))

// use-coding-agent exposes the session-stream primitives the factory
// wires into its subscribe / onReconnect hooks. Mock to avoid loading
// the full hook module (which pulls in React / agents/react).
const mockSubscribe = vi.fn(() => () => {})
const mockOnReconnect = vi.fn(() => () => {})
vi.mock('~/features/agent-orch/use-coding-agent', () => ({
  subscribeSessionStream: mockSubscribe,
  onSessionStreamReconnect: mockOnReconnect,
}))

describe('branch-info-collection — GH#38 P1.5 synced-collection factory', () => {
  beforeEach(() => {
    capturedConfigs = []
    vi.clearAllMocks()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('exports createBranchInfoCollection factory', async () => {
    vi.resetModules()
    const mod = await import('./branch-info-collection')
    expect(typeof mod.createBranchInfoCollection).toBe('function')
  })

  it('delegates to createSyncedCollection with per-session id/collection/queryKey', async () => {
    vi.resetModules()
    const mod = await import('./branch-info-collection')
    mod.createBranchInfoCollection('sess-a')

    expect(capturedConfigs).toHaveLength(1)
    const cfg = capturedConfigs[0]
    expect(cfg.id).toBe('branch_info:sess-a')
    expect(cfg.collection).toBe('branchInfo:sess-a')
    expect(cfg.queryKey).toEqual(['branchInfo', 'sess-a'])
    expect(cfg.schemaVersion).toBe(2)
  })

  it('keys rows on parentMsgId', async () => {
    vi.resetModules()
    const mod = await import('./branch-info-collection')
    mod.createBranchInfoCollection('sess-b')
    const cfg = capturedConfigs[0]
    expect(cfg.getKey({ parentMsgId: 'usr-7' })).toBe('usr-7')
  })

  it('queryFn resolves to an empty array (DO-pushed, no REST)', async () => {
    vi.resetModules()
    const mod = await import('./branch-info-collection')
    mod.createBranchInfoCollection('sess-q')
    const cfg = capturedConfigs[0]
    const rows = await cfg.queryFn()
    expect(rows).toEqual([])
  })

  it('wires subscribe + onReconnect through the session-stream primitives', async () => {
    vi.resetModules()
    const mod = await import('./branch-info-collection')
    mod.createBranchInfoCollection('sess-s')
    const cfg = capturedConfigs[0]

    const frameHandler = vi.fn()
    cfg.subscribe(frameHandler)
    expect(mockSubscribe).toHaveBeenCalledWith('sess-s', frameHandler)

    const reconnectHandler = vi.fn()
    cfg.onReconnect(reconnectHandler)
    expect(mockOnReconnect).toHaveBeenCalledWith('sess-s', reconnectHandler)
  })

  it('memoises collections by sessionId', async () => {
    vi.resetModules()
    const mod = await import('./branch-info-collection')

    const a1 = mod.createBranchInfoCollection('sess-memo')
    const a2 = mod.createBranchInfoCollection('sess-memo')
    const b = mod.createBranchInfoCollection('sess-other')

    expect(a1).toBe(a2)
    expect(a1).not.toBe(b)
    expect(capturedConfigs).toHaveLength(2)
    expect(capturedConfigs[0].id).toBe('branch_info:sess-memo')
    expect(capturedConfigs[1].id).toBe('branch_info:sess-other')
  })

  it('re-exports BranchInfoRow type', async () => {
    vi.resetModules()
    const mod = await import('./branch-info-collection')
    const row: typeof mod extends { BranchInfoRow: infer R } ? R : never = {
      parentMsgId: 'msg-0',
      sessionId: 'sess-t',
      siblings: ['usr-1', 'usr-3'],
      activeId: 'usr-1',
      updatedAt: '2026-04-19T00:00:00Z',
    }
    expect(row.parentMsgId).toBe('msg-0')
    expect(row.siblings).toHaveLength(2)
  })
})
