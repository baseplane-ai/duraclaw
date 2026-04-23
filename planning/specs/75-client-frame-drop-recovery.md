---
initiative: client-frame-drop-recovery
type: project
issue_type: feature
status: draft
priority: high
github_issue: 75
created: 2026-04-23
updated: 2026-04-23
phases:
  - id: p1
    name: "Client-side seq-gap detection + targeted requestSnapshot"
    tasks:
      - "Add lastSeq ref keyed by agentName in use-coding-agent.ts; advance on monotonic non-targeted deltas"
      - "Add optional `targeted?: boolean` wire field to SyncedCollectionFrame in packages/shared-types/src/index.ts (new field — does NOT overload existing `snapshot?: boolean` which has implicit-delete semantics)"
      - "DO broadcastMessages stamps `targeted: true` on every frame with targetClientId (session-do.ts:1945-1954 currently gates only messageSeq advancement; extend to also set the flag). Applies to both cursor-replay (replayMessagesFromCursor:1892) and requestSnapshot replies"
      - "Client dispatcher: on `targeted === true`, bypass gap-check, apply ops, install lastSeq = max(lastSeq, messageSeq). Handles both full-snapshot reply and cursor-replay chunks uniformly"
      - "Client dispatcher: on `!targeted && messageSeq > lastSeq+1`, call requestSnapshot({ targetClientId }) RPC; pass PartySocket connection.id. Dedupe in-flight: at most one outstanding call per session"
      - "Client dispatcher: on `!targeted && messageSeq <= lastSeq`, drop silently (already applied); DEV-only logDelta trace"
      - "Extend DO requestSnapshot @callable to accept optional targetClientId and forward to broadcastMessages({...}, { targetClientId }) + broadcastBranchInfo({...}, { targetClientId })"
      - "Treat BufferedChannel gap sentinel frames ({type:'gap'}) forwarded from runner → DO → client as synthetic gap triggers. Verify/add DO relay path for the runner's {type:'gap'} frame shape if not already present"
      - "Rewrite SyncedCollectionFrame.messageSeq JSDoc in packages/shared-types/src/index.ts to document it as the reconcile knob (clients MUST track lastSeq per session; MUST call requestSnapshot on non-targeted gap); remove 'observability only, clients MUST NOT gate on it' language"
    test_cases:
      - "Unit: deliver frames seq=1,2,4,5 (non-targeted) to messagesCollection — assert requestSnapshot RPC is called exactly once after seq=4 arrives, and ops from seq=4,5 do NOT apply until the targeted snapshot frame resets lastSeq"
      - "Unit: deliver frames seq=1,2,3 (non-targeted) then replayed seq=2,3 — assert the stale frames are dropped (no begin/write/commit on messagesCollection)"
      - "Unit: deliver cursor-replay frame with targeted=true, messageSeq=5 to a client at lastSeq=3 — assert ops DO apply, lastSeq advances to 5 (not dropped by watermark)"
      - "Unit: deliver snapshot frame with targeted=true, messageSeq=20 to a client at lastSeq=3 — assert ops DO apply, lastSeq becomes 20"
      - "Unit: fire two back-to-back gap detects within 10ms — assert exactly one requestSnapshot RPC is issued (dedupe)"
      - "Unit: cold-start — client at lastSeq=0 receives first non-targeted frame with messageSeq=5 (DO rehydrated with persisted seq from prior hibernation) — assert requestSnapshot fires (happy path for hibernation wake)"
      - "Unit: GapSentinel frame {type:'gap', from_seq, to_seq} arrives on the session WS — assert requestSnapshot RPC is called"
      - "Unit: DO requestSnapshot({ targetClientId: 'c1' }) — assert the emitted SyncedCollectionFrame has `targeted: true` and is delivered only to conn id 'c1', not broadcast to the full connection set"
  - id: p2
    name: "Observability + result-handler ordering"
    tasks:
      - "In broadcastToClients (session-do.ts:1642-1652), replace empty catch with console.warn that logs sessionId, conn.id, frame type (best-effort JSON.parse of data; 'unparseable' fallback), and current messageSeq"
      - "In the result handler case ('result' at session-do.ts:4506-4626), reorder so every broadcastMessage/broadcastMessages call that emits a final-turn frame completes synchronously BEFORE the updateState({status:'idle', ...}) call and the downstream syncStatusToD1 / syncResultToD1 / flushLastEventTsToD1 calls. Because CF/PartyKit conn.send() is synchronous (either throws or enqueues on the per-socket send queue), this is a microtask-ordering / source-ordering fix, not a Promise-await change — no new awaitable surface on broadcastMessage is required"
    test_cases:
      - "Unit: stub a connection where conn.send throws — assert broadcastToClients emits a console.warn containing sessionId, conn.id, and the frame type (not empty silence). Assert the loop continues to the next conn (one bad socket does not abort the broadcast)"
      - "Unit: result handler test — spy on updateState and broadcastMessage in call-order; assert every broadcastMessage invocation for final-turn frames precedes updateState({status:'idle'}) in the spy's call log. Valid ordering proof without needing Promise-await semantics"
  - id: p3
    name: "Persist BufferedChannel gap sentinel across process restart"
    tasks:
      - "Persist pendingGap to `${metaFile}.gap` sidecar on every recordDrop — reuse metaFile path (`/run/duraclaw/sessions/<id>.meta.json.gap`) consistent with existing exit/log/pid conventions"
      - "Writer MUST use the existing atomicOverwrite helper in packages/session-runner (write-to-tmp + fs.rename) — raw fs.writeFile is forbidden because it can produce torn state under runner crash"
      - "BufferedChannel gains optional `persistGap: (gap: GapSentinel | null) => Promise<void>` constructor option. On recordDrop, invoke persistGap(this.pendingGap). On attachWebSocket after successful sentinel send, invoke persistGap(null) to signal clear"
      - "session-runner/main.ts wires persistGap to atomicOverwrite(`${argv.metaFile}.gap`, …) and unlink on clear"
      - "On runner startup (before BufferedChannel construction), read `${argv.metaFile}.gap` if present; parse as GapSentinel; pass as initialPendingGap to the channel"
      - "Gateway reaper: extend the terminal-GC sweep (packages/agent-gateway/src/server.ts reaper path) to also unlink `.gap` sidecars in the same one-shot unlink batch as .exit + .log + .meta.json + .pid + .cmd"
    test_cases:
      - "Unit: BufferedChannel with persister callback — overflow triggers write to a test file; simulate re-construction with the same file path and assert pendingGap is rehydrated"
      - "Integration (runner): spawn a runner with a pre-populated .gap sidecar, attach a fake WS — assert the gap sentinel is sent on the first WS open before any other frame"
      - "Integration (gateway reaper): place a terminal .exit + .log + .gap triplet older than the GC threshold and assert all three are unlinked atomically"
  - id: p4
    name: "Verification"
    tasks:
      - "Full pnpm test run — no regressions in session-do, use-coding-agent, buffered-channel, or runner suites"
      - "Manual web verify via scripts/axi: simulate a dropped delta via DEV eval, confirm UI self-heals without tab switch"
      - "Manual mobile verify on the Tailscale Pixel: tail Capacitor/Console for '[cm] gap detected' + 'requestSnapshot' log lines during a long turn"
    test_cases:
      - "Regression: existing use-coding-agent.test.ts 'Gap detection' describe block — unskip if skipped and confirm green"
      - "Regression: session-do result-handler tests still pass with the new await-ordering"
      - "Regression: buffered-channel overflow + reattach tests still pass after the persister hook is added"
