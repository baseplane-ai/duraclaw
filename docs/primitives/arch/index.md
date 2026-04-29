# Architectural Primitives

> Stack-independent building blocks the platform depends on regardless of the libraries currently implementing them.

## Layer test

Arch primitives **survive a stack rewrite** but NOT a UI redesign. Swap the WebSocket library, swap the SQLite host, swap the JSON encoding for protobuf — these primitives still need to exist with the same contract. Replace the visual chrome and they're untouched.

## What an arch primitive is (and isn't)

These are baseplane-style platform primitives — abstract building blocks the platform depends on regardless of the libraries currently implementing them. They are **NOT infrastructure** (no servers, no daemons, no deploys); they are patterns. The "Where this lives in code" section at the bottom of each doc is the only stack-specific anchor — kept narrow so the rest of the doc stays portable.

The disambiguation rule:

- If a doc would also survive a UI redesign, it's **theory**.
- If it wouldn't survive a stack rewrite, it's a **module**.
- If it describes how something *looks* or how a user interacts with it, it's a **UI primitive**.
- Otherwise — abstract mechanism with concrete numbers and invariants — it belongs here.

## Index

- [`buffered-channel.md`](./buffered-channel.md) — monotonically-sequenced ring buffer for streaming events over an unreliable transport, with an explicit gap-sentinel on overflow.
- [`dial-back-client.md`](./dial-back-client.md) — child-dials-parent reconnect-with-backoff client; the child owns reconnect, the parent owns identity & authorization.
- [`synced-collections.md`](./synced-collections.md) — reactive collection ↔ session DO ↔ registry sync pattern, with optimistic-write reconciliation and reconnect-as-resync.
- [`dialback-runner.md`](./dialback-runner.md) — detached-spawn-with-dialback pattern. A spawner kicks off an ephemeral worker that immediately dials a long-lived authority; after the dial, the spawner is out of the message path.
