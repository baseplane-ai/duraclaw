# Docs Runner

Source package: `packages/docs-runner/`.

> **Disambiguation.** The `docs-runner` package is the live yjs collaborative-document feature — a per-document VPS process that hosts a yjs CRDT and bridges it to a markdown file on disk. It is **distinct from `docs/`**, the knowledge tree containing this very file. `docs/` is plain markdown checked into the repo. Naming overlap is unfortunate but unrelated.

A per-document Bun process spawned by `agent-gateway` and dialed back to a per-document `RepoDocumentDO`. Owns the yjs document state and the bidirectional bridge to a single markdown file in the docs worktree.

## Module Test

- **Nav entry / surface:** the per-doc bun-bundled binary at `packages/docs-runner/dist/main.js` (shebanged, `+x`), spawned by the gateway behind `POST /docs-runners/start`.
- **Owns:** the yjs document host for collaborative editing — md ↔ Y.XmlFragment round-trip, the dial-back transport, the on-disk docs worktree state.
- **Domain question:** How do multiple users edit a duraclaw document simultaneously?

## Owns

- The in-memory yjs document state for one tracked file at a time (per-doc `DialBackDocClient` connection)
- The atomic-write pipeline (temp + rename) and the `suppressedPaths` map (2 s TTL) that prevents write-back loops
- The chokidar watcher with debounce + content-hash gate so unchanged saves do not round-trip to the DO
- Per-file SHA-256 hashes persisted to `{docsWorktreePath}/.duraclaw-docs/hashes.json`
- The runner's `/health` endpoint on `CC_DOCS_RUNNER_PORT` exposing per-file state for the gateway and tray UI

## Consumes

- [`docs/theory/data.md`] — the DO is the state authority for collaborative documents; the runner is the bridge between that authority and disk
- [`docs/modules/shared-transport.md`] — `DialBackDocClient`, the binary-frame variant of `DialBackClient` used for raw yjs updates
- [`docs/modules/agent-gateway.md`] — spawning parent; the runner is supervised by the same reaper as session-runner
- [`docs/modules/orchestrator.md`] — the `RepoDocumentDO` peer at the other end of the dial-back; the orchestrator's `projectMetadata` table provides `docsWorktreePath`

## Theory references

- [`docs/theory/topology.md`] — docs-runner follows the same VPS-side, dialed-back, single-purpose shape as session-runner, with the per-document DO substituting for the per-session DO
- [`docs/theory/trust.md`] — bearer auth (`DOCS_RUNNER_SECRET`) on the WS dial-back, dual-auth on the DO endpoint (cookie for browser, bearer for runner)

## Spawn contract

Spawned with 5 positional argv:

```
docs-runner <projectId> <cmd-file> <pid-file> <exit-file> <meta-file>
```

The cmd-file is JSON of shape `DocsRunnerCommand` — `{ projectId, docsWorktreePath, callbackBase, bearer, watch?, ignored?, healthPort? }`. On argv mismatch or unreadable cmd-file the runner writes a `failed` exit-file and exits non-zero before any DOM/state is constructed.

The runner **must** import `./jsdom-bootstrap.js` first — `@blocknote/server-util` evaluates DOM globals at module-load time, so the bootstrap installs `globalThis.document` / `globalThis.window` before any BlockNote import.

## Lifecycle

1. Bootstrap jsdom, parse argv, read cmd-file
2. Stand up the BlockNote bridge (`blocknote-bridge.ts`), the file pipeline, the chokidar watcher, the suppressed writer
3. Open one `DialBackDocClient` per tracked file; complete yjs sync step 1/2; reconcile per the B7 startup rule (Case A/B/C — Case C logs `reconciliation_merge` WARN)
4. Steady state: file change → debounce → hash gate → push to DO; DO update → suppressed atomic write to disk
5. Rewrite meta every 10 s (`last_activity_ts`, `files`, `reconnects`); 5 consecutive failures abort the runner
6. SIGTERM grants 2 s to abort pending writes and close the WS, mirroring the session-runner watchdog

## Health surface

`GET :CC_DOCS_RUNNER_PORT/health` returns `{ status, version, uptime, files, syncing, disconnected, tombstoned, errors, reconnects, per_file: [...] }`. Consumed by the gateway's `GET /docs-runners/:projectId/files` joiner and by the tray / orchestrator UI.

## Reference spec

`planning/specs/27-docs-as-yjs-dialback-runners.md` is the source of truth for the docs-runner contract, the BlockNote ↔ yjs bridge, the tombstone / reconciliation rules, and the dual-auth WS handshake.
