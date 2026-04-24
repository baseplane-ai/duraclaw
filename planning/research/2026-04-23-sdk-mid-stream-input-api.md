# Claude Agent SDK — mid-stream input API research

**Date:** 2026-04-23
**Mode:** research
**SDK version inspected:** `@anthropic-ai/claude-agent-sdk@0.2.98`
**Tracking:** session-runner mid-stream steering (commit `4fe9ca2`), "inconsistent
results" symptom class (dropped / duplicated / stuck follow-up turns).

## TL;DR

We are running a **hybrid of the two documented input modes** and getting the
failure modes of both. The root cause of the inconsistency is that
`query.streamInput(singleMessageGenerator())` **calls
`transport.endInput()` as soon as the supplied iterable exhausts**, which
half-closes stdin on the CLI subprocess. Every mid-flight steering call
therefore burns the stdin write channel after delivering exactly one message;
subsequent `streamInput` calls write to closed stdin and can silently fail,
reorder, or interleave with the next `query()` spawn.

**The documented "preferred" pattern (Streaming Input Mode) is
one lifetime `query()` call with a lifetime-scoped, manually-enqueued async
iterable as `prompt`.** Our current implementation should be reshaped to
match.

## Classification

Library/API research — evaluating whether our current SDK usage matches the
library's documented contract, and identifying the correct pattern.

## Current state (`packages/session-runner/`)

Per `packages/session-runner/src/claude-runner.ts:721-785` and
`packages/session-runner/src/main.ts:151-180`:

1. **Per-turn query**: each user turn calls `query({ prompt: genOneMessage(), options: { ...options, resume: sdkSessionId } })`. The generator yields exactly one `SDKUserMessage` and returns. Between turns, `queue.waitForNext()` blocks.
2. **Mid-flight steering**: when a `stream-input` GatewayCommand arrives while `ctx.query` is non-null, the runner calls `ctx.query.streamInput(singleMessage())` with `priority: 'now'`, where `singleMessage()` is again a one-shot generator. On throw, it falls back to `ctx.messageQueue.push()`.
3. **Resume glue**: each new turn passes `options.resume = sdkSessionId`, so the CLI subprocess cold-starts from the persisted session JSONL.

## SDK contract (from source + docs)

### Two documented modes

Source: [Streaming Input vs Single Message Input](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode).

| Mode | Shape | Supports |
|------|-------|----------|
| **Streaming Input (recommended)** | `prompt: AsyncIterable<SDKUserMessage>` that stays open for the session lifetime | image attachments, queued follow-ups, real-time interrupt, hooks, `canUseTool`, `setPermissionMode`, dynamic MCP |
| **Single Message** | `prompt: string` + `continue: true` / `resume` | one-shot; no queueing, no interrupt, no hooks |

> "Streaming input mode is the **preferred** way to use the Claude Agent SDK.
> It provides full access to the agent's capabilities and enables rich,
> interactive experiences." — official docs.

The doc's canonical TypeScript example is a lifetime generator passed once to
`query({ prompt })`; the `for await (const message of query(...))` loop drains
responses while the generator yields new user turns on demand.

### What `query.streamInput` actually does

From the installed 0.2.98 `sdk.mjs` (deobfuscated, annotations added):

```js
async streamInput(stream) {
  try {
    let count = 0
    for await (const msg of stream) {
      count++
      if (this.abortController?.signal.aborted) break
      await this.transport.write(JSON.stringify(msg) + '\n')
    }
    if (count > 0 && this.hasBidirectionalNeeds())
      await this.waitForFirstResult()
    this.transport.endInput()   // ← CLOSES CLI STDIN
  } catch (e) { /* swallow abort */ }
}
```

Key facts:

- `streamInput()` **always** calls `transport.endInput()` when the iterable
  returns. There is no code path where it leaves stdin open after iterable
  exhaustion.
- `hasBidirectionalNeeds()` (true when `canUseTool` or any hooks are set) only
  delays the `endInput` until after the first result frame — it does not skip
  it.
- Public docstring calls it out: *"Used internally for multi-turn
  conversations."* This is not the user-facing multi-turn API.

### The SDK's own reference implementation (V2 alpha)

`unstable_v2_createSession(options) → SDKSession` (in `sdk.d.ts:4498`)
wraps the correct pattern:

```js
// roughly, from sdk.mjs (V2 Session class)
this.inputStream = new PushPullQueue()           // manually-drained iterable
this.query = new Query(opts, /* canUseTool */, …)
this.query.streamInput(this.inputStream).catch(e => this.abortController.abort(e))

async send(message) {
  this.inputStream.enqueue(normalise(message))   // never .return() — stream stays open
}
```

