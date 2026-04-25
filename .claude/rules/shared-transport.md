---
paths:
  - "packages/shared-transport/**"
---

# Shared Transport

- **`BufferedChannel`**: ring buffer (10K events / 50MB) that sends directly when the WS is attached and queues otherwise. On overflow drops oldest and emits a single `{type:'gap',dropped_count,from_seq,to_seq}` sentinel on next replay.
- **`DialBackClient`**: WS client that dials `callbackUrl?token=<bearer>`, exposes `send()` / `onCommand()`, reconnects with `[1s, 3s, 9s, 27s, 30s x]` backoff. Resets `attempt` after 10s of stable connection. Terminates (fires `onTerminate`) on close codes `4401` / `4410` or after 20 post-connect failures without stability.