---

# Spec 75: Client-side frame-drop recovery (seq-gap + result ordering + sentinel persistence)

> GitHub Issue: [#75](https://github.com/baseplane-ai/duraclaw/issues/75)

## Summary

The orchestrator's live message stream has a self-healing protocol on the
DO side — every broadcast is stamped with a monotonic `messageSeq`
(`session-do.ts:1918-1953`), persisted across hibernation, and a full-
history `requestSnapshot()` RPC exists at `session-do.ts:4171-4192`. The
client never invokes it. Any frame dropped in transit (BufferedChannel
overflow + WS drop, `broadcastToClients` silent swallow on a half-closed
socket, CF-level frame loss) leaves the UI stale until a reconnect
triggers cursor-replay from SQL.

The `ask_user` case was already patched in `064053f` / `e21c78b` by
rendering directly off SDK-native tool shapes. Every other single-
broadcast-ride state transition is still vulnerable — permission gates,
tool-result flips, resumed-session replays, and the `result`-handler
status transition that races the final assistant delta.

This spec ships the client-side reconcile protocol the DO has been waiting
for, plus two supporting defense-in-depth fixes: observability on the
DO's silent-drop path, and await-ordering in the `result` handler so
`status=idle` never overtakes the final message delta. It also persists
the `BufferedChannel` gap sentinel so a runner crash between overflow and
WS reattach doesn't lose the signal that would trigger the snapshot.

Keepalive is **explicitly excluded**: once gap detection ships, any close
(CF idle or otherwise) self-heals on reconnect via `subscribe:messages`
cursor-replay + `lastSeq` watermark. Adding an app-level ping would fight
the network rather than design for loss.

## Root cause / failure model

1. Runner emits a delta. BufferedChannel stamps `seq = N+1`.
2. Frame is lost on one of three known paths:
   - BufferedChannel overflow + WS drop before reattach — `pendingGap` is
     in-memory only (`buffered-channel.ts:48`, `:163-183`) and lost with
     the process.
   - DO `broadcastToClients` silent-drop on a half-closed socket
     (`session-do.ts:1642-1652`) — empty `catch {}`, no log, no retry.
   - Any wire-level loss (CF edge reset, mobile radio handoff, etc.).
3. Client has no seq check. `messagesCollection` at
   `db/messages-collection.ts:95-127` applies every frame in arrival
   order; the UI holds the stale partial.
4. Runner emits `result`. DO writes the final `assistant` row to SQL,
   broadcasts the (possibly lost) final delta, then flips status via
   `updateState({status:'idle'})` on a separate logical frame with no
   awaited ordering.
5. Client sees `status=idle` while its `messagesCollection` is still at
   the pre-final partial. UI renders an idle session with truncated text.
6. **Refresh** pulls from SQL and everything snaps into place — proof the
   persistence layer is correct; the live delta path is the failing link.

## Behaviors

### B1 — Per-session lastSeq watermark

**Where:** `apps/orchestrator/src/features/agent-orch/use-coding-agent.ts`.

**Shape:** `const lastSeqRef = useRef<Map<string, number>>(new Map())`,
keyed by `agentName`. Initialised to `0` for a session on first delivery.

**Acceptance:**
- On `{type:'synced-collection-delta'}` whose `collection === 'messages:<agentName>'`:
  - **Targeted frame** (`frame.targeted === true`): bypass gap-check. Apply ops via the existing `dispatchSessionFrame` path. Install `lastSeq = max(lastSeq, messageSeq)`. This covers both cursor-replay chunks (`replayMessagesFromCursor` at `session-do.ts:1892`) and the full-history snapshot reply (`requestSnapshot`), uniformly.
  - **Non-targeted frame, `messageSeq === lastSeq + 1`**: happy path. Apply and set `lastSeq = messageSeq`.
  - **Non-targeted frame, `messageSeq > lastSeq + 1`**: gap detected. Do **not** apply. Schedule `requestSnapshot({ targetClientId })` via B2. Holds queued ops in a per-session scratch buffer keyed by `messageSeq` so they can be discarded on snapshot arrival (snapshot's lastSeq supersedes them).
  - **Non-targeted frame, `messageSeq <= lastSeq`**: drop (already applied); DEV-only `logDelta` trace.
- `lastSeq` is scoped per-session — tab switches don't reset it (the OPFS-backed collection is retained across tab switches).
- `lastSeq` survives WS reconnect; cursor-replay on reconnect advances it via the targeted path above.
- **Cold-start happy path:** a fresh client reconnecting to a DO whose persisted `messageSeq` is N>0 sees its first non-targeted frame with `messageSeq = N+1`, which looks like a gap against `lastSeq=0`. This is intentional — the first cursor-replay or snapshot after `subscribe:messages` arrives `targeted: true` and installs `lastSeq` to the current DO value. Subsequent live deltas then proceed on the normal `+1` chain.

### B2 — Targeted requestSnapshot RPC

**Where:** `apps/orchestrator/src/agents/session-do.ts` @callable surface
at `:4171-4192`; client call site in `use-coding-agent.ts`.

**Shape:** `requestSnapshot({ targetClientId?: string })`. Argument is
optional for backward compat (omitting keeps today's broadcast behavior,
useful for DO-initiated snapshots). Client always passes
`connection.id` from the PartySocket.

**Acceptance:**
- DO `requestSnapshot` forwards `targetClientId` to `broadcastMessages({ ops }, { targetClientId })` and `broadcastBranchInfo({...}, { targetClientId })`. Existing broadcast plumbing (`session-do.ts:1945-1961`) is reused — no new send path.
- `broadcastMessages` is extended: when `targetClientId` is set, the emitted `SyncedCollectionFrame` carries `targeted: true`. `this.messageSeq` is still echoed (current value, no advancement — preserves the invariant that targeted sends don't desync peers, already documented at `:1913-1917`).
- Client dedupes in-flight snapshot requests per session: at most one outstanding call. Additional gap detections during an in-flight request are no-ops — the pending snapshot will resolve them. Dedupe key: `agentName`; lifecycle: set on RPC invoke, clear on snapshot-frame arrival or RPC-error.
- **Trust boundary on spoofed `targetClientId`:** accepted risk. Any client passing another user's conn id receives a snapshot of *this same session's history* delivered to a conn that is already a member of this DO's connection set — the recipient is authenticated into the same session and already subscribed to the same message stream. There is no cross-session or cross-user data exfiltration path. Worst case is a self-DoS: an attacker triggers repeated snapshots targeted at their own peers, wasting DO bandwidth. Rate-limit is not in scope for this spec.

### B3 — Targeted frame path (snapshot + cursor-replay)

**Where:** Frame dispatch path inside `use-coding-agent.ts` /
`messagesCollection` sync handler.

**Acceptance:**
- A `SyncedCollectionFrame` with `targeted: true` bypasses the watermark gap-check per B1 and applies directly via the existing `begin/write/commit` loop. TanStack DB's deep-equals loopback absorbs rows the collection already had — no row churn on overlap.
- After applying, install `lastSeq = max(lastSeq, messageSeq)`. Using `max` protects against out-of-order arrival of a cursor-replay chunk and a subsequent live delta.
- `branchInfo` snapshot delivered alongside (existing behavior, see `session-do.ts:4189-4190`) refreshes sibling branch state. `broadcastBranchInfo` also honors `targetClientId` per B2 so the branch frame is targeted in lockstep with the messages frame.
- **No reliance on `SyncedCollectionFrame.snapshot`** — that flag's existing semantics at `shared-types/src/index.ts:770-778` imply implicit deletes for keys not present in the frame, which is wrong for cursor-replay chunks (chunked by LIMIT 500 — see `session-do.ts:1895`). The new `targeted: true` flag is orthogonal to `snapshot` and has no implicit-delete semantic.

### B4 — Gap sentinel is a gap trigger

**Where:** Session-WS handler in `use-coding-agent.ts`.

**Shape:** The BufferedChannel `GapSentinel` frame (`{type:'gap',
dropped_count, from_seq, to_seq}`) is forwarded over the runner→DO WS
and relayed by the DO. On the client it's a synthetic gap signal.

**Acceptance:**
- On `{type:'gap'}` frame: treat identically to "messageSeq > lastSeq + 1" — fire `requestSnapshot({ targetClientId })`. Do **not** try to apply the sentinel's numeric range (the runner's seq and the DO's messageSeq are different namespaces; the snapshot is the only safe rehydration).

### B5 — Wire type: add `targeted` + upgrade `messageSeq` contract

**Where:** `packages/shared-types/src/index.ts:769-787` (SyncedCollectionFrame).

**Acceptance:**
- Add new optional field `targeted?: boolean`. JSDoc describes it as "Set by the DO on every frame emitted to a single `targetClientId`. Clients MUST bypass `lastSeq` gap-gating on targeted frames and install `lastSeq = max(lastSeq, messageSeq)` after applying."
- `messageSeq` JSDoc rewritten: old language "observability only, clients MUST NOT gate on it" removed. New language: "Per-stream monotonic seq stamped by the DO in `broadcastMessages` for non-targeted frames. Advances monotonically on every non-targeted send; echoed (unchanged) on targeted sends. Clients MUST track `lastSeq` per session and request a snapshot on non-targeted gap."
- Wire shape: `messageSeq` unchanged (already present); `targeted` is a new optional field — older servers never emit it, older clients never read it, neither side breaks.
- **Compat analysis for the mobile OTA channel:** older web bundles in R2 continue to receive the new `targeted` field as an ignored key (they have no reader for it) and continue to receive `messageSeq` the same way (they have no reader). They simply don't benefit from B1-B4 until they refresh the bundle. No runtime break on either side of the version skew.

### B6 — broadcastToClients silent-drop is logged

**Where:** `apps/orchestrator/src/agents/session-do.ts:1642-1652`.

**Acceptance:**
- On `conn.send()` throw: `console.warn` with `sessionId=${this.name}`, `connId=${conn.id}`, `frameType=<parsed from data>`, `messageSeq=${this.messageSeq}`. Best-effort frameType parse — if `JSON.parse` throws, log `frameType=<unparseable>`.
- No queue, no retry. Recovery is via B1–B4 on next delta or reconnect.

### B7 — Result handler: source-order message broadcasts before status flip

**Where:** `apps/orchestrator/src/agents/session-do.ts:4506-4626` (the
`case 'result':` branch).

**Acceptance:**
- CF/PartyKit `conn.send()` is synchronous: it either throws (caught and logged per B6) or enqueues the frame on the per-socket send queue. There is no Promise on the send path. "Ordering" here is therefore **source ordering** — the JS statements that invoke `broadcastMessage` / `broadcastMessages` must appear textually (and execute) before the statement that invokes `updateState({status:'idle', …})` and the downstream `syncStatusToD1` / `syncResultToD1` / `flushLastEventTsToD1`.
- Because CF preserves per-socket send order, frames enqueued first arrive at the client first. The fix is purely reordering within the `case 'result':` block — no new Promise-awaitable surface on `broadcastMessage` is required.
- Subpoints:
  - The orphaned-streaming-parts finalization broadcast (current `session-do.ts:4513`) stays where it is — already first.
  - The `is_error` system-message broadcast (`:4530`) and the result-text promotion broadcast (`:4550` / `:4561`) stay where they are — also before the `updateState` call at `:4573`.
  - Current code already has the correct source ordering for message broadcasts vs `updateState`. The spec's real change is ensuring the `syncStatusToD1` / `syncResultToD1` / `flushLastEventTsToD1` calls at `:4586-4590` do not fire until after the broadcast source-lines above. Re-verify by reading the ordering in the final diff; if already correct, the B7 code change is a no-op and the test case in P2 frontmatter becomes a regression guard against future reordering.
- No wire-shape change.

### B8 — Gap sentinel sidecar persistence

**Where:** `packages/shared-transport/src/buffered-channel.ts` +
`packages/session-runner/src/main.ts`.

**Shape:** Sidecar file `${metaFile}.gap` (e.g.
`/run/duraclaw/sessions/<id>.meta.json.gap`).

**Acceptance:**
- `BufferedChannel` gains an optional `persistGap: (gap: GapSentinel | null) => Promise<void>` option. On every `recordDrop`, invoke `persistGap(this.pendingGap)`. On `attachWebSocket` after successful sentinel send, invoke `persistGap(null)` to clear.
- `session-runner/main.ts` wires `persistGap` to atomically write `${argv.metaFile}.gap` (via the existing `atomicOverwrite` helper) and unlink on clear.
- Runner startup (before `BufferedChannel` construction): read `${argv.metaFile}.gap` if present; pass the parsed GapSentinel as `initialPendingGap` to the channel.
- Gateway reaper (`packages/agent-gateway/src/server.ts`) extends its terminal-GC sweep to also unlink `.gap` sidecars when cleaning up `.exit` + `.log` pairs past the `>1h past .exit mtime` threshold.

## Phases

See frontmatter for the authoritative phase/task/test-case breakdown. Summary:

- **P1 — Gap detection + targeted snapshot (B1-B5).** Headline client
  work, ~1 day. Fixes the reported symptoms.
- **P2 — Observability + result ordering (B6, B7).** Additive, no wire
  change.
- **P3 — Gap sentinel persistence (B8).** Only matters once P1 is
  live; covers the runner-crash-between-overflow-and-reattach edge.
- **P4 — Verification.** Full test run + manual web/mobile smoke.

All four phases ship in a single PR (no incremental merges per
`initiative` decision — the items are cohesive and reviewers want to see
the end-to-end picture).

## Verification plan

1. **Unit green.** `pnpm --filter @duraclaw/orchestrator test`,
   `pnpm --filter @duraclaw/shared-transport test`, and
   `pnpm --filter @duraclaw/session-runner test` all pass with the new
   test cases from each phase's frontmatter.
2. **Gap-drop simulation (web).** Via `scripts/axi eval` during a long
   turn:
   - Capture current `lastSeq` via
     `window.__lastSeq?.get('<agentName>')` (expose in DEV).
   - Monkeypatch the frame dispatcher to drop one mid-turn delta.
   - Assert `requestSnapshot` is called and `messagesCollection` settles
     to the full turn without tab-switch.
3. **Result ordering (integration).** Use the existing session-do
   handler tests (`apps/orchestrator/src/agents/session-do.test.ts` or
   equivalent) with an artificially slow mock broadcast; assert
   `updateState({status:'idle'})` is not invoked until after the
   broadcast's Promise resolves.
4. **Silent-drop log (unit).** Construct a fake connection whose `send`
   throws; call `broadcastToClients` with a known payload; assert a
   `console.warn` containing sessionId, connId, and frameType.
5. **Sentinel persistence (integration).** Runner harness: write a
   `.gap` sidecar pre-spawn, launch the runner pointing at the same
   metaFile path, attach a fake WS, assert the sentinel is the first
   frame received on the wire.
6. **Manual mobile.** Sideload to the Tailscale Pixel (see CLAUDE.md
   logcat section). Run a long turn with network flapping via
   airplane-mode toggles; `Capacitor/Console` should show `[ws:session:*]
   close → open` pairs followed by `requestSnapshot` lines, and the UI
   should never show an "idle + truncated text" terminal state.

## Out of scope

- **Keepalive / app-level ping.** Gap detection + cursor-replay subsumes
  the need. Re-introducing a ~30s ping regresses spec-#50's removal for
  no observed benefit.
- **Permission-gate synthesis rework.** No SDK-native counterpart;
  separate, deeper change.
- **OPFS cache retention / eviction rules.** Orthogonal — refresh already
  works; this spec targets the live-path recovery.
- **Runner seq assignment changes.** Already sequential by construction.
- **Upgrading `@callable` to surface caller conn id.** We opted for
  "client passes its own connection.id as an RPC arg" instead (see B2).
  SDK-surface upgrade stays as a possible future cleanup.
- **ConnectionManager changes.** The manager already triggers reconnect
  on foreground/online; `onOpen` in `use-coding-agent.ts` already fires
  `subscribe:messages`. No additional hooks needed.

## References

- Audit: `planning/research/2026-04-23-streaming-incomplete-messages-cursor-audit.md`
- Prior art (status drift): `planning/specs/69-session-state-hibernation-drift.md`, `planning/research/2026-04-22-gh69-session-state-drift.md`
- DO broadcast + snapshot surface: `apps/orchestrator/src/agents/session-do.ts:1642, 1918-1959, 4171-4192, 4506-4626`
- Client dispatch: `apps/orchestrator/src/db/messages-collection.ts:95-127`, `apps/orchestrator/src/features/agent-orch/use-coding-agent.ts:385-416, 608-624`
- Wire type: `packages/shared-types/src/index.ts:779-786`
- BufferedChannel: `packages/shared-transport/src/buffered-channel.ts`
- Runner state files: `packages/session-runner/src/main.ts:37-64, 370-450`
- Already-shipped ask_user fix (context, not part of this spec): `064053f`, `e21c78b`

## Open questions

- None blocking. Trust boundary on targetClientId spoofing is accepted
  (B2 acceptance). `@callable` surface upgrade deferred.
