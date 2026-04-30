---
date: 2026-04-30
topic: Gateway as runner-liveness authority — replace DO-side hasLiveRunner state with gateway-dispatch
type: feasibility
status: complete
github_issue: 150
items_researched: 6
---

# Research: Gateway as runner-liveness authority (GH#150)

## Context

The `SessionDO` tries to track whether a runner is alive via `active_callback_token` + `cachedGatewayConnId`. That state can lie — runners die silently (reaper SIGTERM after 30 min idle, OOM, host reboot, network partition) and the DO doesn't notice until a watchdog tick or a WS close arrives. Until that catches up, `hasLiveRunner = true` based on stale state, `sendMessageImpl` takes the `stream-input` branch, `conn.send()` doesn't throw, the bytes go nowhere, the user message lands stuck in `awaiting_response@pending`.

Three patches shipped this session (`ad1ee7b`, `670796d`, `7ef6c22`) all addressed symptoms with timeout-based heuristics. The root issue: the DO is asking "is the runner alive?" with no synchronous, authoritative answer. The gateway can answer it synchronously — `kill(pid, 0)` returns instantly with truth.

This is a feasibility study (not brainstorming) — the architectural direction is given. The questions are: what *exactly* gets deleted, what gets added, what's the runner-side input channel, and what blocks a hard cut?

## Scope

Six parallel deep-dives:

| Item | Question |
|------|----------|
| A | DO-side liveness state — every reader, writer, test, schema column |
| B | Gateway dispatch surface — what's already there, what's net-new |
| C | Runner ingress channel — FIFO vs UDS vs file-tail vs HTTP |
| D | Runner→DO event channel — keep direct dial-back WSS or fold through gateway |
| E | Mid-turn / cold-start / control commands — what must the new path preserve |
| F | Migration strategy + latency budget |

Sources: `apps/orchestrator/src/agents/session-do/**`, `packages/{agent-gateway,session-runner,shared-transport}/**`, `docs/theory/{topology,dynamics}.md`, `docs/modules/agent-gateway.md`, `.claude/rules/deployment.md`, `planning/specs/`, recent commits `ad1ee7b 670796d 7ef6c22 4e70457`, Bun docs.

## Findings

### Item A — DO-side state to delete (corrected from issue)

**Genuinely deletable (clear-cut):**

- `failAwaitingTurnSilentDropImpl` (`awaiting.ts:66-91`)
- `AWAITING_LIVE_CONN_GRACE_MS` constant (`types.ts:73`) — 90s extended grace from `7ef6c22`
- `clearStaleGatewayConnection` (`runner-link.ts:168-175`) — silent-drop reactive clear from `670796d`
- `planAwaitingTimeout` silent-drop branch (`watchdog.ts:142-151`)
- The follow-up-message subset of the `hasLiveRunner` / `isResumable` / `isFreshSpawnable` triple-branch in `sendMessageImpl` (`rpc-messages.ts:90-302`)

**Issue is wrong — these must NOT be deleted:**

- **`active_callback_token`** (DO state field, `session_meta` migration v6, `types.ts:127`) — load-bearing for the dial-back auth gate (`client-ws.ts:68-71`, timing-safe compare). Without it, any caller is accepted on the dial-back WS.
- **`cachedGatewayConnId` + `gateway_conn_id` kv** (`runner-link.ts:118-157`) — load-bearing for routing **control commands** (`interrupt`/`stop`/`permission-response`/`answer`/`transcript-rpc-response`) to the *specific* runner WS. Deleting forces broadcast to all DO connections — trust-boundary violation. Item D confirmed this.
- **`recoverFromDroppedConnection` + `RECOVERY_GRACE_MS`** (`awaiting.ts:125-205`, `types.ts:54`) — needed for orphan recovery (`rebindRunner` primitive in `dynamics.md`). The new dispatch path replaces the *silent-drop* case but not the *connection-lost* case.
- **`triggerGatewayDial`** (`runner-link.ts:336-560`) — first-turn / resume / orphan-rebind. Dispatch is for follow-up turns on a live runner; spawn dial stays separate.

**Surprises:**

