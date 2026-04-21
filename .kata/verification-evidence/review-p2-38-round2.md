## Code Review

I'll analyze the diff across all four files systematically.

```
REVIEW_SCORE: 79/100

## Issues Found

### 🔴 Critical (must fix)

1. **session-do.ts:EOF** — The diff is truncated mid-token (`const ` on the last line). The entire POST `/messages` handler implementation in production code is missing from review. The test mirrors suggest a body-size gate, content/clientId/createdAt validation, and duplicate-id precheck — but none of this production code is visible. Cannot confirm the production handler matches the test mirrors, which is especially dangerous given the mirror-based test approach (see 🟡 #1).

### 🟡 Suggestion (should consider)

1. **session-do.test.ts:1962–2998** — All new test suites (`broadcastMessages`, `/messages cursor REST`, `POST /messages ingest`, `broadcastBranchInfo`, `B10 atomic dual-emit`) test **hand-written mirrors** of production logic, not the actual production code. If production drifts from the mirror, tests still pass green while bugs ship. This is acknowledged (TC39 decorator barrier), but consider at least one integration-level smoke test via `unstable_dev` or Miniflare that exercises the real `SessionDO.fetch()` path for the cursor query and POST ingest — the two highest-risk surfaces.

2. **session-do.test.ts:1968** — `import type { SyncedCollectionOp }` appears mid-file (after line 1959), well below the top-of-file import block. While valid JS, mid-file imports are atypical, can confuse linters/tooling, and make dependency scanning harder. Move it to the top import block alongside the other `@duraclaw/shared-types` usage already implied by the test file.

3. **session-do.ts:~320–340** — The keyset cursor SQL query is only exercised by a JS-mirror test that reimplements the filtering in JS (`Array.filter + sort + slice`). The actual SQL predicate (`(created_at > $1) OR (created_at = $1 AND id > $2)`) is never tested against a real SQLite engine. An off-by-one in the SQL (e.g., `>=` instead of `>`) would be invisible to the current test suite.

4. **session-do-helpers.ts:29** — `deriveSnapshotOps` emits the **full** `newLeaf` as insert ops (authoritative-full strategy). For large histories (hundreds of messages), this means re-sending every shared-prefix row on every branch switch/rewind. The `chunkOps` mechanism mitigates wire size, but consider adding a comment noting the upper-bound cost or a future TODO for minimal-diff mode when histories grow beyond a threshold.

5. **session-do-migrations.ts:135–137** — Migration v9's catch block swallows "no such table" silently with no log. Consider `console.info('[migration v9] skipped — assistant_messages table not yet created')` so operators have observability into why the index is missing on a given DO.

6. **session-do.test.ts broadcastBranchInfo vs broadcastMessages** — The two mirror functions have subtly different empty-ops semantics: `broadcastMessages` early-returns on `ops.length === 0` regardless of `targetClientId`, while `broadcastBranchInfo` only early-returns on `rows.length === 0 && !opts.targetClientId`. This asymmetry is tested and intentional, but add a brief comment in production code explaining *why* branchInfo emits an empty frame to a target (explicit "no branches" signal) while messages does not — a future maintainer may "fix" the inconsistency.

7. **session-do-migrations.ts:127** — Migration v8 description comment has a slightly garbled sentence: *"SDK Session owns assistant_messages which has no seq column"*. Should clarify whether this means "the seq column was never created" or "seq was removed" — the current text could be read either way.

### 🟢 Good

1. **`deriveSnapshotOps` extraction** — Clean pure function with a well-typed generic signature (`TRow extends { id: string }`), thorough JSDoc, and no side effects. Using a `Set` for O(n) stale-id computation is the right call. Extracting it into `-helpers.ts` to avoid the TC39 decorator import barrier is pragmatic.

2. **Delete-before-insert ordering** — The wire contract (B9) requiring deletes before inserts is clearly documented in the JSDoc and enforced by the spread order in the implementation. Tests explicitly assert this ordering.

3. **Keyset pagination design** — The `(created_at, id)` cursor with a composite index (migration v9) is the correct approach for cursor-based pagination. 400 on asymmetric cursor params, ISO 8601 validation, and LIMIT 500 cap are all solid defensive choices.

4. **Migration v9 safety** — `CREATE INDEX IF NOT EXISTS` against an SDK-owned table is appropriately cautious. The try/catch for table-not-yet-created is a sensible edge case handler.

5. **POST /messages body size gate** — The 64 KiB `Content-Length` check before parsing protects the DO from memory exhaustion. The `clientId` regex (`/^usr-client-[a-z0-9-]+$/`) prevents injection and enforces a naming convention.

6. **Test thoroughness** — Despite being mirror-based, the tests are extensive: edge cases (empty ops, targeted vs broadcast, duplicate ids, invalid dates, body size boundary), ordering invariants (B10 dual-emit), chunking behavior, and the cursor pagination cap. The test descriptions are clear and reference the relevant design doc sections (GH#38 P1.2/P1.4/P1.5).

7. **SQL parameterization** — The tagged-template SQL in `session-do.ts` properly parameterizes all user-supplied values (`sinceCreatedAt`, `sinceId`, `this.name`), preventing SQL injection.

8. **409 idempotency on duplicate POST** — Returning `{ id: clientId }` on duplicate lets the client treat retries as successful without re-insertion. Clean idempotent design.
```

**Summary:** The code is well-designed and thoroughly documented. The primary structural risk is the mirror-based test approach — if production drifts, these tests provide a false sense of safety. The truncated diff is a blocker for full review of the POST handler. Address those two items and this is a solid merge.
