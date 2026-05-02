/**
 * createSyncedCollection — canonical factory for user-scoped TanStack DB
 * collections driven by the shared user-stream WS.
 *
 * Wraps `queryCollectionOptions` to:
 *   1. Run the initial `queryFn` on cold start (markReady, retry: 2).
 *   2. Subscribe to `subscribeUserStream(syncFrameType, …)` for incremental
 *      delta frames and apply them via `begin / write / commit` on the
 *      synced layer. Deep-equality in `applySuccessfulResult` reconciles
 *      the optimistic layer so loopback echoes don't double-render.
 *   3. Register `onUserStreamReconnect` so a dropped + resumed WS re-fires
 *      `queryFn` via `queryClient.invalidateQueries` — the B7 reconnect
 *      resync path.
 *
 * The sync wrap is applied BEFORE persistence wrapping so
 * `persistedCollectionOptions`' own sync augmentation stacks on top of
 * our subscription and doesn't clobber it.
 *
 * See `planning/specs/28-synced-collections-pattern.md` B1 / B7 for the
 * optimistic-loopback contract and reconnect semantics.
 */

import type { SyncedCollectionFrame } from '@duraclaw/shared-types'
import { persistedCollectionOptions } from '@tanstack/browser-db-sqlite-persistence'
import type { Transaction } from '@tanstack/db'
import { createCollection } from '@tanstack/db'
import { queryCollectionOptions } from '@tanstack/query-db-collection'
import { onUserStreamReconnect, subscribeUserStream } from '~/hooks/use-user-stream'
import { queryClient } from './db-instance'

type AnyPersistence = Parameters<typeof persistedCollectionOptions>[0]['persistence']

export interface SyncedCollectionConfig<TRow extends object, TKey extends string | number> {
  id: string
  getKey: (row: TRow) => TKey
  queryKey: readonly unknown[]
  /** Initial cold-start fetch. Called once on sync() start + on reconnect. */
  queryFn: () => Promise<TRow[]>
  /**
   * Wire filter — frames whose `collection` field matches this string drive
   * begin/write/commit. Canonical name; preferred over `syncFrameType`.
   * If both are set, `collection` wins.
   */
  collection?: string
  /** Back-compat alias for `collection`. Kept so existing callers don't churn. */
  syncFrameType?: string
  /**
   * How this collection receives SyncedCollectionFrame frames. Handler fires
   * for EVERY frame delivered on this stream — consumer must filter by
   * `frame.collection` itself (the factory wires this filter internally
   * below). Defaults to the user-scoped stream.
   */
  subscribe?: (handler: (frame: SyncedCollectionFrame<unknown>) => void) => () => void
  /**
   * Fires after a dropped+resumed WS (not on initial connect). Defaults to
   * the user-scoped stream.
   */
  onReconnect?: (handler: () => void) => () => void
  onInsert?: (ctx: { transaction: Transaction<TRow> }) => Promise<unknown>
  onUpdate?: (ctx: { transaction: Transaction<TRow> }) => Promise<unknown>
  onDelete?: (ctx: { transaction: Transaction<TRow> }) => Promise<unknown>
  /** OPFS / Capacitor / op-sqlite persistence. Pass `getResolvedPersistence()` from consumer. */
  persistence?: AnyPersistence | null
  schemaVersion?: number
}

