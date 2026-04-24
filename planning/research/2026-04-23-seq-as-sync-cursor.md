# Seq-as-sync-cursor — collapsing the dual sync systems

**Date:** 2026-04-23
**Mode:** research (feature research + brainstorming → converges on a
consolidation spec)
**Trigger:** Two independent reconnect bugs in one session —
(a) server re-emitting the final row's delta on every reconnect
(`modifiedAt` cursor drift, see conversation transcript), and
(b) cursor-replay chunks all sharing the DO's current `messageSeq` so
the client's gap detector fires on repeated seq (issue #81). Both
symptoms trace back to the same root: **we have two parallel sync
cursors (`messageSeq` envelope counter vs `(modifiedAt, id)` row
cursor) and neither knows about the other.**
**Related:** #14 (seq'd wire protocol), #42 (connection manager),
#75 (client frame-drop recovery), #78 (streaming UX), #81 (cursor
replay seq reuse), #80 (awaiting-response state).

## TL;DR

- We ship `messageSeq` on every broadcast envelope and the client
  tracks `lastSeq` per session — but we don't use it for
  replay-on-reconnect. Replay uses a *second* cursor `(modifiedAt, id)`
  keyset against the `assistant_messages` SQL table.
- The two systems drift independently. `messageSeq` gap detection
  fires on replay chunks that reuse a seq (#81). `modifiedAt` cursor
  re-emits the tail row when `T_wire < T_sql` (conversation transcript
  on 2026-04-23).
- Recommendation: **add a per-row `seq INTEGER` column to
  `assistant_messages`, stamp it on every append / update from the
  same session counter, replay by seq, delete the `modifiedAt` cursor
  path entirely.** One source of truth, monotonic by construction,
  trivially re-joinable on reconnect.
- Subsumes #81 (no more seq reuse — each replayed row carries its
  own row-level seq) and the `modifiedAt` drift bug (no more
  `T_wire` vs `T_sql` comparison space).
- Migration: backfill `seq` in `(modified_at, id)` order, then
  stamp-forward.

## The two cursors we have today

### System 1 — `messageSeq` envelope counter (GH #14, #75)

| Field | Value |
|---|---|
| Where it lives | `this.messageSeq` (DO in-memory) + `session_meta.message_seq` (SQLite, hibernation-safe) |
| Scope | Per-session |
| Increment | `+= 1` per **non-targeted** broadcast (`session-do.ts:1979–1982`) |
| Stamped on | Broadcast envelope (`SyncedCollectionFrame.messageSeq`) |
| Client state | `lastSeqRef: Map<agentName, number>` (`use-coding-agent.ts:325`) |
| Purpose | **Gap detection**: if incoming `seq > lastSeq + 1` → `requestSnapshot()`; if `seq === lastSeq + 1` → apply + advance |
| Used for replay? | **No** |

### System 2 — `(modifiedAt, id)` row cursor (v13 cursor unification)

| Field | Value |
|---|---|
| Where it lives | `assistant_messages.modified_at` column, indexed by `(session_id, modified_at, id)` (migration v13) |
| Scope | Per-row |
| Stamped on | `safeAppendMessage` (SQL `modified_at = created_at`) and `safeUpdateMessage` (SQL `modified_at = now()`) |
| Wire stamp | `new Date().toISOString()` at emit time in `broadcastMessages` — only if the value lacks `modifiedAt` (`session-do.ts:1969–1977`) |
| Client state | Folded out of `messagesCollection` via `computeTailCursor` on every `subscribe:messages` (`messages-collection.ts:231–259`) |
| Purpose | **Replay on WS (re)connect**: client sends `subscribe:messages {sinceCursor}`, server returns rows where `modified_at > cursor.modifiedAt OR (=, id >)` |
| Used for gap detection? | No |

**The two systems never reconcile.** The gap detector says "we're
fine" when all incoming seqs match; the replay path says "here's
what's new" based on a completely independent timestamp. Either can
mis-fire without the other noticing.

## Concrete bugs each system has surfaced

### Bug A — replay chunks reuse envelope seq (#81)

`replayMessagesFromCursor` pages the SQL keyset at 500 rows per page
and calls `broadcastMessages({ops: chunk}, {targetClientId: ...})`
for each. `broadcastMessages` increments `messageSeq` only on
non-targeted sends:

```ts
if (!opts.targetClientId) {
  this.messageSeq += 1
  this.persistMessageSeq()
}
```

So all replay chunks share one seq value (the current
`messageSeq`). The client's gap check has a `targeted: true` bypass
(`use-coding-agent.ts:302–305`) that's supposed to catch this, but
the #81 author's prod logs show `gap-detected seq=1530` mid-replay
anyway. One of: the `targeted: true` flag isn't being set on some
path, or a live non-targeted broadcast at the same seq arrives
interleaved with the replay burst. Either way the root cause is
that **envelope seq is session-scoped and replay is per-connection —
the two don't compose cleanly.**

