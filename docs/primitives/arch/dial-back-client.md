# Dial-Back Client

> A child-dials-parent reconnect-with-backoff client — the child owns reconnect, the parent owns identity and authorization.

## Layer test

This primitive survives a stack rewrite but NOT a UI redesign.

## Concept

The dial-back pattern inverts the usual server-listens-for-clients model. The **parent** is a long-lived authority (typically a per-entity coordinator like a Durable Object) — addressable, persistent, the holder of state. The **child** is an ephemeral worker (a runner) spawned to do one unit of work. The child dials the parent, not the other way around.

Why dial-back rather than parent-pushes:

- The parent doesn't know the child's network address. Children are spawned wherever capacity is available; their addresses are private and ephemeral.
- The child always knows the parent's URL — it's published, stable, and embedded in the spawn intent.
- So the dial direction is always **child → parent**, and the child takes responsibility for staying connected.

The client wraps a single WebSocket-style connection with auth-on-dial, exponential reconnect, and clean termination on terminal close codes.

## Authentication

The child presents a **single-shot bearer token** as a query parameter on the dial URL. The parent issued this token at spawn time and stored it; on dial it does a **timing-safe compare** and either accepts or rejects.

The token is deliberately not in a header (some upgrade paths rewrite headers; query params survive intact through every proxy on the path). It's single-shot in the sense that the parent rotates it on certain transitions and refuses any subsequent dial that presents the old value.

## Backoff

| Attempt | Delay |
|---------|-------|
| 1 | 1 s |
| 2 | 3 s |
| 3 | 9 s |
| 4 | 27 s |
| 5+ | 30 s (capped) |

After the connection has been **stable for 10 seconds**, the attempt counter resets to zero — the next outage starts the backoff over from 1 s. This keeps a flapping connection from amplifying into 30-second silences while protecting the parent from a tight reconnect loop on a child that genuinely can't reach it.

## Termination

The client distinguishes "transient outage, reconnect" from "you're done, exit". Three classes of close trigger permanent termination instead of reconnect:

1. **Terminal close codes from the parent.** The parent sends a code in a reserved range (e.g. `4401` invalid token, `4410` token rotated, `4411` mode transition, plus subclass-registered codes for domain-specific terminations). Each maps to a documented reason. The client emits an `onTerminate(reason)` callback, does not reconnect, does not orphan.
2. **Reconnect exhaustion.** After the connection has succeeded once but then failed `MAX_POST_CONNECT_ATTEMPTS` times back-to-back without ever stabilising for 10 s, the client gives up and emits `onTerminate('reconnect_exhausted')`. This prevents an unreachable parent from keeping a zombie child hammering forever.
3. **Startup timeout.** If the very first connection never lands within a startup window, the client surfaces a non-recoverable failure to the spawner.

## Reconnect semantics

- The child does not lose buffered events across reconnects — those are held by the [buffered-channel](./buffered-channel.md) primitive that the dial-back client wraps. The buffer drains in order on the new connection, prefixed by a gap sentinel if anything was dropped.
- The parent does not lose state across child-side disconnects — its state lives in its own durable store, independent of any individual dial.
- The dial URL itself is idempotent. Two dials with the same valid token are a recoverable race; the parent closes the older one cleanly.

## Why this is a primitive, not a module

Any system with detached workers that must call back to a coordinator faces the same questions: how does the worker authenticate, how often does it retry, when does it give up, who's responsible for state during a gap. The numbers (`1/3/9/27/30 s` backoff, 10-s stability window, terminal-code range) are platform commitments — they don't change when the WebSocket library does. A different transport (long-polling, QUIC streams, SSE-with-POST-uplink) would need the exact same shape.

## Where this lives in code

- `packages/shared-transport/src/dial-back-client.ts` — canonical implementation.
- `packages/shared-transport/src/dial-back-doc-client.ts` — subclass for the binary-frame yjs path.
- `packages/session-runner/src/main.ts` — dials the per-session coordinator.
- `packages/docs-runner/src/main.ts` — dials the per-document coordinator.