One `streamInput` call for the entire session; `send()` is just an enqueue
into the manually-controlled iterable. Because the iterable never returns,
`endInput()` never fires. `SDKSession` is `@alpha` (V2 UNSTABLE) — reference it
for shape, don't depend on the export.

### `priority: 'now' | 'next' | 'later'`

- Validated by a Zod enum in `cli.js` on `SDKUserMessage`.
- `sdk.mjs` passes it through unchanged to the CLI over stdin.
- On the CLI side (`cli.js`): `if (messages.some(m => m.priority === 'now')) abortController.current?.abort('interrupt')`.

So `priority: 'now'` triggers an interrupt of the current turn when the
message is observed by the CLI. This is a legitimate interrupt-and-queue
primitive — **but it depends on the CLI actually receiving the message**,
which requires stdin to still be open.

## Why the current hybrid produces inconsistent results

Ranked by likely impact:

1. **`streamInput(oneShot)` half-closes stdin.** First mid-flight steering
   call works (message lands, CLI interrupts). Any second call writes after
   `endInput()` — depending on transport state, the message is silently
   dropped or throws. The fallback-to-queue-on-throw path masks the error but
   doesn't fix ordering: the queued message is only delivered on the next
   `query()` spawn, potentially reordered behind the first interrupted turn's
   result frame.
2. **Every turn spawns a fresh CLI subprocess.** Per-turn `query()` means a
   new subprocess with `resume: sdk_session_id`. Each turn re-loads the
   session JSONL, re-initialises tool approvals and MCP servers, and
   invalidates any in-flight `streamInput` queue on the previous query.
   The "orphan runner" case (DO lost WS to live runner) documented in
   CLAUDE.md is downstream of this: the previous subprocess may still be
   holding the `sdk_session_id` lock when the new one tries to resume.
3. **Fallback queue doesn't wake `waitForNext()`.** When `streamInput()`
   throws and the runner pushes to `ctx.messageQueue`, the blocked promise
   inside `waitForNext()` is not resolved — the message sits in the buffer
   until the next turn's result frame happens to wake the loop for some
   other reason. Observed as "sent a message, no response."
4. **Interrupt state machine fights itself.** `ctx.interrupted` is reset
   per-turn to allow follow-up messages (per commit `ef47291`). But a
   `priority: 'now'` streamInput call triggers the CLI's own interrupt,
   which resolves the turn with an aborted reason; the runner then can't
   distinguish "user interrupted" from "model finished" when deciding
   whether to auto-nudge on idle-stop.
5. **`interrupt()` / `setPermissionMode()` are streaming-input-mode only.**
   The SDK's typedefs document this explicitly. Our hybrid technically
   enters streaming input mode on each per-turn `query()`, but because the
   iterable closes before the first result, bidirectional capabilities are
   effectively unavailable mid-turn for anything but our ad-hoc
   `streamInput` calls.

## Recommendation

**Adopt the documented Streaming Input Mode: one lifetime `query()` call,
one lifetime async iterable, one `queue.enqueue()` per user turn.**

Shape:

```ts
// runner lifetime
const userTurnQueue = createPushPullQueue<SDKUserMessage>()  // e.g. Deno-style async iterator backed by waiters

async function* lifetimePrompt(): AsyncGenerator<SDKUserMessage> {
  // First turn is the initial prompt from `cmd.prompt`
  yield {
    type: 'user',
    message: { role: 'user', content: cmd.prompt },
    parent_tool_use_id: null,
  }
  // Subsequent turns come from the queue; yield until runner terminates.
  for await (const msg of userTurnQueue) {
    yield msg
  }
}

const q = query({
  prompt: lifetimePrompt(),
  options,   // no `resume` here — the session IS this query's lifetime
})

// Drain responses in the existing processQueryMessages loop.
// The result-frame-wait / idle-auto-nudge becomes a pure consumer
// decision — if idle-stop, enqueue `{ content: 'continue', priority: 'next' }`;
// otherwise the next user turn arrives via enqueue from main.ts.

// On stream-input command:
userTurnQueue.enqueue({
  type: 'user',
  message: { role: 'user', content: msg.content },
  parent_tool_use_id: null,
  priority: interruptCurrent ? 'now' : 'next',
})

// On interrupt command:
await q.interrupt()   // documented API, streaming-input-mode only — works now

// On session close:
userTurnQueue.return()  // lets the generator return → endInput() → clean exit
```

