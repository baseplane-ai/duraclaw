# SDK Peel-back Spike — Verification Addendum (P0)

Addendum to: planning/research/2026-04-25-sdk-interference-peelback.md
Spec: planning/specs/102-sdk-peelback.md (P0)
Date: 2026-04-25
Branch: feature/102-sdk-peelback

## Purpose
Lock the SDK contract assumptions before P1+ deletion lands.

## §1: SDK Message Shape Capture (Static)

SDK file: `node_modules/.pnpm/@anthropic-ai+claude-agent-sdk@0.2.98_@cfworker+json-schema@4.1.1_zod@3.25.76/node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` (referred to as `$SDK` below). Package version: `@anthropic-ai/claude-agent-sdk@0.2.98`.

### 1.1 `SDKSessionStateChangedMessage`

`$SDK` lines 2729-2738 (verbatim):

```typescript
/**
 * Mirrors notifySessionStateChanged. 'idle' fires after heldBackResult flushes and the bg-agent do-while exits — authoritative turn-over signal.
 */
export declare type SDKSessionStateChangedMessage = {
    type: 'system';
    subtype: 'session_state_changed';
    state: 'idle' | 'running' | 'requires_action';
    uuid: UUID;
    session_id: string;
};
```

Implication — **CONFIRMED**: `state` enum is exactly `'idle' | 'running' | 'requires_action'` (3 values). No `'compacting'` and no `'api_retry'` member. Locks the spec's wire-enum extension decision: any union we put on the wire that wants to expose compaction or retry as a "state" must extend the enum at the runner→DO boundary, not assume the SDK already carries it.

### 1.2 `SDKStatusMessage`

`$SDK` lines 2758-2767 (verbatim):

```typescript
export declare type SDKStatus = 'compacting' | null;

export declare type SDKStatusMessage = {
    type: 'system';
    subtype: 'status';
    status: SDKStatus;
    permissionMode?: PermissionMode;
    uuid: UUID;
    session_id: string;
};
```

Implication — **CONFIRMED**: `'compacting'` is signalled via `SDKStatusMessage` (`subtype: 'status'`, `status: 'compacting' | null`), not via `SDKSessionStateChangedMessage`. Two distinct wire frames. `null` is the "not compacting / idle status" value. This is the dedicated channel for compaction lifecycle and is independent of the `session_state_changed` enum.

### 1.3 `SDKAPIRetryMessage`

`$SDK` lines 1971-1984 (verbatim):

```typescript
/**
 * Emitted when an API request fails with a retryable error and will be retried after a delay. error_status is null for connection errors (e.g. timeouts) that had no HTTP response.
 */
export declare type SDKAPIRetryMessage = {
    type: 'system';
    subtype: 'api_retry';
    attempt: number;
    max_retries: number;
    retry_delay_ms: number;
    error_status: number | null;
    error: SDKAssistantMessageError;
    uuid: UUID;
    session_id: string;
};
```

Supporting alias (`$SDK` line 1995):

```typescript
export declare type SDKAssistantMessageError = 'authentication_failed' | 'billing_error' | 'rate_limit' | 'invalid_request' | 'server_error' | 'unknown' | 'max_output_tokens';
```

Implication — **REFUTED with drift**: the spec claims `error_class: 'rate_limit' | 'server_error' | 'overloaded' | 'billing_error'`. The actual SDK shape is different in **two material ways**:

1. **Field name drift.** The field is `error: SDKAssistantMessageError` — not `error_class`. There is no `error_class` field on this type at all.
2. **Enum drift.** The actual enum has **7 values**, not 4: `'authentication_failed' | 'billing_error' | 'rate_limit' | 'invalid_request' | 'server_error' | 'unknown' | 'max_output_tokens'`. Notably, the spec's claimed `'overloaded'` is **NOT** present, and four spec-unmentioned values (`authentication_failed`, `invalid_request`, `unknown`, `max_output_tokens`) **are** present.