- `failAwaitingTurnImpl` (`awaiting.ts:93-123`) sets `status='error'` and clears `active_callback_token`. With silent-drop deletion, only the connection-lost path remains — keep the function but delete its silent-drop sibling.
- D1 `agent_sessions` table has zero columns being deleted. Liveness state is entirely in DO SQLite (`session_meta.active_callback_token`) and DO kv (`gateway_conn_id`, `recovery_grace_until`).
- `failAwaitingTurnImpl` sets status to `'error'` which is treated as resumable by spec #80 B7 — keep that semantic.

**Net code change:**

- Delete: ~150 LoC (silent-drop watchdog + stale-conn clear + extended-grace + silent-drop notice impl)
- Add: ~250 LoC (gateway dispatch handler + FIFO writer + runner FIFO reader + atomic spawn lock + DO-side caller)
- Net: ~+100 LoC. Cognitive surface shrinks because watchdog timing logic disappears.

### Item B — Gateway dispatch surface

**Already in place:**

- `$SESSIONS_DIR/{id}.{cmd,pid,exit,meta.json,log}` file lifecycle (`/run/duraclaw/sessions`, tmpfs, `0700`)
- `defaultLivenessCheck` uses `process.kill(pid, 0)` (`session-state.ts:23-30`)
- Bearer-token auth via `CC_GATEWAY_API_TOKEN` (`auth.ts:19-37`, timing-safe compare)
- Atomic write primitive — `writeExitOnce` uses `fs.link()` + EEXIST (`reaper.ts:377`)
- Existing HTTP routes: `POST /sessions/start`, `GET /sessions`, `GET /sessions/:id/status`, `POST /sessions/:id/kill`, `GET /health`
- DO→gateway transport: plain `fetch()` to `CC_GATEWAY_URL`, bearer `CC_GATEWAY_SECRET` (`runner-link.ts:513-559`)
- Reaper logs reaping decisions back to DO via `recordReapDecision` RPC

**Net-new code needed:**

1. `POST /sessions/:id/dispatch` handler — read `.pid`, `kill(pid, 0)`, write to FIFO, return 200/404/503
2. Runner-side FIFO listener (Item C)
3. Atomic session-keyed spawn lock (`.lock` file via `fs.link()`) — closes the spawn-during-dispatch race (Q3)

**Spawn-during-dispatch race (Q3 answer):**

Today there is **no session-keyed spawn lock**. Two concurrent `POST /sessions/start` requests both write `.cmd`, both spawn runners, second `.pid` overwrites first → second runner becomes the live one and the first is orphaned (will be reaped after 30 min idle). DO single-threading hides this for normal traffic, but the new dispatch path makes the race visible. Mitigation: gateway writes a `.lock` file via `fs.link()` before `.cmd`; second concurrent spawn returns 409.

### Item C — Runner ingress channel: FIFO recommended

| | FIFO | UDS | File-tail | HTTP |
|---|---|---|---|---|
| Bun support | Idiomatic via `fs.createReadStream` | Idiomatic via `bun:net` | Trivial via `fs.appendFile` | Idiomatic via `Bun.serve` |
| Atomicity | POSIX-atomic ≤ 4KB; length-prefix handles >4KB | Stream-ordered per connection | Append-atomic but no read sync | HTTP framing native |
| Failure detection | EPIPE / ENOENT | Connection error | None — silent | Connection refused |
| Implementation cost | ~100 LoC | ~105 LoC | ~120 LoC | ~150 LoC |
| Latency | Sub-ms (kernel wakeup) | Sub-ms | 100ms-1s polling | Local HTTP overhead |
| Fit with existing infra | Matches `.cmd`/`.pid`/`.exit` file pattern | New socket file | Same FS but no cleanup | Net-new HTTP server |

**Recommendation: Named FIFO** at `$SESSIONS_DIR/{id}.input`, length-prefixed (4B LE uint32) JSON frames. Bytes are atomic ≤ PIPE_BUF (4 KB on Linux); larger payloads use the length prefix to recover from torn reads. EPIPE on write = runner dead → DO falls back to spawn dial.

**Open caveat:** if stream-input payloads regularly exceed 4 KB (large code blocks, base64 images), UDS becomes preferable for cleaner atomicity. Current evidence suggests payloads are <2 KB typical.

