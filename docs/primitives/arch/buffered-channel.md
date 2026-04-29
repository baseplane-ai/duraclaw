# Buffered Channel

> A monotonically-sequenced ring buffer for streaming events from a producer to a consumer over an unreliable transport — drops on overflow with an explicit gap signal, never silently.

## Layer test

This primitive survives a stack rewrite but NOT a UI redesign.

## Concept

A buffered channel sits between a producer that emits events at its own pace and a consumer reached over a transport that may go away and come back. The channel exposes one write path. Internally it has two states:

- **Attached** — the transport is open. Writes flow straight through.
- **Detached** — the transport is gone. Writes accumulate in a ring with bounded capacity. On reattach, the buffer drains to the consumer in original order before any new writes are sent.

The producer never blocks and never waits for ack. The consumer's connection state is the channel's concern, not the producer's. When capacity is exceeded, the channel evicts the oldest entries to make room and emits a single **gap sentinel** so the consumer learns that data was lost.

## Invariants

- **Monotonic sequence.** Every event carries a `seq` stamped by the producer. The consumer can detect any gap by `seq` skip even before the explicit gap sentinel arrives.
- **Capacity.** 10,000 events OR 50 MB, whichever fills first. Both bounds are checked on every write; whichever bites first triggers eviction.
- **Eviction policy.** Oldest-first. The buffer is FIFO; evictions come off the head.
- **Gap-sentinel semantics.** A gap sentinel is `{type: 'gap', dropped_count, from_seq, to_seq}`. Consecutive evictions while a sentinel is already pending **coalesce** into the same sentinel: `dropped_count` increments and `to_seq` advances. One sentinel per gap, not one per dropped event.
- **Sentinel ordering.** When the transport reattaches, the pending gap sentinel is the FIRST frame sent on the new connection, before any buffered events drain. The consumer sees the gap before the resumed stream.
- **Oversized event.** A single event larger than the byte cap is dropped with a sentinel, and the buffer is also drained (because the cap can never accommodate it alongside the rest).
- **Backpressure model.** The producer never blocks. The consumer is the throttle: it controls drain rate by how fast it reads from the transport.
- **Crash durability (optional).** A persistence hook can be wired to mirror the pending gap sentinel to durable storage so a producer-side crash between drop and reattach doesn't swallow the gap signal.

## Wire shape of the gap sentinel

| Field | Meaning |
|-------|---------|
| `type` | `'gap'` — distinguishes from regular events. |
| `dropped_count` | Total events evicted in this gap (coalesced). |
| `from_seq` | `seq` of the first dropped event. |
| `to_seq` | `seq` of the most-recently dropped event. |

The consumer's job on receiving a gap sentinel is up to it — typically: invalidate any local derivation that assumed a complete stream, refetch authoritative state, or surface a "history was truncated" indicator.

## Why this is a primitive, not a module

Any in-memory streaming with bounded capacity must answer the same overflow / gap / ordering questions. Swap the transport from WebSocket to gRPC streaming or Server-Sent Events; swap the encoding from JSON to MessagePack; swap the consumer from a Durable Object to a long-poll endpoint — the channel's contract doesn't change. The numbers (10K / 50 MB / oldest-first / coalesced sentinel) are the platform's commitment to the consumer, not the library's.

## Where this lives in code

- `packages/shared-transport/src/buffered-channel.ts` — canonical implementation.
- `packages/session-runner/src/main.ts` — primary consumer (event stream from runner to per-session Durable Object).
- `packages/docs-runner/src/main.ts` — secondary consumer (yjs awareness frames from docs-runner to its dial-back authority).