### Bug B — `modifiedAt` cursor drift (conversation transcript 2026-04-23)

Symptom: the server re-emits the final row's delta on every
reconnect, always carrying the same `seq=N` (the client's current
`lastSeq`). Possible drift sources inside System 2:

1. **`T_wire` pre-stamp skip.** `broadcastMessages` stamps
   `modifiedAt = now` only if the value lacks one; if an upstream
   path pre-stamps with `row.createdAt`, `T_wire < T_sql` and the
   row re-qualifies on reconnect.
2. **Legacy `createdAt` fallback in `computeTailCursor`** —
   `const ts = modifiedTs || createdTs`. A cached row missing
   `modifiedAt` becomes the cursor max by its `createdAt`; since
   SQL `modified_at >= created_at`, the row re-matches.
3. **Update-without-broadcast.** If `safeUpdateMessage` bumps SQL
   `modified_at` without a subsequent broadcast, SQL advances past
   `T_wire` and the row re-qualifies on next subscribe.

The server's "strictly conservative" branch at `session-do.ts:1028–
1032` (legacy `createdAt` cursor compat) is the same bug *by
design* — it over-replays any row whose `modified_at > createdAt`.

### Why both exist at the same time

Neither system was designed to subsume the other. #14 introduced
seq'd envelopes specifically for gap *detection* (the prior
protocol had no way to notice a dropped frame). v13 cursor
unification was about fixing a narrower bug (created_at vs
modified_at double-keyset) without touching the seq layer. Each
change was local and correct in its own context; the interaction
is where it falls apart.

## The proposal — one cursor, per-row seq

**Replace both systems with a single per-row monotonic counter.**

### Schema

Add one column to `assistant_messages`:

```sql
ALTER TABLE assistant_messages ADD COLUMN seq INTEGER;
CREATE INDEX idx_assistant_messages_session_seq
  ON assistant_messages (session_id, seq);
