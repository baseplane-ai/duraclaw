```
REVIEW_SCORE: 80/100

## Issues Found

### 🔴 Critical (must fix)

1. **session-do.ts: POST /messages — no content-length / body-size limit**
   The `POST /messages` handler calls `request.json()` without gating on `Content-Length`. A malicious client can POST an arbitrarily large JSON body (e.g. a multi-GB `content` string) that the DO must fully parse and hold in memory before the `content.length === 0` check fires. Consider adding a `Content-Length` cap (e.g. 64 KiB) or a streaming size check before `request.json()`.

2. **Diff is truncated — `onConnect` refactor not fully visible**
   The diff cuts off mid-way through the `onConnect` handler rewrite in `session-do.ts` (the old `broadcastMessages({ kind: 'snapshot', ... })` call is removed but the replacement isn't shown). The reviewer cannot verify correctness of the reconnect-replay path, which is the most critical real-time path. Please ensure the full diff is available for review.

### 🟡 Suggestion (should consider)

1. **session-do.ts:~320 — Missing index comment for cursor query**
   The SQL query `SELECT content FROM assistant_messages WHERE session_id = ? AND ((created_at > ?) OR (created_at = ? AND id > ?)) ORDER BY created_at ASC, id ASC LIMIT 500` relies on a composite index `(session_id, created_at, id)` for acceptable performance. If this index doesn't exist, this will table-scan. Add a comment documenting the expected index, or verify it exists in a migration.

2. **session-do.test.ts — "mirror" test pattern carries drift risk (~1000 new lines)**
   All test functions (`broadcastMessages`, `runMessagesHandler`, `postMessagesHandler`, `broadcastBranchInfo`) are hand-written mirrors of production methods — not imports of the actual code. If the production logic changes (e.g. a new validation rule in `POST /messages`), the mirrors silently diverge. Consider:
   - Adding a comment at each mirror referencing the exact production line range it mirrors
   - Creating a lint rule or CI check that flags when the production method's signature changes without a corresponding test update
   - Long-term: investigating a vitest plugin or build step that strips TC39 decorators so the actual `SessionDO` class can be imported

3. **session-do.ts:~380 — `sendMessage` return shape `{ok, error, duplicate}` is not visible**
   The POST handler destructures `result.ok`, `result.error`, and `result.duplicate` from `this.sendMessage(...)`, but the `sendMessage` method signature/return type isn't in the diff. If `sendMessage` was updated as part of this PR, that change should be included in this review. If it's a pre-existing interface, a TypeScript type annotation on `result` would improve readability.

4. **session-do.ts — Repeated JSON response boilerplate**
   The pattern `new Response(JSON.stringify({...}), { status: N, headers: { 'Content-Type': 'application/json' } })` appears 10+ times across the GET and POST handlers. Consider a small helper like `jsonResponse(body, status?)` to reduce repetition and prevent a missed `Content-Type` header.

5. **session-do-helpers.ts:25 — `deriveSnapshotOps` emits full `newLeaf` as inserts unconditionally**
   The function always emits every `newLeaf` row as an insert, even for shared-prefix rows already on the client. The comment says "TanStack DB's key-based upsert dedupes the shared-prefix rows at apply time" — this is correct but means wire bandwidth scales as O(newLeaf) rather than O(delta). For large histories (hundreds of messages), this could be significant. Fine for now if histories are bounded, but worth a TODO comment if unbounded growth is possible.

6. **session-do.ts — `as string` casts after null checks (lines ~315-330)**
   `sinceCreatedAt as string` and `sinceId as string` are used after the `hasCA`/`hasId` null guards. TypeScript's control-flow narrowing should handle this automatically if the variables are `const`-bound from `url.searchParams.get(...)`. The `as` casts suppress type errors without adding safety — prefer a refactor:
   ```ts
   if (sinceCreatedAt !== null && sinceId !== null) {
     // TS now narrows both to `string` here
   ```

7. **session-do-migrations.ts v8 — No-op migration is fine but consider a comment in session_meta**
   The no-op migration is good for audit trail, but the description mentions "seq column drop stub (column never existed)." This could confuse future developers. The description is detailed enough, but consider linking to the GH issue directly in the code comment.

### 🟢 Good

1. **`deriveSnapshotOps` extraction** — Clean separation of pure logic from the DO class, enabling unit testing without the TC39 decorator barrier. Well-documented JSDoc with clear contract (deletes before inserts).

2. **Cursor pagination design** — The `(created_at, id)` composite cursor with strict-after semantics and 500-row cap is a solid keyset pagination pattern. The asymmetric-cursor 400 guard prevents misuse.

3. **POST /messages validation** — Thorough input validation: regex-guarded `clientId`, ISO 8601 date check, non-empty content check, and 409 for idempotent duplicate detection. The `clientId` regex `^usr-client-[a-z0-9-]+$` enforces a safe namespace.

4. **Test coverage breadth** — Edge cases are well-covered: empty ops, targeted vs. broadcast, messageSeq monotonicity, cursor tie-breaking, chunking byte limits, B10 dual-emit ordering.

5. **`chunkOps` integration** — Proper use of chunking to stay under the DO's 256 KiB broadcast limit, with tests that verify no rows are lost or duplicated across chunks.

6. **Wire contract documentation** — The comments clearly document the B9 delete-before-insert ordering requirement and the B10 atomic dual-emit invariant (messages then branchInfo in the same JS tick for React 18 batching).

7. **Migration chain integrity test update** — The existing test for sequential migration versions was correctly updated from `[1..7]` to `[1..8]`.
```