Spec must be updated: rename `error_class` → `error`, replace the 4-value enum with the verbatim 7-value `SDKAssistantMessageError` union, and reconsider any rate-limit-class-handling logic that assumed `'overloaded'` was a discriminator (it isn't — server-side overload presumably falls under `'server_error'` or surfaces via `error_status: 529`).

### 1.4 `SDKCompactBoundaryMessage`

`$SDK` lines 2008-2025 (verbatim):

```typescript
export declare type SDKCompactBoundaryMessage = {
    type: 'system';
    subtype: 'compact_boundary';
    compact_metadata: {
        trigger: 'manual' | 'auto';
        pre_tokens: number;
        /**
         * Relink info for messagesToKeep. Loaders splice the preserved segment at anchor_uuid (summary for suffix-preserving, boundary for prefix-preserving partial compact) so resume includes preserved content. Unset when compaction summarizes everything (no messagesToKeep).
         */
        preserved_segment?: {
            head_uuid: UUID;
            anchor_uuid: UUID;
            tail_uuid: UUID;
        };
    };
    uuid: UUID;
    session_id: string;
};
```

Implication — **CONFIRMED on all four points**:
- `pre_tokens: number` — present (inside `compact_metadata`).
- `trigger: 'manual' | 'auto'` — present (inside `compact_metadata`).
- `preserved_segment?` — present and optional, with `{head_uuid, anchor_uuid, tail_uuid}` as documented.
- **`post_tokens` field is ABSENT.** Critically confirms B11 / gotcha #2: the SDK does not emit a post-compaction token count on this frame. Any "after compaction we are at N tokens" UI must derive that downstream (e.g. by reading the next assistant turn's usage), not by reading a `post_tokens` field that doesn't exist. Note also the field is `pre_tokens` (singular path inside `compact_metadata.pre_tokens`), not flat at the message root.

### 1.5 `Query` interface — `interrupt()` signature

`$SDK` lines 1683-1697 (verbatim, with surrounding context):

```typescript
/**
 * Query interface with methods for controlling query execution.
 * Extends AsyncGenerator and has methods, so not serializable.
 */
export declare interface Query extends AsyncGenerator<SDKMessage, void> {
    /**
     * Control Requests
     * The following methods are control requests, and are only supported when
     * streaming input/output is used.
     */
    /**
     * Interrupt the current query execution. The query will stop processing
     * and return control to the caller.
     */
    interrupt(): Promise<void>;
```

Implication — JSDoc says: *"Interrupt the current query execution. The query will stop processing and return control to the caller."* It does **NOT** state whether `interrupt()` closes / completes the user-supplied prompt async iterable. The ambient framing (the comment block immediately above marks all the listed methods as "control requests, only supported when streaming input/output is used") confirms `interrupt()` is a control-plane signal targeted at the in-flight turn — there is no documented contract that it terminates the outer prompt iterable. Caller must still close the prompt iterable itself to make `query()` return. This matters for the runner's shutdown sequence: a single `interrupt()` is **not** sufficient to end the SDK loop; the runner must additionally end the input async iterator (or let it throw / close) for the SDK's outer `for await` to drain.

## §2: PushPullQueue Prototype + Interrupt-Survives Test

Artifact landed on the spike branch (will be reused/finalised in P2/Reduction B):

- `packages/session-runner/src/push-pull-queue.ts` — 38 LoC. Verbatim implementation of the spec scaffold (spec lines 678–714). Top-of-file JSDoc cites this spec.
- `packages/session-runner/src/push-pull-queue.test.ts` — 103 LoC, 6 test cases, all passing (vitest, ~404 ms total). Typecheck clean across `@duraclaw/session-runner`.

Test coverage:

| # | Case | Spec test_case ID covered |
|---|------|---------------------------|
| 1 | push then iterate yields the pushed item | (foundational) |
| 2 | multi-push FIFO order | (foundational) |
| 3 | close after items flushes buffered then ends | (foundational) |
| 4 | close while iterator awaits ends iteration | (foundational) |
| 5 | push after close throws | (foundational) |
| 6 | lifetime simulation — interrupt-doesn't-touch-queue | `spike-interrupt-survives-lifetime-iterable` (queue side only) |

Test #6 pins the **queue side** of the load-bearing contract: with msg1 pushed and consumed, a no-op `interrupt()` representing `q.interrupt()` does not mutate queue state, msg2 is then consumed by the same iterator, and the iterator never enters `done`. The **SDK side** of the same contract — that `Query.interrupt()` does not internally `endInput()` or otherwise terminate the prompt async iterable — is **not pinned by a static unit test** (the SDK's CLI bridge is opaque from JS) and is therefore **deferred to the live trace** (see §4).

Note on a minor scaffold quirk surfaced during testing: the `if (item !== undefined)` guard inside the iterator is fragile if `T` is ever instantiated with `undefined` in its type set. For the planned `SDKUserMessage` payload this is safe (SDKUserMessage is never `undefined`), so the scaffold was kept verbatim. P2 should not loosen `T` to a union including `undefined` without revisiting this guard.

## §3: ContextBar Data-Path Audit

**Verdict — CONFIRMED.** Reduction A's cut of the standalone `context_usage` GatewayEvent does not break ContextBar.

Evidence:

1. **ContextBar reads from `sessionsCollection`, not from a WS event subscription** — `apps/orchestrator/src/components/status-bar.tsx:225` calls `useSession(sessionId)`, then line 245 extracts `contextUsage = parseJsonField<ContextUsage>(session?.contextUsageJson ?? null)`. The component renders `<ContextBar contextUsage={contextUsage} />` at line 288. `sessionsCollection` (`apps/orchestrator/src/db/sessions-collection.ts:22-69`) syncs via `agent_sessions` D1 deltas, not via per-event WS frames.

2. **The `result` event already drives ContextBar refresh end-to-end** — `apps/orchestrator/src/features/agent-orch/use-coding-agent.ts:590-594` carries an explicit comment that the client-side `result` handler was deliberately removed under spec #37 B13: "the running → idle transition is now driven by the D1-mirrored `agent_sessions.status` synced-collection delta (written by the DO's `updateState` + `broadcastSessionRow`)." The DO's `case 'result':` (`session-do.ts:5062-5192`) calls `syncResultToD1()` → `broadcastSessionRow()`. So when Reduction A folds `context_usage` into the result payload, the existing DO `result` handler can write `contextUsageJson` into `agent_sessions` and the synced-collection delta carries it to ContextBar — no UI hook change needed.

3. **Standalone `context_usage` event has exactly one client consumer** — `apps/orchestrator/src/features/agent-orch/use-coding-agent.ts:572-574` invalidates `['sessions']` on `event.type === 'context_usage'`. This branch deletes cleanly under Reduction A; the synced-delta path supersedes it.

4. **DO REST endpoint at `session-do.ts:693-698` (`GET /context-usage`) has zero callsites in `apps/orchestrator/src`** — `getContextUsage` is admin/debug-only, consistent with the spec's "endpoint stays" note.

**Implication for P3 (Reduction A):** The DO's `case 'result':` handler (`session-do.ts:5062-5192`) must be extended in P3 to read `event.context_usage` (when present) and trigger the existing 5s-debounced D1-write at `session-do.ts:2576-2599`. No new wiring; just point the existing debounce at the new source.

## §4: Empirical Items Deferred to Live Trace

The following P0 spike items require running infrastructure (live SDK + Anthropic API + injected failures) and **were not run in this spike pass**. Each is documented with a contingency-path decision so P1+ implementation can proceed without blocking on the live capture.

### 4.1 Auto-compact trace (200K-token paste)

**Status:** Deferred. Static type capture (§1.2, §1.4) is sufficient to lock the contract: `SDKStatusMessage{status:'compacting'}` and `SDKCompactBoundaryMessage` are distinct types in `sdk.d.ts@0.2.98` and emission order is asserted by the SDK's internal `notifySessionStateChanged` semantics (the JSDoc at `$SDK:2722` describes 'idle' as the post-flush turn-over signal, implying compact intervals show up as a `status=compacting` window inside or alongside a turn).

**Wire-enum decision (B1 contract lock):** The wire enum stays as the spec defined: `'idle' | 'running' | 'requires_action' | 'compacting' | 'api_retry'`. The runner translates `SDKStatusMessage{status:'compacting'}` → `session_state_changed{state:'compacting'}` and `SDKStatusMessage{status:null}` → no-op (the next `SDKSessionStateChangedMessage` will reassert authoritative state). **Contingency from spec line 25 does NOT trigger** — `SDKStatusMessage{status:'compacting'}` is confirmed present in the SDK type defs.

**To run later (optional, post-merge confidence):**
```bash
# In a worktree with dev gateway up:
wrangler tail --format json | grep -E 'compact|state_changed|status_message|api_retry' \
  > /tmp/compact-trace.jsonl
# Drive a session past auto-compact threshold; capture the trace order.
```

### 4.2 `SDKAPIRetryMessage` shape capture (529 injection)

**Status:** Deferred for live capture, but **NOT BLOCKING** — §1.3 captured the static shape verbatim from `sdk.d.ts`. Live capture would only confirm runtime field population, which is implicit in the type contract.

**Material spec drift surfaced (§1.3):**

- Field name: SDK is `error: SDKAssistantMessageError`, **not** `error_class`.
- Enum values: SDK has 7 values (`'authentication_failed' | 'billing_error' | 'rate_limit' | 'invalid_request' | 'server_error' | 'unknown' | 'max_output_tokens'`). Spec listed 4. The spec's claimed `'overloaded'` is **absent**; four SDK-present values are **unmentioned** in the spec.
- Field naming: `max_retries` (not `max_attempts`); `retry_delay_ms` (not `delay_ms`); plus `error_status: number | null`.

**Contingency / decision for P4 (Reduction D, P1.5 task):** Update the spec's `ApiRetryEvent` shape **before** P4 lands. Recommended `ApiRetryEvent`:

```typescript
interface ApiRetryEvent {
  type: 'api_retry'
  session_id: string
  seq: number
  attempt: number
  max_retries: number          // was max_attempts in spec — match SDK
  retry_delay_ms: number       // was delay_ms in spec — match SDK
  error_status: number | null  // NEW per SDK; HTTP code (529 → 529, connection drop → null)
  error: SDKAssistantMessageError | 'unknown'
                               // was error_class with 4 values — full SDK enum + 'unknown' fallback
                               // (NB: 'unknown' is already in the SDK enum; the explicit '| unknown'
                               //  is for forward-compat against future SDK enum widening)
  ts: number
}
```

The `mapErrorClass()` helper in P4 collapses to a single-line passthrough plus a coalescing fallback for new SDK values (warn-log on unmapped, emit as `'unknown'`):

```typescript
const KNOWN: ReadonlySet<SDKAssistantMessageError> = new Set([
  'authentication_failed', 'billing_error', 'rate_limit', 'invalid_request',
  'server_error', 'unknown', 'max_output_tokens',
])
function mapError(input: string): SDKAssistantMessageError | 'unknown' {
  if (KNOWN.has(input as SDKAssistantMessageError)) return input as SDKAssistantMessageError
  // Forward-compat: SDK enum widened — log and degrade to 'unknown'.
  return 'unknown'
}
```

**Action item:** Before opening the P4 PR, update spec `102-sdk-peelback.md` §B12 / phase p4 task list to reflect the corrected field names and enum. Flagged in `## §5` below.

### 4.3 `reloadPlugins()` state-change check

**Status:** Deferred. Marked `[uncertain]` in the umbrella research and is not load-bearing for any reduction in this spec — the gate behind "does `session_state_changed` fire on plugin reload?" affects only diagnostic completeness, not the cut/keep decision for any wire frame in P1–P4. **No contingency needed**; document the open question and move on.

### 4.4 `Query.interrupt()` survival on a lifetime async iterable (live)

**Status:** Static side pinned in §1.5 (JSDoc + interface contract); queue-side pinned by unit test #6 (§2). The remaining unverified surface is the SDK CLI bridge between `interrupt()` and the prompt iterable.

**Decision:** Proceed with Reduction B's design. Risk-reduction step is to add an integration smoke at the top of P2 (claude-runner refactor): a `vitest` integration test that calls `query({prompt: pushPullQueue, options: {...}})` against a recorded transport mock with a small canned message stream, asserts that `q.interrupt()` mid-stream lets the next pushed message land in the same Query iteration. If that test fails when wired against the real SDK CLI, **escalate immediately** per spec line 260 ("Reduction B's design is wrong"). The fallback design — one Query per push, today's pattern but cleaner — is documented in spec line 260.

### 4.5 ContextBar live-render check

**Status:** Static audit in §3 is sufficient. No live capture needed; the data-path is fully explained by the file:line citations.

## §5: Spec Drift to Patch Before P1+ Lands

Two items must be patched in the spec before the corresponding phase opens its PR. Both are localised — neither invalidates the spec's plan, only the surface details:

1. **`ApiRetryEvent` shape (B12 / phase p4 / kata task #6).** Update field names to match SDK (`max_retries`, `retry_delay_ms`, add `error_status`), rename `error_class` → `error`, and replace the 4-value enum with the verbatim 7-value `SDKAssistantMessageError` plus a forward-compat `'unknown'` fallback. Recommended replacement is in §4.2 above. **Owner: whoever opens the P4 PR; do this as the first commit on that branch.**

2. **Phase-p1 task wording for `SDKAPIRetryMessage` translation (B1 plumbing).** Spec phase p1 task lists "Add `SDKAPIRetryMessage` translation — emit a `session_state_changed` with `state: 'api_retry'` plus the api_retry payload (covered by Reduction D's dedicated event; this entry covers the liveness signal only)." That stays correct as a liveness signal; just note that the concurrent P4 dedicated event must use the corrected field names, not the spec's drafted `error_class`.

No structural-spec rework needed. All four reductions (A/B/C/D) and the LoC-delete budget are unchanged by the drift findings.

## §6: B1 Wire-Enum — Final Lock

The wire enum on `SessionStateChangedEvent.state` is locked at:

```typescript
type SessionStateChangedState =
  | 'idle'             // from SDKSessionStateChangedMessage.state
  | 'running'          // from SDKSessionStateChangedMessage.state
  | 'requires_action'  // from SDKSessionStateChangedMessage.state
  | 'compacting'       // synthesised from SDKStatusMessage{status:'compacting'}
  | 'api_retry'        // synthesised from SDKAPIRetryMessage arrival (mirrors Reduction D's dedicated event for liveness)
```

Translation rules (claude-runner.ts processQueryMessages):
- `SDKSessionStateChangedMessage` → emit `{state: msg.state}` 1:1.
- `SDKStatusMessage` with `status === 'compacting'` → emit `{state: 'compacting'}`.
- `SDKStatusMessage` with `status === null` → no `session_state_changed` emit (the SDK's next `SDKSessionStateChangedMessage` reasserts authority).
- `SDKAPIRetryMessage` → emit `{state: 'api_retry'}` for liveness AND emit the dedicated `api_retry` event (Reduction D).

This locks the contract. P1 (Reduction C) implementation can proceed.

---

## P0 Spike — Done

- §1 complete (4 SDK type captures + `Query.interrupt` JSDoc).
- §2 complete (PushPullQueue + 6 unit tests, all green; queue-side interrupt contract pinned).
- §3 complete (ContextBar data path audited, CONFIRMED).
- §4 documents what was deferred to live trace and what was unblocked statically.
- §5 flags two spec patches needed before P4 opens its PR.
- §6 locks the B1 wire-enum.

Phases P1–P4 are unblocked. The contract is locked for B1 (§6); shape-corrections for B12 are queued for the P4 PR (§5).
