---
date: 2026-04-22
topic: SessionDO agents SDK to partyserver migration feasibility
type: feasibility
status: complete
github_issue: 61
items_researched: 5
---

# Research: SessionDO agents SDK to partyserver migration feasibility

## Context

Issue #61 proposes migrating `SessionDO` from `extends Agent` (agents SDK) to
`extends Server` (partyserver) to fix a ~1ms WS close-loop (code 1006) in
prod. The hypothesis: suppressing `shouldSendProtocolMessages() => false`
breaks the `useAgent` client hook, which expects `CF_AGENT_IDENTITY` /
`CF_AGENT_STATE` frames.

This research validates that hypothesis and assesses the full migration
feasibility by mapping the SDK coupling surface, PartyServer parity gaps,
client-side migration path, 1006 root cause, and migration risks.

## Scope

**Items researched:**

1. Current SessionDO SDK surface (every Agent base class interaction)
2. PartyServer `Server` class parity vs `Agent`
3. Client-side `useAgent` to `usePartySocket` migration path
4. 1006 close-loop root cause hypothesis validation
5. Migration risks: wrangler config, tests, runner transport, auth, alarms

**Sources:** `session-do.ts` (4289 lines), `use-coding-agent.ts` (953 lines),
`agents` SDK source, `partyserver` source, existing PartyServer DOs
(`UserSettingsDO`, `SessionCollabDO`), wrangler.toml, test files, specs #31/#37.

## Findings

### 1. SessionDO SDK coupling is deep, not superficial

Issue #61 frames the SDK as "dead weight" with every feature suppressed.
The research shows otherwise:

| SDK Feature | Issue #61 claim | Actual usage |
|---|---|---|
| `this.state` / `setState` | "Suppressed" | **54+ read sites**, `updateState()` wrapper calls `setState` + persists to SQLite |
| `this.sql<T>` template | Not mentioned | **40+ usages** of typed template SQL queries |
| `@callable` decorator | "Thin wrapper" | **18 RPC methods**, ~800 LoC, auto-serialization, type routing |
| `Session` class | Not mentioned | **Core dependency** for all message persistence (assistant_messages table) |
| `this.getConnections()` | Not mentioned | **5+ broadcast loops** iterating all browser WS |
| `shouldSendProtocolMessages` | "Suppressed" | Correctly suppressed, but this is 1 of 200+ SDK interactions |
| `this.name` | Not mentioned | **35+ usages** as session ID |
| `onStart` lifecycle | Not mentioned | Full rehydration: migrations, state recovery, Session init, turn counter |

**Total SDK API call sites: ~200+** across state management, SQL, connections,
RPC dispatch, and message persistence.

### 2. PartyServer `Server` class has structural gaps

| Capability | Agent | Server | Gap severity |
|---|---|---|---|
| Typed SQL `this.sql<T>` | Yes | No (raw `ctx.storage.sql.exec`) | Moderate — lose type safety |
| `@callable` RPC dispatch | Yes (18 methods) | No | **Severe** — ~200-300 LoC custom dispatcher |
| Server-wide state `this.state` | Yes (generic `<State>`) | No (per-connection only) | **Severe** — custom state container |
| `Session` message store | Yes (`agents/experimental/memory`) | No | **BLOCKER** — no replacement exists |
| `schedule()` / alarm wrapper | Yes | No (raw `setAlarm`) | Moderate — rewrite watchdog |
| Hibernation | Yes | Yes (same) | None |
| `this.env` typed | Yes | Yes (same) | None |
| `this.ctx` / DO platform | Yes | Yes (same) | None |

The existing PartyServer DOs in this codebase (`UserSettingsDO` at 96 lines,
`SessionCollabDO` at 56 lines) are trivially simple — no RPC, no state hooks,
no Session class. SessionDO at 4289 lines is a different beast.

### 3. Client-side migration is feasible but non-trivial

`use-coding-agent.ts` uses `useAgent` (L339-354) which returns a connection
with `.call(method, args)` for RPC and `.send()` for raw frames. The hook
makes **15 distinct `connection.call()` invocations** across spawn, sendMessage,
resolveGate, rewind, resubmitMessage, getBranchHistory, and 9 other methods.

A `usePartySocket` replacement would need:
- Custom RPC wrapper: request/response correlation with promise-per-id (~100 LoC)
- Same readyState mirror workaround (PartySocket has same mutable-property issue)
- Same ConnectionManager adapter (already substrate-agnostic)

The `readyState` workaround at L449-463 already bypasses the SDK's protocol-
message-driven re-render. The comment at L440-443 explicitly documents why:

> React only re-renders when useAgent's internal setState fires
> (CF_AGENT_IDENTITY / CF_AGENT_STATE receipt), but our SessionDO
> suppresses those protocol messages.

This workaround already compensates for the missing protocol frames — the
client is NOT closing the socket due to missing frames.

### 4. The 1006 close-loop hypothesis is partially wrong

**Issue #61 hypothesis:** Suppressed protocol messages cause `useAgent` to
close/reopen the socket.

**Actual root cause (per codebase evidence):** Error masking in the SDK's
`_tryCatch` wrapper. When an exception occurs in `onConnect` or `onMessage`,
the SDK catches it, calls `this.onError(e)`, and if `onError` returns `void`,
the SDK executes `throw undefined` — which surfaces as a bare close 1006
with no stack trace.

The code documents this explicitly at `session-do.ts:818-820`:

