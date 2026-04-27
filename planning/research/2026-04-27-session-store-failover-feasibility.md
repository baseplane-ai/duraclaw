---
date: 2026-04-27
topic: Account failover via SDK SessionStore
type: feasibility
status: complete
github_issue: 119
items_researched: 6
---

# Research: Account failover via SDK SessionStore (GH#119)

## Context

GH#119 needs account failover — when a runner hits a rate/auth limit,
spawn a new runner under a different Claude identity and resume the same
session. The issue proposes filesystem sharing (`~/.claude/projects`
mounted across identities). SDK v0.2.119 introduced `SessionStore`, a
pluggable transcript backend that may replace the filesystem approach
entirely.

**Research classification:** feasibility study.
**Decision:** SessionStore via DO SQLite + HOME-per-identity (user-confirmed).

## Scope

| # | Item | Verdict |
|---|------|---------|
| 1 | SessionStore API contract | Minimal, clean, fits our access pattern |
| 2 | Current session state on disk | JSONL + tool-results, 5KB–5MB per session |
| 3 | Resume mechanics | `sessionStore` preempts filesystem on resume — key unlock |
| 4 | Runner identity architecture | Single shared HOME today; needs per-identity HOME override |
| 5 | DO SQLite vs R2 as backend | DO SQLite wins (zero-latency, append-friendly, 10GB budget) |
| 6 | FS-sharing vs SessionStore | SessionStore dominates on every dimension |

## Findings

### 1. SessionStore API (SDK v0.2.119, @alpha)

```typescript
type SessionStore = {
  append(key: SessionKey, entries: SessionStoreEntry[]): Promise<void>
  load(key: SessionKey): Promise<SessionStoreEntry[] | null>
  delete?(key: SessionKey): Promise<void>
  listSessions?(projectKey: string): Promise<Array<{sessionId: string; mtime: number}>>
  listSessionSummaries?(projectKey: string): Promise<SessionSummaryEntry[]>
  listSubkeys?(key: {projectKey: string; sessionId: string}): Promise<string[]>
}

type SessionKey = { projectKey: string; sessionId: string; subpath?: string }
type SessionStoreEntry = { type: string; uuid?: string; timestamp?: string; [k: string]: unknown }
```

- `append()` called every turn (fire-and-forget from SDK's perspective)
- `load()` + `listSubkeys()` called on resume within `loadTimeoutMs` (default 60s)
- `InMemorySessionStore` reference impl exists for testing
- `importSessionToStore()` helper migrates existing `.jsonl` files
- `foldSessionSummary()` pure function for incremental summary maintenance

Passed to SDK via `query({options: {sessionStore}})`.

### 2. Current session state on disk

```
~/.claude/projects/-data-projects-duraclaw-dev2/
├── {uuid}.jsonl              # 5KB–5MB, NDJSON transcript (user, assistant, tool_result, etc.)
├── {uuid}/tool-results/*.txt # Large tool outputs (~500KB each, optional)
└── memory/                   # Project-scoped memory (not session-specific)
```

167 sessions in duraclaw-dev2. JSONL entries are opaque blobs with `type`,
`uuid`, `timestamp`, `sessionId` fields. No `sessions-index.json`.
Per-HOME (`~/.claude/projects/`), not per-project.

### 3. Resume mechanics

When `sessionStore` is provided alongside `resume`:
- SDK calls `store.load(key)` **instead of** reading `{sessionId}.jsonl` from disk
- SDK calls `store.listSubkeys()` to enumerate subagent transcripts
- `loadTimeoutMs` caps the total read time (fail-fast on slow stores)
- Resume is guaranteed correct: the SDK reads the full transcript before executing

**Key unlock:** Runner B (different identity) can resume Runner A's session
without filesystem access — it just needs the same `sessionStore` pointing
at the same DO SQLite.

### 4. Runner identity architecture (current)

- Gateway spawns with inherited `process.env` (no HOME override)
- Runner authenticates via `~/.claude/.credentials.json` (SDK auto-resolves from HOME)
- CAAM (PR #104) rotates profiles within a single HOME — not multi-identity
- No per-runner identity concept today; all runners share one HOME
- `buildCleanEnv()` strips `CLAUDECODE*` vars but doesn't touch HOME

**Required for multi-identity:** Pass `HOME=/srv/duraclaw/homes/<identity>`
in spawn env. Each identity gets isolated auth + settings.

### 5. DO SQLite vs R2

| | DO SQLite | R2 |
|---|---|---|
| Append latency | 0ms (in-thread) | 50–300ms (GET+PUT per append) |
| Append-heavy fit | Perfect (INSERT per batch) | Poor (no native append, 100 PUT/sec cap) |
| Size limits | 10GB per DO | 5TB per object |
| Consistency | Strong (single-writer) | Eventual |
| Existing pattern | SessionDO already uses SQLite | Not used in duraclaw |

**Verdict:** DO SQLite. The runner calls the DO over the existing WS;
the DO writes in-thread to its SQLite. ~50ms per `append()` round-trip
from VPS, which is acceptable (non-blocking from SDK's perspective).

### 6. Filesystem sharing vs SessionStore

| Dimension | FS Sharing | SessionStore |
|---|---|---|
| Complexity | High (mounts, per-identity HOME, locking layer) | Low (1 adapter + 2 RPC endpoints) |
| Locking | Must build (ProjectRegistry locks don't exist) | DO single-writer by design |
| Resume correctness | Race window on mount staleness | Guaranteed by SDK contract |
| Failure modes | Stale mounts, orphaned locks, cleanup jobs | Adapter is thin; DO handles durability |
| Incremental ship | Hard (mount coordination required) | Flag-gated `sessionStore` param |
| Multi-VPS future | Architectural ceiling | Scales naturally |

## Recommendation

**Use SessionStore via DO SQLite + HOME-per-identity.** Dominates the
filesystem-sharing approach on every dimension. The adapter is ~100 lines,
ships behind a feature flag, and the migration path exists
(`importSessionToStore()`).

### Implementation sketch

1. **SessionStore adapter** (new file in session-runner): implements the
   `SessionStore` interface, delegates `append`/`load`/`listSubkeys` as
   RPCs over the dial-back WS to the SessionDO.
2. **SessionDO transcript table** (new migration): `session_transcript`
   table with `(project_key, session_id, subpath, seq, entry_json)`.
   `append()` = batch INSERT, `load()` = SELECT ORDER BY seq.
3. **Runner integration**: when `ENABLE_SESSION_STORE=true` (feature flag),
   instantiate the adapter and pass to `query({sessionStore})`.
4. **Identity abstraction**: gateway accepts optional `runner_home` in
   spawn payload; sets `HOME` in spawn env. DO reads available identities
   from D1 (or a config table).
5. **Failover flow**: on `rate_limit` / auth error, DO marks current
   identity unavailable, picks next identity, spawns new runner with
   `{resume, sessionStore, runner_home: nextIdentity.home}`.

### Open questions

- **@alpha stability risk** — interface could shift. Mitigation: adapter
  is thin, fix is localized.
- **tool-results files** — are these covered by SessionStore or still
  written to disk? Need to verify whether the SDK's `tool-results/*.txt`
  files route through the store or remain filesystem-only.
- **Subagent transcripts** — `listSubkeys()` implies the store handles
  them, but we should verify the round-trip with a prototype.
- **Concurrent sessions per worktree** — if two sessions share a project,
  are their `projectKey` values the same? Locking implications.

## Next steps

1. Write the feature spec against GH#119 with the SessionStore approach
2. Prototype the adapter + DO transcript table to validate the round-trip
3. Verify tool-results and subagent coverage empirically
