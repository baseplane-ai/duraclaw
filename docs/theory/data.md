---
category: data
---

# Data

> Where the truth lives for each piece of state, and what reconciles when the truth and a cache disagree.

Duraclaw runs four distinct state stores at once. The discipline that keeps the system honest is knowing, for every field, exactly which store is authoritative — and where every other store sits in relation to it.

## The four state stores

**1. Durable Object SQLite — durable per-session truth.** The per-session Durable Object owns its own SQLite database. This is where message history, branch tree, runner session id, identity binding, the active callback token, the per-session event log, and a typed metadata row all live. It is durable across deploys, and its retention window for the event log is roughly seven days, garbage-collected on rehydrate. When duraclaw needs to know what really happened in a session, this is the one source.

**2. Orchestrator-wide registry (D1) — catalog and cold-start fallback.** The orchestrator-wide registry holds one row per session for indexing (sidebars, history listings, sort by recency), the identity catalog, the worktrees catalog, user-scoped synced collections (tabs, preferences, projects, chains), and authentication tables. The registry is *not* the truth-gate for live session state: its `status` column is the cold-start fallback only, used for rendering before the first WebSocket frame arrives. Once frames are flowing, the registry is shadow.

**3. Client-side reactive collections — caches, never authoritative.** The browser holds reactive collections (per-session messages, branch info, session summaries, synced user-scoped collections) persisted via the Origin Private File System. These are reactive caches: they fold WebSocket frames, fall back to REST on cold-start or stale reconnect, and they never produce state — they only display state. The collections are reactive on the read side and optimistic on the write side, but neither role makes them authoritative.

**4. SDK transcript files — the resume contract.** The Claude SDK writes a session-file on disk in the project directory. The resume contract is read-once-per-spawn, immutable per turn: a runner spawned with a resume intent reads this file to restore SDK-side context. Duraclaw mirrors a copy of the transcript into Durable Object SQLite via the SDK's session-store interface, so a resume that lands under a different identity (and therefore a different HOME) still has the transcript bytes available. The on-disk file remains the SDK's contract; the mirror is duraclaw's insurance.

## The DO-authoritative status frame

The session status field — what every client surface uses to render running / idle / awaiting-gate / errored / cooled-down — is **DO-authoritative**. The per-session Durable Object stamps `sessionStatus` on every message and branch-info frame it broadcasts, and it pushes a status-only frame on every internal status transition. The browser extracts the stamped status into a transient memory-only collection and reads from there.

There is no client-side message-fold to derive status. There is no tiebreaker between client-derived and server-stated values. There is no race between two paths of inference. The Durable Object says what the status is; the client believes it. Before the first frame on a fresh page load, the registry row's status column is consulted as cold-start fallback — and that is the only role it plays.

## Lossless resume

Resume is lossless across both reaper-driven idle restarts and identity failover. The Durable Object's SQLite mirrors the SDK transcript via the session-store interface; on the next spawn, whether under the same identity or a different one, the SDK loads its context from the mirrored transcript bytes. The cross-identity case matters: each identity has its own HOME, and a transcript file written under HOME-A is not visible to a runner spawned under HOME-B. By keeping the canonical transcript inside the Durable Object's database, duraclaw makes the HOME boundary irrelevant to resume correctness.

## Optimistic writes

User turns are optimistic. The client mints a stable id when the user hits send and writes the turn to the local messages collection immediately. The server-side echo (the message arriving back over the WebSocket) carries the same client-minted id, so reconciliation is a deep-equality compare against the existing row — not a delete-and-reinsert. This avoids the race where the optimistic row briefly disappears between server-confirmation and re-display, which would manifest as flicker or scroll-jump.

There is no client-side sort hint, no watermark, and no tombstone for optimistic writes. The optimistic row either becomes the authoritative row (deep-equal match) or is overwritten by the server's authoritative row (mismatch), and the optimistic layer drops away on settle.

## Synced collections (user-scoped)

User-scoped reactive data — tabs, preferences, projects, chains — rides on a two-layer model. Both layers are explicit; the discipline is to never conflate them.

- **Optimistic layer.** A user-initiated write (insert / update / delete) is recorded in the optimistic maps of the local collection and a request is fired against the registry. On settle (success or rollback) the optimistic entry disappears. While the optimistic entry exists, queries see it overlaid on top of the synced layer.
- **Synced layer.** Authoritative state lives in the orchestrator-wide registry. The synced layer is populated cold via a query (initial load, reconnect resync) and kept hot via WebSocket delta frames pushed from the user's user-settings Durable Object. The server's echo of the user's own write is reconciled by a deep-equality loopback: if the server's row deep-equals the optimistic row, the optimistic entry retires silently — no flicker, no churn.

Reconnect semantics are intentionally simple: invalidate-and-resync. On reconnect the client re-queries every registered synced collection and replaces the synced layer wholesale. The "optimistic delete reappears because the request threw while offline" path is accepted behavior, not a bug — it's the correct outcome of a write that didn't reach authority.