```

Session-scoped counter stays on `session_meta.message_seq` — but
it now allocates **per-row**, not per-envelope.

### Write path

Every `safeAppendMessage` / `safeUpdateMessage` / rewind / resubmit
that mutates a row:

```ts
const seq = ++this.messageSeq
this.persistMessageSeq()
this.sql`UPDATE assistant_messages SET content = ?, seq = ? WHERE id = ?`
```

The `seq` and the SQL row update are in the same DO tick — single-
threaded per instance, atomic in the sense we need.

### Wire stamp

`broadcastMessages` / `broadcastBranchInfo` stamp each op with the
row's `seq`:

```ts
const ops = rawOps.map(op => ({ ...op, seq: op.value.seq }))
```

The envelope `messageSeq` field is *removed*. The per-op seq is
what matters. A multi-op frame carries N different seqs (one per
row); the client applies them in order and sets `lastSeq =
max(opSeqs)`.

### Replay

Client sends `{type: 'subscribe:messages', sinceSeq: number | null}`.
Server runs:

```sql
SELECT id, content, seq FROM assistant_messages
WHERE session_id = ? AND seq > ?
ORDER BY seq ASC
LIMIT 500
```

Monotonic integer keyset — no timestamp drift possible. The cursor
advances *exactly* to the last row's seq with no `T_wire` / `T_sql`
distinction to worry about.

### Gap detection

Client: `if (opSeq !== lastSeq + 1) requestSnapshot()`. Same as
today, but now the cursor the snapshot uses is the same number the
gap detector uses. By construction they can't disagree.

### Deletes

Delete ops need a seq too — otherwise a client at `seq=500` can't
tell "a delete happened at seq=501, new row at seq=502" from just
"new row at seq=502."

Options:
- **Tombstone row.** `safeDeleteMessage` writes a soft-delete row
  with a fresh seq and a tombstone flag; replay returns tombstones;
  client applies as delete and keeps the tombstone row (lazy GC).
- **Side-table of delete seqs.** `assistant_message_deletes
  (session_id, seq, deleted_id)` replayed in the same stream.

Tombstone is simpler; side-table is cheaper for long sessions with
many rewinds.

## What this subsumes

- **#81 — cursor replay seq reuse.** Gone. Each replayed row carries
  its own row-level seq; no reuse is possible. The `targeted: true`
  bypass flag becomes unnecessary; a targeted replay is just
  "rows with seq > X" and the client applies them exactly like live
  frames.
- **`modifiedAt` drift (transcript).** Gone. No `modifiedAt` cursor
  exists; no `T_wire` vs `T_sql` comparison happens; `new
  Date().toISOString()` emit-time stamp is deleted from
  `broadcastMessages`; `computeTailCursor`'s ISO string max-fold is
  replaced with `max(msg.seq)`.
- **Legacy `createdAt` fallback (`session-do.ts:1028–1032`).** Gone.
  Legacy wire shape is `{sinceCursor}` with ISO strings; new shape
  is `{sinceSeq: number}`. No ambiguity.
- **The `targeted: true` flag and its client-side bypass
  (`use-coding-agent.ts:302–305`).** Gone. Targeted and broadcast
  frames are identical on the wire; the server just chooses
  `sendToClient` vs `broadcastToClients` at the transport layer.
- **Two separate migration indexes** (`(session_id, created_at,
  id)` + `(session_id, modified_at, id)`). Replaced by one
  `(session_id, seq)`.

## What breaks / what gets harder

### 1. Migration

Existing rows have no `seq`. Backfill:

```sql
WITH ordered AS (
  SELECT id, session_id,
    ROW_NUMBER() OVER (PARTITION BY session_id
                       ORDER BY modified_at ASC, id ASC) AS rn
  FROM assistant_messages
  WHERE session_id = ?  -- per-DO, done on hydrate
)
UPDATE assistant_messages SET seq = (SELECT rn FROM ordered WHERE ...)
```

Per-DO on first wake after the migration deploys. Also bump
`session_meta.message_seq` to `MAX(seq)` so the counter stays
monotonic. Clients with cached rows missing `seq` send
`{sinceSeq: null}` → full replay → re-hydrate.

Cost: one-time full table scan per session on migration wake. For
sessions with 10k messages, still a keyset op — fine.

### 2. `branchInfo` frames

Currently share `message_seq` with message frames (same envelope
counter). Two options:
- **Shared counter, typed tables.** `session_meta.message_seq`
  still allocates for both; `branchInfo` rows get their own `seq`
  column too. Replay interleaves by seq.
- **Separate counters.** `session_meta.message_seq` and
  `session_meta.branch_info_seq`. Replay is two independent
  streams; client maintains two `lastSeq` values.

Shared counter is simpler and matches how the client already
consumes both as one logical "session sync" stream.

### 3. SDK-managed table

`assistant_messages` is created lazily by the Agent SDK's Session
class — the `CREATE INDEX IF NOT EXISTS` pattern in migrations
v9/v10/v13 handles "table doesn't exist yet." Adding a column via
`ALTER TABLE` has the same hazard; migration must degrade
gracefully if the table isn't there yet. Existing migrations
already do this.

### 4. Multi-op frames with mixed op types

A rewind frame today is `[delete, delete, insert, insert]`. In
seq-per-row land each op has its own seq. If all seqs are
consecutive (one DO tick), the client applies them in order and
advances `lastSeq` to the max. If they're not consecutive (seqs
interleave with other ops between the delete-seqs and insert-seqs),
the client needs to apply by seq order, not by array order.

Simplest rule: **server sorts ops by seq before broadcasting;
client applies in array order**. One-line server-side guarantee.

### 5. Hibernation-safe counter persistence

Already solved for `message_seq` in `session_meta` — same pattern.
`persistMessageSeq()` runs on every bump. On rehydrate,
`hydrateMetaFromSql` reads it back.

### 6. Concurrent writes

Single-threaded per DO, so `++this.messageSeq` is safe. Across DOs
there's no sharing (each session has its own DO). Across replicas
of the same DO there's also no sharing (DO is a singleton by
contract).

## Options considered

### Option 1 — Do nothing, patch the two bugs independently

- Patch #81: mark replay frames with `replay: true` so the client
  skips seq validation entirely on those frames.
- Patch `modifiedAt` drift: remove the `!value.modifiedAt` guard in
  `broadcastMessages`, and drop `computeTailCursor`'s `createdAt`
  fallback.
- Pro: Minimal diff, no migration.
- Con: Preserves two parallel cursor systems and the cognitive
  cost. Next drift bug is already queued up.

### Option 2 — Keep both, but make them talk

Cross-validate: the server replay includes the envelope seq at
which each row was *last broadcast*; the client asserts the
envelope seq matches what it has for that row. Mismatch → force
snapshot.

- Pro: No migration.
- Con: Doubles the complexity; now there are *three* invariants
  (envelope seq, row seq-at-broadcast, row modifiedAt). Debugging
  gets worse not better.

### Option 3 — **Seq-as-cursor consolidation (recommended)**

Described above. Single column, single cursor, single source of
truth. Subsumes both bugs and a class of future bugs in the same
shape.

- Pro: Cleaner than either patch-in-place option. Eliminates the
  entire comparison space where timestamp drift can happen.
- Pro: Makes replay trivially correct — integer keyset on an
  indexed column, the textbook case.
- Con: Real migration (one column, one index, one backfill).
  Touches every broadcast site.
- Con: Requires coordination with in-flight PRs (#79 just merged,
  #81 is open). Best to sequence after #79 and instead of #81's
  proposed A/B patch.

### Option 4 — Skip row-level seq, use `ROWID` as the sync cursor

SQLite's built-in `ROWID` is monotonic and auto-assigned. Could
replay by `WHERE ROWID > sinceRowid`.

- Pro: No schema change, no backfill, no bump logic.
- Con: `ROWID` doesn't track updates — updating a row doesn't bump
  its ROWID. So the client never learns about updates-in-place
  (streaming deltas on a partial_assistant row). That's the 80%
  case, so this option is a non-starter.

## Decision points left open

1. **Per-row seq on updates — new seq value, or keep the insert's
   seq?** Recommended: new seq on every update, because that's how
   "the client learns about the update." Update without seq bump
   means a client that missed the update has no way to pull it. The
   cost is that a streaming message with 50 deltas occupies 50
   seqs; for a 10k-message session that's ~500k seq values, trivially
   fits in INTEGER.
2. **Delete representation — tombstone vs side-table.** Lean
   tombstone for simplicity; side-table if long-session GC pressure
   becomes real.
3. **Envelope seq field — keep for back-compat during rollout, or
   hard cut?** Keep for one release as `Math.max(...opSeqs)` so
   old clients don't break; drop in the release after.
4. **`branchInfo` seq — shared or separate counter?** Lean shared
   (simpler client state); reassess if a workload exposes
   interleaving hazards.

## Plan sketch (if we pick Option 3)

1. **Spec** (this doc → spec document). Nail down delete
   representation + envelope back-compat window.
2. **Migration v15** — `ALTER TABLE assistant_messages ADD COLUMN
   seq INTEGER; CREATE INDEX ...`. Backfill on DO wake.
3. **Server write path** — every append / update / delete stamps
   `seq` from `++this.messageSeq`. Delete this.messageSeq's
   envelope bump in `broadcastMessages`.
4. **Wire shape** — add `seq: number` to each op in
   `SyncedCollectionOp`. Keep envelope `messageSeq` as
   `max(opSeqs)` for one release.
5. **Server replay** — `subscribe:messages {sinceSeq}`. Delete
   `replayMessagesFromCursor`'s keyset, delete `modifiedAt` column
   read (leave column in DB until rollout complete, drop in a
   later migration).
6. **Client** — `computeTailCursor` → `computeLastSeq`. Frame
   router treats per-op seq as the unit of gap detection. Delete
   `targeted: true` handling.
7. **Rollout** — migration first, server emits dual-shape frames
   (seq + modifiedAt both on the wire) for one release, client
   reads seq only; next release drops modifiedAt.
8. **Cleanup migration** — drop `modified_at` column and its index
   once no client reads it.

## Open questions

1. **Does #81's observed `gap-detected seq=1530` require the
   `targeted: true` bypass to be broken, or is there a path where
   targeted flag isn't set on replay?** Worth confirming with a
   log-line in `replayMessagesFromCursor`. If the flag is correctly
   set, #81's gap-detected log must be coming from a different
   path (a live frame at the same seq arriving between replay
   chunks). Either way, Option 3 obsoletes the question.
2. **Is there a workload where per-update seq bumps blow out
   `message_seq`?** Streaming at high delta rates could allocate
   thousands of seqs per assistant turn. SQLite INTEGER is 64-bit;
   even at 10 Hz for 24 hours that's ~860k — orders of magnitude
   under the ceiling. Not a real concern.
3. **Does `ProjectRegistry` or any other cross-DO consumer care
   about the envelope `messageSeq`?** Grep says no — it's
   session-scoped. Confirmed by the `session_meta.message_seq`
   name.

## References

- `apps/orchestrator/src/agents/session-do.ts`
  - `replayMessagesFromCursor` at 1873
  - `broadcastMessages` at 1952
  - subscribe frame handler at 1022
- `apps/orchestrator/src/features/agent-orch/use-coding-agent.ts`
  - `lastSeqRef` at 325
  - `__frameRouterDecisionForTests` at 291
  - `computeTailCursor` call site at 766
- `apps/orchestrator/src/db/messages-collection.ts`
  - `computeTailCursor` at 231
- `apps/orchestrator/src/agents/session-do-migrations.ts`
  - v9 (created_at, id index)
  - v10 (modified_at index)
  - v13 (unified cursor composite index)
- GH #81 — cursor replay seq reuse (the symptom this collapse
  fixes)
- GH #80 — awaiting-response state (companion research)
- `planning/research/2026-04-23-awaiting-response-and-async-wait-state.md`
- `planning/research/2026-04-23-streaming-reconnect-burst-smoothing.md`
