---
paths:
  - "apps/orchestrator/src/**"
---

# Client data flow (rule stub)

Invariants live in [`docs/theory/data.md`](../../docs/theory/data.md). This file just points at code.

- Status hook: `apps/orchestrator/src/hooks/use-session-status.ts`
- Synced collections factory: `apps/orchestrator/src/db/synced-collection.ts`
- Per-session collections: `apps/orchestrator/src/collections/`
- Connection manager (cross-cutting WS reconnect): `apps/orchestrator/src/lib/connection-manager/`
- Wire-protocol types: `packages/shared-types/src/index.ts` (`SyncedCollectionFrame`, `SessionMessage`, etc.)
