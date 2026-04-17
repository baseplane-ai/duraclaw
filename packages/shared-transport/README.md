# @duraclaw/shared-transport

Transport primitives used by [`@duraclaw/session-runner`](../session-runner)
to stream events to its Durable Object counterpart without losing data across
gateway restarts, edge timeouts, or DO redeploys.

## BufferedChannel

Ring buffer (`maxEvents=10 000`, `maxBytes=50 MB`) over the dial-back
WebSocket.

- **Connected**: `send(event)` stamps + serialises + calls `ws.send` directly.
- **Disconnected**: event is queued; overflow drops oldest and records a
  single `{type:'gap', dropped_count, from_seq, to_seq, new_gap?:true}`
  sentinel that coalesces further drops until it's actually sent.
- **On (re)attach**: flushes the pending gap sentinel first, then replays
  every buffered entry in order, then clears the buffer.
- **Oversized single event** (>`maxBytes`) drains the buffer and is dropped
  with a warning + gap record — we never send a message the transport
  cannot carry.

Events are opaque `{seq:number, …}` objects; `seq` must be monotonic across
a channel's lifetime (the runner's context increments `nextSeq`).

## DialBackClient

WS client that dials `callbackUrl?token=<bearer>`, exposes `send()` +
`onCommand()`, and manages reconnects.

| Parameter                     | Value           |
|-------------------------------|-----------------|
| `BACKOFF_BASE`                | `1000 ms`       |
| `BACKOFF_MULTIPLIER`          | `3`             |
| `BACKOFF_CAP`                 | `30 000 ms`     |
| `STABLE_THRESHOLD`            | `10 000 ms`     |
| `STARTUP_TIMEOUT`             | `15 min`        |
| `MAX_POST_CONNECT_ATTEMPTS`   | `20`            |

Reconnect sequence for N consecutive failures: `[1s, 3s, 9s, 27s, 30s×]`.
`attempt` resets to 0 after any `open` that survives `STABLE_THRESHOLD`.

### Terminal close codes

The DO signals "don't come back" with specific codes that the client respects
(the ones used by `SessionDO`):

- `4401` — invalid callback_token (never accepted, or state was cleared)
- `4410` — token rotated (a newer `triggerGatewayDial` replaced this runner)

On either code, the client stops reconnecting and calls
`onTerminate(reason)`. The session-runner wires this to
`ctx.abortController.abort()` so the SDK query unwinds and the process
exits cleanly — no orphaned reconnect loop.

The post-connect attempt cap triggers the same `onTerminate('reconnect_exhausted')`
callback: after 20 back-to-back failures without a `STABLE_THRESHOLD`
window, the client gives up rather than hammer the DO forever.

## Tests

```bash
pnpm --filter @duraclaw/shared-transport test
# vitest — 22 tests covering overflow, gap sentinels, backoff progression,
# reconnect reset, collision replacement, stop() semantics, structured logs.
```

Note: these use Vitest, **not `bun test`**. Bun's vitest-compat shim lacks
`vi.stubGlobal`/`vi.unstubAllGlobals` which the WebSocket stubs rely on.