> Without this, any throw inside onConnect / onMessage surfaces on the
> client as a bare close 1006 with no stack in wrangler tail — the cause
> of the session-WS 1ms-flap diagnostic black hole (issue #61).

The `onError` re-throw mitigation was added to give the SDK a real Error
object, but the **source exception** (what throws at ~1ms uptime in
`onConnect`) has not been traced.

**Key insight:** The 1006 flap is a diagnostic masking issue, not a
protocol-frame-expectation issue. The client-side readyState workaround
proves the client handles missing protocol frames fine — PartySocket's
auto-reconnect fires on the 1006 close, and the mirror catches it.

### 5. Migration blockers

**HARD BLOCKERS (3):**

1. **`agents/experimental/memory/Session` class** — manages `assistant_messages`
   and `assistant_config` tables. Every message operation (`getHistory`,
   `appendMessage`, `updateMessage`, `getMessage`, `getPathLength`) goes through
   it. No partyserver equivalent. Rewriting = rebuilding the message persistence
   layer from scratch.

2. **`@callable` RPC dispatch** — 18 decorated methods. PartyServer has no
   decorator-based RPC. Need a custom JSON-RPC dispatcher in `onMessage` that
   correlates request IDs, routes to methods, serializes responses, and handles
   errors. Feasible (~200-300 LoC) but every callsite in the client changes.

3. **DO alarm lifecycle** — SessionDO uses `this.ctx.storage.setAlarm()` with
   an `async alarm()` handler for the watchdog. PartyServer's support for
   `alarm()` pass-through is undocumented. If it doesn't pass through, the
   watchdog (stale connection recovery, auto-reap) breaks.

**Manageable risks:**

- Wrangler migration tag: new v7+ tag needed, but no class rename required
- Tests: ~30 of 3273 lines touch DO internals; mostly helper-function tests
- Auth token validation: pure-function, base-class-agnostic
- Runner transport: DialBackClient connects via raw WS, not SDK-mediated
- `routePartykitRequest`: not currently used for SessionDO

## Comparison

| Approach | Effort | Risk | Fixes 1006? | Decouples from SDK? |
|---|---|---|---|---|
| **A: Full migration to Server** | 3-4 weeks | High (Session class rewrite, 18 RPC methods, state container, alarms) | Maybe (if source exception is SDK-internal) | Yes |
| **B: Fix 1006 directly** | 1-3 days | Low (instrument onConnect, trace the throw) | Yes (targets actual root cause) | No |
| **C: Hybrid — replace @callable only** | 1 week | Moderate (custom RPC dispatcher, keep Agent base) | No (orthogonal) | Partially |
| **D: B + C combined** | 1-2 weeks | Low-moderate | Yes | Partially |

## Recommendations

**1. Do NOT pursue full migration (Approach A).**

The effort/risk ratio is unfavorable. The `Session` class dependency alone
is a multi-week rewrite with regression risk across every message operation.
The benefit — fixing the 1006 flap — doesn't require this approach.

**2. Fix the 1006 flap directly (Approach B, first).**

The research shows the flap is caused by an untraced exception at ~1ms
uptime in `onConnect`/`onMessage`, not by missing protocol frames. Next step:
instrument `onConnectInner` with structured try/catch tracing to capture what
throws. Check `wrangler tail` for the error with the existing `onError`
re-throw in place. If the source is SDK-internal (e.g., protocol frame
generation throws when `shouldSendProtocolMessages` returns false), file
upstream or monkey-patch.

**3. Consider replacing `@callable` with a thin RPC dispatcher (Approach C,
second) if the SDK ceremony is a genuine DX pain point.**

This gets the decoupling benefit from the issue's proposal without the
Session class / state / alarm rewrite. Keep `extends Agent`, keep
`Session`, keep `this.state` — just route RPC manually in `onMessage`
instead of relying on the decorator.

**4. Revisit full migration only if the agents SDK is abandoned upstream.**

If Cloudflare stops maintaining the SDK, migration becomes necessary rather
than optional. At that point, the Session class rewrite is unavoidable.
Until then, the SDK provides substantial value that would be expensive to
replicate.

## Open Questions

1. **What exception throws at ~1ms in `onConnect`?** Needs prod instrumentation
   via `wrangler tail` or additional structured logging in `onConnectInner`.
2. **Is the 1006 reproducible in local miniflare?** If yes, debugging is
   straightforward. If no, it may be edge-network or hibernation-wake specific.
3. **Does the SDK's `_tryCatch` interact with `shouldSendProtocolMessages`?**
   Tracing the SDK's `index.js:1078-1084` may reveal whether protocol message
   suppression itself causes a throw path.
4. **Is `agents/experimental/memory/Session` stable?** Being in `experimental/`
   is a risk signal — if the API changes, SessionDO breaks. This argues for
   eventually building a custom message store regardless of base class.

## Next Steps

1. **Debug issue** — create a focused debug task to trace the 1006 source
   exception (Approach B). This is the highest-value, lowest-risk action.
2. **Update issue #61** — revise scope from "full migration" to "fix 1006 +
   optional @callable decoupling" based on these findings.
3. **If @callable replacement is desired** — spec a thin JSON-RPC dispatcher
   that lives in `onMessage`, routes by method name, and returns response
   envelopes. Client switches from `connection.call()` to a wrapper that
   sends `{type:'rpc', id, method, args}` and awaits `{type:'rpc-response',
   id, result/error}`.
