# Shared Transport

Source package: `packages/shared-transport/`.

The transport primitives that let a runner stream events to its Durable Object counterpart without losing data across gateway restarts, edge timeouts, or DO redeploys. Consumed by both `session-runner` and `docs-runner`.

## Module Test

- **Nav entry / surface:** a published-internally TypeScript package (`@duraclaw/shared-transport`) consumed by both runners as the only allowed edge from a runner to anywhere. No CLI, no daemon — it is library code.
- **Owns:** `BufferedChannel` (monotonic-`seq` ring) and `DialBackClient` (reconnect with `1/3/9/27/30s` backoff), plus `DialBackDocClient` (binary-frame variant for yjs) — the primitives that every runner uses to dial back its DO.
- **Domain question:** How does a runner reliably stream events back to its DO across transient connection loss?

> **Note:** `BufferedChannel` and `DialBackClient` are arch-shaped — they describe an invariant ("durable monotonic event stream over an unreliable WS") rather than session- or doc-specific behavior. They may eventually graduate to `docs/primitives/arch/` in P2 of GH#135. For now they are part of this module's surface.

## Owns

- The in-memory event buffer (10 000 events / 50 MB cap) over the dial-back WebSocket
- The gap-sentinel emission semantic on overflow: a single `{type:'gap', dropped_count, from_seq, to_seq, new_gap?: true}` record that coalesces further drops until it is actually sent
- The reconnect state machine — base `1000 ms`, multiplier `3`, cap `30 000 ms`, stable-threshold `10 000 ms`, startup timeout `15 min`, post-connect attempt cap `20`
- The terminal-close semantic — codes `4401` (invalid token) / `4410` (token rotated) / post-connect cap exhausted all fire `onTerminate(reason)`, which the session-runner wires to `ctx.abortController.abort()` so the SDK query unwinds and the process exits cleanly

## Consumes

- [`docs/theory/dynamics.md`] — the spawn / follow-up / resume / orphan-recovery transitions are the flows these mechanisms participate in; the buffered ring is what makes "DO redeploy is a non-event" hold

## Theory references

- [`docs/theory/topology.md`] — the runner→DO edge is the only edge from any runner to anywhere; this module is that edge
- [`docs/theory/trust.md`] — bearer-token presentation in the WS query string, terminal close codes as the DO's "don't come back" signal

## BufferedChannel

Ring buffer over a dial-back WebSocket.

- **Connected** — `send(event)` stamps + serialises + calls `ws.send` directly
- **Disconnected** — event is queued; overflow drops oldest and records a single gap sentinel that coalesces further drops
- **On (re)attach** — flushes the pending gap sentinel first, then replays every buffered entry in order, then clears the buffer
- **Oversized single event** (>`maxBytes`) — drains the buffer and is dropped with a warning + gap record

Events are opaque `{ seq: number, ... }` objects; `seq` must be monotonic across a channel's lifetime (the runner context increments `nextSeq`).

## DialBackClient

WS client that dials `callbackUrl?token=<bearer>`, exposes `send()` + `onCommand()`, and manages reconnects.

| Parameter | Value |
|---|---|
| `BACKOFF_BASE` | 1 000 ms |
| `BACKOFF_MULTIPLIER` | 3 |
| `BACKOFF_CAP` | 30 000 ms |
| `STABLE_THRESHOLD` | 10 000 ms |
| `STARTUP_TIMEOUT` | 15 min |
| `MAX_POST_CONNECT_ATTEMPTS` | 20 |

Reconnect sequence for N consecutive failures: `[1s, 3s, 9s, 27s, 30s × ...]`. `attempt` resets to 0 after any `open` that survives `STABLE_THRESHOLD`.

## DialBackDocClient

A subclass of `DialBackClient` used by `docs-runner` — sets `binaryType = 'arraybuffer'`, hands raw `Uint8Array` to `onCommand` (no JSON parse), and adds `send(update: Uint8Array)` for binary yjs frames.

## Tests

22 vitest tests cover overflow, gap sentinels, backoff progression, reconnect reset, collision replacement, `stop()` semantics, and structured logs. The suite uses Vitest, not `bun test` (bun's vitest-compat shim lacks `vi.stubGlobal` / `vi.unstubAllGlobals`).
