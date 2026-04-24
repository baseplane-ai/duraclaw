---
initiative: caam-claude-auth-rotation
type: project
issue_type: feature
status: approved-revised
priority: medium
github_issue: 92
created: 2026-04-24
updated: 2026-04-24
approved: 2026-04-24
revised: 2026-04-24
phases:
  - id: p1
    name: "shared-types + gateway: extend exit/meta schemas and env plumbing"
    tasks:
      - "Extend ExitFile.state union in packages/agent-gateway/src/types.ts: add 'rate_limited', 'rate_limited_no_profile', 'rate_limited_no_rotate'"
      - "Add optional claude_profile?: string | null and rotation?: {from: string; to: string} | null to MetaFile in packages/agent-gateway/src/types.ts"
      - "Confirm session-state.ts passes new states through verbatim (no enum gate); add type test"
      - "Extend RateLimitEvent in packages/shared-types/src/index.ts with optional rotation?: {from: string | null; to: string | null} and exit_reason?: 'rate_limited' | 'rate_limited_no_profile' | 'rate_limited_no_rotate' and resets_at?: number (ms epoch, mirrored from rate_limit_info.resetsAt when present). Drop the earlier cooldown_minutes field — the refresh time comes straight from the SDK event."
      - "Extend GatewayCommand union in packages/shared-types/src/index.ts with {type: 'synth-rate-limit', rate_limit_info?: Record<string, unknown>}. Runner-side handler is implemented in P2 (dev-gated). Lives in P1 so P2 integration tests can depend on the type being in the workspace type-check already."
      - "Allow DURACLAW_CLAUDE_* env vars through buildCleanEnv() in packages/agent-gateway/src/handlers.ts (currently strips CLAUDECODE* / CLAUDE_CODE_ENTRYPOINT; add an explicit passthrough so new vars aren't silently dropped if allowlisting is added later)"
    test_cases:
      - id: "types-exit-state-union"
        description: "TypeScript compiles when .exit file carries state:'rate_limited' | 'rate_limited_no_profile' | 'rate_limited_no_rotate' and resolveSessionState returns them"
        type: "unit"
      - id: "types-meta-claude-profile"
        description: "MetaFile allows claude_profile (string or null) and rotation ({from,to} or null) round-trip through JSON read/write"
        type: "unit"
      - id: "types-ratelimit-rotation-optional"
        description: "RateLimitEvent without rotation field still validates (backward-compatible wire contract)"
        type: "unit"
  - id: p2
    name: "session-runner: caam wrapper + rotation on rate-limit"
    tasks:
      - "Create packages/session-runner/src/caam.ts with typed wrappers: caamResolveBin(), caamIsConfigured(), caamActiveProfile('claude'), caamActivate('claude', profile), caamNext('claude'), caamCooldownSet('claude', profile, minutes), caamCooldownList('claude'), each with a subprocess-plus-text-parse fallback when --json is not supported"
      - "At runner startup (packages/session-runner/src/main.ts spawn path, before claude-runner.ts query()): if DURACLAW_CLAUDE_PROFILE set, call caamActivate; if any caam call fails because the profile is cooling, exit state:'failed' with error: 'pinned profile <p> is in cooldown until <ts>'. Otherwise stamp caamActiveProfile into ctx.meta.claude_profile"
      - "If caamIsConfigured() is false (binary missing OR caam ls claude returns zero profiles) log '[caam] not configured on this host — rotation disabled' exactly once and short-circuit all rotation paths below to no-ops that still relay raw rate_limit events"
      - "In claude-runner.ts:637-646 rate_limit_event branch: (1) if DURACLAW_CLAUDE_ROTATION === 'off' OR peer-claude-runner detected via scanPeerMeta(SESSIONS_DIR, sessionId) returns any live claude runner, call send(ch, {type:'rate_limit', ..., exit_reason:'rate_limited_no_rotate'}), ctx.abortController.abort(); (2) otherwise read resetsAt from message.rate_limit_info, compute minutes = max(1, Math.ceil((resetsAt - Date.now()) / 60000)), call caamCooldownSet('claude', active, minutes) (records the SDK-reported refresh time in caam so 'next' skips it), then caamNext('claude'); if next returns null (every profile is in cooldown / unavailable), read caamCooldownList earliest_clear_ts, set ctx.meta.state = 'rate_limited_no_profile', include earliest_clear_ts in .exit error field, abort; (3) on successful rotation, set ctx.meta.rotation = {from: active, to: next.activated}, send rate_limit event with rotation metadata + resets_at, abort. If rate_limit_info.resetsAt is missing or in the past, fall back to a conservative 5-hour minutes value (the documented five_hour window) — logged as '[caam] rate_limit_info missing resetsAt, falling back to 300m'."
      - "Extend main.ts exit-file writer (lines 536-541, 558) to emit new state values based on ctx.meta.state, exit_code:0 for all rate_limited* variants, and error carrying rotation metadata JSON"
      - "Add packages/session-runner/src/peer-scan.ts: scanPeerMeta(dir, selfId) globs *.meta.json, filters state==='running', model starts with 'claude-', id !== selfId, returns array of peer summaries"
      - "Read env knobs at startup in main.ts: CAAM_BIN (default probe $PATH then /home/ubuntu/bin/caam), DURACLAW_CLAUDE_PROFILE (pin), DURACLAW_CLAUDE_ROTATION ('auto' | 'off', default 'auto'). Resolve into ctx.rotationMode: if DURACLAW_CLAUDE_PROFILE is set OR env rotation is 'off', ctx.rotationMode = 'off'; else 'auto'. This single flag drives the B3 Gate-0 branch. NO cooldown-minutes env knob — B3 derives the value from rate_limit_info.resetsAt on each event."
      - "Refactor main.ts exit-file writer (lines 536-541, 558) into an idempotent writeExitFileInline(ctx, payload) helper using the existing link()+EEXIST single-writer pattern. Export from main.ts so claude-runner.ts's rate-limit branch can call it. Post-abort cleanup path and SIGTERM watchdog both call the same helper — first writer wins, subsequent calls no-op. Unit test: invoke writeExitFileInline twice with different payloads; assert only the first wins."
      - "Emit structured stderr logs at every caam decision point (see Verification Plan): '[caam] active profile=X at startup', '[caam] session_limit reset_at=<iso> derived_cooldown=Nm next=Y rotated', '[caam] session_limit peer_detected skip_rotation', '[caam] session_limit all_unavailable earliest_clear=<ts>', '[caam] rate_limit_info missing resetsAt, falling back to 300m' (fallback path only)."
      - "Implement runner-side dev-gated handler for GatewayCommand {type:'synth-rate-limit'} (type added in P1). Guard on process.env.DURACLAW_DEBUG_ENDPOINTS === '1'; when received, synthesize an SDK-shape rate_limit_event message into the same branch claude-runner.ts:637 consumes, with rate_limit_info from the command payload (or a canned default). All B3 gates fire and produce real .exit / .meta / caam side effects, exactly as a real rate-limit would. Used by P2 integration tests and VP1–VP3."
    test_cases:
      - id: "caam-wrapper-not-configured"
        description: "caam.ts gracefully returns {configured:false} when binary missing; all helpers become no-ops and don't throw"
        type: "unit"
      - id: "caam-wrapper-active-profile"
        description: "caamActiveProfile('claude') parses caam status / caam which output into the profile name or null when (logged in, no matching profile) is present"
        type: "unit"
      - id: "caam-wrapper-cooldown-set"
        description: "caamCooldownSet('claude', 'work2', 60) issues 'caam cooldown set claude/work2 --minutes 60' and treats exit 0 as success"
        type: "unit"
      - id: "peer-scan-detects-claude-peer"
        description: "scanPeerMeta returns a peer when a sibling *.meta.json has state='running' and model='claude-3-5-sonnet-latest'; returns [] when only non-claude peers exist"
        type: "unit"
      - id: "runner-rotate-on-ratelimit"
        description: "Given a stub caam that returns active=work1 and next=work2, a synthetic rate_limit_event in the SDK stream triggers cooldown+next calls and the runner exits .exit {state:'rate_limited', exit_code:0}, .meta.rotation {from:'work1', to:'work2'}"
        type: "integration"
      - id: "runner-skip-when-peer-live"
        description: "Same rate_limit_event but with a live peer in SESSIONS_DIR: no caam calls fire, .exit state is 'rate_limited_no_rotate', stderr log contains 'peer_detected skip_rotation'"
        type: "integration"
      - id: "runner-no-profile-available"
        description: "Stub caam returns next=null and cooldown list earliest_clear=<future-ts>: .exit state is 'rate_limited_no_profile', error JSON carries earliest_clear_ts"
        type: "integration"
      - id: "runner-pin-cooldown-fails-fast"
        description: "DURACLAW_CLAUDE_PROFILE=work2 and caamActivate errors because work2 is cooling: runner exits .exit {state:'failed', error:'pinned profile work2 is in cooldown until <ts>'} before SDK query() runs"
        type: "integration"
      - id: "runner-dev-box-no-caam"
        description: "CAAM_BIN points at a nonexistent path: startup logs 'not configured' once, ctx.meta.claude_profile=null, rate_limit_event path short-circuits to raw-relay (no rotation metadata), .exit state stays 'aborted' on abort"
        type: "integration"
  - id: p3
    name: "orchestrator DO: auto-respawn + transcript breadcrumb + waiting_profile status"
    tasks:
      - "In apps/orchestrator/src/agents/session-do.ts rate_limit GatewayEvent handler (around line 5071-5073): branch on event.exit_reason. For 'rate_limited' with rotation metadata: insert a system-role SessionMessage into the DO's SQLite history + broadcast as a messages delta with kind:'delta' and seq=ctx.nextSeq (wording: '⚡ Claude profile rotated <from> → <to>, resuming…'). Set SessionMeta.pendingResume = {kind:'rotation', at: now()+1s}. For 'rate_limited_no_rotate': insert an error-role system message ('Rate-limited and another Claude session is active — not rotating.'), set status to 'error' via the existing error emission path, do NOT schedule resume. For 'rate_limited_no_profile': insert a system message ('All Claude profiles are cooling down — waiting until <ts> to resume.'), set SessionMeta.pendingResume = {kind:'rotation', at: earliest_clear_ts + 30_000}."
      - "Add a DO alarm handler branch that observes SessionMeta.pendingResume: when alarm fires and now() >= pendingResume.at and no live runner, call triggerGatewayDial({type:'resume', sdk_session_id}) exactly once (clear pendingResume before the dial so a retry doesn't re-fire). Existing watchdog alarm in session-do.ts is the hook point — extend, don't replace."
      - "Expose useDerivedStatus (apps/orchestrator/src/lib/display-state.ts) awareness of a transient 'rotating' and persistent 'waiting_profile' status derived from the newest system breadcrumb message (match on SessionMessage.metadata.caam, NOT regex on body text). Return the derived status from the hook; StatusBar/tabs/sidebar consume it unchanged."
      - "Update deriveDisplayStateFromStatus in apps/orchestrator/src/lib/display-state.ts switch/map: add cases for 'rotating' (label: 'rotating', color: yellow/amber, icon: loader/refresh, pulse: true) and 'waiting_profile' (label: 'waiting for auth', color: gray/muted, icon: clock, pulse: false). Confirm StatusBar, sidebar, and tab bar render the new cases without code changes (they all consume the mapper output)."
      - "Add persistent SessionMeta field pendingResume?: { kind: 'rotation'; at: number } | null — persist in session_meta SQLite table (migration v8 in apps/orchestrator/src/agents/session-do.ts where META_COLUMN_MAP lives, line ~154-181). Hydrated on DO rehydrate."
      - "Wire SessionMessage.metadata to carry rotation info so display-state can key off it without parsing prose"
      - "Filter breadcrumb system messages out of the SDK resume-prompt reconstruction: locate the history → SDK-prompt serializer in session-do.ts (search for where getHistory() feeds resume's stream-input or prior-context reconstruction) and add a single predicate `msg.metadata?.caam === undefined` — messages carrying caam metadata are rendered in messagesCollection but skipped when rebuilding the SDK prompt. Unit test: round-trip a history containing one user, one assistant, one caam breadcrumb, one user through the serializer; assert SDK prompt contains only the non-breadcrumb turns in order."
      - "Add dev-only synthetic rate_limit injector with TWO layers so VPs can exercise both runner-side artifacts AND DO-side respawn. LAYER A (runner-side): extend GatewayCommand union in packages/shared-types/src/index.ts with a new command {type: 'synth-rate-limit', rate_limit_info?: Record<string, unknown>} gated in the runner command handler by env DURACLAW_DEBUG_ENDPOINTS === '1'. When received, the runner injects a synthetic rate_limit_event into its own SDK message loop exactly as if the SDK had emitted one — all B3 gates fire and produce real .exit / .meta / caam cooldown side effects. LAYER B (DO endpoint): POST /api/__dev__/synth-ratelimit/:sessionId in apps/orchestrator/src/api/index.ts, gated on env.DURACLAW_DEBUG_ENDPOINTS === '1'. Body {target: 'runner' | 'do', exit_reason?, rotation?, earliest_clear_ts?}. target:'runner' sends the GatewayCommand to the live runner via existing dial-back (preferred for VP1-VP3 which check runner artifacts); target:'do' bypasses the runner and calls the DO's rate_limit handler directly (for DO-unit tests where a runner isn't live)."
      - "Add insertSystemBreadcrumb(opts: {body: string; metadata: SessionMessageMetadata}): Promise<void> method on SessionDO. Implementation: construct a SessionMessage with role:'system', id:`sys-caam-${ulid()}`, body, metadata, ts:now(); persist via existing SQLite history write path; broadcast as a seq'd {type:'messages', kind:'delta'} frame with seq = ctx.nextSeq. Used by B4/B5/B6 handlers. If a similar helper already exists (search for existing system-message insertion patterns in session-do.ts before adding), reuse it and extend with the metadata param."
    test_cases:
      - id: "do-rate-limited-breadcrumb"
        description: "DO receives rate_limit event with rotation metadata: messagesCollection gains a system-role message with metadata.caam={from,to,kind:'rotated'}; a resume dial is scheduled via alarm ~1s later; useDerivedStatus returns 'rotating' briefly then resolves to 'running' once the resume runner's session.init arrives"
        type: "integration"
      - id: "do-no-rotate-error"
        description: "DO receives rate_limit with exit_reason='rate_limited_no_rotate': system error message appears in transcript, no pendingResume is set, status becomes 'error'"
        type: "integration"
      - id: "do-waiting-profile-status"
        description: "DO receives rate_limit with exit_reason='rate_limited_no_profile' and earliest_clear_ts=now+60m: status becomes 'waiting_profile', alarm fires at that time, resume is dispatched"
        type: "integration"
      - id: "do-alarm-idempotent-resume"
        description: "If a runner is somehow already live when pendingResume fires (race), triggerGatewayDial's existing 4410 token-rotation cleans up the stale peer; only one resume takes hold"
        type: "integration"
      - id: "do-pendingresume-persists"
        description: "Evict and rehydrate the DO between the rate_limit event and the alarm fire: pendingResume survives, alarm still fires, resume still dispatches"
        type: "integration"
      - id: "do-breadcrumb-filter-serializer"
        description: "History → SDK-prompt serializer round-trip: given [user, assistant, system{metadata.caam}, user], SDK prompt output contains only [user, assistant, user]; messagesCollection still carries all four"
        type: "unit"
      - id: "do-synth-ratelimit-runner-target"
        description: "POST /api/__dev__/synth-ratelimit/:sid body={target:'runner'} with DURACLAW_DEBUG_ENDPOINTS=1 routes a synth-rate-limit GatewayCommand to the live runner; runner writes a real .exit file with state rate_limited/rate_limited_no_rotate/rate_limited_no_profile per its gate evaluation"
        type: "integration"
  - id: p4
    name: "end-to-end verification + rollout"
    tasks:
      - "Prereq: on the dev VPS, capture the currently active ~/.claude as caam backup claude work1 (or confirm work1..workN already covers active state). Document this one-time setup in planning/research/2026-04-24-caam-auth-rotation-gh92.md"
      - "Run the full VP1..VP5 verification plan below against a local dev-up stack"
      - "Add session-runner unit tests to vitest workspace (peer-scan, caam wrapper with a stub $CAAM_BIN pointing at a shell script that echoes canned output)"
      - "Confirm build + typecheck across workspace: pnpm build && pnpm typecheck"
      - "Update CLAUDE.md with one paragraph under 'Session lifecycle & resume' describing the rotation path and the D4 single-active-runner assumption"
    test_cases:
      - id: "e2e-rotation-happy-path"
        description: "Stubbed-ratelimit session rotates work1→work2, transcript shows breadcrumb, resume completes, next user turn runs against work2"
        type: "smoke"
      - id: "e2e-peer-safety"
        description: "Two concurrent claude sessions running; one hits rate_limit: that session exits rate_limited_no_rotate, the other is undisturbed"
        type: "smoke"
      - id: "e2e-waiting-profile"
        description: "All profiles stubbed as cooling: session enters waiting_profile, alarm fires at earliest clear, resume proceeds"
        type: "smoke"
      - id: "e2e-build-green"
        description: "pnpm build, pnpm typecheck, pnpm test all green"
        type: "smoke"