**Lifecycle:** runner creates FIFO at startup (`mkfifo` after `.pid` write, before SDK dial-back); unlinks on SIGTERM and clean exit; reaper extends `*.input` to its terminal-trio GC (`>1h past .exit mtime`).

### Item D — Event channel: keep direct dial-back WSS

**Recommendation: no change.**

`BufferedChannel`/`DialBackClient` invariants are load-bearing:

- 10K events / 50 MB ring (`buffered-channel.ts:71-72`)
- 1s/3s/9s/27s/30s reconnect backoff (`dial-back-client.ts:49-51`)
- Ordered replay on reconnect, gap sentinel on overflow (`buffered-channel.ts:149-161`)
- Restart-as-noop for gateway/Worker/DO redeploy (`topology.md:41-42`, `dynamics.md:17`)

Folding events through gateway adds 30-50ms per token, makes gateway a steady-state critical path (currently spawn/reap only), introduces dual buffering (runner ring + gateway ring) with overlapping overflow semantics. No win.

The `agent-gateway.md` module doc explicitly states: "It does not embed the Claude SDK, **it does not buffer messages, it does not proxy events**." Folding events through gateway directly contradicts this invariant.

### Item E — Preserved-behavior questions

**Q4 mid-turn user send: stays on `userQueue`.** The DO's new dispatch HTTP eventually pushes onto the existing `PushPullQueue<SDKUserMsg>` (`packages/session-runner/src/push-pull-queue.ts`). SDK's async iterator drains between turns naturally. Two invariants must hold:
- Send-and-forget — no ack wait
- Order preservation — two dispatches in flight must reach `userQueue.push` in send order (per-session write mutex on the gateway side; FIFO single-reader handles this naturally)

**Q7 first-turn cold start: stays separate.** Three blockers prevent unifying with dispatch:
1. Token rotation must close-old-WS-then-rotate-then-spawn (`runner-link.ts:480-525`)
2. User message must persist to DO SQLite *before* runner dials back (`rpc-messages.ts:124-128` → `triggerGatewayDial`)
3. `POST /sessions/start` returns gateway-assigned `session_id` that DO persists for subsequent calls

`triggerGatewayDial` flow stays as-is. The `hasLiveRunner` branch in `sendMessageImpl` collapses; the `isFreshSpawnable` and `isResumable` branches stay (call `triggerGatewayDial` when no live runner).

**Q8 control commands: stay on dial-back WS.** `interrupt` is latency-critical (<50ms target — user clicked Stop), tightly coupled to SDK's `Query.interrupt()`. `stop` aborts the SDK + closes the queue + exits the process; needs to fire fast. Routing them through HTTP adds 100-300ms cross-region — defeats the UX. They keep using `sendToGateway` over the dial-back WS, which is why `cachedGatewayConnId` must be preserved (Item A correction).

### Item F — Migration: hard cut

**Existing flag system has a 5-min in-DO cache** (`feature-flags.ts:14-31`) — defeats gradual rollout. Toggling the flag won't take effect for up to 5 minutes; not useful for this migration.

**Hard-cut precedent: spec #101 P2** (`runner_session_id` rename, migration v18, currently on main) shipped atomically with code via the standard infra pipeline.

**Deploy story** (`.claude/rules/deployment.md`): single pipeline runs in sequence — D1 migration, Worker `wrangler deploy`, gateway bundle build + systemd restart. Gateway uses `KillMode=process` so detached runners survive the gateway bounce. Runner bundles are atomically `mv`'d so a spawn race always reads either old or new bundle, never half.

**Worst-case skew window: 30-60 seconds** during deploy. Mitigation:
- Gateway dispatch endpoint is **additive** (old `POST /sessions/start` still works alongside new `POST /sessions/:id/dispatch`)
- Old DO code calling old gateway: works (no change)
- New DO code calling old gateway: 404 on dispatch → DO falls back to spawn dial → still works
- Old DO code calling new gateway: never tries dispatch → uses old paths → still works

**Latency:** CF Worker → VPS gateway is plain HTTPS `fetch()`, no service binding (`runner-link.ts:519-526`). Cross-region 100-300ms. SDK first-token is 1-3s. Net cost <10%.