export function createSyncedCollection<TRow extends object, TKey extends string | number>(
  config: SyncedCollectionConfig<TRow, TKey>,
) {
  const effectiveCollection = config.collection ?? config.syncFrameType
  if (!effectiveCollection) {
    throw new Error('createSyncedCollection: collection or syncFrameType required')
  }

  const subscribe =
    config.subscribe ??
    ((handler: (frame: SyncedCollectionFrame<unknown>) => void) =>
      subscribeUserStream(effectiveCollection, handler))
  const onReconnect =
    config.onReconnect ?? ((handler: () => void) => onUserStreamReconnect(handler))

  // `queryCollectionOptions` auto-calls `refetch()` after onInsert/onUpdate/
  // onDelete unless the handler returns `{refetch: false}` (documented
  // opt-out, see @tanstack/query-db-collection query-adapter docs). Every
  // synced collection in this codebase uses WS delta frames for live
  // sync-back — a post-mutation refetch is redundant and wasted bandwidth.
  // Force `{refetch: false}` uniformly so `queryFn` fires only on cold-
  // start + reconnect invalidate (the paths documented in `createSyncedCollection`).
  const noRefetch = <T>(fn?: (ctx: T) => Promise<unknown>) =>
    fn
      ? async (ctx: T) => {
          const result = ((await fn(ctx)) ?? {}) as Record<string, unknown>
          return { ...result, refetch: false }
        }
      : undefined

  const baseOpts = queryCollectionOptions({
    id: config.id,
    queryKey: config.queryKey,
    queryFn: config.queryFn,
    queryClient,
    getKey: config.getKey,
    staleTime: Number.POSITIVE_INFINITY,
    refetchInterval: false,
    retry: 2,
    retryDelay: 500,
    onInsert: noRefetch(config.onInsert),
    onUpdate: noRefetch(config.onUpdate),
    onDelete: noRefetch(config.onDelete),
  } as any) as any

  // Wrap sync BEFORE persistence-wrapping. `persistedCollectionOptions` may
  // itself wrap `sync.sync`; applying our wrap first keeps us closest to the
  // collection core and lets the persistence layer wrap our wrapper.
  const originalSync = baseOpts.sync.sync
  baseOpts.sync.sync = (params: any) => {
    const queryCleanupRaw = originalSync?.(params)

    const unsubFrame = subscribe((frame: SyncedCollectionFrame<unknown>) => {
      if (frame.collection !== effectiveCollection) return

      if (frame.snapshot) {
        // Full-state snapshot: ops contains every current row. Diff against
        // local state — upsert everything in the frame, delete anything
        // local that's missing. Deletes are implicit (no lost-delete risk).
        const incomingKeys = new Set<string | number>()
        params.begin()
        for (const op of frame.ops) {
          if (op.type === 'delete') continue // snapshots shouldn't carry deletes, but skip if they do
          const key = config.getKey(op.value as TRow)
          incomingKeys.add(key)
          const hasFn = params.collection?.has
          const alreadyPresent = typeof hasFn === 'function' && hasFn.call(params.collection, key)
          params.write({
            type: alreadyPresent ? 'update' : 'insert',
            value: op.value,
          })
        }
        // Delete any local keys not present in the snapshot.
        const keysFn = params.collection?.keys
        if (typeof keysFn === 'function') {
          for (const localKey of keysFn.call(params.collection)) {
            if (!incomingKeys.has(localKey)) {
              params.write({
                type: 'delete',
                key: localKey,
                value: undefined as never,
              })
            }
          }
        }
        params.commit()
        return
      }

      // Delta frame — apply ops individually.
      params.begin()
      for (const op of frame.ops) {
        if (op.type === 'delete') {
          params.write({
            type: 'delete',
            key: op.key,
            // `value` is required by the ChangeMessageOrDeleteKeyMessage
            // union at the type level; the runtime ignores it on delete.
            value: undefined as never,
          })
        } else {
          // TanStack DB's sync layer auto-converts `insert` → `update`
          // only when `deepEquals(existingValue, newValue)` is true; on
          // mismatch it throws `DuplicateKeySyncError`, which aborts the
          // rest of the frame (leaving later ops in the same batch
          // unapplied). Our wire protocol is upsert-by-key — streaming
          // `partial_assistant` turns keep re-emitting the same row id
          // with growing text, and `onConnect` re-sends persisted rows
          // that the OPFS cache already has with slightly different
          // values. Convert to `update` whenever the key is already in
          // the collection so writes stay idempotent.
          const key = config.getKey(op.value as TRow)
          const hasFn = params.collection?.has
          const alreadyPresent =
            op.type === 'insert' &&
            typeof hasFn === 'function' &&
            hasFn.call(params.collection, key)
          const writeType = alreadyPresent ? 'update' : op.type
          params.write({ type: writeType, value: op.value })
        }
      }
      params.commit()
    })

    const unsubReconnect = onReconnect(() => {
      void queryClient.invalidateQueries({ queryKey: config.queryKey as readonly unknown[] })
    })

    return () => {
      unsubFrame()
      unsubReconnect()
      if (typeof queryCleanupRaw === 'function') {
        try {
          queryCleanupRaw()
        } catch (err) {
          console.warn('[synced-collection] query cleanup threw', err)
        }
      } else if (queryCleanupRaw && typeof queryCleanupRaw === 'object') {
        const cleanup = (queryCleanupRaw as { cleanup?: () => void }).cleanup
        if (typeof cleanup === 'function') {
          try {
            cleanup()
          } catch (err) {
            console.warn('[synced-collection] query cleanup threw', err)
          }
        }
      }
    }
  }

  const persistence = config.persistence
  if (persistence) {
    const opts = persistedCollectionOptions({
      ...baseOpts,
      persistence,
      schemaVersion: config.schemaVersion ?? 1,
    })
    return createCollection(opts as any)
  }

  return createCollection(baseOpts)
}