---

# caam Claude auth profile rotation in session-runner

> GitHub Issue: [#92](https://github.com/baseplane-ai/duraclaw/issues/92)

## Overview

`caam` (Coding Agent Account Manager) is installed on the VPS at
`/home/ubuntu/bin/caam` and manages multiple backed-up Claude auth
profiles (`claude/work1..workN`). Today, when a Claude profile exhausts
its session-usage window (Anthropic's five-hour / seven-day limits —
surfaced as an SDK `rate_limit_event` with `status:'rejected'`), the
stream halts and the Duraclaw session stalls. This spec adds a
single-active-runner Phase 1 integration that treats the event as a
**session-limit exhaustion, not an abstract rate-limit**: read the
authoritative refresh timestamp directly from `rate_limit_info.resetsAt`,
record it against the current profile in `caam`, pick the next
non-exhausted profile, exit; the SessionDO then auto-respawns a
`resume` runner against the rotated auth and resumes the user's
conversation with a transcript breadcrumb.

> **Revision note (2026-04-24).** Earlier draft of this spec treated the
> event as a generic rate-limit and applied a fixed 60-minute cooldown
> via a `DURACLAW_CLAUDE_COOLDOWN_MINUTES` env knob. That knob has been
> removed. The SDK event carries the real refresh time in
> `rate_limit_info.resetsAt` (see spec #13 B13 for the payload shape),
> so the runner now derives cooldown-minutes from the event per-hit and
> feeds the exact value into `caam cooldown set`. No guessing; no env
> tuning.

## Root Cause / Current State

- `packages/session-runner/src/claude-runner.ts:637-646` already detects
  `message.type === 'rate_limit_event'` and forwards it to the DO as a
  `RateLimitEvent` — but does nothing else. Runner stays alive, SDK
  stream is paused, session is dead.
- `apps/orchestrator/src/agents/session-do.ts:5071-5073` handles the
  event by broadcasting it. No state transition, no respawn.
- `~/.claude` is global on the VPS. Every runner reads the same auth
  files — so rotation requires a runner restart boundary, not an
  in-process swap. This matches Duraclaw's existing
  runner-per-session spawn model exactly; no architectural change needed.
- `caam activate claude <profile>` / `caam next claude` swap files under
  `~/.claude/` in well under a second; the next `query()` call in a
  fresh runner process picks up the new auth automatically.

## Feature Behaviors

### B1: Runner stamps active Claude profile into meta at startup

**Core:**
- **ID:** runner-active-profile-stamp
- **Trigger:** session-runner process starts and reaches the point
  where `.meta.json` is first written (before SDK `query()`).
- **Expected:** If `caam` is configured on this host (binary exists AND
  `caam ls claude` returns ≥1 profile), `ctx.meta.claude_profile` is
  the output of `caam which claude` (falling back to parsing
  `caam status`). If caam is not configured, field is `null` and a
  single startup log line is emitted.
- **Verify:** Start a runner on a VPS with caam configured; cat the
  `.meta.json` file — `claude_profile` field matches output of
  `caam which claude`. Start a runner with `CAAM_BIN=/nonexistent` —
  `claude_profile` is `null`, stderr contains
  `[caam] not configured on this host — rotation disabled` exactly
  once.
- **Source:** `packages/session-runner/src/main.ts` (meta-write path
  around line 401-410), new `packages/session-runner/src/caam.ts`

#### UI Layer
N/A.

#### API Layer
N/A.

#### Data Layer
New optional field on `MetaFile`:
```ts
claude_profile?: string | null
rotation?: { from: string; to: string } | null  // populated only during rotation exit
```

---

### B2: Pinned profile honored; fails fast if pinned profile is cooling

**Core:**
- **ID:** runner-profile-pin
- **Trigger:** session-runner starts with `DURACLAW_CLAUDE_PROFILE`
  env var set (gateway passes this through from the DO spawn payload).
- **Expected:** Runner calls `caam activate claude <pinned>` before
  `query()`. If activation fails because the profile is in cooldown,
  runner exits **before** touching the SDK with `.exit` state
  `'failed'` and `error` = `"pinned profile '<p>' is in cooldown until
  <ISO ts>"`. If activation succeeds, the runner internally treats
  `DURACLAW_CLAUDE_ROTATION` as `'off'` for this session (pinning is an
  explicit no-fallback choice — see decision D8). If a rate-limit fires
  on the pinned profile mid-session, the runner takes the
  `rotation === 'off'` branch in B3 (abort + exit with
  `'rate_limited_no_rotate'`, NOT a hang).
- **Verify:** Set `DURACLAW_CLAUDE_PROFILE=work2`; first
  `caam cooldown set claude/work2 --minutes 60`; spawn runner; assert
  `.exit` state is `failed`, `error` matches pattern; assert
  `claude-runner.ts query()` was never entered (verify via a sentinel
  log line that would appear at the top of `query()`).
- **Source:** new `src/caam.ts`, `packages/session-runner/src/main.ts`
  startup block

#### API Layer
Gateway `POST /sessions/start` payload accepts a new optional field
`env: { DURACLAW_CLAUDE_PROFILE?: string; DURACLAW_CLAUDE_ROTATION?: 'auto' | 'off' }`
that the gateway merges into the spawned child env. Backward-compatible
— missing block means runner reads env from its own inherited
environment. (There is deliberately no cooldown-minutes knob: the runner
reads the refresh time from each `rate_limit_event` payload instead.)

#### Data Layer
None (env-only).

---

### B3: On rate_limit_event, runner rotates via caam and exits cleanly

**Core:**
- **ID:** runner-rotate-on-ratelimit
- **Trigger:** SDK emits a `rate_limit_event` message while a runner is
  mid-`query()`.
- **Expected:** In the rate-limit branch of the SDK message handler, the
  runner evaluates gates in this exact order:

  0. **Rotation disabled** (`DURACLAW_CLAUDE_ROTATION === 'off'` OR
     pinned per B2): skip caam entirely, relay a `rate_limit` event to
     the DO with `exit_reason:'rate_limited_no_rotate'` and
     `rotation:null`, set `ctx.meta.state = 'rate_limited_no_rotate'`,
     write `.exit` inline (see step 4 below), abort.
  1. **caam not configured** (B7 dev-box path,
     `!caamIsConfigured()`): relay a raw `rate_limit` event with no
     `exit_reason` and no `rotation`, **do not abort, do not exit**.
     Today's behavior preserved so dev boxes without caam still
     surface the original SDK error to the user.
  2. **Peer claude runner live**: `scanPeerMeta(SESSIONS_DIR, selfId)`
     returns ≥1 entry with `state:'running'` and `model.startsWith
     ('claude-')`. Skip caam, relay a `rate_limit` event with
     `exit_reason:'rate_limited_no_rotate'` + `rotation:null`, set
     `ctx.meta.state = 'rate_limited_no_rotate'`, write `.exit` inline,
     abort.
  3. **Normal rotation**: read `resetsAt` (ms epoch) from
     `message.rate_limit_info`. If present and in the future, derive
     `minutes = max(1, Math.ceil((resetsAt - Date.now()) / 60_000))` —
     this is the SDK-reported refresh window for the current profile.
     If `resetsAt` is missing or in the past, fall back to 300 minutes
     (Anthropic's documented five-hour window) and log the fallback.
     Then `caam cooldown set claude/<active> --minutes <minutes>`
     (records the exact refresh time in caam's cooldown list so `next`
     skips this profile until it naturally resets), then
     `caam next claude --quiet`.
     - If `caam next` returns `null` (every profile is in caam's
       cooldown list): read `caam cooldown list` to find the earliest
       clear timestamp across all profiles; relay `rate_limit` event
       with `exit_reason:'rate_limited_no_profile'`, `rotation:null`,
       `earliest_clear_ts: <ms>`, `resets_at: <resetsAt or null>`; set
       `ctx.meta.state = 'rate_limited_no_profile'` and
       `ctx.meta.rate_limit_earliest_clear_ts = <ts>`; write `.exit`
       inline; abort.
     - If rotation succeeds: set `ctx.meta.rotation = {from, to}` and
       `ctx.meta.state = 'rate_limited'`, relay `rate_limit` event with
       `exit_reason:'rate_limited'`, `rotation:{from, to}`, and
       `resets_at: <resetsAt or null>`, write `.exit` inline, abort.
  4. **Inline `.exit` write ordering.** Steps 0, 2, 3 all write
     `.exit` BEFORE calling `ctx.abortController.abort()`. The runner
     uses the single-writer `link()+EEXIST` pattern already in
     `main.ts`; the post-abort cleanup path becomes a no-op when
     `.exit` already exists. This deterministically wins the race
     against the SIGTERM watchdog's 2-second grace writer — under no
     circumstances should a `rate_limited*` transition be clobbered
     by a watchdog-written `aborted` state.

  All `rate_limited*` exits use `exit_code: 0` (not a crash, explicit
  lifecycle transition).
- **Verify:** Three integration tests in the P2 phase table above
  (`runner-rotate-on-ratelimit`, `runner-skip-when-peer-live`,
  `runner-no-profile-available`) using a shell-script stub for `$CAAM_BIN`.
- **Source:** `packages/session-runner/src/claude-runner.ts:637-646`,
  new `src/peer-scan.ts`, `src/caam.ts`

#### API Layer
`RateLimitEvent` extension on the runner→DO WS (shared-types):

```ts
interface RateLimitEvent {
  type: 'rate_limit'
  session_id: string
  rate_limit_info: Record<string, unknown>  // existing SDK passthrough
  // new optional fields, backward-compatible
  exit_reason?: 'rate_limited' | 'rate_limited_no_rotate' | 'rate_limited_no_profile'
  rotation?: { from: string; to: string } | null
  earliest_clear_ts?: number  // ms epoch, only on rate_limited_no_profile
  resets_at?: number          // ms epoch, mirrored from rate_limit_info.resetsAt
}
```

The `resets_at` field is the runner's read of `rate_limit_info.resetsAt`
lifted to a typed top-level field so the DO doesn't have to re-parse the
loosely-typed `rate_limit_info` blob. Omitted when the SDK payload
didn't carry it (unlikely on real events, but the spec doesn't assume).

#### Data Layer
`ExitFile.state` union gains three literals:
`'rate_limited' | 'rate_limited_no_rotate' | 'rate_limited_no_profile'`.
All use `exit_code: 0`. `error` field carries a JSON-stringified blob
with rotation metadata or earliest-clear-ts for observability.

---

### B4: DO auto-respawns a resume runner after rotation

**Core:**
- **ID:** do-respawn-after-rotation
- **Trigger:** DO receives `GatewayEvent` of type `'rate_limit'` with
  `exit_reason: 'rate_limited'` and non-null `rotation`.
- **Expected:** DO (1) inserts a system-role `SessionMessage` with
  `metadata.caam = {kind:'rotated', from, to, at: now()}` into the
  SQLite history and broadcasts it as a seq'd `messages` delta, (2)
  sets `SessionMeta.pendingResume = {kind:'rotation', at: now()+1000}`,
  (3) schedules a DO alarm for that timestamp, (4) on alarm fires, if
  no live runner, calls existing
  `triggerGatewayDial({type:'resume', sdk_session_id})` exactly once
  and clears `pendingResume`. The existing 4410/4401 token rotation in
  `triggerGatewayDial` handles any race where the old runner hasn't
  fully closed yet.
- **Verify:** Integration test against a real local DO: synthesize a
  `rate_limit` event with rotation metadata into the DO's WS handler;
  assert messagesCollection gains a system message with `metadata.caam`;
  assert an alarm is scheduled; advance DO time past the alarm;
  assert `triggerGatewayDial` is invoked with
  `{type:'resume', sdk_session_id: <original>}`. Also: simulate DO
  eviction+rehydrate between event and alarm — `pendingResume` must
  survive and the resume must still fire.
- **Source:** `apps/orchestrator/src/agents/session-do.ts:5071-5073`
  (handler), alarm branch (existing watchdog around
  `ALARM_INTERVAL_MS`), `META_COLUMN_MAP` around lines 154-181 (new
  SQLite column), migration v8 in the DO's migration ladder.

#### UI Layer
Transcript shows a new system-role message with rendered text
`⚡ Claude profile rotated work1 → work2, resuming…`. Rendering uses
the existing system-role pathway in `ai-elements` — no new component.
`useDerivedStatus` is extended to surface a transient `'rotating'`
status derived from the newest system breadcrumb with `metadata.caam`;
StatusBar / tab / sidebar pick it up unchanged. Once the resume runner
connects and emits `session.init`, `useDerivedStatus` returns to
`'running'`.

#### API Layer
No new endpoints. The existing `triggerGatewayDial`
`POST /sessions/start` call is reused for the resume dial.

#### Data Layer
New DO SQLite column on `session_meta`:
```sql
pending_resume_json TEXT NULL  -- JSON of { kind: 'rotation'; at: number } | null
```
Migration v8 — additive nullable column, no backfill needed.

`SessionMessage.metadata` gains an optional `caam?: { kind: 'rotated' |
'skipped' | 'waiting'; from?: string; to?: string; at: number;
earliest_clear_ts?: number }` shape. Additive, no migration.

---

### B5: DO handles rate_limited_no_rotate with an error breadcrumb

**Core:**
- **ID:** do-no-rotate-error
- **Trigger:** DO receives `rate_limit` event with
  `exit_reason: 'rate_limited_no_rotate'`.
- **Expected:** DO inserts a system-role `SessionMessage` with
  `metadata.caam = {kind:'skipped', at: now()}` and body text
  `"Rate-limited; another Claude session is active — not rotating.
  Retry manually when the other session completes."`. Session status
  transitions to `'error'` via the existing error-surface path. No
  `pendingResume` scheduled. User must send a new message to retry
  (existing demand-driven respawn path handles it).
- **Verify:** Integration test parallel to B4 with
  `exit_reason: 'rate_limited_no_rotate'`; assert no alarm scheduled,
  status becomes `'error'`, system message present.
- **Source:** same handler as B4.

#### UI Layer
System error-style message in transcript. `useDerivedStatus` returns
`'error'` with a reason readable from `metadata.caam.kind === 'skipped'`.

---

### B6: DO handles rate_limited_no_profile with waiting_profile status + delayed alarm

**Core:**
- **ID:** do-waiting-profile
- **Trigger:** DO receives `rate_limit` event with
  `exit_reason: 'rate_limited_no_profile'` and
  `earliest_clear_ts: <future>`.
- **Expected:** DO inserts system-role message with
  `metadata.caam = {kind:'waiting', at: now(), earliest_clear_ts}` and
  body text `"All Claude profiles are cooling down — waiting until
  <human-readable ts> to resume."`. Sets
  `SessionMeta.pendingResume = {kind:'rotation', at: earliest_clear_ts + 30_000}`
  (30 s slop). Alarm scheduled. Session status becomes
  `'waiting_profile'` (new derived status). On alarm fire, same resume
  dispatch as B4.
- **Verify:** Integration test per the P3 phase table
  (`do-waiting-profile-status`): synthesize event, assert status +
  message + alarm; advance time past alarm; assert resume dials.
- **Source:** same handler as B4.

#### UI Layer
Persistent `waiting_profile` badge in StatusBar / sidebar via
`useDerivedStatus` + `deriveDisplayStateFromStatus`. Text renders the
clear timestamp in the user's locale.

#### Data Layer
Reuses `pending_resume_json` column from B4.

---

### B7: Dev-box safety — graceful no-op when caam isn't configured

**Core:**
- **ID:** dev-box-caam-absent
- **Trigger:** Runner starts on a machine where `$CAAM_BIN`
  (default: probe `$PATH` then `/home/ubuntu/bin/caam`) doesn't exist
  OR `caam ls claude` returns zero profiles.
- **Expected:** `caamIsConfigured()` returns `false`. Runner logs
  `[caam] not configured on this host — rotation disabled` to stderr
  exactly once at startup. All subsequent caam calls become no-ops.
  Rate-limit events still relay to the DO as raw `RateLimitEvent` with
  no `rotation` metadata; runner does NOT exit automatically — existing
  SDK abort / timeout behavior applies. DO's rate_limit handler falls
  into a default branch that just broadcasts (same as today).
- **Verify:** `CAAM_BIN=/nonexistent/caam pnpm --filter
  @duraclaw/session-runner build && node dist/main.js ...` — startup log
  present; simulate a rate_limit_event in a unit harness; assert no
  caam subprocess was spawned, event relayed to DO unchanged.
- **Source:** `packages/session-runner/src/caam.ts`,
  `packages/session-runner/src/main.ts` startup block.

---

## Non-Goals

Explicitly **out of scope** for this issue. Each has a follow-up ticket or a
documented "we'll revisit if telemetry says so":

- **Per-runner profile isolation** (per-process `HOME` override, `caam
  exec`, Unix users, containers). Phase 1 is single-active-Claude-runner
  per VPS. D4 peer-check makes unsafe rotation skip itself; if that
  path fires often in telemetry, we open a Phase 2 issue.
- **UI to choose profile policy per session** (pin / auto / off chip in
  the session settings). Env knobs ship first. UI is a follow-up.
- **Admin endpoint / web UI for caam status** (`/api/admin/caam/*`).
  Phase 1 uses runner stderr logs + `caam status` on the VPS +
  transcript breadcrumbs. If ops wants more, it's a separate issue.
- **Rate-limit-aware concurrency control** (e.g., pausing new session
  spawns while we're mid-rotation). Out of scope; the single-runner
  assumption makes it moot for Phase 1.
- **Force-rotation UI button** ("skip cooldown, force next profile
  now"). Not needed for Phase 1; `caam cooldown clear claude/<profile>`
  on the VPS suffices for ops.
- **Structured telemetry for rotation frequency / reset-time accuracy.**
  We now derive cooldown from `rate_limit_info.resetsAt`; if that field
  ever drifts from reality we'd see "rotated but still rate-limited"
  loops. Phase 1 observability is stderr logs only; a structured metric
  pipeline (counter: rotations/hour; gauge: earliest_clear_ts drift) is
  a separate issue if/when the logs say we need it.
- **Migration of existing in-flight sessions.** On deploy, running
  session-runners continue with the old behavior (relay-only). Next
  spawn picks up the new logic. No backfill needed.

## Open Questions

- [ ] **(resolved — wrapper-side)** `caam status` / `caam next` /
  `caam cooldown list` `--json` availability on the installed binary.
  `caam.ts` probes `--json` first, falls back to documented text
  format on any non-JSON or non-zero exit. Regression test stubs the
  text format in `caam-stub.sh`. Closed.
- [ ] **(resolved — commit)** Breadcrumb filtering out of SDK resume
  prompt. **Decision: reuse `role: 'system'` and filter on
  `msg.metadata?.caam !== undefined` in the history → SDK-prompt
  serializer.** Implemented as a P3 task (see phases YAML). The
  serializer is exactly one choke point in
  `apps/orchestrator/src/agents/session-do.ts`; unit test asserts
  caam-metadata messages are dropped from SDK prompt reconstruction
  while still rendering in `messagesCollection`. Closed.
- [x] **(superseded — 2026-04-24 revision)** Cooldown duration default
  (60 vs 120 vs 300 minutes). Moot: the runner now derives the cooldown
  value from `rate_limit_info.resetsAt` per-event, so there's no tunable
  default to pick. Kept here for traceability because the earlier draft
  spent a whole decision (D1) on it. Closed.
- [ ] **(new — verify on first real hit)** `rate_limit_info.resetsAt`
  field presence on actual SDK `rate_limit_event` messages for each
  `rateLimitType` (`five_hour`, `seven_day`, `seven_day_opus`,
  `seven_day_sonnet`, `overage`). Spec #13 B13 documents the shape as
  optional; B3 has a 300-minute fallback that fires when missing. VP1
  should capture one real event's payload (not just the synthetic) to
  lock this in before we trust the derived-cooldown path end-to-end.

## Implementation Phases

See YAML frontmatter `phases:` above. Summary:

1. **P1 (types + gateway plumbing)** — 1–2 h. Extend `ExitFile`,
   `MetaFile`, `RateLimitEvent`. Gateway env passthrough.
2. **P2 (runner: caam wrapper + rotation)** — 3–4 h. `caam.ts`,
   `peer-scan.ts`, claude-runner.ts rate-limit branch, main.ts startup
   pin, exit-file writer.
3. **P3 (DO: auto-respawn + transcript + status)** — 2–3 h. DO rate_limit
   handler branches, alarm extension, SQLite migration v8,
   `useDerivedStatus` extension, `metadata.caam` wiring.
4. **P4 (verification + rollout)** — 1–2 h. Real-binary integration
   against local dev stack. Update CLAUDE.md.

Total: 7–11 h, single implementer.

## Verification Strategy

### Test Infrastructure
- **vitest workspace** already covers session-runner, agent-gateway,
  shared-types. Add new test files alongside existing ones.
- **Stub caam binary**: write a shell script to `/tmp/caam-stub.sh`
  that echoes canned JSON for each subcommand, set `CAAM_BIN=/tmp/caam-stub.sh`
  in the integration test env. This tests the wrapper + runner flow
  without needing real caam on CI.
- **DO integration**: use miniflare + the existing DO harness pattern
  from other session-do tests (rg for "SessionDO" in
  `apps/orchestrator/**/*.test.ts`).

### Build Verification
- `pnpm typecheck` across workspace (Turbo).
- `pnpm --filter @duraclaw/session-runner build` emits
  `dist/main.js` with `#!/usr/bin/env bun` shebang.
- `pnpm --filter @duraclaw/orchestrator build` (TanStack Start + Vite).
- No need for `pnpm ship` locally — infra handles deploy on main push.

## Verification Plan

Concrete, executable scenarios run against a local `scripts/verify/dev-up.sh`
stack on a VPS that has real caam configured. The active `~/.claude`
must have been captured into caam as one of `work1..work3` first (P4
prerequisite).

### VP1: Rotation happy path

Steps:
1. `scripts/verify/dev-up.sh`
   Expected: orchestrator on `$VERIFY_ORCH_PORT`, gateway on
   `$CC_GATEWAY_PORT`, both healthy.
2. `caam cooldown clear --all` then
   `caam activate claude work1 --force`
   Expected: `caam status` shows `claude: work1 ✅`
3. Login via `scripts/verify/axi-a` to
   `http://127.0.0.1:$VERIFY_ORCH_PORT/login` and start a new session.
4. In the session, synthesize a session-limit event via the dev
   endpoint added in P3 (`POST /api/__dev__/synth-ratelimit/:sessionId`
   with body `{target:'runner', rate_limit_info:{status:'rejected',
   rateLimitType:'five_hour', resetsAt:<now+45min>}}`, gated on
   `DURACLAW_DEBUG_ENDPOINTS=1`). The payload uses a 45-minute
   `resetsAt` so we can verify the derived-minutes math (not a round
   60). Steps 6/7 use that timestamp explicitly, so substitute whatever
   you pass here.
   Expected: Within ~3 s, transcript shows system message
   `⚡ Claude profile rotated work1 → work2, resuming…`; StatusBar
   shows `rotating` briefly then `running`; next user message works
   normally.
5. `cat /run/duraclaw/sessions/<sid>.exit`
   Expected: `{"state":"rate_limited","exit_code":0,...,
   "error":"{\"rotation\":{\"from\":\"work1\",\"to\":\"work2\"},\"resets_at\":<ts>}"}`
6. `caam cooldown list`
   Expected: `claude/work1` listed with ~45 min remaining (matching the
   synthesized `resetsAt` minus now). The exact minute count should
   equal `Math.ceil((resetsAt - t_observed) / 60_000)` where
   `t_observed` is the moment step 4 fires — tolerances of ±1 minute
   are fine.
7. `caam which claude`
   Expected: `claude: work2`
8. Check runner stderr in `/run/duraclaw/sessions/<sid>.log`.
   Expected: a single structured line of shape
   `[caam] session_limit reset_at=<iso> derived_cooldown=45m next=work2 rotated`.
   NO `[caam] rate_limit_info missing resetsAt` fallback line.

### VP2: Peer-detected skip

Steps:
1. Start two concurrent Claude sessions (A and B) under `axi-a` and
   `axi-b`.
2. Trigger synthetic rate-limit in session A only.
   Expected: A's transcript shows system error
   `Rate-limited; another Claude session is active — not rotating.
   Retry manually when the other session completes.` A's status is
   `error`. No `caam cooldown set` or `caam next` ran (check
   `caam cooldown list` is empty).
3. Session B continues streaming normally, completes its turn.
   Expected: No change to B's status or transcript.
4. `cat /run/duraclaw/sessions/<sid-A>.exit`
   Expected: `{"state":"rate_limited_no_rotate","exit_code":0,...}`.

### VP3: All profiles cooling → waiting_profile

Steps:
1. Put every Claude profile into cooldown:
   `for p in work1 work2 work3; do caam cooldown set claude/$p --minutes 5; done`
2. Activate `work1 --force` and start a session under `axi-a`.
3. Trigger synthetic rate-limit.
   Expected: transcript shows
   `All Claude profiles are cooling down — waiting until <ts> to
   resume.`; StatusBar shows `waiting profile`. No `caam activate` was
   run.
4. `cat /run/duraclaw/sessions/<sid>.exit`
   Expected: `{"state":"rate_limited_no_profile","exit_code":0,...,"error":"{\"earliest_clear_ts\":<ts>}"}`.
5. Wait until the earliest clear timestamp + 30 s slop.
   Expected: a new runner is spawned (
   `gh-axi` / status endpoint shows live runner); transcript continues
   normally; StatusBar returns to `running`.
6. Alternative fast-path: `caam cooldown clear claude/work2 --force`
   and manually trigger DO alarm (a dev-only
   `POST /api/__dev__/trigger-alarm/:sessionId` if present).

### VP4: Pinned profile in cooldown fails fast

Uses the real pin-via-gateway-env path documented in the break-glass
section (no dev endpoint needed — pinning is a production mechanism,
so the VP exercises the production shape).

Steps:
1. `caam cooldown set claude/work2 --minutes 30`
2. Export the pin for the gateway process and restart it (local dev
   stack, not systemd):
   ```bash
   cd packages/agent-gateway
   DURACLAW_CLAUDE_PROFILE=work2 bun run src/server.ts &
   ```
   (On prod VPS, this is the `sudo systemctl edit` workflow from the
   Rollback section — same env-passthrough from gateway to runner via
   `buildCleanEnv()`.)
3. Log in via `scripts/verify/axi-a` and start a new session.
   Expected: session status is `error` within 2 s; transcript shows
   system error breadcrumb body
   `pinned profile 'work2' is in cooldown until <ts>`; `.exit` state is
   `failed`.
4. `cat /run/duraclaw/sessions/<sid>.log`
   Expected: log contains the startup caam line and the failure, but
   NO SDK query lifecycle lines — runner bailed before `query()` was
   invoked.
5. Teardown: unset the env on the gateway and restart; confirm a new
   session spawns with `caam which` → whichever profile is currently
   active on the VPS.

### VP5: Dev-box without caam

Steps:
1. `CAAM_BIN=/nonexistent pnpm --filter @duraclaw/session-runner build`
2. Rebuild and restart the gateway so the runner binary it spawns uses
   the above env. Start a session.
3. `tail /run/duraclaw/sessions/<sid>.log | grep caam`
   Expected: exactly one line `[caam] not configured on this host —
   rotation disabled` on the first runner startup of that session.
   `.meta.json` has `claude_profile: null`.
4. Trigger synthetic rate-limit.
   Expected: transcript shows the raw rate_limit-based error today's
   code produces; no rotation breadcrumb, no respawn. `.exit` state on
   the runner is whatever the current behavior produces (most likely
   session stays alive and later times out via reaper at 30 min idle).

## Implementation Hints

### Dependencies

No new runtime packages. `caam` is an external binary; we spawn it via
Node/Bun `child_process`.

### Key Imports

| Module | Import | Used For |
|--------|--------|----------|
| `node:child_process` | `{ spawn, execFile }` | Invoking `caam` subprocesses from `caam.ts` |
| `node:fs/promises` | `{ readdir, readFile, stat }` | `peer-scan.ts` globbing sibling `.meta.json` |
| `node:path` | `{ join, basename }` | Sessions-dir path math |
| `@duraclaw/shared-types` | `RateLimitEvent`, `ExitFile`, `MetaFile` | Extended types |
| `@duraclaw/shared-transport` | `BufferedChannel` (already in use) | Relay rate_limit events with rotation metadata |

### Code Patterns

**caam CLI argument conventions (authoritative — use verbatim).**
Verified against the installed `/home/ubuntu/bin/caam` `--help` output:

| Operation | argv array |
|-----------|------------|
| Activate profile | `['activate', 'claude', '<profile>']` |
| Activate with force | `['activate', 'claude', '<profile>', '--force']` |
| Rotate (smart) | `['next', 'claude', '--quiet']` |
| Rotate (json, if supported) | `['next', 'claude', '--json']` |
| Set cooldown | `['cooldown', 'set', 'claude/<profile>', '--minutes', '<N>']` — slash-separated key |
| List cooldowns | `['cooldown', 'list']` |
| Clear all cooldowns | `['cooldown', 'clear', '--all']` |
| List profiles for a tool | `['ls', 'claude']` |
| Active profile per tool | `['which']` (single command, no tool arg) |
| Status dashboard | `['status']` |

**Rule:** tool name always comes AFTER the subcommand (`caam <cmd>
[tool]`), except for `cooldown set`/`clear` where the profile key is
`<tool>/<profile>` slash-separated. Never invert this; the wrapper
functions below enforce it.

**Runner → caam subprocess with JSON-first, text-fallback parsing:**

```ts
// packages/session-runner/src/caam.ts
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { access } from 'node:fs/promises'
import { constants as fsc } from 'node:fs'

const pexec = promisify(execFile)

async function caamExec(args: string[]): Promise<{stdout: string; stderr: string; code: number}> {
  const bin = process.env.CAAM_BIN ?? '/home/ubuntu/bin/caam'
  try {
    const { stdout, stderr } = await pexec(bin, args, { timeout: 5000 })
    return { stdout, stderr, code: 0 }
  } catch (e: any) {
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? String(e), code: e.code ?? 1 }
  }
}

let _configuredCache: boolean | null = null
export async function caamIsConfigured(): Promise<boolean> {
  if (_configuredCache !== null) return _configuredCache
  const bin = process.env.CAAM_BIN ?? '/home/ubuntu/bin/caam'
  try { await access(bin, fsc.X_OK) } catch { return (_configuredCache = false) }
  const ls = await caamExec(['ls', 'claude'])
  _configuredCache = ls.code === 0 && /work\d|_original|\w/.test(ls.stdout)
  return _configuredCache
}

export async function caamActivate(profile: string, opts: { force?: boolean } = {}): Promise<void> {
  const args = ['activate', 'claude', profile, ...(opts.force ? ['--force'] : [])]
  const r = await caamExec(args)
  if (r.code !== 0) throw new Error(`caam activate claude ${profile} failed: ${r.stderr.trim()}`)
}

export async function caamNext(): Promise<{ activated: string } | null> {
  const json = await caamExec(['next', 'claude', '--json'])
  if (json.code === 0 && json.stdout.trim().startsWith('{')) {
    try { return JSON.parse(json.stdout) } catch { /* fall through to text */ }
  }
  const q = await caamExec(['next', 'claude', '--quiet'])
  if (q.code !== 0) return null
  const name = q.stdout.trim().split(/\s+/).pop()
  return name ? { activated: name } : null
}

export async function caamCooldownSet(profile: string, minutes: number): Promise<void> {
  const r = await caamExec(['cooldown', 'set', `claude/${profile}`, '--minutes', String(minutes)])
  if (r.code !== 0) throw new Error(`caam cooldown set claude/${profile} failed: ${r.stderr.trim()}`)
}

export async function caamEarliestClearTs(): Promise<number> {
  // `caam cooldown list` plain-text parse; look for lines like
  //   claude/work1    cooling   clears 2026-04-24T19:22:00Z
  const r = await caamExec(['cooldown', 'list'])
  const now = Date.now()
  const times: number[] = []
  for (const line of r.stdout.split('\n')) {
    const m = line.match(/claude\/\S+.*?(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ)/)
    if (m) { const t = Date.parse(m[1]); if (!Number.isNaN(t) && t > now) times.push(t) }
  }
  return times.length ? Math.min(...times) : now + 60 * 60_000
}

export async function caamActiveProfile(): Promise<string | null> {
  // caam which prints lines like "claude: work2" or "claude: (none)"
  const r = await caamExec(['which'])
  if (r.code !== 0) return null
  const m = r.stdout.match(/^claude:\s+(\S+)/m)
  if (!m || m[1] === '(none)' || m[1] === '(logged') return null
  return m[1]
}
```

**Peer scan:**

```ts
// packages/session-runner/src/peer-scan.ts
import { readdir, readFile } from 'node:fs/promises'
import { join, basename } from 'node:path'

export interface PeerSummary { sessionId: string; model: string; lastActivityTs: number }

export async function scanPeerMeta(dir: string, selfId: string): Promise<PeerSummary[]> {
  const files = (await readdir(dir).catch(() => [])).filter(f => f.endsWith('.meta.json'))
  const out: PeerSummary[] = []
  for (const f of files) {
    const sid = basename(f, '.meta.json')
    if (sid === selfId) continue
    try {
      const m = JSON.parse(await readFile(join(dir, f), 'utf8'))
      if (m.state === 'running' && typeof m.model === 'string' && m.model.startsWith('claude-')) {
        out.push({ sessionId: sid, model: m.model, lastActivityTs: m.last_activity_ts })
      }
    } catch { /* skip malformed */ }
  }
  return out
}
```

**Rate-limit branch in claude-runner.ts (shape).** Note: pinning (B2)
sets a local `rotationMode = 'off'` flag at startup; that flag flows
into gate 0 below. `.exit` is written inline BEFORE `abort()` in every
rate_limited* path via `writeExitFileInline()` — a single-writer helper
that reuses `main.ts`'s existing `link()+EEXIST` semantics so the
post-abort cleanup writer becomes a no-op:

```ts
// packages/session-runner/src/claude-runner.ts near line 637
} else if (message.type === 'rate_limit_event') {
  const raw = (message as any).rate_limit_info
  const rotationMode = ctx.rotationMode  // 'auto' | 'off', set at startup;
                                         // pinning forces 'off' regardless of env

  // Gate 0: rotation disabled (pin or env) — abort, surface to DO, exit.
  if (rotationMode === 'off') {
    send(ch, { type: 'rate_limit', session_id: sessionId, rate_limit_info: raw,
               exit_reason: 'rate_limited_no_rotate', rotation: null }, ctx)
    ctx.meta.state = 'rate_limited_no_rotate'
    await writeExitFileInline(ctx, { state: 'rate_limited_no_rotate', exit_code: 0,
      error: JSON.stringify({ reason: 'rotation_disabled', mode: rotationMode }) })
    ctx.abortController.abort()
    return
  }

  // Gate 1: caam not configured (dev box) — relay raw, stay alive (today's behavior).
  if (!(await caamIsConfigured())) {
    send(ch, { type: 'rate_limit', session_id: sessionId, rate_limit_info: raw }, ctx)
    return  // no abort, no exit — preserves dev-box degradation
  }

  // Gate 2: peer Claude runner live — skip rotation.
  const peers = await scanPeerMeta(SESSIONS_DIR, sessionId)
  if (peers.length > 0) {
    send(ch, { type: 'rate_limit', session_id: sessionId, rate_limit_info: raw,
               exit_reason: 'rate_limited_no_rotate', rotation: null }, ctx)
    ctx.meta.state = 'rate_limited_no_rotate'
    await writeExitFileInline(ctx, { state: 'rate_limited_no_rotate', exit_code: 0,
      error: JSON.stringify({ reason: 'peer_detected', peer_ids: peers.map(p => p.sessionId) }) })
    ctx.abortController.abort()
    return
  }

  // Gate 3: normal rotation.
  // Derive refresh time from the SDK event — no manual cooldown fudge.
  const resetsAt: number | undefined =
    typeof raw?.resetsAt === 'number' && raw.resetsAt > Date.now()
      ? raw.resetsAt
      : undefined
  let minutes: number
  if (resetsAt) {
    minutes = Math.max(1, Math.ceil((resetsAt - Date.now()) / 60_000))
  } else {
    // Fallback: SDK payload didn't carry a usable resetsAt. Use 300m
    // (Anthropic's documented five-hour window) as the conservative cap.
    minutes = 300
    ctx.log.warn('[caam] rate_limit_info missing resetsAt, falling back to 300m')
  }

  const active = (await caamActiveProfile()) ?? 'unknown'
  await caamCooldownSet(active, minutes)  // caam's 'next' now skips <active> until resetsAt
  const next = await caamNext()

  if (!next) {
    const earliest = await caamEarliestClearTs()
    send(ch, { type: 'rate_limit', session_id: sessionId, rate_limit_info: raw,
               exit_reason: 'rate_limited_no_profile', rotation: null,
               earliest_clear_ts: earliest, resets_at: resetsAt ?? null }, ctx)
    ctx.meta.state = 'rate_limited_no_profile'
    ctx.meta.rate_limit_earliest_clear_ts = earliest
    await writeExitFileInline(ctx, { state: 'rate_limited_no_profile', exit_code: 0,
      error: JSON.stringify({ reason: 'all_unavailable', earliest_clear_ts: earliest,
                              resets_at: resetsAt ?? null }) })
    ctx.abortController.abort()
    return
  }

  ctx.meta.rotation = { from: active, to: next.activated }
  ctx.meta.state = 'rate_limited'
  send(ch, { type: 'rate_limit', session_id: sessionId, rate_limit_info: raw,
             exit_reason: 'rate_limited',
             rotation: { from: active, to: next.activated },
             resets_at: resetsAt ?? null }, ctx)
  await writeExitFileInline(ctx, { state: 'rate_limited', exit_code: 0,
    error: JSON.stringify({ rotation: { from: active, to: next.activated },
                            resets_at: resetsAt ?? null }) })
  ctx.abortController.abort()
}
```

`writeExitFileInline(ctx, payload)` lives in `main.ts` alongside the
existing cleanup writer (lines 536-541, 558). Implementation: same
`link()+EEXIST` single-writer pattern the cleanup path already uses;
caller invokes it synchronously before `abort()`. Post-abort cleanup
checks for `.exit` existence first and no-ops if present.

**DO rate_limit handler branch (shape):**

```ts
// apps/orchestrator/src/agents/session-do.ts around line 5071
case 'rate_limit': {
  this.broadcastGatewayEvent(event)  // keep existing broadcast
  if (event.exit_reason === 'rate_limited' && event.rotation) {
    await this.insertSystemBreadcrumb({
      body: `⚡ Claude profile rotated ${event.rotation.from} → ${event.rotation.to}, resuming…`,
      metadata: { caam: { kind: 'rotated', from: event.rotation.from, to: event.rotation.to, at: Date.now() } },
    })
    this.meta.pendingResume = { kind: 'rotation', at: Date.now() + 1000 }
    await this.persistMeta()
    await this.ctx.storage.setAlarm(this.meta.pendingResume.at)
  } else if (event.exit_reason === 'rate_limited_no_rotate') {
    await this.insertSystemBreadcrumb({
      body: `Rate-limited; another Claude session is active — not rotating. Retry manually when the other session completes.`,
      metadata: { caam: { kind: 'skipped', at: Date.now() } },
    })
    this.setStatus('error', 'rate_limited_no_rotate')
  } else if (event.exit_reason === 'rate_limited_no_profile') {
    const at = (event.earliest_clear_ts ?? (Date.now() + 60_000)) + 30_000
    await this.insertSystemBreadcrumb({
      body: `All Claude profiles are cooling down — waiting until ${new Date(at).toISOString()} to resume.`,
      metadata: { caam: { kind: 'waiting', at: Date.now(), earliest_clear_ts: at } },
    })
    this.meta.pendingResume = { kind: 'rotation', at }
    await this.persistMeta()
    await this.ctx.storage.setAlarm(at)
  }
  break
}
```

### Gotchas

- **`caam activate` mutates GLOBAL `~/.claude`.** If a peer runner is
  mid-`query()` when this fires, that peer's next API call can 401.
  B3's peer-scan exists specifically to prevent this; don't remove it
  under "optimization."
- **SDK resume and the transcript breadcrumb.** The DO's history is
  also the input the SDK's `resume` uses to reconstruct context. A
  system-role breadcrumb must either be filtered out of the
  SDK-prompt reconstruction path OR be carefully worded so it doesn't
  confuse the model. Default recommendation: filter by
  `metadata.caam !== undefined` in the history → SDK-prompt serializer.
  Open Question tracks this.
- **`.exit` is single-writer via `link()+EEXIST`.** The rate-limit
  branch writes `.exit` INLINE via `writeExitFileInline()` BEFORE
  calling `abort()` — see B3 code pattern. This deterministically wins
  the race against the SIGTERM watchdog's 2 s grace writer and the
  post-abort cleanup writer, both of which now check for `.exit`
  existence first and no-op when present. The cleanup writer at
  `main.ts:536-541, 558` must be updated in P2 to call the same
  existence-check helper, not just write unconditionally.
- **`caam next --quiet` output format.** Not formally specified. P2
  unit test pins this against the installed binary — if it changes on
  a caam upgrade, the wrapper's text fallback catches it; add a
  regression test in the same file.
- **`rate_limit_info.resetsAt` is now load-bearing.** The 60-min
  manual cooldown is gone; the runner reads `resetsAt` (ms epoch) out
  of the SDK event and feeds `Math.ceil((resetsAt - now) / 60000)`
  minutes directly into `caam cooldown set`. Spec #13 B13 types this
  field as optional; the runner guards with `typeof raw.resetsAt ===
  'number' && raw.resetsAt > Date.now()` and falls back to 300
  minutes when the guard fails, logging the fallback exactly once per
  event. Watch for `[caam] rate_limit_info missing resetsAt` in stderr
  — it means the SDK passthrough schema drifted and the fallback is
  masking it.
- **DO alarms are coarse.** `ctx.storage.setAlarm` has minute-ish
  granularity under load. 30 s slop on `earliest_clear_ts` already
  accounts for this; don't rely on precise sub-second alarm fire.
- **Gateway `buildCleanEnv` allowlist vs denylist.** Today it denylists
  `CLAUDECODE*` and `CLAUDE_CODE_ENTRYPOINT` and passes everything else
  through. `DURACLAW_CLAUDE_*` and `CAAM_BIN` flow through naturally.
  If the gateway's env policy ever flips to an allowlist, this spec's
  env passthrough needs revisiting — leave a comment in `buildCleanEnv`
  calling out the rotation vars.
- **Miniflare alarm persistence** — confirm that DO alarms survive
  eviction in local `miniflare` the same way they do in prod. If not,
  VP3's "wait for alarm" step may need a manual trigger; the dev-only
  `/api/__dev__/trigger-alarm/:sessionId` endpoint referenced in VP3
  is OK to add gated on `DURACLAW_DEBUG_ENDPOINTS=1`.
- **Synthetic rate-limit for local VP.** The real SDK rarely fires
  `rate_limit_event` in test. The safest approach is a hidden dev
  endpoint on the runner's dial-back WS (commanded from the DO) that
  the DO will only expose under `DURACLAW_DEBUG_ENDPOINTS=1`. Don't
  try to trigger via hammering the real Anthropic API.

### Reference Docs

- [`@anthropic-ai/claude-agent-sdk` — types](https://www.npmjs.com/package/@anthropic-ai/claude-agent-sdk)
  — `rate_limit_event` message shape (passthrough for now).
- [caam binary help](local: `caam help <cmd>`) — authoritative CLI
  surface; commands used: `activate`, `next`, `cooldown {set,list}`,
  `status`, `ls`, `which`.
- `CLAUDE.md` — "Session lifecycle & resume" section and "agent-gateway"
  section for spawn/exit-file semantics.
- `planning/research/2026-04-24-caam-auth-rotation-gh92.md` — full
  research findings.
- `planning/research/2026-04-24-caam-auth-rotation-gh92-decisions.md`
  — interview-output decisions (D1–D8) + architectural bets (A1–A4) +
  codebase findings.

## Rollback / Break-Glass

If rotation misbehaves in production (cascading 401s, wrong profile
activated, `~/.claude` left in an inconsistent state):

1. **Disable rotation for new sessions (zero-downtime).**
   SSH to the VPS running `duraclaw-agent-gateway`. Add an environment
   override to the systemd unit:

   ```bash
   sudo systemctl edit duraclaw-agent-gateway --full
   # Under [Service], add:
   Environment=DURACLAW_CLAUDE_ROTATION=off
   # Save and exit; then:
   sudo systemctl restart duraclaw-agent-gateway
   ```

   Effective for all subsequently-spawned runners within seconds.
   In-flight runners continue with their original mode until they exit
   naturally — see `CLAUDE.md` "Session lifecycle & resume" for why
   this is safe (runners are independent of gateway process lifetime).

2. **Clear stuck cooldowns** (if caam has benched profiles that
   shouldn't be benched):

   ```bash
   /home/ubuntu/bin/caam cooldown clear --all
   # Or, specific profile:
   /home/ubuntu/bin/caam cooldown clear claude/work2
   ```

3. **Force-activate a known-good profile** (if `~/.claude` is pointing
   at the wrong account):

   ```bash
   /home/ubuntu/bin/caam activate claude work1 --force
   /home/ubuntu/bin/caam which          # confirm claude: work1
   ```

4. **Pin a profile for a specific session via the gateway systemd
   drop-in** (ops-only; normal usage keeps this unset so `auto`
   rotation runs):

   ```bash
   sudo systemctl edit duraclaw-agent-gateway --full
   Environment=DURACLAW_CLAUDE_PROFILE=work1
   sudo systemctl restart duraclaw-agent-gateway
   # Runners now pin work1 and fail fast if work1 is cooling (B2).
   ```

5. **Live telemetry on rotation decisions:**

   ```bash
   journalctl -u duraclaw-agent-gateway -f | grep '\[caam\]'
   # Or, for a specific session's log:
   tail -f /run/duraclaw/sessions/<session-id>.log | grep -E 'caam|rate_limit'
   ```

6. **Full revert** (if the feature needs to be yanked): the only state
   this spec creates is additive — the `pending_resume_json` SQLite
   column (nullable) and the new `exit_state` literals. Reverting the
   code leaves these inert. No schema downgrade required.

## Architectural Bets (flagged for review)

Straight from the decisions doc — surfaced here so spec review can flip
any single bet cheaply without rewriting the spec.

- **A1 (D4).** Single active Claude runner per VPS. If wrong, D4's
  peer-skip becomes the common case and no rotation happens. Mitigation:
  Phase 2 (per-runner `HOME` or `caam exec`) is a follow-up issue; this
  spec only assumes A1 holds today.
- **A2 (D3).** `useDerivedStatus` reliably folds a `rotating` /
  `waiting_profile` transient status from system breadcrumb messages.
  Confirmed by CLAUDE.md — `messageSeq` tiebreaker is the canonical
  source of session live state.
- **A3 (D2 / D6).** DO alarm can schedule a one-shot at an arbitrary
  future timestamp and survive eviction. Confirmed via existing
  session_meta persistence and the pre-existing watchdog alarm. Add a
  VP3 test that specifically exercises evict → rehydrate → alarm fire
  to lock this bet in.
- **A4 (D6).** Global `caam activate` between runner restarts is the
  complete auth-swap. User-verified: "we just need to switch auth and
  restart." If the SDK ever caches auth cross-process via some shared
  file lock or daemon, we'd see "rotated to work2 but still
  rate-limited" — break-glass is `DURACLAW_CLAUDE_ROTATION=off` env var
  set gateway-side.
