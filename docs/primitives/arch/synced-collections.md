# Synced Collections

> A reactive client-side collection ↔ per-user coordinator ↔ central registry sync pattern. Write-through to the registry, broadcast to peers on commit, full-resync on reconnect.

## Layer test

This primitive survives a stack rewrite but NOT a UI redesign.

## Concept

A synced collection is a slice of authoritative server state mirrored into a reactive client cache, kept hot via WebSocket delta frames and reconciled wholesale on reconnect. Every consumer of the same collection sees the same state, and a write by any peer is visible to the others within one round-trip.

The pattern composes three actors:

- **Authority** — the central registry (relational store) where the canonical row lives. Writes commit here.
- **Coordinator** — a per-user (or per-scope) durable coordinator that fans out commits to all live peers. Owns no state; owns the broadcast.
- **Cache** — the client-side reactive collection. Reads from the cache, writes optimistically, settles against the authority's echo.

## The two layers

A synced collection is **two stacked layers**, both explicit. Discipline is in never conflating them.

| Layer | Populated by | Lifetime |
|-------|--------------|----------|
| **Optimistic** | Local user writes (insert / update / delete). Recorded immediately on submit, with a client-minted stable id. | Until the authority's echo arrives — then deep-equality-compared against the synced layer; on match, the optimistic entry retires silently. |
| **Synced** | Cold-start query at sync start; delta frames from the coordinator's WebSocket while live; full re-query on reconnect. | The authoritative cache. Persisted locally for fast reload. |

Reads see the optimistic layer overlaid on the synced layer. Writes only touch the optimistic layer plus a request to the authority — the synced layer is server-driven exclusively.

## Reconciliation

The server's echo of the user's own write carries the same client-minted id. Reconciliation is **deep-equality on value**, not delete-and-reinsert. This eliminates the flicker race where the optimistic row would briefly disappear between server-confirmation and re-display.

There is no client-side sort hint, no watermark, and no tombstone. The optimistic row either becomes the authoritative row (deep-equal match) or is overwritten by the authoritative row (mismatch). Either way, the optimistic layer drops away on settle.

## Wire protocol

Frames carry one of:

| Op | Shape |
|----|-------|
| `insert` | `{type: 'insert', value: <full row>}` |
| `update` | `{type: 'update', value: <full row>}` |
| `delete` | `{type: 'delete', key: <row key>}` |

A frame can carry multiple ops (a batch). The frame envelope tags the **collection name** so a single multiplexed user-stream can serve many collections; each collection-side handler filters by its own name.

Frames cap at **256 KiB**. Bulk changes chunk into multiple frames at the coordinator boundary.

A frame may also carry a `snapshot: true` marker. Snapshot frames replace the synced layer wholesale: every key not present in the snapshot is implicitly deleted. This is used on initial sync after a missed-frame gap; deltas don't carry implicit deletes.

## Reconnect semantics

**Reconnect is invalidate-and-resync.** No watermarks, no resume tokens, no tombstones. On a dropped-and-resumed connection the cache invalidates every registered collection's query and replaces the synced layer wholesale.

The accepted edge case — "an optimistic delete reappears because the request threw while the user was offline" — is a feature, not a bug. It's the correct outcome of a write that didn't reach authority: the authority never saw the delete, the resync surfaces the row that was never deleted, the user retries.

## Why this is a primitive, not a module

Any reactive client-side cache that mirrors authoritative server state faces the same questions: how do optimistic writes settle without flicker, how do peer commits propagate, how does the cache recover from a dropped connection. The numbers (256 KiB frame cap, deep-equality reconciliation, full-resync-on-reconnect) are platform commitments — they don't change when the reactive-collection library does. A different stack (a custom store, RxDB, Zustand-with-sync) would still need this exact contract.

## Where this lives in code

- `apps/orchestrator/src/db/synced-collection.ts` — canonical factory.
- `apps/orchestrator/src/db/user-tabs-collection.ts`, `user-preferences-collection.ts`, `projects-collection.ts`, `chains-collection.ts` — the four current consumers.
- `packages/shared-types/src/index.ts` — `SyncedCollectionFrame` wire type.
- `planning/specs/28-synced-collections-pattern.md` — the spec that defines the two-layer contract.
