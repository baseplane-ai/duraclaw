---
date: 2026-04-24
topic: Integrate caam Claude auth rotation into session-runner
type: feasibility
status: complete
github_issue: 92
items_researched: 3
---

# Research: caam auth rotation for Duraclaw session-runner

## Context

`caam` (Coding Agent Account Manager) is installed at `/home/ubuntu/bin/caam`
on the VPS and manages multiple backed-up Claude auth profiles
(`claude/work1..work3`). Today, when `session-runner` hits an Anthropic
usage limit, the SDK stream "pauses with a usage error" (user-verified)
and the session stalls — Duraclaw has no rotation. This research scopes a
Phase 1 integration: on rate-limit, swap auth via caam and restart the
runner against the same Duraclaw session.

## Scope

Items researched:

1. `caam` CLI surface — the commands we actually need (activate, next,
   cooldown, status, ls).
2. `session-runner` — where rate-limits are detected today, existing exit
   paths, meta/exit file shapes, current auth source.
3. `agent-gateway` + `SessionDO` — spawn env plumbing and today's respawn
   policy (to find the hook for auto-respawn-after-rotation).

Deferred (user ruled out of scope for Phase 1):

- SDK mid-stream re-read behavior. User confirmed the stream halts cleanly
  on usage limit, so rotation is a restart boundary — no need to dig into
  `@anthropic-ai/claude-agent-sdk` auth caching.
- Concurrent-safe per-runner profile isolation (Phase 2).

## Findings

### 1. caam CLI surface

Binary: `/home/ubuntu/bin/caam` (16 MB single-file binary).

Commands we'll call from Duraclaw (verified via `--help` locally):

| Command | Purpose | Notes |
|---|---|---|
| `caam activate claude <profile>` | Instant file-swap to a named profile. | Sub-second. `--backup-current` optional. `--json` output. |
| `caam next claude --quiet` | Smart rotation to next healthy profile (respects cooldowns). Aliases: `rotate`, `switch`. | Algorithms: `smart` (default), `round_robin`, `random`. `--dry-run` supported. |
| `caam cooldown set claude/<profile> --minutes 60` | Mark a profile as cooling down so `next` skips it. | Subcmds: `set`, `clear`, `list`. |
| `caam status` | Show active profiles + health; also surfaces `(logged in, no matching profile)` when current `~/.claude` isn't backed up. | For ops visibility; runner can also call for startup stamp. |
| `caam ls claude` | Enumerate available profiles for a tool. | Shows `work1..workN` plus `_original [system]` (pre-caam auth). |

**Observed state today** on this VPS:

```
claude      (logged in, no matching profile)
```

…plus `work1`, `work2`, `work3` all available. Operational prerequisite:
the active credential set must be captured as one of the profiles (or a
new one) before rotation is meaningful — this is an infra task, not a
code change.

[uncertain] Whether `caam status` / `caam next` support a stable
`--json` machine-readable output on the installed version — the binary
advertises `--json` on `activate` but not all subcommands shown in the
brief `--help`. Design assumes `--json` where available, falls back to
`which`-style parsing; the runner wrapper will own that parsing detail.

### 2. session-runner internals

Files: `packages/session-runner/src/{claude-runner.ts,main.ts,types.ts,env.ts}`.

**Rate-limit detection — already exists.** `claude-runner.ts:637-646`:

```ts
} else if (message.type === 'rate_limit_event') {
  send(ch, {
    type: 'rate_limit',
    session_id: sessionId,
    rate_limit_info: (message as any).rate_limit_info,
  }, ctx)
}
```

Today the event is relayed to the DO and nothing else happens — runner
continues, stream is paused at the SDK layer, no recovery.

**Exit paths — all already converge on writing `.exit`:**

- SIGTERM watchdog (`main.ts:464-499`) — 2s grace, force-write `aborted`,
  `process.exit(1)`.
- DialBackClient terminate (codes 4401/4410/4411 in
  `shared-transport/src/dial-back-client.ts:158-172`) — aborts, sets
  `meta.state = 'aborted'`.
- SDK abort / normal completion (`claude-runner.ts:343-345, 846-848`).

Exit file schema (`packages/agent-gateway/src/types.ts:18-62`,
`session-runner/src/main.ts:536-541,558`):

```ts
{ state: 'completed' | 'failed' | 'aborted' | 'crashed',
  exit_code: 0 | 1 | 2,
  duration_ms?: number,
  error?: string }
```

**Meta file** (`session-runner/src/types.ts:54-62`): carries
`sdk_session_id`, `last_activity_ts`, `cost`, `model`, `turn_count`,
`state`. No profile / auth field today — adding one is a pure append.

**Current auth source:** SDK picks up whatever is in `~/.claude` (the
global auth files that caam swaps). `buildCleanEnv()` strips
`CLAUDECODE*` + `CLAUDE_CODE_ENTRYPOINT` but leaves `HOME` and any
`ANTHROPIC_*` env untouched — so global caam activation naturally flows
through to the SDK on next spawn.

### 3. agent-gateway + SessionDO

**Spawn env plumbing** (`packages/agent-gateway/src/handlers.ts:190-199`):
runner is spawned detached with `env = { ...buildCleanEnv(), SESSIONS_DIR }`.
Adding `DURACLAW_CLAUDE_*` env vars is trivial — thread them from the DO
through `POST /sessions/start` payload and into the spawn env. Already a
well-defined extension point.

**Respawn policy today — it's demand-driven, not exit-driven.** There is
**no** code path that reads `.exit` and triggers auto-respawn. Respawn
happens lazily when the user's next `sendMessage` notices no live runner
and either:

- dials a fresh `resume` runner with the persisted `sdk_session_id`
  (`session-do.ts:3710-3732`), or