### What this gets us

- **One CLI subprocess for the whole session.** `resume` is only needed on
  cold-start after the reaper kills the runner (unchanged from today's
  orphan-recovery path).
- **Mid-stream send = one enqueue, no stdin half-close.** Ordering matches
  enqueue order.
- **Interrupt is a documented method call**, not a side-effect of
  `priority: 'now'` streamInput.
- **Hooks / `canUseTool` / `setPermissionMode` become usable** anywhere
  in the session lifetime.
- **Fewer moving parts**: `ctx.query` stays stable, no per-turn
  `query()` spawn + `ctx.query = null` race, no fallback-to-queue
  reconciliation.

### Keep the current design for

- **Cold-start after reaper kill**: `options.resume = sdk_session_id` on the
  new runner's initial `query()`. The lifetime queue replays nothing —
  the CLI loads history from the session JSONL as today.
- **Orphan / fork-with-history**: unchanged — that path already forces a
  fresh `sdk_session_id`.

### Alternative: `unstable_v2_createSession()`

The V2 API (`SDKSession` with `send()` / `stream()` / `close()`) *is* the
above pattern, packaged. Ergonomic, but marked `@alpha` / *UNSTABLE*.
We'd take an API-stability risk for a thin convenience wrapper we can
write ourselves in ~20 lines. **Recommend: implement the pattern directly
against the stable `query()` API; revisit V2 when it stabilises.**

## Open questions for spec/impl

1. **Per-turn options (`model`, `mcpServers`, `allowedTools`)**: Streaming
   Input Mode requires these to be set at `query()` construction. If we
   need to switch model mid-session today via per-turn `options` overrides,
   we'll need to use `q.setModel()` / `q.setMcpServers()` / `q.setPermissionMode()`
   instead — all documented, all streaming-mode-only. Audit all current
   per-turn option tweaks in `claude-runner.ts`.
2. **Idle-stop auto-nudge**: today's "No response requested." → `"continue"`
   path is a per-turn decision. In the lifetime-query shape, it becomes
   "detect idle-stop result → enqueue `content: 'continue'` into
   userTurnQueue". Needs to interact cleanly with the `ctx.interrupted`
   flag (should not auto-nudge if the previous turn was user-interrupted).
3. **`hasBidirectionalNeeds()`**: will be `true` in our config (we set
   hooks / canUseTool). Confirm that the `waitForFirstResult()` gate
   doesn't introduce a deadlock when the first message is the only
   message and the runner hasn't started draining yet — I don't believe
   it will (the drain loop is ours, runs concurrently), but worth a
   targeted test.
4. **`priority: 'next'` vs `'later'` semantics**: docs don't explain.
   `cli.js` only branches on `'now'` for interrupt; the non-`'now'`
   cases presumably differ in queue ordering. Needs empirical test,
   or we can just omit the field (default behavior) until we have a
   reason to use it.

## References

- `@anthropic-ai/claude-agent-sdk@0.2.98` — installed at
  `node_modules/.pnpm/@anthropic-ai+claude-agent-sdk@0.2.98_*/node_modules/@anthropic-ai/claude-agent-sdk/`
  - `sdk.d.ts:1862` — `streamInput(stream: AsyncIterable<SDKUserMessage>): Promise<void>` docstring: *"Used internally for multi-turn conversations."*
  - `sdk.d.ts:1694` — `interrupt()` docstring: *"Interrupt the current query execution."*
  - `sdk.d.ts:2876` — `priority?: 'now' | 'next' | 'later'` on `SDKUserMessage`
  - `sdk.d.ts:2613` — `SDKSession` interface (V2 UNSTABLE)
  - `sdk.d.ts:4498` — `unstable_v2_createSession()`
  - `sdk.mjs` — `streamInput` implementation (calls `transport.endInput()` on iterable exhaustion)
  - `cli.js` — CLI-side `priority === 'now'` → `abort('interrupt')`
- [Streaming vs Single Message Input docs](https://code.claude.com/docs/en/agent-sdk/streaming-vs-single-mode)
- `packages/session-runner/src/claude-runner.ts:721-785` — current per-turn query loop
- `packages/session-runner/src/main.ts:151-180` — current mid-flight `streamInput` call + fallback
- Commit `4fe9ca2` — introduction of mid-flight `streamInput` steering
- Commit `ef47291` — interrupt flag reset to unblock follow-up after Stop