**Recommendation: hard cut, single PR**, ship migration + endpoint + DO refactor + topology doc update + tests together. Revert is a single commit.

## Comparison

### Issue's claims vs. actual deletion list

| Issue says delete | Actual decision | Why |
|---|---|---|
| `active_callback_token` | **Keep** | Auth gate on dial-back WS (`client-ws.ts:68-71`) |
| `cachedGatewayConnId` + `gateway_conn_id` kv | **Keep** | Routes interrupt/stop/permission-response/answer to specific WS |
| `hasLiveRunner` triple-branch in `sendMessageImpl` | **Collapse only the live-runner branch** | Fresh-execute and resume branches still need `triggerGatewayDial` |
| `recoverFromDroppedConnection` | **Keep** | Connection-lost recovery (orphan path); not silent-drop |
| `failAwaitingTurnImpl` | **Keep** | Connection-lost handler stays |
| `failAwaitingTurnSilentDropImpl` | **Delete** | Silent-drop case now structurally impossible |
| `planAwaitingTimeout` | **Trim silent-drop branch only** | Connection-lost timeout still needed |
| `clearStaleGatewayConnection` | **Delete** | Reactive clear no longer needed |
| `AWAITING_LIVE_CONN_GRACE_MS` | **Delete** | Extended-grace not needed |
| `triggerGatewayDial` "in current form" | **Keep as-is** | Issue was wrong — dispatch is a separate, narrower endpoint |

### Path matrix (post-implementation)

| Path | Trigger | Mechanism |
|------|---------|-----------|
| Spawn dial | Fresh session OR resume from idle | `triggerGatewayDial` → `POST /sessions/start` HTTP, runner reads `cmd` file |
| Dispatch (NEW) | `hasLiveRunner` (cached `gateway_conn_id` exists) | `POST /sessions/:id/dispatch` HTTP → gateway writes FIFO → runner pushes to `userQueue` |
| Control + events | interrupt/stop/permission-response/answer; runner→DO events | Direct dial-back WSS (unchanged) |

## Recommendations

1. **Adopt FIFO** for runner ingress (`$SESSIONS_DIR/{id}.input`, length-prefix JSON framing).
2. **Hard cut, single PR.** Bundle dispatch endpoint + runner FIFO listener + spawn-lock fix + DO refactor + topology doc update + tests.
3. **Narrow the deletion** — keep `active_callback_token`, `cachedGatewayConnId`/`gateway_conn_id`, `recoverFromDroppedConnection`, `triggerGatewayDial`. Delete only the silent-drop layer.
4. **Bundle the spawn-lock fix** into GH#150 — the race exists today, but new dispatch path makes it more likely to surface.
5. **Update `topology.md`** in the same PR — the line "After spawn, the gateway has no direct channel to the runner" is the invariant being relaxed.
6. **Fall-back semantics:** dispatch returns 404/503 → DO falls back to `triggerGatewayDial`. The old "live-runner-but-stale" silent-drop case is impossible with `kill(pid, 0)`.

## Open Questions

To be resolved in P1 interview:

- **Q-A.** Bundle the spawn-lock fix (`.lock` file via `fs.link()`) into GH#150, or split into a separate issue first?
- **Q-B.** Should dispatch *also* handle the resume case (no PID + have `runner_session_id` → gateway spawns with `cmd.type='resume'` using user message as initial prompt)? Or stay narrow (dispatch only for live runners; resume stays on `triggerGatewayDial`)?
- **Q-C.** FIFO lifecycle ownership — runner creates at startup, or gateway pre-creates before spawn? Pre-creation avoids startup race but couples gateway tighter to runner.
- **Q-D.** Single-PR hard cut, or 2-PR sequence (P1: add dispatch endpoint behind no-flag; P2: delete silent-drop layer once production confirms)?
- **Q-E.** Does the spec ship the `topology.md` + `dynamics.md` doc updates in the same PR?

## Next Steps

1. P1 — kata-interview: surface Q-A through Q-E with the user
2. P2 — kata-spec-writing: produce `planning/specs/150-gateway-liveness-authority.md` with B-IDs, phases, acceptance criteria, verification plan
3. P3 — kata-spec-review
4. P4 — kata-close: commit + PR