- detects an orphan (runner alive on VPS but unreachable) and
  auto-`forkWithHistory`'s with a fresh sdk_session_id.

This matters for the design: we need to **add** an exit-driven respawn
trigger for the rate-limited case. The DO already owns the
`triggerGatewayDial({type:'resume', sdk_session_id})` path — we just need
to invoke it from a new handler wired to the `rate_limit` GatewayEvent
(or a new exit-state).

**Token lifecycle** (`session-do.ts:1420-1446, 1041-1043`): each spawn
generates a fresh `active_callback_token`; prior gateway WS is closed
with 4410 and new token rejects via 4401. Safe for automatic respawn.

**GatewayCommand union** (`shared-types/src/index.ts:3-17`): no
profile-select command needed — rotation happens between runner
lifetimes, not during one. The existing `execute` / `resume` commands
suffice.

## Design recommendation (feeding Phase 1 spec)

**Architecture: runner-shells-caam, DO-respawns-on-rate-limit.**

The runner itself is the natural place to call `caam` — it's on the VPS
right next to the binary, already has process.spawn, and already holds
the active-profile identity at startup. The DO just needs a one-shot
respawn on the `rate_limit` event.

### Runner changes (`packages/session-runner`)

1. New file `src/caam.ts` — typed wrapper over `caam` subprocess:
   - `caamStatus(): Promise<{active: string | null, health: ...}>`
   - `caamActivate(profile: string): Promise<void>`
   - `caamNext(tool='claude'): Promise<{activated: string} | null>`
   - `caamCooldownSet(key, minutes): Promise<void>`
   - Gracefully degrades if `caam` binary missing (noop → warn) so dev
     machines without caam still boot.
2. At runner startup (before `query()`), stamp active profile into
   `.meta.json` as new field `claude_profile: string | null`.
3. Extend `rate_limit_event` handler (`claude-runner.ts:637`):
   - Relay event to DO as today (preserve existing wire contract).
   - If `DURACLAW_CLAUDE_ROTATION !== 'off'`: call
     `caam cooldown set claude/<active> --minutes $DURACLAW_CLAUDE_COOLDOWN_MINUTES`,
     then `caam next claude --quiet`.
   - Abort the SDK query, write `.exit` with new state `'rate_limited'`
     and `error` carrying the new active profile name for
     observability — **exit code 0** so this isn't treated as a crash.
4. Env knobs read at startup:
   - `DURACLAW_CLAUDE_PROFILE` — if set, `caam activate` it pre-query
     (pin).
   - `DURACLAW_CLAUDE_ROTATION` — `auto` (default) | `off`.
   - `DURACLAW_CLAUDE_COOLDOWN_MINUTES` — default `60`.

### Shared-types changes

- Extend `ExitFile.state` union: `| 'rate_limited'`.
- Extend `RateLimitEvent` with optional `rotated_from?: string` and
  `rotated_to?: string` — DO uses these for the system-message breadcrumb
  it inserts into the transcript.
- Add `claude_profile?: string | null` to `MetaFile`.

### Gateway changes (minimal)

- `session-state.ts` exit parser already passes `state` through; bump
  the union literal and confirm `GET /sessions/:id/status` surfaces the
  new value.
- Pass through any `DURACLAW_CLAUDE_*` env from the DO spawn payload to
  the child env (plumb one new field in the `/sessions/start` body).

### DO changes (`apps/orchestrator/src/agents/session-do.ts`)

- On `GatewayEvent` of type `rate_limit` with rotation metadata: persist
  breadcrumb as a system message in the transcript (so user sees
  "rotated `work1 → work2`, resuming…"), then schedule an immediate
  `triggerGatewayDial({type:'resume', sdk_session_id})` — gated by a new
  flag on the existing alarm so we don't hot-loop if multiple
  rate-limits land in quick succession.
- Idempotency: if the session already has a live runner (new dial
  races), the existing 4410 token rotation cleans up correctly.

### Explicitly out of scope (Phase 2 follow-ups)

- Per-runner profile isolation via `HOME` override or `caam exec`.
- UI surface for "Claude profile policy" per session (`auto` / `work1`
  / `work2` / `work3`). Backend env knobs ship first; UI is a separate
  issue.
- Multi-concurrent-Claude-runner safety. Phase 1 is single-active; if
  multiple Duraclaw Claude sessions run concurrently on one VPS, global
  `caam activate` during one session's rotation will silently swap auth
  under the others. Acceptable risk given current concurrency (typically
  1–2 active runners) and session boundary = restart boundary.

## Open questions (for interview / spec phase)

- **Cooldown duration** — 60 min is the caam example; Anthropic's usage
  limit is nominally 5h but resets on a rolling window. Should the
  cooldown default be 60, 300, or read from the SDK event itself if the
  `rate_limit_info` payload carries a `resets_at`?
- **"No healthy profiles left"** — if `caam next` fails (all in
  cooldown), what does the DO surface to the user? Options: (a) sticky
  "waiting for profile to cool down" status + auto-retry at earliest
  reset_at, (b) hard-error and require manual intervention.
- **Observability** — do we want a tiny admin endpoint (`GET
  /api/admin/caam/status`) or is `caam status` on the VPS sufficient?
- **Dev ergonomics** — on a dev box without caam profiles set up, should
  the runner fail fast, warn once, or silently skip? Recommendation:
  warn once per process, continue; rate-limit handling becomes a no-op
  rotation.

## Next steps

1. P1 interview to resolve the four open questions above.
2. P2 spec — behaviors (B-IDs) across runner / shared-types / gateway /
   DO, acceptance criteria, phased rollout.
3. P3 spec review → P4 approve & push.
