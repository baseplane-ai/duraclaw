---
category: dynamics
---

# Dynamics

> How work moves through duraclaw — the lifecycle of a session from spawn to close, including resume, failover, orphan recovery, and gate handling.

Every duraclaw session is a sequence of transitions across the entities defined in `domains.md`. The transitions described here are the only ones that should exist; if a code path appears to introduce a new transition, it is a candidate either for refactoring or for a revision of the theory.

## Spawn

A new session is born when the browser issues a spawn intent to its per-session Durable Object. The Durable Object is authoritative for spawn intent — it decides whether a runner should exist, mints the active callback token, and only then triggers a gateway dial. The gateway is the spawn mechanism: it receives the dial as an HTTPS request, spawns a detached runner process, and forgets about it.

The runner, on starting, reads its spawn arguments, dials its session's Durable Object directly over a WebSocket, and presents the active callback token. The Durable Object validates the token via timing-safe comparison; on success it accepts the connection and the runner is now `dialed-back`. From this moment forward, all command and event traffic is between the runner and the Durable Object — the gateway is out of the message path.

This separation is load-bearing. A gateway restart while a runner is already dialed-back is invisible to the conversation. A Worker redeploy that recycles the Durable Object buffers events on the runner side and replays them on reconnect.

## Follow-up message (live runner)

When a user sends a message during an active session, the Durable Object checks whether a live dial-back connection exists. If it does, the message is injected as a stream-input command over the existing WebSocket and the runner's command queue picks it up to start the next turn. No re-spawn, no resume, no token mint — the WebSocket is already open and authenticated.

This is the normal hot-path; it is by far the most common branch.

## Follow-up message (cold runner — resume)

After roughly thirty minutes of idle, the gateway's reaper kills the runner. The Durable Object learns about the kill via an RPC and updates its session state to `idle`, but it persists the runner's session id so that the SDK can resume against the same on-disk transcript later.

The next user message in this state cannot stream-input (the WebSocket is gone). Instead, the Durable Object triggers a resume dial: a fresh runner is spawned with the persisted session id, and on starting it instructs the SDK to resume from the transcript file. The first user turn after resume runs against the restored SDK context, indistinguishable from a turn against a never-died session — minus the spawn latency.

## Reaper

Idle runners are reaped on the gateway side, not the Durable Object side. After roughly thirty minutes without activity a runner receives SIGTERM, and after a grace window it receives SIGKILL. The reaper's decision is forwarded to the relevant Durable Object via an RPC so the Durable Object can move the session to `idle` and broadcast the status transition to clients.

Reaps are idle-driven, not load-driven. Duraclaw does not evict runners under memory pressure or competition for resources; if a runner is alive and within the idle window, it stays.

## Failover (rate-limit cooldown)

When a runner emits a rate-limit event, or the SDK reports an auth-class error, the Durable Object marks the session's currently-bound identity as `cooldown` with an expiry timestamp and selects the next available identity by an LRU policy. It then triggers a resume dial under the new identity.

Because resume reads from the transcript bytes mirrored into Durable Object SQLite, the failover is lossless: the new runner spawns under a new HOME, has access to a new credentials file, and reconstructs SDK context from the transcript without depending on the previous HOME's filesystem. The user sees a brief pause, possibly a status of `cooled-down` during the swap, then the conversation continues.

If no available identity exists at swap time (every identity is in cooldown, or the catalog is empty), the session enters `errored` and waits for either a cooldown to expire lazily or admin action.

## Orphan recovery

The orphan case is a runner that is alive on the VPS but unreachable from its session's Durable Object. This can arise after split-brain DNS, after a Durable Object loses track of a connection without a clean close, or other transient transport failures.

When the user sends a message and the Durable Object has no live WebSocket but persists a runner session id, it preflights the gateway over HTTPS to check whether a runner with that session id is still listed alive. If one is — and it is unreachable — the Durable Object treats it as an orphan: it serializes its local message history into a transcript-prefixed prompt (a single user turn that contains the prior conversation as context), drops the runner session id (forcing a fresh one rather than colliding with the orphan), and spawns a brand-new runner with that prompt. User-visible UX is a normal send.

Orphan recovery is self-healing on the runner side too. When a runner receives an authorization-class close from the Durable Object — invalid token, rotated token — it aborts its SDK query and exits. This guarantees that an abandoned runner cannot squat indefinitely on a session id and interfere with future spawns.

## Gate lifecycle

The runner's command queue parks on `ask_user` and `permission_request` events. When the user resolves the gate (by answering the question or approving / denying the tool), the resolution is delivered to the runner via a resolve-gate command, which unparks the queue with the user's payload. The SDK then either continues the turn or starts the next one, as the gate's semantics dictate.

Gate cancellation — the user dismisses without answering — flows the same way: a resolve-gate command with a cancellation payload, the queue unparks, the SDK reacts. The Durable Object remains authoritative for gate state across all of this; the runner is the executor.
